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

// 意図検出をより詳細に
function detectIntent(text){
  if (!text) return 'unknown';
  if (/^(おはよう|こんにちは|こんばんは|やあ|もしもし|おっす)/.test(text)) return 'greeting';
  if (/ありがとう|助かった|感謝|どうも/.test(text)) return 'thanks';
  if (/(天気|気温|降水|雨|晴れ|雪|台風|予報)/.test(text)) return 'weather';
  if (/(ジョーク|冗談|ギャグ|おもしろ|笑わせて|ネタ)/.test(text)) return 'joke';
  if (/助言|アドバイス|どうすれば|どうしたら|相談/.test(text)) return 'advice';
  if (/(作り方|レシピ|材料|献立|調理法|料理|食べ物|作り方)/.test(text)) return 'recipe';
  if (/[+\-*/^=]/.test(text) || /(計算|平方根|微分|積分|方程式|解)/.test(text)) return 'math';
  if (/どっち|どっちが|違い/.test(text)) return 'comparison';
  if (/じゃない|ではない|ない/.test(text)) return 'negation';
  if (/(どこ|場所|位置|住所)/.test(text)) return 'location';
  if (/(何|いつ|誰|なぜ|どう|どのように|〜とは|〜って)/.test(text) || /\?|\？/.test(text)) return 'question';
  if (/(イギリス|英国|ベトナム|インドシナ)/.test(text) || (text.length <= 4 && /[A-Za-z]+/.test(text))) return 'named_entity_query';
  return 'unknown';
}

// 複合キーワード生成を高度化
function getCompoundKeywordsFromTokens(tokens){
  const keywords = [];
  let buf = [];
  const pushBuf = ()=>{ if (buf.length){ keywords.push(buf.join('')); buf = []; } };
  for (const t of tokens){
    const sf = t.surface_form || '';
    const pos = t.pos;
    const pos_detail_1 = t.pos_detail_1;

    // 名詞、固有名詞、形容詞、動詞の語幹を抽出対象とする
    const isNoun = pos === '名詞';
    const isProper = pos_detail_1 === '固有名詞';
    const isKatakana = pos === '名詞' && pos_detail_1 === '固有名詞' && /^[\u30A0-\u30FF]+$/.test(sf);
    const isAdjective = pos === '形容詞';
    const isVerb = pos === '動詞';
    const isAllowed = isNoun || isProper || isKatakana || isAdjective || (isVerb && t.conjugated_form === '基本形');

    // 助詞の「の」「は」「と」は結合する
    const isConnectingParticle = pos === '助詞' && (sf === 'の' || sf === 'は' || sf === 'と');

    if (isAllowed || isConnectingParticle) {
      buf.push(sf);
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
  const hasPronoun = pronouns.some(p => text.includes(p));

  // 特定のパターン（「この料理は」など）を解決
  const m = text.match(/(この|その|あの|これらの|それらの)([^\s　]+)/);
  if (m){
    const noun = m[2];
    if (ctx && ctx.lastEntities && ctx.lastEntities.length){
      for (const e of ctx.lastEntities) if (e.title.includes(noun) || e.title === noun) return e.title;
    }
    return noun;
  }
  
  // 直前の発言が「はい」や「いいえ」だった場合、一つ前の文脈を考慮
  if ((text === 'はい' || text === 'いいえ' || text === 'そう') && ctx && ctx.history.length >= 2) {
    const lastBotReply = ctx.history[ctx.history.length-2];
    const lastUserQuery = ctx.history[ctx.history.length-1];
    const botTokens = tokenizer.tokenize(lastBotReply.text);
    const userTokens = tokenizer.tokenize(lastUserQuery.text);
    const botKeywords = getCompoundKeywordsFromTokens(botTokens);
    const userKeywords = getCompoundKeywordsFromTokens(userTokens);
    if(botKeywords.length > 0) return botKeywords[0];
    if(userKeywords.length > 0) return userKeywords[0];
  }

  // 汎用的なコア参照解決
  if (hasPronoun && ctx && ctx.lastEntities && ctx.lastEntities.length) {
    return ctx.lastEntities[0].title;
  }
  
  // 最後に抽出されたキーワードを返す
  if (hasPronoun && ctx && ctx.lastKeyword) {
    return ctx.lastKeyword;
  }

  return null;
}

// 複数APIを賢く使うための変更
async function getBotResponse(userId, userMessage, opts = {}){
  await initTokenizer;

  const now = nowTs();
  let ctx = contextMap.get(userId);
  if (!ctx || (now - (ctx.updatedAt || 0) > CONTEXT_TTL_MS)) {
    ctx = { history: [], persona: opts.persona || 'neutral', lastKeyword: null, lastEntities: [], updatedAt: now };
  }

  // 新しい話題を検出し、コンテキストをリセット
  let isNewTopic = false;
  if (ctx.lastKeyword) {
    let currentKeywords = getCompoundKeywordsFromTokens(tokenizer.tokenize(userMessage));
    const isSimilar = currentKeywords.some(k => ctx.lastKeyword.includes(k) || k.includes(ctx.lastKeyword));
    if (!isSimilar && !detectIntent(userMessage).includes('question')) {
      isNewTopic = true;
    }
  }
  if (isNewTopic) {
      console.log('Detected new topic. Resetting context for userId=', userId);
      ctx = { history: [], persona: opts.persona || 'neutral', lastKeyword: null, lastEntities: [], updatedAt: now };
  }

  pushHistory(ctx, 'user', userMessage);
  const intent = detectIntent(userMessage);

  // 挨拶、感謝、ジョーク、助言は優先して処理
  if (intent === 'greeting') { /* ... 既存ロジック ... */ }
  if (intent === 'thanks') { /* ... 既存ロジック ... */ }
  if (intent === 'joke') { /* ... 既存ロジック ... */ }
  if (intent === 'advice') { /* ... 既存ロジック ... */ }

  const tokens = tokenizer ? tokenizer.tokenize(userMessage) : [];
  const extractedKeywords = getCompoundKeywordsFromTokens(tokens);

  // 検索クエリの生成ロジックを強化
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

  // インテントに応じたAPIの優先順位付け
  if (intent === 'recipe') {
    const query = uniqueQueries.find(q => !/(作り方|レシピ|材料|献立|調理法)/.test(q)) || uniqueQueries[0];
    const recipeResult = await trySpoonacular(query);
    if (recipeResult) { /* ... 既存ロジック ... */ }
  }

  if (intent === 'math') {
    const mathResult = await tryWolframAlpha(userMessage);
    if (mathResult) { /* ... 既存ロジック ... */ }
  }
  
  if (intent === 'weather') {
    for (const q of uniqueQueries) {
      const w = await getWeatherForPlace(q);
      if (w) { /* ... 既存ロジック ... */ }
    }
  }

  // 汎用的な情報検索
  for (const q of uniqueQueries) {
    const wiki = await tryWikipedia(q);
    if (wiki) {
      ctx.lastKeyword = q;
      ctx.lastEntities.unshift({ title: wiki.title, ts: now });
      if (ctx.lastEntities.length > 10) ctx.lastEntities.pop();
      const reply = `お調べしました：「${wiki.title}」 — ${wiki.text}。他に知りたいことはありますか？`;
      pushHistory(ctx, 'bot', reply); contextMap.set(userId, ctx);
      return { text: reply, meta: { source: wiki.source, title: wiki.title, usedQuery: q } };
    }

    const ddg = await tryDuckDuckGo(q);
    if (ddg) {
      ctx.lastKeyword = q;
      ctx.lastEntities.unshift({ title: ddg.title, ts: now });
      if (ctx.lastEntities.length > 10) ctx.lastEntities.pop();
      const reply = `ちょっと調べたら、「${ddg.title}」に関する情報が見つかりました：${ddg.text}。どうでしょうか？`;
      pushHistory(ctx, 'bot', reply); contextMap.set(userId, ctx);
      return { text: reply, meta: { source: ddg.source, title: ddg.title, usedQuery: q } };
    }
  }

  // どの検索も失敗した場合
  if (extractedKeywords.length > 0) {
    const keywords = extractedKeywords.join('、');
    const reply = `すみません、「${keywords}」に関する情報をうまく見つけることができませんでした。質問の内容を変えていただけますか？`;
    pushHistory(ctx, 'bot', reply); contextMap.set(userId, ctx);
    return { text: reply, meta: { mode: 'search_fail', keywords: extractedKeywords } };
  }

  const persona = ctx.persona || 'neutral';
  const s = smalltalk(persona);
  pushHistory(ctx, 'bot', s); contextMap.set(userId, ctx);
  return { text: s, meta: { mode: 'smalltalk', persona } };
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
