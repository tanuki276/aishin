const path = require('path');
const fs = require('fs');
const kuromoji = require('kuromoji');
const fetch = require('node-fetch');

const dataPath = path.join(__dirname, 'data.json');
let knowledgeBase = {};
try {
  const rawData = fs.readFileSync(dataPath, 'utf8');
  const botData = JSON.parse(rawData);
  knowledgeBase = botData.knowledgeBase || {};
} catch (error) {
  console.error('Failed to load data.json:', error.message);
}

const SPOONACULAR_API_KEY = process.env.SPOONACULAR_API_KEY;
const WOLFRAM_ALPHA_APP_ID = process.env.WOLFRAM_ALPHA_APP_ID;

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

const contextMap = new Map();
const MAX_HISTORY = 80;
const CONTEXT_TTL_MS = 1000 * 60 * 30;

function nowTs(){ return Date.now(); }
function pushHistory(ctx, role, text){
  ctx.history.push({ role, text, ts: nowTs() });
  if (ctx.history.length > MAX_HISTORY) ctx.history.shift();
  ctx.updatedAt = nowTs();
}
function choose(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

function detectIntent(text){
  if (!text) return 'unknown';
  if (/^(おはよう|こんにちは|こんばんは|やあ|もしもし|おっす)/.test(text)) return 'greeting';
  if (/ありがとう|助かった|感謝/.test(text)) return 'thanks';
  if (/(天気|気温|降水|雨|晴れ)/.test(text)) return 'weather';
  if (/(ジョーク|冗談|ギャグ|おもしろ|笑わせて|ネタ)/.test(text)) return 'joke';
  if (/助言|アドバイス|どうすれば|どうしたら/.test(text)) return 'advice';
  if (/(作り方|レシピ|材料|献立|調理法)/.test(text)) return 'recipe';
  if (/[+\-*/^=]/.test(text) || /(計算|平方根|微分|積分|方程式|解)/.test(text)) return 'math';
  if (/\?|\？|かな|かも|だろう/.test(text)) return 'question';
  return 'unknown';
}

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
    const isAllowed = (isNoun || isKatakana || isAlphaNum || isProper) || (t.pos === '助詞' && (sf === 'の' || sf === 'は'));
    if (isAllowed) buf.push(sf);
    else pushBuf();
  }
  pushBuf();
  return Array.from(new Set(keywords.filter(k => k.length > 1))).sort((a, b) => b.length - a.length);
}

function resolveCoref(text, ctx){
  if (!text) return null;
  const pronouns = ['それ','あれ','これ','ここ','そこ','あそこ','この','その','あの'];
  if (!pronouns.some(p => text.includes(p))) return null;
  const m = text.match(/(この|その|あの)([^\s　]+)/);
  if (m){
    const noun = m[2];
    if (ctx && ctx.lastEntities && ctx.lastEntities.length){
      for (const e of ctx.lastEntities) if (e.title.includes(noun) || e.title === noun) return e.title;
    }
    return noun;
  }
  if (ctx && ctx.lastEntities && ctx.lastEntities.length) return ctx.lastEntities[0].title;
  if (ctx && ctx.lastKeyword) return ctx.lastKeyword;
  return null;
}

async function tryWikipedia(keyword){
  if (!fetchImpl || !keyword) return null;
  try {
    const opUrl = `https://ja.wikipedia.org/w/api.php?action=opensearch&limit=5&format=json&origin=*&search=${encodeURIComponent(keyword)}`;
    const opRes = await fetchImpl(opUrl);
    if (!opRes.ok) return null;
    const opJson = await opRes.json();
    const titles = opJson && opJson[1] ? opJson[1] : [];
    for (const t of titles){
      const sumUrl = `https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t)}`;
      const sres = await fetchImpl(sumUrl);
      if (!sres.ok) continue;
      const sjson = await sres.json();
      if (sjson && sjson.extract){
        const text = (sjson.extract.length > 600) ? sjson.extract.substring(0,600) + '...' : sjson.extract;
        return { source: 'wikipedia', title: sjson.title, text };
      }
    }
  } catch (err) {
    console.warn('tryWikipedia error', err && err.message ? err.message : err);
  }
  return null;
}

async function tryDuckDuckGo(q){
  if (!fetchImpl || !q) return null;
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skipsdisambig=1`;
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const j = await res.json();
    if (j && j.AbstractText && j.AbstractText.length) {
      const txt = j.AbstractText.length > 600 ? j.AbstractText.substring(0,600)+'...' : j.AbstractText;
      return { source: 'duckduckgo', title: j.Heading || q, text: txt };
    }
  } catch (err) { /* ignore */ }
  return null;
}

async function trySpoonacular(query){
  if (!fetchImpl || !query || !SPOONACULAR_API_KEY) return null;
  try {
    const url = `https://api.spoonacular.com/recipes/complexSearch?apiKey=${SPOONACULAR_API_KEY}&query=${encodeURIComponent(query)}&number=1&addRecipeInformation=true`;
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const j = await res.json();
    if (j && j.results && j.results.length > 0) {
      const recipe = j.results[0];
      const ingredients = recipe.extendedIngredients ? recipe.extendedIngredients.map(i => i.name).join('、') : '情報なし';
      const instructions = recipe.analyzedInstructions && recipe.analyzedInstructions.length > 0 ? recipe.analyzedInstructions[0].steps.map(s => `${s.number}. ${s.step}`).join('\n') : '手順情報なし';
      const reply = `「${recipe.title}」のレシピをお探しですね。\n材料: ${ingredients}\n手順:\n${instructions}`;
      return { source: 'spoonacular', title: recipe.title, text: reply };
    }
  } catch(e){ console.warn('trySpoonacular error', e && e.message ? e.message : e); }
  return null;
}

async function tryWolframAlpha(query){
  if (!fetchImpl || !query || !WOLFRAM_ALPHA_APP_ID) return null;
  try {
    const url = `https://api.wolframalpha.com/v2/result?i=${encodeURIComponent(query)}&appid=${WOLFRAM_ALPHA_APP_ID}&output=json&units=metric&includepodid=Result`;
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const j = await res.json();
    if (j && j.Result) {
      return { source: 'wolframalpha', title: query, text: j.Result };
    }
  } catch(e){ console.warn('tryWolframAlpha error', e && e.message ? e.message : e); }
  return null;
}

async function getJoke(){
  if (!fetchImpl) return null;
  try {
    const res = await fetchImpl('https://official-joke-api.appspot.com/random_joke');
    if (!res.ok) return null;
    const j = await res.json();
    if (j && j.setup) return { source: 'joke', text: `${j.setup} — ${j.punchline || ''}`.trim() };
  } catch(e){ }
  return null;
}

async function getAdvice(){
  if (!fetchImpl) return null;
  try {
    const res = await fetchImpl('https://api.adviceslip.com/advice');
    if (!res.ok) return null;
    const j = await res.json();
    if (j && j.slip && j.slip.advice) return { source: 'advice', text: j.slip.advice };
  } catch(e){}
  return null;
}

async function getWeatherForPlace(place){
  if (!fetchImpl || !place) return null;
  try {
    const nomUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(place)}&limit=1`;
    const nom = await fetchImpl(nomUrl, { headers: { 'User-Agent': 'vercel-chat-example/1.0' }});
    if (!nom.ok) return null;
    const nomj = await nom.json();
    if (!nomj || !nomj[0]) return null;
    const lat = parseFloat(nomj[0].lat), lon = parseFloat(nomj[0].lon), display = nomj[0].display_name;
    const meto = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=auto`;
    const mres = await fetchImpl(meto);
    if (!mres.ok) return null;
    const mj = await mres.json();
    if (mj && mj.current_weather) {
      const cw = mj.current_weather;
      const text = `${display} の現在の天気: weathercode=${cw.weathercode || ''}、気温 ${cw.temperature}°C、風速 ${cw.windspeed} m/s（取得元: Open-Meteo）`;
      return { source: 'open-meteo', text, meta: { lat, lon } };
    }
  } catch(e){ console.warn('getWeatherForPlace error', e && e.message ? e.message : e); }
  return null;
}

const smalltalkPools =
