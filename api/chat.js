const path = require('path');
const fs = require('fs');
const dataPath = path.join(__dirname, 'data.json'); 
let knowledgeBase = {};
try {
  const rawData = fs.readFileSync(dataPath, 'utf8');
  const botData = JSON.parse(rawData);
  knowledgeBase = botData.knowledgeBase || {};
} catch (error) {
  
}

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
      fetchImpl = null;
    }
  }
}

const kuromoji = require('kuromoji');
let tokenizer = null;
const initTokenizer = (async () => {
  try {
    let dictPath;
    try {
      dictPath = path.join(path.dirname(require.resolve('kuromoji')), '..', 'dict');
    } catch (e) {
      dictPath = null;
    }

    await new Promise((resolve, reject) => {
      const builderArgs = dictPath ? { dicPath: dictPath } : {};
      kuromoji.builder(builderArgs).build((err, built) => {
        if (err) {
          return resolve();
        }
        tokenizer = built;
        resolve();
      });
    });
  } catch (err) {
    
  }
})();

const contextMap = new Map();
const MAX_HISTORY = 80;
const CONTEXT_TTL_MS = 1000 * 60 * 15;
function nowTs() { return Date.now(); }
function pushHistory(ctx, role, text) {
  ctx.history.push({ role, text, ts: nowTs() });
  if (ctx.history.length > MAX_HISTORY) ctx.history.shift();
  ctx.updatedAt = nowTs();
}
function choose(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function checkTemporalKeywords(text) {
  if (!text) return { isFuture: false, isCurrent: false };
  if (/(明日|あさって|来週|来月|将来|週間|予報|翌日|以降)/.test(text)) {
    return { isFuture: true, isCurrent: false };
  }
  if (/(現在|今|いま|なう|今日の)/.test(text)) {
    return { isFuture: false, isCurrent: true };
  }
  return { isFuture: false, isCurrent: true };
}

function getCompoundKeywordsFromTokens(tokens) {
  const keywords = [];
  let buf = [];
  const pushBuf = () => { if (buf.length) { keywords.push(buf.join('')); buf = []; } };
  for (const t of tokens || []) {
    const sf = t.surface_form || '';
    const isNoun = t.pos === '名詞';
    const isProper = t.pos_detail_1 === '固有名詞';
    const isKatakana = /^[\u30A0-\u30FF]+$/.test(sf);
    const isAlphaNum = /^[A-Za-z0-9-_]+$/.test(sf);
    const isAllowed = (isNoun || isKatakana || isAlphaNum || isProper) || (t.pos === '接頭詞' && (sf === '第' || sf === '旧'));
    if (isAllowed) buf.push(sf);
    else pushBuf();
  }
  pushBuf();
  return Array.from(new Set(keywords.filter(k => k.length > 1))).sort((a, b) => b.length - a.length);
}

function resolveCoref(text, ctx) {
  if (!text) return null;
  const pronouns = ['それ', 'これ', 'あれ', '彼', '彼女', 'それら', 'あの'];
  if (!pronouns.some(p => text.includes(p))) return null;
  const m = text.match(/(それ|これ|あれ)([^\s、。]+)/);
  if (m) {
    const noun = m[2];
    if (ctx && ctx.lastEntities && ctx.lastEntities.length) {
      for (const e of ctx.lastEntities) if (e.title && (e.title.includes(noun) || e.title === noun)) return e.title;
    }
    return noun;
  }
  if (ctx && ctx.lastEntities && ctx.lastEntities.length) return ctx.lastEntities[0].title;
  if (ctx && ctx.lastKeyword) return ctx.lastKeyword;
  return null;
}

function resolveIntentAndEntities(text, tokens, ctx) {
  const result = {
    intent: 'unknown',
    mainKeyword: null,
    placeEntity: null,
    isQuestion: false
  };
  if (!text) return result;

  if (/^(おは|こんにちは|こんばんは|やあ|hi|hello)/i.test(text)) {
    result.intent = 'greeting';
    return result;
  }
  if (/ありがとう|感謝|thanks/.test(text)) {
    result.intent = 'thanks';
    return result;
  }

  const weatherKeywords = ['天気', '天候', '気温', '雨', '週間', '予報'];
  if (weatherKeywords.some(k => text.includes(k))) {
    const temporal = checkTemporalKeywords(text);
    if (temporal.isFuture) {
        result.intent = 'weather_future';
    } else {
        result.intent = 'weather';
    }
  }

  result.isQuestion = (/[?？]/.test(text) || /何|誰|いつ|どこ|どう|知りたい|教えて/.test(text));

  const extractedKeywords = getCompoundKeywordsFromTokens(tokens);
  
  for (const t of tokens) {
    if (t.pos === '名詞' && (t.pos_detail_1 === '固有名詞' || t.pos_detail_1 === '地域' || t.pos_detail_1 === '国' || t.surface_form.endsWith('市') || t.surface_form.endsWith('府') || t.surface_form.endsWith('県') || t.surface_form.endsWith('町') || t.surface_form.endsWith('村'))) {
      result.placeEntity = t.surface_form;
      break;
    }
  }

  const filteredKeywords = extractedKeywords.filter(k => k.length > 1 && !['あなた', 'それ', 'これ'].includes(k));

  if (filteredKeywords.length > 0) {
    if (result.placeEntity) {
      const nonPlaceKeywords = filteredKeywords.filter(k => k !== result.placeEntity && !weatherKeywords.includes(k));
      result.mainKeyword = nonPlaceKeywords.length > 0 ? nonPlaceKeywords[0] : null;
    } else {
      result.mainKeyword = filteredKeywords[0];
    }
  }

  if (result.intent === 'unknown' && result.isQuestion) {
    result.intent = 'question';
  }

  return result;
}

async function tryWikipedia(keyword) {
  if (!fetchImpl || !keyword) return null;
  try {
    const opUrl = `https://ja.wikipedia.org/w/api.php?action=opensearch&limit=5&format=json&origin=*&search=${encodeURIComponent(keyword)}`;
    const opRes = await fetchImpl(opUrl);
    if (!opRes.ok) return null;
    const opJson = await opRes.json();
    const titles = opJson && opJson[1] ? opJson[1] : [];
    for (const t of titles) {
      const sumUrl = `https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t)}`;
      const sres = await fetchImpl(sumUrl);
      if (!sres.ok) continue;
      const sjson = await sres.json();
      if (sjson && sjson.extract) {
        const text = (sjson.extract.length > 600) ? sjson.extract.substring(0, 600) + '...' : sjson.extract;
        return { source: 'wikipedia', title: sjson.title, text };
      }
    }
  } catch (err) {
    
  }
  return null;
}

async function tryDuckDuckGo(q) {
  if (!fetchImpl || !q) return null;
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const j = await res.json();
    if (j && j.AbstractText && j.AbstractText.length) {
      const txt = j.AbstractText.length > 600 ? j.AbstractText.substring(0, 600) + '...' : j.AbstractText;
      return { source: 'duckduckgo', title: j.Heading || q, text: txt };
    }
  } catch (err) {
    
  }
  return null;
}

async function getJoke() {
  if (!fetchImpl) return null;
  try {
    const res = await fetchImpl('https://official-joke-api.appspot.com/random_joke');
    if (res.ok) {
      const j = await res.json();
      if (j && j.setup) return { source: 'joke', text: `${j.setup} — ${j.punchline || ''}`.trim() };
    }
  } catch (e) {}
  try {
    const r2 = await fetchImpl('https://api.adviceslip.com/advice');
    if (r2.ok) {
      const a = await r2.json();
      if (a && a.slip && a.slip.advice) return { source: 'advice-slip', text: a.slip.advice };
    }
  } catch (e) {}
  return null;
}

async function getAdvice() {
  if (!fetchImpl) return null;
  try {
    const res = await fetchImpl('https://api.adviceslip.com/advice');
    if (!res.ok) return null;
    const j = await res.json();
    if (j && j.slip && j.slip.advice) return { source: 'advice', text: j.slip.advice };
  } catch (e) {
    
  }
  return null;
}

async function getWeatherForPlace(place) {
  if (!fetchImpl || !place) return null;
  try {
    const nomUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(place)}&limit=1`;
    const nom = await fetchImpl(nomUrl, { headers: { 'User-Agent': 'node-chat-bot/1.0' } });
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
      const text = `${display} の現在の天気: code=${cw.weathercode || ''}、気温 ${cw.temperature}℃、風速 ${cw.windspeed} m/s`;
      return { source: 'open-meteo', text, meta: { latitude: lat, longitude: lon } };
    }
  } catch (e) {
    
  }
  return null;
}

const smalltalkPools = {
  neutral: ['ふーん、そうなんだ。','なるほどね。','うん、わかった。'],
  kind: ['いいね、それ。','素敵だよ。']
};
function smalltalk(mode = 'neutral') { return choose(smalltalkPools[mode] || smalltalkPools.neutral); }

async function getBotResponse(userId, userMessage, opts = {}) {
  await initTokenizer;
  const now = nowTs();
  let ctx = contextMap.get(userId);
  if (!ctx || (now - (ctx.updatedAt || 0) > CONTEXT_TTL_MS)) {
    ctx = { history: [], persona: opts.persona || 'neutral', lastKeyword: null, lastEntities: [], updatedAt: now };
  }
  let isNewTopic = false;
  let currentKeywords = [];
  if (tokenizer) {
    try { currentKeywords = getCompoundKeywordsFromTokens(tokenizer.tokenize(userMessage)); } catch (e) { }
  }

  if (ctx.lastKeyword) {
    if (!currentKeywords.some(k => ctx.lastKeyword.includes(k) || k.includes(ctx.lastKeyword))) {
      isNewTopic = true;
    }
  }
  if (isNewTopic) {
    ctx = { history: [], persona: opts.persona || 'neutral', lastKeyword: null, lastEntities: [], updatedAt: now };
  }

  pushHistory(ctx, 'user', userMessage);

  const tokens = tokenizer ? tokenizer.tokenize(userMessage) : [];
  const resolved = resolveIntentAndEntities(userMessage, tokens, ctx);
  const intent = resolved.intent;
  const explicitPlace = resolved.placeEntity;
  const mainKeyword = resolved.mainKeyword;

  const corefKeyword = resolveCoref(userMessage, ctx);

  const candidates = [];
  if (corefKeyword) candidates.push(corefKeyword);
  if (mainKeyword) candidates.push(mainKeyword);
  for (const k of candidates) {
    if (knowledgeBase[k] && !candidates.includes(knowledgeBase[k])) candidates.push(knowledgeBase[k]);
  }
  if (ctx.lastEntities && ctx.lastEntities.length) {
    for (const e of ctx.lastEntities) if (!candidates.includes(e.title)) candidates.push(e.title);
  }

  if (intent === 'greeting') {
    const r = choose(['こんにちは！','やあ。','調子はどうですか？']);
    pushHistory(ctx, 'bot', r); contextMap.set(userId, ctx);
    return { text: r, meta: { mode: 'greeting' } };
  }
  if (intent === 'thanks') {
    const r = choose(['どういたしまして。','お役に立てて光栄です。']);
    pushHistory(ctx, 'bot', r); contextMap.set(userId, ctx);
    return { text: r, meta: { mode: 'thanks' } };
  }

  if (intent === 'weather' || intent === 'weather_future') {
    let placeToSearch = explicitPlace || null;

    if (!placeToSearch) {
      for (const cand of candidates) {
        if (cand && (cand.endsWith('市') || cand.endsWith('府') || cand.endsWith('県') || cand.endsWith('国') || cand.endsWith('町') || cand.endsWith('村'))) {
          placeToSearch = cand;
          break;
        }
      }
    }
    
    if (intent === 'weather_future') {
        const r = `「明日」「週間」などの未来の天気について検索するには、より高度なAPIが必要です。現在は「${placeToSearch || '現在の場所'}」の現在の天気のみ対応しています。`;
        pushHistory(ctx, 'bot', r); contextMap.set(userId, ctx);
        return { text: r, meta: { mode: 'future_weather_limitation' } };
    }


    if (placeToSearch) {
      const w = await getWeatherForPlace(placeToSearch);
      if (w) {
        ctx.lastKeyword = placeToSearch;
        ctx.lastEntities.unshift({ title: placeToSearch, ts: now });
        if (ctx.lastEntities.length > 10) ctx.lastEntities.pop();
        const reply = w.text + ' — 参考情報';
        pushHistory(ctx, 'bot', reply);
        contextMap.set(userId, ctx);
        return { text: reply, meta: { source: w.source, usedKeyword: placeToSearch } };
      }
    }

    const r = 'どの場所の天気が知りたいですか？場所名を入れてください。';
    pushHistory(ctx, 'bot', r); contextMap.set(userId, ctx);
    return { text: r, meta: { mode: 'weather-failed' } };
  }

  if (intent === 'joke') {
    const j = await getJoke();
    if (j) { pushHistory(ctx, 'bot', j.text); contextMap.set(userId, ctx); return { text: j.text, meta: { source: j.source } }; }
  }
  if (intent === 'advice') {
    const a = await getAdvice();
    if (a) { pushHistory(ctx, 'bot', a.text); contextMap.set(userId, ctx); return { text: a.text, meta: { source: a.source } }; }
  }
  
  // 1. 質問全体をDuckDuckGoに投げてみる (複合的な質問への対応を最優先)
  // このブロックが追加・優先されています。
  const ddgWholeQuery = await tryDuckDuckGo(userMessage);
  if (ddgWholeQuery) {
      const r = `${ddgWholeQuery.title} — ${ddgWholeQuery.text}`;
      pushHistory(ctx, 'bot', r); contextMap.set(userId, ctx);
      return { text: r, meta: { source: ddgWholeQuery.source, whole_query: true } };
  }

  // 2. 次に、個別のキーワードを使ってWikipedia/DuckDuckGo検索を試みる
  for (const cand of candidates) {
    if (!cand || String(cand).trim().length === 0) continue;
    const wiki = await tryWikipedia(cand);
    if (wiki) {
      ctx.lastKeyword = cand;
      ctx.lastEntities.unshift({ title: wiki.title, ts: now });
      if (ctx.lastEntities.length > 10) ctx.lastEntities.pop();
      const reply = `${wiki.title} — ${wiki.text}`;
      pushHistory(ctx, 'bot', reply); contextMap.set(userId, ctx);
      return { text: reply, meta: { source: wiki.source, title: wiki.title } };
    }
    const ddg = await tryDuckDuckGo(cand);
    if (ddg) {
      ctx.lastKeyword = cand;
      ctx.lastEntities.unshift({ title: ddg.title, ts: now });
      if (ctx.lastEntities.length > 10) ctx.lastEntities.pop();
      const reply = `${ddg.title} — ${ddg.text}`;
      pushHistory(ctx, 'bot', reply); contextMap.set(userId, ctx);
      return { text: reply, meta: { source: ddg.source, title: ddg.title } };
    }
  }

  if (intent === 'question' || /知りたい|教えて|どうやって/.test(userMessage)) {
    const fallbackQ = choose(['もう少し詳しく言ってくれますか？','それはどういう意味ですか？','要点は何でしょうか？']);
    pushHistory(ctx, 'bot', fallbackQ); contextMap.set(userId, ctx);
    return { text: fallbackQ, meta: { mode: 'clarify' } };
  }

  const persona = opts.persona || 'neutral';
  const s = smalltalk('neutral');
  pushHistory(ctx, 'bot', s); contextMap.set(userId, ctx);
  return { text: s, meta: { mode: 'smalltalk', persona } };
}

function isEchoMessage(userId, message) {
  if (!message) return false;
  const ctx = contextMap.get(userId);
  if (!ctx || !ctx.history || ctx.history.length === 0) return false;
  const normalized = String(message).trim();
  for (let i = ctx.history.length - 1; i >= 0; i--) {
    const item = ctx.history[i];
    if (item.role === 'bot' && item.text) {
      if (String(item.text).trim() === normalized) return true;
    }
  }
  return false;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
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
      return res.status(200).json({ reply: '', text: '', ignore: true, reason: 'echo' });
    }

    if (message === null || typeof message === 'undefined') {
      if (wantInit) {
        const welcome = 'ようこそ。何でも聞いてください。';
        const now = nowTs();
        const ctx = contextMap.get(userId) || { history: [], persona: 'neutral', lastKeyword: null, lastEntities: [], updatedAt: now };
        pushHistory(ctx, 'bot', welcome);
        contextMap.set(userId, ctx);
        return res.status(200).json({ reply: welcome, text: welcome, meta: { welcome: true } });
      }
      return res.status(400).json({ reply: '', text: '', error: 'message (or q) required. To receive welcome set init=true or send a message.' });
    }

    if (wantInit) {
      const welcome = 'ようこそ。何でも聞いてください。';
      const now = nowTs();
      const ctx = contextMap.get(userId) || { history: [], persona: 'neutral', lastKeyword: null, lastEntities: [], updatedAt: now };
      pushHistory(ctx, 'bot', welcome);
      contextMap.set(userId, ctx);
    }

    const start = Date.now();
    const result = await getBotResponse(userId, message, { persona: req.query && req.query.persona ? req.query.persona : undefined });
    const took = Date.now() - start;
    const replyText = result && result.text ? result.text : 'すみません、何か問題が起きたようです。';
    const responseBody = {
      reply: replyText,
      text: replyText,
      meta: result && result.meta ? result.meta : {},
      took_ms: took
    };
    return res.status(200).json(responseBody);

  } catch (err) {
    return res.status(500).json({ reply: '', text: '', error: 'internal server error', detail: err && err.message ? err.message : String(err) });
  }
};
