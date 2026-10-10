const DEFAULT_MODEL = process.env.LLM_MODEL || 'openai/gpt-6-astra';

function authLikelyAvailable() {
  return Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL || process.env.VERCEL_ENV || process.env.VERCEL_OIDC_TOKEN);
}

function formatKnowledge(items) {
  if (!items.length) return '（外部参考情報なし）';
  return items.map((item, i) => `[${i + 1}] ${item.source}: ${item.title}\n${item.text}${item.url ? `\nURL: ${item.url}` : ''}`).join('\n\n');
}

async function generateAnswer({ history, userMessage, searchQuery, knowledge, persona }) {
  if (process.env.DISABLE_LLM === '1' || !authLikelyAvailable()) return null;
  try {
    const { generateText } = await import('ai');
    const previous = (history || []).slice(-12, -1)
      .filter((m) => m && (m.role === 'user' || m.role === 'bot' || m.role === 'assistant') && m.text)
      .map((m) => ({ role: m.role === 'bot' ? 'assistant' : m.role, content: String(m.text).slice(0, 1800) }));

    const system = [
      'あなたは日本語で会話する高精度なアシスタントです。',
      'ユーザーの質問にはまず直接答え、必要なら短い補足を続けてください。',
      '会話履歴を使い、「それ」「彼」「何歳で？」などの省略や代名詞を解決してください。',
      '外部参考情報がある場合、事実確認が必要な内容ではそれを優先してください。',
      '資料と自分の知識が衝突する場合や最新性を確認できない場合は、断定せず不確実性を明示してください。',
      '知らない数値・日付・固有名詞を作らないでください。参考情報は長く転載せず要約してください。',
      'ユーザーが短く聞けば短く、詳しく求めれば詳しく答えてください。',
      `会話スタイル: ${persona || 'neutral'}`
    ].join('\n');

    const prompt = `今回の発言:\n${userMessage}\n\n文脈を補った検索クエリ:\n${searchQuery}\n\n外部参考情報:\n${formatKnowledge(knowledge)}`;
    const result = await generateText({
      model: DEFAULT_MODEL,
      system,
      messages: [...previous, { role: 'user', content: prompt }],
      maxOutputTokens: 1200,
      timeout: 20000
    });
    const text = result?.text ? String(result.text).trim() : '';
    return text ? { text, model: DEFAULT_MODEL } : null;
  } catch (error) {
    console.warn('[aishin] LLM fallback:', error?.message || error);
    return null;
  }
}

module.exports = { generateAnswer, DEFAULT_MODEL };
