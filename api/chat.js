const path = require('path');
const fs = require('fs');
const kuromoji = require('kuromoji');
const fetch = require('node-fetch');

// --- 知識ベースとメタデータの読み込み ---
const dataPath = path.join(__dirname, 'data.json');
let knowledgeBase = {};
let metaData = {};
try {
    const rawData = fs.readFileSync(dataPath, 'utf8');
    const botData = JSON.parse(rawData);
    knowledgeBase = botData.knowledgeBase || {};
    metaData = botData.metaData || {};
} catch (error) {
    console.error('Failed to load data.json:', error.message);
}

// --- Kuromoji 初期化 ---
let tokenizer = null;
const initTokenizer = (async () => {
    const dictPath = path.join(path.dirname(require.resolve('kuromoji')), '..', 'dict');
    await new Promise((resolve, reject) => {
        kuromoji.builder({ dicPath: dictPath }).build((err, built) => {
            if (err) return reject(err);
            tokenizer = built;
            console.log('Kuromoji ready.');
            resolve();
        });
    });
})();

// --- コンテキスト/履歴管理 ---
const contextMap = new Map();
const MAX_HISTORY = 20;
const CONTEXT_TTL_MS = 1000 * 60 * 30; // 30分に延長

function nowTs() { return Date.now(); }
function pushHistory(ctx, role, text) {
    ctx.history.push({ role, text, ts: nowTs() });
    if (ctx.history.length > MAX_HISTORY) ctx.history.shift();
    ctx.updatedAt = nowTs();
}
function choose(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// --- コンテキストに基づくキーワード抽出 ---
function getRelevantKeywords(tokens, ctx) {
    const nouns = tokens.filter(t => t.pos === '名詞' && t.surface_form.length > 1).map(t => t.surface_form);
    const keywords = [...new Set(nouns)];
    // 以前の会話のキーワードを重み付けして追加
    if (ctx && ctx.lastKeywords) {
        for (const k of ctx.lastKeywords) {
            if (!keywords.includes(k)) keywords.push(k);
        }
    }
    return keywords;
}

// --- 質問の意図とエンティティをより精密に解析 ---
function analyzeUserQuery(tokens, userMessage, ctx) {
    const intent = {};
    const nouns = tokens.filter(t => t.pos === '名詞').map(t => t.surface_form);
    
    // インテントを決定
    if (/(おはよう|こんにちは|こんばんは)/.test(userMessage)) intent.type = 'greeting';
    else if (/ありがとう|助かった/.test(userMessage)) intent.type = 'thanks';
    else if (/(ジョーク|冗談|おもしろ)/.test(userMessage)) intent.type = 'joke';
    else if (/(天気|気温|雨|晴れ)/.test(userMessage)) intent.type = 'weather';
    else if (/(作り方|レシピ|材料)/.test(userMessage)) intent.type = 'recipe';
    else if (/(とは|とは何|は？|って何)/.test(userMessage)) intent.type = 'definition';
    else if (nouns.length > 0) intent.type = 'knowledge';
    else intent.type = 'smalltalk';
    
    // エンティティとプロパティを抽出
    intent.entity = null;
    intent.property = null;
    let keywordList = getRelevantKeywords(tokens, ctx);
    
    if (intent.type === 'weather') {
        const place = nouns.find(n => n.endsWith('市') || n.endsWith('都') || n.endsWith('県') || n.endsWith('区'));
        intent.entity = place || ctx.lastPlace;
    } else if (intent.type === 'recipe') {
        const recipeNoun = nouns.find(n => !n.includes('作り方') && !n.includes('レシピ') && !n.includes('材料'));
        intent.entity = recipeNoun || ctx.lastKeywords[0];
        intent.property = nouns.find(n => n.includes('作り方') || n.includes('レシピ') || n.includes('材料'));
    } else if (intent.type === 'definition' || intent.type === 'knowledge') {
        // 「...の...は？」のような構造を解析
        const particles = tokens.filter(t => t.pos === '助詞');
        const noParticle = particles.find(p => p.surface_form === 'の');
        if (noParticle) {
            const noIndex = tokens.indexOf(noParticle);
            const propCandidate = tokens[noIndex - 1];
            const entityCandidate = tokens[noIndex + 1];
            if (propCandidate && propCandidate.pos === '名詞') intent.property = propCandidate.surface_form;
            if (entityCandidate && entityCandidate.pos === '名詞') intent.entity = entityCandidate.surface_form;
        }
        // 他のケースのエンティティ
        if (!intent.entity && keywordList.length > 0) intent.entity = keywordList[0];
    }
    
    return intent;
}

// --- 応答生成のコアロジック ---
function generateResponse(intent, data, ctx) {
    if (!data) {
        if (intent.type === 'knowledge' || intent.type === 'definition') {
            return choose([
                `「${intent.entity}」についてですね。少し調べてみます。`,
                `「${intent.entity}」について、もう少し詳しい情報を教えていただけますか？`,
                'その件について、今は情報がありません。'
            ]);
        }
        return null;
    }
    
    // データから応答を動的に生成
    if (intent.type === 'recipe' && intent.property) {
        return `${intent.entity}の${intent.property}ですね。${data}という情報があります。`;
    }
    if (intent.type === 'definition' || intent.type === 'knowledge') {
        if (intent.property) {
            return `${intent.entity}の${intent.property}は、${data}です。`;
        }
        return `「${intent.entity}」とは、${data}のことです。`;
    }
    
    // 汎用的な応答
    return `${data}についてお答えしました。他に何か知りたいことはありますか？`;
}

// --- 外部API（フォールバック） ---
async function tryWikipedia(keyword) { /* ... 既存のコードをそのまま利用 ... */ }
async function getWeatherForPlace(place) { /* ... 既存のコードをそのまま利用 ... */ }

// --- メインの応答関数 ---
async function getBotResponse(userId, userMessage) {
    await initTokenizer;

    const now = nowTs();
    let ctx = contextMap.get(userId);
    if (!ctx || (now - (ctx.updatedAt || 0) > CONTEXT_TTL_MS)) {
        ctx = { history: [], lastKeywords: [], lastPlace: null, updatedAt: now };
    }
    pushHistory(ctx, 'user', userMessage);

    const tokens = tokenizer.tokenize(userMessage);
    const intent = analyzeUserQuery(tokens, userMessage, ctx);
    ctx.lastKeywords = getRelevantKeywords(tokens, ctx);

    let responseText = null;

    // 1. 定型インテント応答
    if (intent.type === 'greeting') responseText = choose(metaData.greetings);
    if (intent.type === 'thanks') responseText = choose(metaData.thanks);
    if (intent.type === 'joke') responseText = choose(metaData.jokes);
    if (intent.type === 'smalltalk') responseText = choose(metaData.smalltalks);
    if (responseText) {
        pushHistory(ctx, 'bot', responseText);
        contextMap.set(userId, ctx);
        return { text: responseText };
    }

    // 2. ローカル知識ベース検索
    const entity = intent.entity;
    const property = intent.property;

    if (entity && knowledgeBase[entity]) {
        if (property && knowledgeBase[entity][property]) {
            responseText = generateResponse(intent, knowledgeBase[entity][property], ctx);
        } else if (knowledgeBase[entity].default) {
            // プロパティが不明な場合はデフォルトの情報を返す
            responseText = generateResponse(intent, knowledgeBase[entity].default, ctx);
        }
    }
    if (responseText) {
        pushHistory(ctx, 'bot', responseText);
        contextMap.set(userId, ctx);
        return { text: responseText };
    }

    // 3. 外部APIを最終手段として利用
    if (intent.type === 'weather' && intent.entity) {
        const weatherInfo = await getWeatherForPlace(intent.entity);
        if (weatherInfo) {
            ctx.lastPlace = weatherInfo.place;
            responseText = weatherInfo.text;
        } else {
            responseText = `ごめんなさい、${intent.entity}の天気情報を取得できませんでした。`;
        }
    }
    if (!responseText && entity) {
        const wikiResult = await tryWikipedia(entity);
        if (wikiResult) {
            responseText = `「${wikiResult.title}」についてですね。${wikiResult.text}`;
        }
    }

    // 4. 応答が見つからなかった場合のフォールバック
    if (!responseText) {
        responseText = choose(metaData.clarifications);
    }
    
    pushHistory(ctx, 'bot', responseText);
    contextMap.set(userId, ctx);
    return { text: responseText };
}

// --- HTTP Handler（省略） ---
// ... 既存のコードをそのまま利用 ...
