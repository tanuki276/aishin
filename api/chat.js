async function getBotResponse(userId, userMessage) {
  await initTokenizer;

  console.log(`[getBotResponse] userId: ${userId}, message: ${userMessage}`);

  const context = contextMap.get(userId) || { lastKeyword: null, history: [] };
  context.history.push({ role: 'user', text: userMessage });

  const intent = detectIntent(userMessage);
  if (intent === 'greeting') {
    const response = "こんにちは！何かお調べしましょうか？";
    console.log(`[getBotResponse] intent greeting response: ${response}`);
    context.history.push({ role: 'bot', text: response });
    contextMap.set(userId, context);
    return response;
  }
  if (intent === 'thanks') {
    const response = "どういたしまして！何かあればまたどうぞ。";
    console.log(`[getBotResponse] intent thanks response: ${response}`);
    context.history.push({ role: 'bot', text: response });
    contextMap.set(userId, context);
    return response;
  }

  let searchKeyword = null;
  const tokens = tokenizer.tokenize(userMessage);
  const hasSore = tokens.some(token => token.surface_form === 'それ' && token.pos === '代名詞');
  console.log(`[getBotResponse] tokens: ${tokens.map(t => t.surface_form).join(', ')}, hasSore: ${hasSore}`);

  if (hasSore && context.lastKeyword) {
    searchKeyword = context.lastKeyword;
  } else {
    const keywords = getKeywords(userMessage);
    console.log(`[getBotResponse] extracted keywords: ${keywords.join(', ')}`);
    if (keywords.length > 0) {
      searchKeyword = keywords[0];
    }
  }

  if (searchKeyword) {
    console.log(`[getBotResponse] searchKeyword: ${searchKeyword}`);
    const response = await searchWikipediaAndRespond(searchKeyword);
    console.log(`[getBotResponse] wikipedia response: ${response}`);
    if (response) {
      context.lastKeyword = searchKeyword;
      context.history.push({ role: 'bot', text: response });
      contextMap.set(userId, context);
      return response;
    }
  }

  const fallbackResponses = [
    "すみません、うまく応答できませんでした。",
    "申し訳ありませんが、その内容については情報がありません。",
    "ちょっとわかりませんでした。別の言葉で聞いてみてください。"
  ];
  const fallbackResponse = fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
  console.log(`[getBotResponse] fallbackResponse: ${fallbackResponse}`);
  context.history.push({ role: 'bot', text: fallbackResponse });
  contextMap.set(userId, context);
  return fallbackResponse;
}

async function searchWikipediaAndRespond(keyword) {
  console.log(`[searchWikipediaAndRespond] keyword: ${keyword}`);
  const url = `https://ja.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&format=json&origin=*&titles=${encodeURIComponent(keyword)}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    console.log(`[searchWikipediaAndRespond] Wikipedia API data:`, data);

    const pages = data.query.pages;
    const pageId = Object.keys(pages)[0];

    if (pageId === '-1') {
      console.log(`[searchWikipediaAndRespond] No Wikipedia page found for: ${keyword}`);
      return null;
    }

    const summary = pages[pageId].extract;
    if (summary) {
      const summary_short = summary.substring(0, 150) + '...';
      return `【${keyword}】について調べました。${summary_short}`;
    }
    return null;

  } catch (error) {
    console.error("[searchWikipediaAndRespond] Wikipedia search failed:", error);
    return null;
  }
}