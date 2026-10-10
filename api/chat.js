const path = require('path');
const fs = require('fs');
const kuromoji = require('kuromoji');
const { normalizeText, resolveIntent, isExplicitTopicSwitch, resolveCoref, buildSearchQuery } = require('./lib/nlp');
const { collectKnowledge, weather } = require('./lib/retrieval');
const { generateAnswer } = require('./lib/llm');

let knowledgeBase = {};
try {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));
  knowledgeBase = data.knowledgeBase || {};
} catch (error) {
  console.warn('[aishin] knowledge base load failed:', error?.message || error);
}

let tokenizer = null;
const initTokenizer = (async () => {
  try {
    let dictPath = null;
    try { dictPath = path.join(path.dirname(require.resolve('kuromoji')), '..', 'dict'); } catch (_) {}
    await new Promise((resolve) => {
      kuromoji.builder(dictPath ? { dicPath: dictPath } : {}).build((err, built) => {
        if (!err) tokenizer = built;
        else console.warn('[aishin] kuromoji init failed:', err?.message || err);
        resolve();
      });
    });
  } catch (error) {
    console.warn('[aishin] tokenizer init failed:', error?.message || error);
  }
})();

const contextMap = new Map();
const MAX_HISTORY = 24;
const CONTEXT_TTL_MS = 30 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 2400;

function newContext(persona = 'neutral') {
  return { history: [], persona, lastKeyword: null, lastEntities: [], lastSearchQuery: null, updatedAt: Date.now() };
}

function pushHistory(ctx, role, text) {
  ctx.history.push({ role, text: String(text || ''), ts: Date.now() });
  if (ctx.history.length > MAX_HISTORY) ctx.history.shift();
  ctx.updatedAt = Date.now();
}

function rememberEntity(ctx, title) {
  const value = normalizeText(title);
  if (!value) return;
  ctx.lastKeyword = value;
  ctx.lastEntities = [{ title: value, ts: Date.now() }, ...(ctx.lastEntities || []).filter((e) => e.title !== value)].slice(0, 10);
}

function clearTopic(ctx) {
  ctx.lastKeyword = null;
  ctx.lastEntities = [];
  ctx.lastSearchQuery = null;
}

function expandCandidates(values) {
  const out = [], queue = [...values], seen = new Set();
  while (queue.length && out.length < 8) {
    const value = normalizeText(queue.shift());
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    const mapped = knowledgeBase[value];
    if (mapped && !seen.has(mapped)) queue.push(mapped);
  }
  return out;
}

function fallbackFromKnowledge(items) {
  if (!items.length) return null;
  const best = items[0];
  return `${best.title} — ${best.text.slice(0, 700)}${best.text.length > 700 ? '…' : ''}`;
}

function lastBotEquals(userId, message) {
  const ctx = contextMap.get(userId);
  if (!ctx?.history?.length) return false;
  const lastBot = [...ctx.history].reverse().find((item) => item.role === 'bot' && item.text);
  return Boolean(lastBot && normalizeText(lastBot.text) === normalizeText(message));
}

async function getBotResponse(userId, userMessage, opts = {}) {
  await initTokenizer;
  const now = Date.now();
  let ctx = contextMap.get(userId);
  if (!ctx || now - (ctx.updatedAt || 0) > CONTEXT_TTL_MS) ctx = newContext(opts.persona || 'neutral');
  if (opts.persona) ctx.persona = opts.persona;

  const message = normalizeText(userMessage);
  if (isExplicitTopicSwitch(message)) clearTopic(ctx);

  const tokens = tokenizer ? tokenizer.tokenize(message) : [];
  const resolved = resolveIntent(message, tokens);
  const corefKeyword = resolveCoref(message, ctx);
  const candidates = expandCandidates([
    corefKeyword,
    resolved.mainKeyword,
    ...(resolved.keywords || []),
    ...(ctx.lastEntities || []).map((e) => e.title)
  ].filter(Boolean));
  const searchQuery = buildSearchQuery(message, ctx);
  ctx.lastSearchQuery = searchQuery;
  pushHistory(ctx, 'user', message);

  if (resolved.intent === 'greeting') {
    const reply = 'こんにちは！何を手伝おうか？';
    pushHistory(ctx, 'bot', reply); contextMap.set(userId, ctx);
    return { text: reply, meta: { mode: 'greeting' } };
  }
  if (resolved.intent === 'thanks') {
    const reply = 'どういたしまして。';
    pushHistory(ctx, 'bot', reply); contextMap.set(userId, ctx);
    return { text: reply, meta: { mode: 'thanks' } };
  }

  if (resolved.intent === 'weather' || resolved.intent === 'weather_future') {
    const place = resolved.placeEntity || candidates.find((c) => /(都|道|府|県|市|区|町|村)$/.test(c));
    if (place) {
      const result = await weather(place, resolved.intent === 'weather_future');
      if (result) {
        rememberEntity(ctx, place);
        pushHistory(ctx, 'bot', result.text); contextMap.set(userId, ctx);
        return { text: result.text, meta: { source: result.source, usedKeyword: place } };
      }
    }
    const reply = '場所名を入れてください。例: 「東京の明日の天気」';
    pushHistory(ctx, 'bot', reply); contextMap.set(userId, ctx);
    return { text: reply, meta: { mode: 'weather-failed' } };
  }

  const knowledge = await collectKnowledge(searchQuery, candidates);
  const llm = await generateAnswer({ history: ctx.history, userMessage: message, searchQuery, knowledge, persona: ctx.persona });
  if (llm) {
    const entity = knowledge[0]?.title || resolved.mainKeyword || corefKeyword;
    if (entity) rememberEntity(ctx, entity);
    pushHistory(ctx, 'bot', llm.text); contextMap.set(userId, ctx);
    return {
      text: llm.text,
      meta: {
        mode: 'llm', model: llm.model, searchQuery,
        sources: knowledge.map((item) => ({ source: item.source, title: item.title, url: item.url || null }))
      }
    };
  }

  if (resolved.intent === 'joke') {
    const reply = 'AIがカフェで注文しました。「学習率、少なめで。」';
    pushHistory(ctx, 'bot', reply); contextMap.set(userId, ctx);
    return { text: reply, meta: { mode: 'joke-local' } };
  }

  const knowledgeReply = fallbackFromKnowledge(knowledge);
  if (knowledgeReply) {
    const best = knowledge[0];
    if (best.title) rememberEntity(ctx, best.title);
    pushHistory(ctx, 'bot', knowledgeReply); contextMap.set(userId, ctx);
    return { text: knowledgeReply, meta: { source: best.source, title: best.title, url: best.url || null, searchQuery } };
  }

  if (resolved.intent === 'advice') {
    const reply = 'もちろん。状況・目標・いちばん困っている点を教えてくれれば、選択肢を整理して一緒に考えるよ。';
    pushHistory(ctx, 'bot', reply); contextMap.set(userId, ctx);
    return { text: reply, meta: { mode: 'advice-fallback' } };
  }

  const reply = corefKeyword
    ? `「${corefKeyword}」の続きとして受け取ったよ。もう少し具体的に聞いてくれれば、絞って答えられる。`
    : 'もう少し具体的に教えてください。';
  pushHistory(ctx, 'bot', reply); contextMap.set(userId, ctx);
  return { text: reply, meta: { mode: 'clarify', searchQuery } };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['GET','POST'].includes(req.method)) return res.status(405).json({ reply: '', text: '', error: 'method not allowed' });

  try {
    let body = {};
    if (req.method === 'POST') body = typeof req.body === 'object' && req.body !== null ? req.body : (req.body ? JSON.parse(req.body) : {});
    const query = req.query || {};
    const userId = String(req.method === 'POST' ? (body.userId || body.user?.id || 'anon') : (query.userId || query.user || 'anon')).slice(0, 160);
    const rawMessage = req.method === 'POST'
      ? (Object.prototype.hasOwnProperty.call(body, 'message') ? body.message : null)
      : (Object.prototype.hasOwnProperty.call(query, 'message') ? query.message : (query.q ?? null));
    const wantInit = req.method === 'POST' ? Boolean(body.init) : ['1','true'].includes(String(query.init)) || query.welcome === '1';
    const persona = req.method === 'POST' ? (body.persona || query.persona) : query.persona;

    if (rawMessage === null || rawMessage === undefined) {
      if (!wantInit) return res.status(400).json({ reply: '', text: '', error: 'message (or q) required' });
      const welcome = 'ようこそ。何でも聞いてください。';
      const ctx = contextMap.get(userId) || newContext(persona || 'neutral');
      pushHistory(ctx, 'bot', welcome); contextMap.set(userId, ctx);
      return res.status(200).json({ reply: welcome, text: welcome, meta: { welcome: true } });
    }

    const message = normalizeText(rawMessage);
    if (!message) return res.status(400).json({ reply: '', text: '', error: 'message is empty' });
    if (message.length > MAX_MESSAGE_LENGTH) return res.status(413).json({ reply: '', text: '', error: `message is too long (max ${MAX_MESSAGE_LENGTH} characters)` });
    if (lastBotEquals(userId, message)) return res.status(200).json({ reply: '', text: '', ignore: true, reason: 'echo' });

    const start = Date.now();
    const result = await getBotResponse(userId, message, { persona: persona ? String(persona).slice(0, 40) : undefined });
    const replyText = result?.text || 'すみません、うまく答えられませんでした。';
    return res.status(200).json({ reply: replyText, text: replyText, meta: result?.meta || {}, took_ms: Date.now() - start });
  } catch (error) {
    console.error('[aishin] chat handler error:', error);
    return res.status(500).json({ reply: '', text: '', error: 'internal server error' });
  }
};
