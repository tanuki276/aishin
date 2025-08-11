
//  - 初回ウェルカムを返す init フラグを追加（?init=1 または POST { "init": true }）

const path = require('path');
const fs = require('fs');

// ---- fetch フォールバック ----
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
      console.warn('fetch not available: network calls will fail unless global.fetch / node-fetch / undici present.');
      fetchImpl = null;
    }
  }
}

// ---- kuromoji 初期化（node_modules の dict を使う） ----
const kuromoji = require('kuromoji');
let tokenizer = null;
const initTokenizer = (async () => {
  try {
    const dictPath = path.join(
      path.dirname(require.resolve('kuromoji')),
      '..',
      'dict'
    );
    await new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath: dictPath }).build((err, built) => {
        if (err) return reject(err);
        tokenizer = built;
        console.log('Kuromoji ready (dictPath=', dictPath, ')');
        resolve();
      });
    });
  } catch (err) {
    console.error('initTokenizer error:', err);
    // tokenizer stays null but we don't throw here to allow degraded service
  }
})();

// ---- コンテキスト/履歴 ----
const contextMap = new Map();
const MAX_HISTORY = 80;
const CONTEXT_TTL_MS = 1000 * 60 * 60 * 6; // 6時間

function nowTs(){ return Date.now(); }
function pushHistory(ctx, role, text){
  ctx.history.push({ role, text, ts: nowTs() });
  if (ctx.history.length > MAX_HISTORY) ctx.history.shift();
  ctx.updatedAt = nowTs();
}
function choose(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

// ---- 実用的なインテント判定 ----
function detectIntent(text){
  if (!text) return 'unknown';
  if (/^(おはよう|こんにちは|こんばんは|やあ|もしもし|おっす)/.test(text)) return 'greeting';
  if (/ありがとう|助かった|感謝/.test(text)) return 'thanks';
  if (/(天気|気温|降水|雨|晴れ)/.test(text)) return 'weather';
  if (/ジョーク|おもしろ|笑わせて|ネタ/.test(text)) return 'joke';
  if (/助言|アドバイス|どうすれば|どうしたら/.test(text)) return 'advice';
  if (/\?|\？|かな|かも|だろう/.test(text)) return 'question';
  return 'unknown';
}

// ---- 形態素処理から複合キーワード抽出 ----
function getCompoundKeywordsFromTokens(tokens){
  const keywords = [];
  let buf = [];
  const pushBuf = ()=>{ if (buf.length){ keywords.push(buf.join('')); buf = []; } };
  for (const t of tokens){
    const sf = t.surface_form || '';
    const isNoun = t.pos === '名詞';
    const isProper = t.pos_detail_1 === '固有名詞';
    const isKatakana = /^[\u30A0-\u30FF]+$/.test(sf);
    const isAlphaNum = /^[A-Za-z0-9\-\_]+$/.test(sf);
    const isAllowed = (isNoun || isKatakana || isAlphaNum || isProper) && t.pos_detail_1 !== '代名詞';
    if (isAllowed) buf.push(sf);
    else pushBuf();
  }
  pushBuf();
  return Array.from(new Set(keywords)).sort((a,b)=>b.length-b.length);
}

// ---- コア参照（簡易） ----
function resolveCoref(text, ctx){
  if (!text) return null;
  const pronouns = ['それ','あれ','これ','ここ','そこ','あそこ','この','その','あの'];
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

// ---- Wikipedia (ja) 検索（OpenSearch -> summary） ----
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
    console.warn('tryWikipedia error', err && err.message);
  }
  return null;
}

// ---- DuckDuckGo Instant Answer (英語/多言語補助) ----
async function tryDuckDuckGo(q){
  if (!fetchImpl || !q) return null;
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skipsdisambig=1`;
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const j = await res.json();
    if (j.AbstractText && j.AbstractText.length) {
      const txt = j.AbstractText.length > 600 ? j.AbstractText.substring(0,600)+'...' : j.AbstractText;
      return { source: 'duckduckgo', title: j.Heading || q, text: txt };
    }
  } catch (err) {
    // ignore
  }
  return null;
}

// ---- ジョーク（Official Joke API） ----
async function getJoke(){
  if (!fetchImpl) return null;
  try {
    const res = await fetchImpl('https://official-joke-api.appspot.com/random_joke');
    if (!res.ok) return null;
    const j = await res.json();
    if (j && j.setup) return { source: 'joke', text: `${j.setup} — ${j.punchline || ''}`.trim() };
  } catch(e){ }
  try {
    const r2 = await fetchImpl('https://api.adviceslip.com/advice');
    if (r2.ok){
      const a = await r2.json();
      if (a && a.slip && a.slip.advice) return { source: 'advice-slip', text: a.slip.advice };
    }
  } catch(e){}
  return null;
}

// ---- アドバイス（Advice Slip） ----
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

// ---- 天気（Nominatim + Open-Meteo） ----
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
      const text = `${display} の現在の天気: ${cw.weathercode || ''}、気温 ${cw.temperature}°C、風速 ${cw.windspeed} m/s（取得元: Open-Meteo）`;
      return { source: 'open-meteo', text, meta: { lat, lon } };
    }
  } catch(e){ console.warn('getWeatherForPlace error', e && e.message); }
  return null;
}

// ---- 雑談・トーン ----
const smalltalkPools = {
  neutral: [
    'ふむ、なるほどね。',
    'へえ、そうなんだ！',
    '面白いね。もっと聞かせて？',
    'いいね、その話。'
  ],
  snarky: [
    'そう？でも本気で言ってるの？',
    'おや、それは意外（としか言えない）',
    'ふーん、君は勇気あるね。'
  ],
  kind: [
    'いいね、よくやったね。',
    '素敵な話だね。ありがとう。',
    'そういうの聞けて嬉しいよ。'
  ]
};
function smalltalk(mode='neutral'){ return choose(smalltalkPools[mode]||smalltalkPools.neutral); }

// ---- メイン応答ロジック ----
async function getBotResponse(userId, userMessage, opts = {}){
  await initTokenizer; // ensure tokenizer init attempted

  // context
  const now = nowTs();
  let ctx = contextMap.get(userId);
  if (!ctx || (now - (ctx.updatedAt || 0) > CONTEXT_TTL_MS)) {
    ctx = { history: [], persona: opts.persona || 'neutral', lastKeyword: null, lastEntities: [], updatedAt: now };
  }
  pushHistory(ctx, 'user', userMessage);

  // quick intents
  const intent = detectIntent(userMessage);

  if (intent === 'greeting'){
    const r = choose(['こんにちは！今日どうする？','やあ！何か知りたい？','おっす、調べ・雑談どっちがいい？']);
    pushHistory(ctx, 'bot', r); contextMap.set(userId, ctx); return { text: r, meta:{mode:'greeting'} };
  }
  if (intent === 'thanks'){
    const r = choose(['どういたしまして！','いつでも聞いてね。']);
    pushHistory(ctx, 'bot', r); contextMap.set(userId, ctx); return { text: r, meta:{mode:'thanks'} };
  }

  // tokenize
  let tokens = [];
  if (tokenizer){
    try { tokens = tokenizer.tokenize(userMessage); } catch(e){ console.warn('tokenize failed', e && e.message); }
  }

  const coref = resolveCoref(userMessage, ctx);
  const extracted = getCompoundKeywordsFromTokens(tokens);
  const candidates = [];
  if (coref) candidates.push(coref);
  for (const k of extracted) if (!candidates.includes(k)) candidates.push(k);
  if (ctx.lastEntities && ctx.lastEntities.length){
    for (const e of ctx.lastEntities) if (!candidates.includes(e.title)) candidates.push(e.title);
  }

  console.log('[getBotResponse] userId=', userId, 'intent=', intent, 'candidates=', candidates);

  // 1) 天気要求
  if (intent === 'weather' || /天気|気温|雨|晴れ|降水/.test(userMessage)){
    for (const cand of candidates){
      if (!cand) continue;
      const w = await getWeatherForPlace(cand);
      if (w){
        ctx.lastKeyword = cand;
        ctx.lastEntities.unshift({ title: cand, ts: now });
        if (ctx.lastEntities.length>10) ctx.lastEntities.pop();
        const reply = w.text + ' 何か他に知りたい？';
        pushHistory(ctx, 'bot', reply);
        contextMap.set(userId, ctx);
        return { text: reply, meta: {source:w.source, usedKeyword:cand} };
      }
    }
    const placeMatch = userMessage.match(/([^\s　]+市|都|道|府|県|町|村|区|東京|大阪|京都)/);
    if (placeMatch){
      const w2 = await getWeatherForPlace(placeMatch[0]);
      if (w2){
        const reply = w2.text + ' 何か他に知りたい？';
        pushHistory(ctx,'bot',reply); contextMap.set(userId,ctx);
        return { text: reply, meta: {source:w2.source, usedKeyword:placeMatch[0]} };
      }
    }
    const r = 'ごめん、場所の特定ができなかったか、天気情報を取得できませんでした。地名を教えてもらえる？';
    pushHistory(ctx,'bot',r); contextMap.set(userId, ctx);
    return { text: r, meta: { mode: 'weather-failed' } };
  }

  // 2) ジョーク / 励まし / アドバイス系
  if (intent === 'joke'){
    const j = await getJoke();
    if (j){ pushHistory(ctx,'bot',j.text); contextMap.set(userId,ctx); return { text: j.text, meta:{source:j.source} }; }
  }
  if (intent === 'advice'){
    const a = await getAdvice();
    if (a){ pushHistory(ctx,'bot',a.text); contextMap.set(userId,ctx); return { text: a.text, meta:{source:a.source} }; }
  }

  // 3) Wikipedia / DuckDuckGo 検索
  for (const cand of candidates){
    if (!cand || String(cand).trim().length===0) continue;
    const wiki = await tryWikipedia(cand);
    if (wiki){
      ctx.lastKeyword = cand;
      ctx.lastEntities.unshift({ title: wiki.title, ts: now });
      if (ctx.lastEntities.length>10) ctx.lastEntities.pop();
      const reply = `お調べしました：「${wiki.title}」 — ${wiki.text} 他にも知りたい？`;
      pushHistory(ctx,'bot',reply); contextMap.set(userId,ctx);
      return { text: reply, meta: {source: wiki.source, title: wiki.title} };
    }
    const ddg = await tryDuckDuckGo(cand);
    if (ddg){
      ctx.lastKeyword = cand;
      ctx.lastEntities.unshift({ title: ddg.title, ts: now });
      if (ctx.lastEntities.length>10) ctx.lastEntities.pop();
      const reply = `ちょっと調べたら：「${ddg.title}」 — ${ddg.text}。どうする？`;
      pushHistory(ctx,'bot',reply); contextMap.set(userId,ctx);
      return { text: reply, meta: {source: ddg.source, title: ddg.title} };
    }
  }

  // 4) 質問っぽいなら一般応答
  if (intent === 'question' || /どう|なぜ|なに|どの|いつ|どこ/.test(userMessage)){
    const ddgWhole = await tryDuckDuckGo(userMessage);
    if (ddgWhole){
      const r = `${ddgWhole.title} に関する情報です： ${ddgWhole.text} もっと詳しく？`;
      pushHistory(ctx,'bot',r); contextMap.set(userId,ctx);
      return { text: r, meta:{source: ddgWhole.source} };
    }
    const fallbackQ = choose([
      'いい質問だね…少し考えさせて。',
      'その点については色々な見方があるよ。具体的にはどの部分が気になる？',
      'なるほど、もう少し背景を教えてくれる？'
    ]);
    pushHistory(ctx,'bot',fallbackQ); contextMap.set(userId,ctx);
    return { text: fallbackQ, meta:{mode:'clarify'} };
  }

  // 5) 雑談（最後の砦）
  const persona = ctx.persona || 'neutral';
  const s = smalltalk(persona);
  pushHistory(ctx,'bot',s); contextMap.set(userId,ctx);
  return { text: s, meta:{mode:'smalltalk', persona} };
}

// ---- helper: 受信メッセージが直近のbotの発話と一致するか（エコー判定） ----
function isEchoMessage(userId, message){
  if (!message) return false;
  const ctx = contextMap.get(userId);
  if (!ctx || !ctx.history || ctx.history.length === 0) return false;
  // find last bot message
  for (let i = ctx.history.length - 1; i >= 0; i--){
    const item = ctx.history[i];
    if (item.role === 'bot' && item.text){
      return String(item.text).trim() === String(message).trim();
    }
  }
  return false;
}

// ---- Vercel / serverless handler ----
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // parse body (if POST)
    let body = {};
    if (req.method === 'POST') {
      body = typeof req.body === 'object' ? req.body : (req.body ? JSON.parse(req.body) : {});
    }

    // accept JSON body (POST) or query param (GET)
    let userId = null;
    let message = null;
    let wantInit = false;

    if (req.method === 'POST') {
      userId = body && body.userId ? String(body.userId) : (body && body.user && body.user.id ? String(body.user.id) : null);
      message = body && (typeof body.message !== 'undefined') ? (body.message === null ? '' : String(body.message)) : null;
      wantInit = !!body.init;
    } else {
      userId = req.query && req.query.userId ? String(req.query.userId) : (req.query && req.query.user ? String(req.query.user) : 'anon');
      message = req.query && (typeof req.query.message !== 'undefined') ? String(req.query.message) : (req.query.q || null);
      wantInit = req.query && (req.query.init === '1' || req.query.init === 'true' || req.query.welcome === '1');
    }

    if (!userId) userId = 'anon';

    // Echo-guard: 受信メッセージが直近のbot発話と同じなら無視する
    if (isEchoMessage(userId, message)) {
      console.log('Ignored echo message for userId=', userId);
      return res.status(200).json({ ignored: true, reason: 'echo' });
    }

    // If client requests initial welcome (init) OR there is no context yet and client asked for welcome,
    // return welcome message "何か質問はありますか？"
    const existingCtx = contextMap.get(userId);
    if (wantInit || (!existingCtx || !existingCtx.history || existingCtx.history.length === 0) && wantInit) {
      const welcome = '何か質問はありますか？';
      const now = nowTs();
      const ctx = existingCtx || { history: [], persona: 'neutral', lastKeyword: null, lastEntities: [], updatedAt: now };
      pushHistory(ctx, 'bot', welcome);
      contextMap.set(userId, ctx);
      return res.status(200).json({ reply: welcome, meta: { welcome: true } });
    }

    // if no message provided (and not init), complain
    if (!message) return res.status(400).json({ error: 'message (or q) is required. To get welcome