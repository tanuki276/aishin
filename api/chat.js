const path = require('path');
const fs = require('fs');

// --- data.json から知識ベースを読み込む ---
const dataPath = path.join(__dirname, 'data.json');
let botData = { inferencePatterns: [] };
try {
  const rawData = fs.readFileSync(dataPath, 'utf8');
  botData = JSON.parse(rawData);
} catch (error) {
  console.error('Failed to load data.json:', error.message);
}
// ----------------------------------------

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
      console.warn('fetch not available: network calls will fail unless global.fetch/node-fetch/undici present.');
      fetchImpl = null;
    }
  }
}

// ---- kuromoji 初期化（node_modules の dict を使う） ----
const kuromoji = require('kuromoji');
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

// ---- コンテキスト/履歴（メモリ） ----
const contextMap = new Map();
const MAX_HISTORY = 80;
const CONTEXT_TTL_MS = 1000 * 60 * 15; 

function nowTs(){ return Date.now(); }
function pushHistory(ctx, role, text){
  ctx.history.push({ role, text, ts: nowTs() });
  if (ctx.history.length > MAX_HISTORY) ctx.history.shift();
  ctx.updatedAt = nowTs();
}
function choose(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

// ---- インテント判定 ----
function detectIntent(text){
  if (!text) return 'unknown';
  if (/^(おはよう|こんにちは|こんばんは|やあ|もしもし|おっす)/.test(text)) return 'greeting';
  if (/ありがとう|助かった|感謝/.test(text)) return 'thanks';
  if (/(天気|気温|降水|雨|晴れ)/.test(text)) return 'weather';
  if (/(ジョーク|冗談|ギャグ|おもしろ|笑わせて|ネタ)/.test(text)) return 'joke';
  if (/助言|アドバイス|どうすれば|どうしたら/.test(text)) return 'advice';
  if (/\?|\？/.test(text)) return 'question';
  return 'unknown';
}

// ---- 形態素/キーワード抽出（簡易） ----
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
    const isAllowed = (isNoun || isKatakana || isAlphaNum || isProper);
    if (isAllowed) buf.push(sf);
    else pushBuf();
  }
  pushBuf();
  return Array.from(new Set(keywords.filter(k => k.length > 1))).sort((a, b) => b.length - a.length);
}

// ---- DuckDuckGo Instant Answer ----
async function tryDuckDuckGo(q){
  if (!fetchImpl || !q) return null;
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1&t=user`;
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const j = await res.json();
    if (j && j.AbstractText && j.AbstractText.length) {
      const txt = j.AbstractText.length > 600 ? j.AbstractText.substring(0,600)+'...' : j.AbstractText;
      return { source: 'duckduckgo', title: j.Heading || q, text: txt };
    }
  } catch (err) {
    // ignore
  }
  return null;
}

// ---- プロパティ抽出（思考の心臓部） ----
function extractProperties(text) {
  const properties = [];
  if (/(近接|近距離)/.test(text)) properties.push('近接');
  if (/(高高度|上空|航空機|飛行機)/.test(text)) properties.push('高高度');
  if (/(平地|平野|温暖|熱帯)/.test(text)) properties.push('平地');
  if (/(高山|山岳|極地|深海|特殊環境)/.test(text)) properties.push('高山');
  if (/(作用|原因|影響)/.test(text)) properties.push('原因');
  if (/(反応|変化|結果)/.test(text)) properties.push('結果');
  if (/(矛盾|対立|対義)/.test(text)) properties.push('矛盾');
  if (/(類似|同じ|比較|共通)/.test(text)) properties.push('類似');
  if (/(歴史|功績|時代|出来事)/.test(text)) properties.push('歴史');
  return properties;
}

// ---- 推論・生成ロジック ----
async function searchAndInfer(keywords){
  if (!keywords || keywords.length < 2) return null;

  const subjectName = keywords[0];
  const objectName = keywords[1];

  const subjectSearch = await tryDuckDuckGo(subjectName);
  const objectSearch = await tryDuckDuckGo(objectName);
  
  if (!subjectSearch || !objectSearch) {
    return null;
  }

  const subjectProperties = extractProperties(subjectSearch.text);
  const objectProperties = extractProperties(objectSearch.text);

  if (subjectProperties.length > 0 && objectProperties.length > 0) {
    for (const pattern of botData.inferencePatterns) {
      const subjectMatch = pattern.conditions[0].keyword1_properties.some(prop => subjectProperties.includes(prop));
      const objectMatch = pattern.conditions[1].keyword2_properties.some(prop => objectProperties.includes(prop));
      
      if (subjectMatch && objectMatch) {
        const template = choose(pattern.responseTemplates);
        const responseText = template
          .replace('{{keyword1}}', subjectName)
          .replace('{{keyword2}}', objectName)
          .replace('{{keyword1_reason}}', subjectSearch.text)
          .replace('{{keyword2_reason}}', objectSearch.text)
          .replace('{{reason}}', pattern.negation_reason || ''); // テンプレートによっては理由を直接挿入

        return { text: responseText, meta: { rule: pattern.name } };
      }
    }
  }

  return null;
}

// ---- 応答ロジック（修正済み） ----
async function getBotResponse(userId, userMessage, opts = {}){
  await initTokenizer;

  const now = nowTs();
  let ctx = contextMap.get(userId);
  if (!ctx || (now - (ctx.updatedAt || 0) > CONTEXT_TTL_MS)) {
    ctx = { history: [], persona: opts.persona || 'neutral', lastKeyword: null, lastEntities: [], updatedAt: now };
  }
  pushHistory(ctx, 'user', userMessage);

  const intent = detectIntent(userMessage);

  let tokens = [];
  if (tokenizer) {
    try { tokens = tokenizer.tokenize(userMessage); } catch (e) { console.warn('tokenize failed', e && e.message ? e.message : e); }
  }

  const extracted = getCompoundKeywordsFromTokens(tokens);

  // 新しい推論ロジックを優先して実行
  const inferResult = await searchAndInfer(extracted);
  if (inferResult) {
    pushHistory(ctx, 'bot', inferResult.text);
    contextMap.set(userId, ctx);
    return { text: inferResult.text, meta: inferResult.meta };
  }
  
  // 従来のキーワード検索ロジック (単一キーワード)
  for (const cand of extracted) {
    if (!cand || String(cand).trim().length === 0) continue;
    const ddg = await tryDuckDuckGo(cand);
    if (ddg) {
      ctx.lastKeyword = cand;
      const reply = `ちょっと調べたら：「${ddg.title}」 — ${ddg.text}。何か他に知りたい？`;
      pushHistory(ctx, 'bot', reply); contextMap.set(userId, ctx);
      return { text: reply, meta: { source: ddg.source, title: ddg.title } };
    }
  }

  // 質問に対する汎用的なフォールバック
  if (intent === 'question' || /どう|なぜ|なに|どの|いつ|どこ/.test(userMessage)) {
    const fallbackQ = choose([
      'いい質問だね…少し考えさせて。',
      'その点については色々な見方があるよ。具体的にはどの部分が気になる？'
    ]);
    pushHistory(ctx, 'bot', fallbackQ); contextMap.set(userId, ctx);
    return { text: fallbackQ, meta: { mode: 'clarify' } };
  }

  // smalltalk
  const persona = ctx.persona || 'neutral';
  const s = choose(['ふむ、なるほどね。','へえ、そうなんだ！','面白いね、もっと聞かせて？','いいね、その話。']);
  pushHistory(ctx, 'bot', s); contextMap.set(userId, ctx);
  return { text: s, meta: { mode: 'smalltalk', persona } };
}

// ---- HTTP handler (Vercel) ----
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
