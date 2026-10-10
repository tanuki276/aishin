function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function checkTemporalKeywords(text) {
  const value = normalizeText(text);
  if (/(明日|あさって|明後日|来週|来月|週間|予報|翌日|今週末)/.test(value)) return { isFuture: true, isCurrent: false };
  return { isFuture: false, isCurrent: /(現在|今|いま|今日|なう)/.test(value) };
}

function getCompoundKeywords(tokens) {
  const out = [];
  let buf = [];
  const stop = new Set(['こと','もの','ため','よう','それ','これ','あれ','あなた','自分','何','誰','どこ','いつ','今日','明日','現在','情報','質問','回答','お願い','教えて','知りたい']);
  const flush = () => {
    if (!buf.length) return;
    const word = buf.join('');
    if (word.length > 1 && !stop.has(word)) out.push(word);
    buf = [];
  };
  for (const t of tokens || []) {
    const sf = t.surface_form || '';
    const allowed = t.pos === '名詞' || t.pos_detail_1 === '固有名詞' || /^[\u30A0-\u30FFー]+$/.test(sf) || /^[A-Za-z0-9_-]+$/.test(sf) || (t.pos === '接頭詞' && (sf === '第' || sf === '旧'));
    if (allowed) buf.push(sf); else flush();
  }
  flush();
  return Array.from(new Set(out)).sort((a, b) => b.length - a.length);
}

function extractPlace(tokens) {
  for (const t of tokens || []) {
    const sf = t.surface_form || '';
    if (t.pos !== '名詞') continue;
    if (t.pos_detail_1 === '地域' || t.pos_detail_1 === '国' || /(都|道|府|県|市|区|町|村)$/.test(sf)) return sf;
  }
  return null;
}

function resolveIntent(text, tokens) {
  const value = normalizeText(text);
  const keywords = getCompoundKeywords(tokens);
  const placeEntity = extractPlace(tokens);
  let intent = 'unknown';
  if (/^(おはよう|おは|こんにちは|こんばんは|やあ|どうも|hi|hello)\b/i.test(value)) intent = 'greeting';
  else if (/(ありがとう|感謝|助かった|thanks)/i.test(value)) intent = 'thanks';
  else if (/(ジョーク|冗談|笑わせて|面白い話|おもしろい話)/.test(value)) intent = 'joke';
  else if (/(相談|アドバイス|悩んで|悩み|どうしたらいい|どうすればいい)/.test(value)) intent = 'advice';

  const weatherWords = ['天気','天候','気温','降水','雨','雪','週間','予報'];
  if (weatherWords.some((k) => value.includes(k))) intent = checkTemporalKeywords(value).isFuture ? 'weather_future' : 'weather';

  const isQuestion = /[?？]/.test(value) || /(何|誰|いつ|どこ|なぜ|どう|知りたい|教えて|説明して|違い|比較)/.test(value);
  if (intent === 'unknown' && isQuestion) intent = 'question';
  const filtered = keywords.filter((k) => !weatherWords.includes(k) && k !== placeEntity);
  return { intent, keywords, placeEntity, mainKeyword: filtered[0] || placeEntity || null, isQuestion };
}

function isExplicitTopicSwitch(text) {
  return /^(ところで|話(?:題)?を?変えると|話変わるけど|別の話(?:だけど|ですが)?|別件(?:だけど|ですが)?)/.test(normalizeText(text));
}

function looksLikeFollowUp(text, ctx) {
  const value = normalizeText(text);
  if (!ctx || !ctx.lastKeyword || !value) return false;
  if (/(それ|これ|あれ|その|この|あの|彼|彼女|彼ら|それら|さっき|先ほど)/.test(value)) return true;
  if (/^(いつ|どこ|誰|なぜ|どうして|どう|何歳|何年|何人|いくら|どれ|どっち|どの|その後|その理由)/.test(value)) return true;
  return value.length <= 24 && /[?？]|教えて|詳しく|理由|違い|続き|それで/.test(value);
}

function resolveCoref(text, ctx) {
  if (!ctx || !ctx.lastKeyword) return null;
  const value = normalizeText(text);
  const references = /(それ|これ|あれ|その|この|あの|彼|彼女|彼ら|それら|さっき|先ほど)/.test(value);
  if (!references && !looksLikeFollowUp(value, ctx)) return null;
  return ctx.lastEntities && ctx.lastEntities[0] ? ctx.lastEntities[0].title : ctx.lastKeyword;
}

function buildSearchQuery(message, ctx) {
  const value = normalizeText(message);
  if (!ctx || !ctx.lastKeyword || isExplicitTopicSwitch(value)) return value;
  const coref = resolveCoref(value, ctx);
  if (coref && !value.includes(coref)) return `${coref} ${value}`;
  if (looksLikeFollowUp(value, ctx) && !value.includes(ctx.lastKeyword)) return `${ctx.lastKeyword} ${value}`;
  return value;
}

module.exports = { normalizeText, resolveIntent, isExplicitTopicSwitch, looksLikeFollowUp, resolveCoref, buildSearchQuery };
