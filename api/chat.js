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
    try {
        const dictPath = path.join(path.dirname(require.resolve('kuromoji')), '..', 'dict');
        await new Promise((resolve, reject) => {
            kuromoji.builder({ dicPath: dictPath }).build((err, built) => {
                if (err) return reject(err);
                tokenizer = built;
                console.log('Kuromoji ready.');
                resolve();
            });
        });
    } catch (err) {
        console.error('initTokenizer error:', err && err.message ? err.message : err);
    }
})();

// --- コンテキスト/履歴管理 ---
const contextMap = new Map();
const MAX_HISTORY = 20;
const CONTEXT_TTL_MS = 1000 * 60 * 30;

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
    if (ctx && ctx.lastKeywords) {
        for (const k of ctx.lastKeywords) {
            if (!keywords.includes(k)) keywords.push(k);
        }
    }
    return keywords;
}

// --- 質問の意図とエンティティをより精密に解析 ---
function analyzeUserQuery(tokens, userMessage, ctx) {
    const intent = { type: 'unknown', entity: null, property: null };
    const nouns = tokens.filter(t => t.pos === '名詞').map(t => t.surface_form);
    
    // インテントを決定
    if (/(おはよう|こんにちは|こんばんは)/.test(userMessage)) intent.type = 'greeting';
    else if (/ありがとう|助かった/.test(userMessage)) intent.type = 'thanks';
    else if (/(ジョーク|冗談|おもしろ)/.test(userMessage)) intent.type = 'joke';
    else if (/(天気|気温|雨|晴れ)/.test(userMessage)) intent.type = 'weather';
    else if (/(作り方|レシピ|材料)/.test(userMessage)) intent.type = 'recipe';
    else if (/(とは|とは何|は？|って何)/.test(userMessage)) intent.type = 'definition';
    else if (/(どうして|なぜ|理由)/.test(userMessage)) intent.type = 'why';
    else if (nouns.length > 0) intent.type = 'knowledge';
    else intent.type = 'smalltalk';

    // エンティティとプロパティを抽出
    let keywordList = getRelevantKeywords(tokens, ctx);
    
    if (intent.type === 'weather') {
        const place = nouns.find(n => n.endsWith('市') || n.endsWith('都') || n.endsWith('県') || n.endsWith('区'));
        intent.entity = place || ctx.lastPlace;
    } else if (intent.type === 'recipe') {
        const recipeNoun = nouns.find(n => !/(作り方|レシピ|材料)/.test(n));
        intent.entity = recipeNoun || (ctx.lastKeywords.length > 0 ? ctx.lastKeywords[0] : null);
        intent.property = nouns.find(n => /(作り方|レシピ|材料)/.test(n));
    } else if (intent.type === 'definition' || intent.type === 'knowledge' || intent.type === 'why') {
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
    
    if (intent.type === 'recipe' && intent.property) {
        return `${intent.entity}の${intent.property}ですね。${data}という情報があります。`;
    }
    if (intent.type === 'definition' || intent.type === 'knowledge') {
        if (intent.property) {
            return `${intent.entity}の${intent.property}は、${data}です。`;
        }
        return `「${intent.entity}」とは、${data}のことです。`;
    }
    
    return `${data}についてお答えしました。他に何か知りたいことはありますか？`;
}

// --- APIツール: Wikipedia (ja) ---
async function tryWikipedia(keyword) {
    if (!fetch || !keyword) return null;
    try {
        const opUrl = `https://ja.wikipedia.org/w/api.php?action=opensearch&limit=1&format=json&origin=*&search=${encodeURIComponent(keyword)}`;
        const opRes = await fetch(opUrl);
        if (!opRes.ok) return null;
        const opJson = await opRes.json();
        const title = opJson && opJson[1] && opJson[1][0] ? opJson[1][0] : null;
        if (!title) return null;

        const sumUrl = `https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
        const sres = await fetch(sumUrl);
        if (!sres.ok) return null;
        const sjson = await sres.json();
        if (sjson && sjson.extract) {
            const text = sjson.extract.length > 600 ? sjson.extract.substring(0, 600) + '...' : sjson.extract;
            return { source: 'wikipedia', title: sjson.title, text };
        }
    } catch (err) {
        console.warn('tryWikipedia error', err && err.message ? err.message : err);
    }
    return null;
}

// --- APIツール: DuckDuckGo Instant Answer ---
async function tryDuckDuckGo(q){
    if (!fetch || !q) return null;
    try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skipsdisambig=1`;
        const res = await fetch(url);
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

// --- APIツール: Open-Meteo ---
async function getWeatherForPlace(place) {
    if (!fetch || !place) return null;
    try {
        const nomUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(place)}&limit=1`;
        const nom = await fetch(nomUrl, { headers: { 'User-Agent': 'vercel-chat-example/1.0' } });
        if (!nom.ok) return null;
        const nomj = await nom.json();
        if (!nomj || !nomj[0]) return null;
        const lat = parseFloat(nomj[0].lat), lon = parseFloat(nomj[0].lon), display = nomj[0].display_name;
        const meto = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=auto`;
        const mres = await fetch(meto);
        if (!mres.ok) return null;
        const mj = await mres.json();
        if (mj && mj.current_weather) {
            const cw = mj.current_weather;
            const text = `${display}の現在の天気: 気温 ${cw.temperature}°C、風速 ${cw.windspeed} m/sです。`;
            return { source: 'open-meteo', text, place: display };
        }
    } catch (e) {
        console.warn('getWeatherForPlace error', e && e.message ? e.message : e);
    }
    return null;
}

// --- APIツール: Joke API ---
async function getJoke(){
    if (!fetch) return null;
    try {
      const res = await fetch('https://official-joke-api.appspot.com/random_joke');
      if (!res.ok) return null;
      const j = await res.json();
      if (j && j.setup) return { source: 'joke', text: `${j.setup} — ${j.punchline || ''}`.trim() };
    } catch(e){ }
    return null;
}

// --- APIツール: Advice API ---
async function getAdvice(){
    if (!fetch) return null;
    try {
      const res = await fetch('https://api.adviceslip.com/advice');
      if (!res.ok) return null;
      const j = await res.json();
      if (j && j.slip && j.slip.advice) return { source: 'advice-slip', text: j.slip.advice };
    } catch(e){}
    return null;
}

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

    // 1. 定型インテント応答 (API呼び出しなし)
    if (intent.type === 'greeting') responseText = choose(metaData.greetings);
    if (intent.type === 'thanks') responseText = choose(metaData.thanks);
    if (intent.type === 'smalltalk') responseText = choose(metaData.smalltalks);

    if (responseText) {
        pushHistory(ctx, 'bot', responseText);
        contextMap.set(userId, ctx);
        return { text: responseText };
    }

    // 2. 外部APIを積極的に活用
    if (intent.type === 'joke') {
        const joke = await getJoke();
        responseText = joke ? joke.text : choose(metaData.clarifications);
    }
    
    if (intent.type === 'weather' && intent.entity) {
        const weatherInfo = await getWeatherForPlace(intent.entity);
        if (weatherInfo) {
            ctx.lastPlace = weatherInfo.place;
            responseText = weatherInfo.text;
        } else {
            responseText = `ごめんなさい、${intent.entity}の天気情報を取得できませんでした。`;
        }
    }
    
    if (responseText) {
        pushHistory(ctx, 'bot', responseText);
        contextMap.set(userId, ctx);
        return { text: responseText };
    }
    
    // 3. ローカル知識ベース検索
    const entity = intent.entity;
    const property = intent.property;

    if (entity && knowledgeBase[entity]) {
        if (property && knowledgeBase[entity][property]) {
            responseText = generateResponse(intent, knowledgeBase[entity][property], ctx);
        } else if (knowledgeBase[entity].default) {
            responseText = generateResponse(intent, knowledgeBase[entity].default, ctx);
        }
    }

    if (responseText) {
        pushHistory(ctx, 'bot', responseText);
        contextMap.set(userId, ctx);
        return { text: responseText };
    }

    // 4. 外部知識APIを最終手段として利用
    const searchKeyword = entity || userMessage;
    const wikiResult = await tryWikipedia(searchKeyword);
    if (wikiResult) {
        responseText = `「${wikiResult.title}」についてですね。${wikiResult.text}`;
    } else {
        const ddgResult = await tryDuckDuckGo(searchKeyword);
        if (ddgResult) {
            responseText = `${ddgResult.title}についての情報です：${ddgResult.text}`;
        }
    }

    // 5. 応答が見つからなかった場合のフォールバック
    if (!responseText) {
        responseText = choose(metaData.clarifications);
    }
    
    pushHistory(ctx, 'bot', responseText);
    contextMap.set(userId, ctx);
    return { text: responseText };
}

// --- HTTP Handler for Vercel ---
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
  
    try {
        let body = {};
        if (req.method === 'POST') {
            body = typeof req.body === 'object' ? req.body : (req.body ? JSON.parse(req.body) : {});
        }
    
        const userId = body.userId || req.query.userId || 'anon';
        const message = body.message || req.query.message;
    
        if (!message) {
            return res.status(400).json({ error: 'message is required.' });
        }
    
        const start = Date.now();
        const result = await getBotResponse(userId, message);
        const took_ms = Date.now() - start;
    
        res.status(200).json({
            reply: result.text,
            meta: { took_ms }
        });
    } catch (err) {
        console.error('Handler error:', err && err.stack ? err.stack : err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};
