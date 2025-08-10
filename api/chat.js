const path = require('path');
const fs = require('fs');

let fetchImpl = global.fetch;
if (!fetchImpl) {
  try {
    fetchImpl = require('node-fetch');
  } catch (e) {
    console.warn('global.fetch not found and node-fetch not installed. External fetch will fail.');
  }
}

const kuromoji = require('kuromoji');
let tokenizer = null;
let initTokenizer = (async () => {
  try {
    const dictPath = path.join(__dirname, 'dict');
    if (!fs.existsSync(dictPath)) {
      console.warn('Warning: kuromoji dict folder not found at', dictPath);
    }
    await new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath: dictPath }).build((err, built) => {
        if (err) {
          console.error('Kuromoji init failed:', err);
          reject(err);
          return;
        }
        tokenizer = built;
        console.log('Kuromoji ready');
        resolve();
      });
    });
  } catch (err) {
    console.error('initTokenizer error:', err);
    throw err;
  }
})();

const contextMap = new Map();
const MAX_HISTORY = 40;
const CONTEXT_TTL_MS = 1000 * 60 * 60 * 3;

function nowTs() { return Date.now(); }

function pushHistory(ctx, role, text) {
  ctx.history.push({ role, text, ts: nowTs() });
  if (ctx.history.length > MAX_HISTORY) ctx.history.shift();
  ctx.updatedAt = nowTs();
}

function choose(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function detectIntent(text) {
  if (!text) return 'unknown';
  const t = text.toLowerCase();
  if (['こんにちは','こんばんは','おはよう','やあ','おっす'].some(w => text.includes(w))) return 'greeting';
  if (['ありがとう','感謝','助かった','サンキュー','thanks'].some(w => t.includes(w))) return 'thanks';
  if (/^(hi|hello|hey)\b/.test(t)) return 'greeting';
  return 'unknown';
}

function getCompoundKeywordsFromTokens(tokens) {
  const keywords = [];
  let buf = [];
  const pushBuf = () => { if (buf.length) { keywords.push(buf.join('')); buf = []; } };

  for (const t of tokens) {
    const sf = t.surface_form || '';
    const isNoun = t.pos === '名詞';
    const isProper = t.pos_detail_1 === '固有名詞';
    const isKatakana = /^[\u30A0-\u30FF]+$/.test(sf);
    const isAlphaNum = /^[A-Za-z0-9\-\_]+$/.test(sf);
    const isAllowed = (isNoun || isKatakana || isAlphaNum || isProper) && t.pos_detail_1 !== '代名詞';

    if (isAllowed) {
      buf.push(sf);
    } else {
      pushBuf();
    }
  }
  pushBuf();

  return Array.from(new Set(keywords)).sort((a,b)=>b.length-a.length);
}

function resolveCoref(text, ctx) {
  if (!text) return null;
  const pronouns = ['それ','あれ','これ','ここ','そこ','あそこ','この','その','あの'];
  if (!pronouns.some(p => text.includes(p))) return null;

  const m = text.match(/(この|その|あの)([^\s　]+)/);
  if (m) {
    const noun = m[2];
    if (ctx && ctx.lastEntities && ctx.lastEntities.length) {
      for (const e of ctx.lastEntities) {
        if (e.title.includes(noun) || e.title === noun) return e.title;
      }
    }
    return noun;
  }

  if (ctx && ctx.lastEntities && ctx.lastEntities.length) return ctx.lastEntities[0].title;
  if (ctx && ctx.lastKeyword) return ctx.lastKeyword;
  return null;
}

async function searchWikipediaBestMatch(keyword) {
  if (!fetchImpl) {
    console.error('fetch not available');
    return { found: false };
  }
  try {
    const opensearchUrl = `https://ja.wikipedia.org/w/api.php?action=opensearch&limit=5&format=json&origin=*&search=${encodeURIComponent(keyword)}`;
    const opRes = await fetchImpl(opensearchUrl);
    const opJson = await opRes.json();
    const candidates = (opJson && opJson[1]) ? opJson[1] : [];

    for (const title of candidates) {
      const extractUrl = `https://ja.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&format=json&origin=*&titles=${encodeURIComponent(title)}`;
      const exRes = await fetchImpl(extractUrl);
      const exJson = await exRes.json();
      if (!exJson || !exJson.query || !exJson.query.pages) continue;
      const pages = exJson.query.pages;
      const pageId = Object.keys(pages)[0];
      if (pageId === '-1') continue;
      const page = pages[pageId];
      if (!page || !page.extract) continue;
      return { found: true, title: page.title, extract: page.extract, pageid: pageId };
    }
    return { found: false };
  } catch (err) {
    console.error('searchWikipediaBestMatch error:', err);
    return { found: false, error: err.message || String(err) };
  }
}

function renderReplyFromWiki(title, extract) {
  if (!extract) return null;
  let summary = extract.replace(/\n+/g, ' ').trim();
  const maxLen = 360;
  if (summary.length > maxLen) summary = summary.substring(0, maxLen) + '...';

  const intro = choose([
    `お調べしました：「${title}」についてです。`,
    `はい、「${title}」ですね。概要は次の通りです。`,
    `なるほど、「${title}」についてですね。`
  ]);
  const outro = choose([
    'さらに詳しく知りたいですか？',
    '他にも関連することを調べますか？',
    'ここまでで大丈夫ですか？'
  ]);
  const smalltalk = choose(['','（ちなみに面白い事実として…）','']);

  return `${intro}${summary}${smalltalk} ${outro}`;
}

function getFallbackResponse() {
  return choose([
    'すみません、うまく応答できませんでした。別の言い方で試してもらえますか？',
    'ちょっと情報が見つかりませんでした。もう少し詳しく教えてください。',
    '申し訳ないですが、その内容に関しては今は分かりません。'
  ]);
}

async function getBotResponse(userId, userMessage) {
  try {
    await initTokenizer;
  } catch (err) {
    console.error('Tokenizer init failed in getBotResponse:', err);
    return '申し訳ありません。内部の準備ができていません。';
  }

  if (!tokenizer) {
    console.error('tokenizer is null');
    return '申し訳ありません。形態素解析が利用できません。';
  }

  const now = nowTs();
  let ctx = contextMap.get(userId);
  if (!ctx || (now - (ctx.updatedAt || 0) > CONTEXT_TTL_MS)) {
    ctx = { history: [], lastKeyword: null, lastEntities: [], updatedAt: now };
  }
  pushHistory(ctx, 'user', userMessage);

  const intent = detectIntent(userMessage);
  if (intent === 'greeting') {
    const r = choose(['こんにちは！何を調べる？','やあ、どうしたい？','おっす！教えてください。']);
    pushHistory(ctx, 'bot', r);
    contextMap.set(userId, ctx);
    return r;
  }
  if (intent === 'thanks') {
    const r = choose(['どういたしまして！','また聞いてね。']);
    pushHistory(ctx, 'bot', r);
    contextMap.set(userId, ctx);
    return r;
  }

  let tokens = [];
  try {
    tokens = tokenizer.tokenize(userMessage);
  } catch (e) {
    console.error('tokenize error:', e);
  }

  const coref = resolveCoref(userMessage, ctx);
  const extracted = getCompoundKeywordsFromTokens(tokens);

  const candidates = [];
  if (coref) candidates.push(coref);
  for (const k of extracted) if (!candidates.includes(k)) candidates.push(k);
  if (ctx.lastEntities && ctx.lastEntities.length) {
    for (const e of ctx.lastEntities) if (!candidates.includes(e.title)) candidates.push(e.title);
  }

  console.log('[getBotResponse] userId=', userId, 'candidates=', candidates);

  for (const cand of candidates) {
    if (!cand || String(cand).trim().length === 0) continue;
    try {
      const wiki = await searchWikipediaBestMatch(cand);
      console.log('[getBotResponse] wiki result for', cand, wiki && wiki.found);
      if (wiki && wiki.found) {
        ctx.lastKeyword = cand;
        ctx.lastEntities.unshift({ title: wiki.title, ts: now });
        if (ctx.lastEntities.length > 10) ctx.lastEntities.pop();

        const reply = renderReplyFromWiki(wiki.title, wiki.extract);
        pushHistory(ctx, 'bot', reply);
        contextMap.set(userId, ctx);
        return reply;
      }
    } catch (err) {
      console.error('Error when searching wiki for', cand, err);
    }
  }

  let clarifying = '';
  if (extracted && extracted.length) {
    clarifying = `「${extracted[0]}」についてでしょうか？ もう少し詳しく（例: どの時代の、どの国の、人物ならどの職業の）を教えてください。`;
  } else if (ctx.lastEntities && ctx.lastEntities.length) {
    clarifying = `さっきの「${ctx.lastEntities[0].title}」の続きですか？それとも別の話題に移りますか？`;
  } else {
    clarifying = getFallbackResponse();
  }

  pushHistory(ctx, 'bot', clarifying);
  contextMap.set(userId, ctx);
  return clarifying;
}

const handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { userId, message } = req.body || {};
    if (!userId || !message) {
      return res.status(400).json({ error: 'userId and message are required' });
    }