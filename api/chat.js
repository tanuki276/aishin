const kuromoji = require('kuromoji');
const fetch = require('node-fetch');
const path = require('path');

let tokenizer;
const contextMap = new Map();

// Vercelはコールドスタートするため、一度初期化が走れば次回以降は高速
const initTokenizer = new Promise((resolve, reject) => {
    const dictPath = path.join(__dirname, '../dict');

    kuromoji.builder({ dicPath: dictPath }).build((err, builder) => {
        if (err) {
            console.error('Kuromoji initialization failed:', err);
            reject(err);
            return;
        }
        tokenizer = builder;
        console.log('Kuromoji is ready!');
        resolve();
    });
});

/**
 * ユーザーメッセージに基づいてボットの応答を生成
 * @param {string} userId - ユーザーを識別するID
 * @param {string} userMessage - ユーザーからのメッセージ
 * @returns {string} - ボットの応答
 */
async function getBotResponse(userId, userMessage) {
    await initTokenizer;

    // 文脈オブジェクトに会話履歴を追加
    const context = contextMap.get(userId) || { lastKeyword: null, history: [] };
    context.history.push({ role: 'user', text: userMessage });

    // 意図に基づく応答ロジック
    const intent = detectIntent(userMessage);
    if (intent === 'greeting') {
        const response = "こんにちは！何かお調べしましょうか？";
        context.history.push({ role: 'bot', text: response });
        contextMap.set(userId, context);
        return response;
    }
    if (intent === 'thanks') {
        const response = "どういたしまして！何かあればまたどうぞ。";
        context.history.push({ role: 'bot', text: response });
        contextMap.set(userId, context);
        return response;
    }

    // 文脈管理ロジック
    let searchKeyword = null;
    const tokens = tokenizer.tokenize(userMessage);
    const hasSore = tokens.some(token => token.surface_form === 'それ' && token.pos === '代名詞');

    if (hasSore && context.lastKeyword) {
        // 「それ」を検出した場合、直前のキーワードを使用
        searchKeyword = context.lastKeyword;
    } else {
        // 通常のキーワード抽出
        const keywords = getKeywords(userMessage);
        if (keywords.length > 0) {
            searchKeyword = keywords[0];
        }
    }

    if (searchKeyword) {
        const response = await searchWikipediaAndRespond(searchKeyword);
        if (response) {
            context.lastKeyword = searchKeyword; // 最後のキーワードを更新
            context.history.push({ role: 'bot', text: response }); // 履歴にボットの応答を追加
            contextMap.set(userId, context); // 文脈を保存
            return response;
        }
    }

    // キーワードが見つからなかった場合
    const noKeywordResponses = [
        "すみません、よく分かりません。",
        "ごめんなさい、その言葉はちょっと理解できませんでした。"
    ];
    const finalResponse = noKeywordResponses[Math.floor(Math.random() * noKeywordResponses.length)];
    context.history.push({ role: 'bot', text: finalResponse });
    contextMap.set(userId, context);
    return finalResponse;
}

/**
 * ユーザーのメッセージから意図を検出
 * @param {string} text - ユーザーのメッセージ
 * @returns {string} - 検出された意図（'greeting', 'thanks', 'unknown'など）
 */
function detectIntent(text) {
    const greetingWords = ['こんにちは', 'こんばんは', 'おはよう', 'やあ'];
    const thanksWords = ['ありがとう', '助かった', '感謝'];

    if (greetingWords.some(word => text.includes(word))) {
        return 'greeting';
    }
    if (thanksWords.some(word => text.includes(word))) {
        return 'thanks';
    }
    return 'unknown';
}

/**
 * Kuromojiを使ってメッセージからキーワードを抽出
 * @param {string} text - ユーザーのメッセージ
 * @returns {Array<string>} - 抽出されたキーワードの配列
 */
function getKeywords(text) {
    const tokens = tokenizer.tokenize(text);
    return tokens
        .filter(token =>
            token.pos === '名詞' &&
            !['非自立', '接尾', '代名詞'].includes(token.pos_detail_1)
        )
        .map(token => token.surface_form);
}

/**
 * Wikipedia APIを呼び出して記事の要約を取得（応答をより自然に改良）
 * @param {string} keyword - 検索キーワード
 * @returns {string|null} - 記事の要約またはnull
 */
async function searchWikipediaAndRespond(keyword) {
    const url = `https://ja.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&format=json&origin=*&titles=${encodeURIComponent(keyword)}`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        const pages = data.query.pages;
        const pageId = Object.keys(pages)[0];

        if (pageId === '-1') {
            return `「${keyword}」という言葉について、Wikipediaでは情報を見つけられませんでした。`;
        }

        const summary = pages[pageId].extract;
        if (summary) {
            // 応答の多様化
            const summary_short = summary.substring(0, 150) + '...';
            const introPatterns = [
                `お調べしました。「${keyword}」についてですね。`,
                `はい、「${keyword}」ですね。Wikipediaによると、`,
                `なるほど、「${keyword}」ですね。`
            ];
            const outroPatterns = [
                `...という情報がありました。他に何か知りたいことはありますか？`,
                `...のようです。さらに詳しく調べますか？`,
                `...と書かれています。`
            ];

            const intro = introPatterns[Math.floor(Math.random() * introPatterns.length)];
            const outro = outroPatterns[Math.floor(Math.random() * outroPatterns.length)];
            
            return `${intro}${summary_short}${outro}`;
        }
        
        return null;

    } catch (error) {
        console.error("Wikipedia search failed:", error);
        return "申し訳ありません。検索中にエラーが発生しました。";
    }
}

// Vercelのサーバーレス関数としてエクスポート
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { userId, message } = req.body;

    if (!userId || !message) {
      return res.status(400).json({ error: 'userId and message are required.' });
    }

    const response = await getBotResponse(userId, message);
    return res.status(200).json({ response });
  } catch (error) {
    console.error('Error processing chat request:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};
