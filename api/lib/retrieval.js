let fetchImpl = typeof globalThis !== 'undefined' && globalThis.fetch ? globalThis.fetch : null;
if (!fetchImpl) {
  try { const nf = require('node-fetch'); fetchImpl = nf.default || nf; }
  catch (_) { try { fetchImpl = require('undici').fetch; } catch (_) { fetchImpl = null; } }
}

const FETCH_TIMEOUT_MS = 7000;

async function fetchJson(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  if (!fetchImpl) return null;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, { ...options, ...(controller ? { signal: controller.signal } : {}) });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; }
  finally { if (timer) clearTimeout(timer); }
}

function scoreTitle(title, keyword) {
  const a = String(title || '').toLowerCase();
  const b = String(keyword || '').toLowerCase();
  if (!a || !b) return 0;
  if (a === b) return 100;
  let score = a.includes(b) || b.includes(a) ? 40 : 0;
  for (const ch of new Set([...b])) if (a.includes(ch)) score += 1;
  return score;
}

async function wikipedia(keyword) {
  if (!keyword) return null;
  const search = await fetchJson(`https://ja.wikipedia.org/w/api.php?action=opensearch&limit=5&format=json&origin=*&search=${encodeURIComponent(keyword)}`);
  const titles = search && search[1] ? search[1] : [];
  for (const title of [...titles].sort((a,b) => scoreTitle(b, keyword) - scoreTitle(a, keyword)).slice(0, 3)) {
    const data = await fetchJson(`https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    if (!data || !data.extract || data.type === 'disambiguation') continue;
    return { source: 'wikipedia', title: data.title || title, text: data.extract.slice(0, 1200), url: data.content_urls?.desktop?.page || null };
  }
  return null;
}

async function duckDuckGo(query) {
  if (!query) return null;
  const data = await fetchJson(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
  if (!data || !data.AbstractText) return null;
  return { source: 'duckduckgo', title: data.Heading || query, text: data.AbstractText.slice(0, 1200), url: data.AbstractURL || null };
}

async function collectKnowledge(searchQuery, candidates = []) {
  const primary = candidates.find(Boolean) || searchQuery;
  const [wiki, ddg] = await Promise.all([wikipedia(primary), duckDuckGo(searchQuery)]);
  return [wiki, ddg].filter(Boolean);
}

function weatherLabel(code) {
  const labels = {0:'快晴',1:'晴れ',2:'一部くもり',3:'くもり',45:'霧',48:'霧氷',51:'弱い霧雨',53:'霧雨',55:'強い霧雨',61:'弱い雨',63:'雨',65:'強い雨',71:'弱い雪',73:'雪',75:'強い雪',80:'弱いにわか雨',81:'にわか雨',82:'強いにわか雨',95:'雷雨',96:'雷雨・ひょう',99:'強い雷雨・ひょう'};
  return labels[Number(code)] || `天気コード${code}`;
}

async function weather(place, future = false) {
  if (!place) return null;
  const geo = await fetchJson(`https://nominatim.openstreetmap.org/search?format=json&accept-language=ja&q=${encodeURIComponent(place)}&limit=1`, { headers: { 'User-Agent': 'aishin-chat/2.0' } });
  if (!geo || !geo[0]) return null;
  const lat = Number(geo[0].lat), lon = Number(geo[0].lon), display = geo[0].display_name || place;
  const data = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=7`);
  if (!data) return null;
  if (future && data.daily?.time) {
    const lines = data.daily.time.slice(0, 7).map((date, i) => `${date}: ${weatherLabel(data.daily.weather_code?.[i])}、${data.daily.temperature_2m_min?.[i]}〜${data.daily.temperature_2m_max?.[i]}℃、降水確率 最大${data.daily.precipitation_probability_max?.[i] ?? '?'}%`);
    return { source: 'open-meteo', text: `${display} の予報\n${lines.join('\n')}` };
  }
  if (!data.current) return null;
  const c = data.current;
  return { source: 'open-meteo', text: `${display} の現在の天気は${weatherLabel(c.weather_code)}、気温 ${c.temperature_2m}℃（体感 ${c.apparent_temperature}℃）、風速 ${c.wind_speed_10m} km/hです。` };
}

module.exports = { collectKnowledge, weather };
