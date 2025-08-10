const kuromoji = require('kuromoji');
const fetch = require('node-fetch');

let tokenizer;
const contextMap = new Map();

// Vercelはコールドスタートするため、一度初期化が走れば次回以降は高速
const initTokenizer = new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath: 'node_modules/kuromoji/dict' }).build((err, builder) => {
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

async function getBotResponse(userId, userMessage) {
    await initTokenizer;

    const context = contextMap.get(userId) || { lastKeyword: null };

    // 意図に基づく応答ロジック
    const intent = detectIntent(userMessage);
    if (intent === 'greeting') {
        return "こんにちは！何かお調べしましょうか？";
    }
    if (intent === 'thanks') {
        return "どういたしまして！何かあればまたどうぞ。";
    }

    // 文脈管理ロジック
    if (userMessage.includes('それ') && context.lastKeyword) {
        const response = await searchWikipediaAndRespond(context.lastKeyword);
        if (response) return response;
    }

    const keywords = getKeywords(userMessage);
    if (keywords.length > 0) {
        const response = await searchWikipediaAndRespond(keywords[0]);
        if (response) {
            context.lastKeyword = keywords[0];
            contextMap.set(userId, context);
            return response;
        }
    }

    const noKeywordResponses = [
        "すみません、もう少し具体的に教えていただけますか？",
        "そのことについては分かりませんでした。別の質問をどうぞ。"
    ];
    return noKeywordResponses[Math.floor(Math.random() * noKeywordResponses.length)];
}

function detectIntent(text) {
    const greetingWords = ['こんにちは', 'こんばんは', 'おはよう'];
    const thanksWords = ['ありがとう', '助かった', '感謝'];

    if (greetingWords.some(word => text.includes(word))) {
        return 'greeting';
    }
    if (thanksWords.some(word => text.includes(word))) {
        return 'thanks';
    }
    return 'unknown';
}

function getKeywords(text) {
    const tokens = tokenizer.tokenize(text);
    return tokens
        .filter(token =>
            token.pos === '名詞' &&
            !['非自立', '接尾', '代名詞'].includes(token.pos_detail_1)
        )
        .map(token => token.surface_form);
}

async function searchWikipediaAndRespond(keyword) {
    const url = `https://ja.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&format=json&origin=*&titles=${encodeURIComponent(keyword)}`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        const pages = data.query.pages;
        const pageId = Object.keys(pages)[0];

        if (pageId === '-1') return null;

        const summary = pages[pageId].extract;
        if (summary) {
            const responsePatterns = [
                `${keyword}についてですね。${summary.substring(0, 200)}...さらに詳しく知りたいことはありますか？`,
                `はい、${keyword}について調べてみました。${summary.substring(0, 200)}...何か他にお手伝いできることはありますか？`
            ];
            return responsePatterns[Math.floor(Math.random() * responsePatterns.length)];
        }
        return null;

    } catch (error) {
        console.error("Wikipedia search failed:", error);
        return null;
    }
}

module.exports = { getBotResponse };