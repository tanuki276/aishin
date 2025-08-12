// --- 変更なしの既存部分 ---
const path = require('path');
const fs = require('fs');
const kuromoji = require('kuromoji');
const fetch = require('node-fetch');

const dataPath = path.join(__dirname, 'data.json');
let knowledgeBase = {};
try {
  const rawData = fs.readFileSync(dataPath, 'utf8');
  const botData = JSON.parse(rawData);
  knowledgeBase = botData.knowledgeBase || {};
} catch (error) {
  console.error('Failed to load data.json:', error.message);
}

const SPOONACULAR_API_KEY = process.env.SPOONACULAR_API_KEY;
const WOLFRAM_ALPHA_APP_ID = process.env.WOLFRAM_ALPHA_APP_ID;

let fetchImpl = (typeof globalThis !== 'undefined' && globalThis.fetch) ? globalThis.fetch : null;
if (!fetchImpl) {
  try {
    const nf = require('node-fetch');
    fetchImpl = nf.default || nf;
  } catch (e1) {
    try {
      const undici = require('undici');
      fetchImpl = undici.fetch;
    } catch (e2) {
      console.warn('fetch not available: network calls will fail unless global.fetch/node-fetch/undici present.');
      fetchImpl = null;
    }
  }
}

let tokenizer = null;
const initTokenizer = (async () => {
  try {
    const dictPath = path.join(path.dirname(require.resolve('kuromoji')), '..', 'dict');
    await new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath: dictPath }).build((err, built) => {
        if (err) return reject(err);
        tokenizer = built;
        console.log('Kuromoji ready (dictPath=', dictPath, ')');
        resolve();
      });
    });
  } catch (err) {
    console.error('initTokenizer error:', err && err.message ? err.message : err);
  }
})();

const contextMap = new Map();
const MAX_HISTORY = 80;
const CONTEXT_TTL_MS = 1000 * 60 * 30;

function nowTs(){ return Date.now(); }
function pushHistory(ctx, role, text){
  ctx.history.push({ role, text, ts: nowTs() });
  if (ctx.history.length > MAX_HISTORY) ctx.history.shift();
  ctx.updatedAt = nowTs();
}
function choose(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

// --- 変更ここから ---

// 意図検出をより詳細に、豊富なキーワードに対応
function detectIntent(text){
  if (!text) return 'unknown';
  if (/^(おはよう|こんにちは|こんばんは|やあ|もしもし|おっす)/.test(text)) return 'greeting';
  if (/ありがとう|助かった|感謝|どうも/.test(text)) return 'thanks';
  if (/(天気|気温|降水|雨|晴れ|雪|台風|予報)/.test(text)) return 'weather';
  if (/(ジョーク|冗談|ギャグ|おもしろ|笑わせて|ネタ)/.test(text)) return 'joke';
  if (/助言|アドバイス|どうすれば|どうしたら|相談/.test(text)) return 'advice';
  if (/(作り方|レシピ|材料|献立|調理法|料理|ご飯|メニュー|食べ物)/.test(text)) return 'recipe';
  if (/[+\-*/^=]/.test(text) || /(計算|平方根|微分|積分|方程式|解)/.test(text)) return 'math';
  if (/\?|\？|かな|かも|だろう|何|どう|とは|って何/.test(text)) return 'question';
  return 'unknown';
}

// 複合キーワード生成を高度化し、品詞の幅を広げる
function getCompoundKeywordsFromTokens(tokens){
  const keywords = [];
  let buf = [];
  const pushBuf = ()=>{ if (buf.length){ keywords.push(buf.join('')); buf = []; } };
  const isAllowed = (t) => {
      const pos = t.pos;
      const pos_detail_1 = t.pos_detail_1;
      const sf = t.surface_form || '';
      return (pos === '名詞' && (pos_detail_1 === '固有名詞' || pos_detail_1 === '一般' || pos_detail_1 === 'サ変接続')) ||
             (pos === '形容詞') ||
             (pos === '動詞' && t.conjugated_form === '基本形') ||
             (pos === '助詞' && (sf === 'の' || sf === 'は' || sf === 'と'));
  };

  for (const t of tokens){
    if (isAllowed(t)) {
      buf.push(t.surface_form);
    } else {
      pushBuf();
    }
  }
  pushBuf();
  return Array.from(new Set(keywords.filter(k => k.length > 1))).sort((a, b) => b.length - a.length);
}

// コア参照を文脈から解決
function resolveCoref(text, ctx){
  if (!text) return null;
  const pronouns = ['それ','あれ','これ','ここ','そこ','あそこ','この','その','あの','これら','それら'];
  if (!pronouns.some(p => text.includes(p))) return null;

  const m = text.match(/(この|その|あの)([^\s　]+)/);
  if (m){
    const noun = m[2];
    if (ctx && ctx.lastEntities && ctx.lastEntities.length){
      for (const e of ctx.lastEntities) if (e.title.includes(noun) || e.title === noun) return e.title;
    }
    return noun;
  }
  
  if (ctx && ctx.lastEntities && ctx.lastEntities.length) return ctx.lastEntities[0].title;
  if (ctx && ctx.lastKeyword) return ctx.lastKeyword;
  return null;
}

async function tryWikipedia(keyword){
  if (!fetchImpl || !keyword) return null;
  try {
    const opUrl = `https://ja.wikipedia.org/w/api.php?action=opensearch&limit=5&format=json&origin=*&search=${encodeURIComponent(keyword)}`;
    const opRes = await fetchImpl(opUrl);
    if (!opRes.ok) return null;
    const opJson = await opRes.json();
    const titles = opJson && opJson[1] ? opJson[1] : [];
    for (const t of titles){
      const sumUrl = `https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t)}`;
      const sres = await fetchImpl(sumUrl);
      if (!sres.ok) continue;
      const sjson = await sres.json();
      if (sjson && sjson.extract){
        const text = (sjson.extract.length > 600) ? sjson.extract.substring(0,600) + '...' : sjson.extract;
        return { source: 'wikipedia', title: sjson.title, text };
      }
    }
  } catch (err) {
    console.warn('tryWikipedia error', err && err.message ? err.message : err);
  }
  return null;
}

async function tryDuckDuckGo(q){
  if (!fetchImpl || !q) return null;
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skipsdisambig=1`;
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const j = await res.json();
    if (j && j.AbstractText && j.AbstractText.length) {
      const txt = j.AbstractText.length > 600 ? j.AbstractText.substring(0,600)+'...' : j.AbstractText;
      return { source: 'duckduckgo', title: j.Heading || q, text: txt };
    }
  } catch (err) { /* ignore */ }
  return null;
}

async function trySpoonacular(query){
  if (!fetchImpl || !query || !SPOONACULAR_API_KEY) return null;
  try {
    const url = `https://api.spoonacular.com/recipes/complexSearch?apiKey=${SPOONACULAR_API_KEY}&query=${encodeURIComponent(query)}&number=1&addRecipeInformation=true`;
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const j = await res.json();
    if (j && j.results && j.results.length > 0) {
      const recipe = j.results[0];
      const ingredients = recipe.extendedIngredients ? recipe.extendedIngredients.map(i => i.name).join('、') : '情報なし';
      const instructions = recipe.analyzedInstructions && recipe.analyzedInstructions.length > 0 ? recipe.analyzedInstructions[0].steps.map(s => `${s.number}. ${s.step}`).join('\n') : '手順情報なし';
      const reply = `「${recipe.title}」のレシピをお探しですね。\n材料: ${ingredients}\n手順:\n${instructions}`;
      return { source: 'spoonacular', title: recipe.title, text: reply };
    }
  } catch(e){ console.warn('trySpoonacular error', e && e.message ? e.message : e); }
  return null;
}

async function tryWolframAlpha(query){
  if (!fetchImpl || !query || !WOLFRAM_ALPHA_APP_ID) return null;
  try {
    const url = `https://api.wolframalpha.com/v2/result?i=${encodeURIComponent(query)}&appid=${WOLFRAM_ALPHA_APP_ID}&output=json&units=metric&includepodid=Result`;
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const j = await res.json();
    if (j && j.Result) {
      return { source: 'wolframalpha', title: query, text: j.Result };
    }
  } catch(e){ console.warn('tryWolframAlpha error', e && e.message ? e.message : e); }
  return null;
}

async function getJoke(){
  if (!fetchImpl) return null;
  try {
    const res = await fetchImpl('https://official-joke-api.appspot.com/random_joke');
    if (!res.ok) return null;
    const j = await res.json();
    if (j && j.setup) return { source: 'joke', text: `${j.setup} — ${j.punchline || ''}`.trim() };
  } catch(e){ }
  return null;
}

async function getAdvice(){
  if (!fetchImpl) return null;
  try {
    const res = await fetchImpl('https://api.adviceslip.com/advice');
    if (!res.ok) return null;
    const j = await res.json();
    if (j && j.slip && j.slip.advice) return { source: 'advice', text: j.slip.advice };
  } catch(e){}
  return null;
}

async function getWeatherForPlace(place){
  if (!fetchImpl || !place) return null;
  try {
    const nomUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(place)}&limit=1`;
    const nom = await fetchImpl(nomUrl, { headers: { 'User-Agent': 'vercel-chat-example/1.0' }});
    if (!nom.ok) return null;
    const nomj = await nom.json();
    if (!nomj || !nomj[0]) return null;
    const lat = parseFloat(nomj[0].lat), lon = parseFloat(nomj[0].lon), display = nomj[0].display_name;
    const meto = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=auto`;
    const mres = await fetchImpl(meto);
    if (!mres.ok) return null;
    const mj = await mres.json();
    if (mj && mj.current_weather) {
      const cw = mj.current_weather;
      const text = `${display} の現在の天気: weathercode=${cw.weathercode || ''}、気温 ${cw.temperature}°C、風速 ${cw.windspeed} m/s（取得元: Open-Meteo）`;
      return { source: 'open-meteo', text, meta: { lat, lon } };
    }
  } catch(e){ console.warn('getWeatherForPlace error', e && e.message ? e.message : e); }
  return null;
}

const smalltalkPools = {
  neutral: ['ふむ、なるほどね。','へえ、そうなんだ！','面白いね。もっと聞かせて？','いいね、その話。','うん、それで？','なるほど、続けて。'],
  snarky: ['そう？でも本気で言ってるの？','おや、それは意外（としか言えない）','ふーん、君は勇気あるね。','まあ、君がそう思うならね。'],
  kind: ['いいね、よくやったね。','素敵な話だね。ありがとう。','そういうの聞けて嬉しいよ。','それは大変だったね、大丈夫？'],
  search_fail: [
    'ごめんなさい、うまく見つけられませんでした。',
    'うーん、その情報は見当たらないようです。',
    'ちょっと難しかったみたいです。別の言葉で教えていただけますか？',
    'すみません、お探しの情報が見つかりませんでした。'
  ]
};
function smalltalk(mode='neutral'){ return choose(smalltalkPools[mode] || smalltalkPools.neutral); }

// --- 変更ここから ---
async function getBotResponse(userId, userMessage, opts = {}){
  await initTokenizer;

  const now = nowTs();
  let ctx = contextMap.get(userId);
  if (!ctx || (now - (ctx.updatedAt || 0) > CONTEXT_TTL_MS)) {
    ctx = { history: [], persona: opts.persona || 'neutral', lastKeyword: null, lastEntities: [], updatedAt: now };
  }

  // 話題の切り替わり検知を強化
  let isNewTopic = false;
  if (ctx.lastKeyword) {
    let currentKeywords = getCompoundKeywordsFromTokens(tokenizer.tokenize(userMessage));
    const isSimilar = currentKeywords.some(k => ctx.lastKeyword.includes(k) || k.includes(ctx.lastKeyword));
    if (!isSimilar && detectIntent(userMessage) !== 'question') {
      isNewTopic = true;
    }
  }
  if (isNewTopic) {
      console.log('Detected new topic. Resetting context for userId=', userId);
      ctx = { history: [], persona: opts.persona || 'neutral', lastKeyword: null, lastEntities: [], updatedAt: now };
  }

  pushHistory(ctx, 'user', userMessage);

  const intent = detectIntent(userMessage);

  if (intent === 'greeting') {
    const r = choose(['こんにちは！今日どうする？','やあ！何か知りたい？','おっす、調べ・雑談どっちがいい？']);
    pushHistory(ctx, 'bot', r); contextMap.set(userId, ctx);
    return { text: r, meta: { mode: 'greeting' } };
  }
  if (intent === 'thanks') {
    const r = choose(['どういたしまして！','いつでも聞いてね。']);
    pushHistory(ctx, 'bot', r); contextMap.set(userId, ctx);
    return { text: r, meta: { mode: 'thanks' } };
  }

  if (intent === 'joke') {
    const j = await getJoke();
    if (j) { pushHistory(ctx, 'bot', j.text); contextMap.set(userId, ctx); return { text: j.text, meta: { source: j.source } }; }
  }
  if (intent === 'advice') {
    const a = await getAdvice();
    if (a) { pushHistory(ctx, 'bot', a.text); contextMap.set(userId, ctx); return { text: a.text, meta: { source: a.source } }; }
  }

  let tokens = [];
  if (tokenizer) {
    try { tokens = tokenizer.tokenize(userMessage); } catch (e) { /* ignore */ }
  }
  const extractedKeywords = getCompoundKeywordsFromTokens(tokens).filter(k => k.length > 1);

  // 検索クエリの優先順位リスト
  const searchQueries = [];
  const coref = resolveCoref(userMessage, ctx);
  if (coref) {
      const corefQuery = `${coref} ${extractedKeywords.join(' ')}`.trim();
      searchQueries.push(corefQuery);
  }
  searchQueries.push(userMessage);
  if (extractedKeywords.length > 0) {
    searchQueries.push(extractedKeywords.join(' '));
  }
  searchQueries.push(...extractedKeywords);
  const uniqueQueries = [...new Set(searchQueries)].filter(q => q.length > 0);

  // 意図に応じたAPIの優先順位付け
  if (intent === 'recipe') {
    const recipeQuery = uniqueQueries.find(q => !/(作り方|レシピ|材料|献立|調理法|料理|ご飯|メニュー|食べ物)/.test(q)) || userMessage;
    const recipeResult = await trySpoonacular(recipeQuery);
    if (recipeResult) {
      const reply = `${recipeResult.text} ${choose(['このレシピはいかがでしたか？','他にお探しのレシピはありますか？','どうぞお試しください！'])}`;
      pushHistory(ctx, 'bot', reply); contextMap.set(userId, ctx);
      return { text: reply, meta: { source: 'spoonacular', title: recipeResult.title } };
    }
  }

  if (intent === 'math') {
    const mathResult = await tryWolframAlpha(userMessage);
    if (mathResult) {
      const reply = `計算結果は以下の通りです： ${mathResult.text} ${choose(['他に計算することはありますか？', 'いかがでしたか？'])}`;
      pushHistory(ctx, 'bot', reply); contextMap.set(userId, ctx);
      return { text: reply, meta: { source: 'wolframalpha' } };
    }
  }
  
  if (intent === 'weather') {
    for (const q of uniqueQueries) {
      const w = await getWeatherForPlace(q);
      if (w) {
        ctx.lastKeyword = q;
        ctx.lastEntities.unshift({ title: q, ts: now });
        if (ctx.lastEntities.length > 10) ctx.lastEntities.pop();
        const reply = `${w.text} ${choose(['他に何か知りたい？','お出かけの予定はありますか？'])}`;
        pushHistory(ctx, 'bot', reply); contextMap.set(userId, ctx);
        return { text: reply, meta: { source: w.source, usedKeyword: q } };
      }
    }
  }

  // 汎用的な情報検索
  for (const q of uniqueQueries) {
    const wiki = await tryWikipedia(q);
    if (wiki) {
      ctx.lastKeyword = q;
      ctx.lastEntities.unshift({ title: wiki.title, ts: now });
      if (ctx.lastEntities.length > 10) ctx.lastEntities.pop();
      const reply = `お調べしました：「${wiki.title}」 — ${wiki.text}。${choose(['他に知りたいことはありますか？', 'この情報でよろしいでしょうか？'])}`;
      pushHistory(ctx, 'bot', reply); contextMap.set(userId, ctx);
      return { text: reply, meta: { source: wiki.source, title: wiki.title, usedQuery: q } };
    }

    const ddg = await tryDuckDuckGo(q);
    if (ddg) {
      ctx.lastKeyword = q;
      ctx.lastEntities.unshift({ title: ddg.title, ts: now });
      if (ctx.lastEntities.length > 10) ctx.lastEntities.pop();
      const reply = `ちょっと調べたら、「${ddg.title}」に関する情報が見つかりました：${ddg.text}。${choose(['どうでしょうか？', 'お役に立てると嬉しいです。'])}`;
      pushHistory(ctx, 'bot', reply); contextMap.set(userId, ctx);
      return { text: reply, meta: { source: ddg.source, title: ddg.title, usedQuery: q } };
    }
  }

  // どの検索も失敗した場合
  const failReply = smalltalk('search_fail') + ' ' + choose(['質問の内容を変えていただけますか？', '何か別のことをお手伝いしましょうか？']);
  pushHistory(ctx, 'bot', failReply); contextMap.set(userId, ctx);
  return { text: failReply, meta: { mode: 'search_fail', keywords: extractedKeywords } };
}

// --- 変更なしの既存部分 ---
function isEchoMessage(userId, message){
  if (!message) return false;
  const ctx = contextMap.get(userId);
  if (!ctx || !ctx.history || ctx.history.length === 0) return false;
  for (let i = ctx.history.length - 1; i >= 0; i--){
    const item = ctx.history[i];
    if (item.role === 'bot' && item.text) {
      return String(item.text).trim() === String(message).trim();
    }
  }
  return false;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let body = {};
    if (req.method === 'POST') {
      body = typeof req.body === 'object' ? req.body : (req.body ? JSON.parse(req.body) : {});
    }

    let userId = null;
    let message = null;
    let wantInit = false;

    if (req.method === 'POST') {
      userId = body && body.userId ? String(body.userId) : (body && body.user && body.user.id ? String(body.user.id) : 'anon');
      message = (typeof body.message !== 'undefined') ? (body.message === null ? '' : String(body.message)) : null;
      wantInit = !!body.init;
    } else {
      userId = req.query && req.query.userId ? String(req.query.userId) : (req.query && req.query.user ? String(req.query.user) : 'anon');
      message = (typeof req.query.message !== 'undefined') ? String(req.query.message) : (req.query.q || null);
      wantInit = req.query && (req.query.init === '1' || req.query.init === 'true' || req.query.welcome === '1');
    }

    if (!userId) userId = 'anon';

    if (isEchoMessage(userId, message)) {
      console.log('Ignored echo message for userId=', userId);
      const resp = { reply: '', text: '', ignored: true, reason: 'echo' };
      return res.status(200).json(resp);
    }

    if (wantInit) {
      const welcome = '何か質問はありますか？';
      const now = nowTs();
      const ctx = contextMap.get(userId) || { history: [], persona: 'neutral', lastKeyword: null, lastEntities: [], updatedAt: now };
      pushHistory(ctx, 'bot', welcome);
      contextMap.set(userId, ctx);
      return res.status(200).json({ reply: welcome, text: welcome, meta: { welcome: true } });
    }

    if (!message) {
      return res.status(400).json({
        reply: '',
        text: '',
        error: 'message (or q) is required. To get welcome, provide init=true or send a message.'
      });
    }

    const start = Date.now();
    const result = await getBotResponse(userId, message, { persona: req.query && req.query.persona ? req.query.persona : undefined });
    const took = Date.now() - start;
    const replyText = result && result.text ? result.text : 'すみません、応答できませんでした。';
    const responseBody = {
      reply: replyText,
      text: replyText,
      meta: result && result.meta ? result.meta : {},
      took_ms: took
    };
    return res.status(200).json(responseBody);

  } catch (err) {
    console.error('handler error', err && err.stack ? err.stack : err);
    return res.status(500).json({ reply: '', text: '', error: 'Internal Server Error', detail: err && err.message ? err.message : String(err) });
  }
};
