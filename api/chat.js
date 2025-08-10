// index.js (Vercel serverless handler)
const kuromoji = require('kuromoji');
const path = require('path');

let tokenizer = null;

// コンテキストをユーザーごとに保持（必要なら Redis 等に置き換え）
const contextMap = new Map();
// 最大履歴長、古いコンテキストは自動で切る
const MAX_HISTORY = 30;
const CONTEXT_TTL_MS = 1000 * 60 * 60 * 2; // 2時間の TTL（必要なら延長）

// Kuromoji の初期化（Cold start 対策として一度だけやる）
const initTokenizer = new Promise((resolve, reject) => {
  const dictPath = path.join(__dirname, '../dict');
  kuromoji.builder({ dicPath: dictPath }).build((err, built) => {
    if (err) {
      console.error('Kuromoji init failed', err);
      reject(err);
      return;
    }
    tokenizer = built;
    console.log('Kuromoji ready');
    resolve();
  });
});

/**
 * メイン：Bot の応答を返す
 * @param {string} userId
 * @param {string} userMessage
 * @returns {Promise<object>} { text: string, meta: {source, title, fallback?} }
 */
async function getBotResponse(userId, userMessage) {
  await initTokenizer;

  // シンプルなコンテキスト管理（TTL・最大履歴）
  const now = Date.now();
  let ctx = contextMap.get(userId);
  if (!ctx || (now - (ctx.updatedAt || 0) > CONTEXT_TTL_MS)) {
    ctx = { history: [], lastEntities: [], lastKeyword: null, updatedAt: now };
  }
  ctx.updatedAt = now;

  // 履歴に保存（最大長）
  ctx.history.push({ role: 'user', text: userMessage, ts: now });
  if (ctx.history.length > MAX_HISTORY) ctx.history.shift();

  // 意図検出（簡易）
  const intent = detectIntent(userMessage);
  if (intent === 'greeting') {
    const r = choose([
      'こんにちは！何を調べましょうか？',
      'やあ、どうした？知りたいことを教えて。',
    ]);
    pushBot(ctx, r);
    contextMap.set(userId, ctx);
    return { text: r, meta: { source: 'intent:greeting' } };
  }
  if (intent === 'thanks') {
    const r = choose(['どういたしまして！', 'また何かあれば言ってね。']);
    pushBot(ctx, r);
    contextMap.set(userId, ctx);
    return { text: r, meta: { source: 'intent:thanks' } };
  }

  // 形態素解析 → 複合名詞抽出（固有名詞・連続名詞・カタカナ・英数字ブロックを塊に）
  const tokens = tokenizer.tokenize(userMessage);
  const keywords = getCompoundKeywords(tokens);

  // コア参照解決（「それ」「あれ」「この国」等）
  const corefTarget = resolveCoref(userMessage, ctx);

  // 最終的に検索するキーワード候補を作る
  let searchCandidates = [];
  if (corefTarget) {
    searchCandidates.push(corefTarget);
  }
  // ユーザーの入力から抽出した複合語（優先度順）
  searchCandidates = searchCandidates.concat(keywords);

  // 履歴から直近の entity を追加（保険）
  if (ctx.lastEntities && ctx.lastEntities.length) {
    for (const e of ctx.lastEntities) {
      if (!searchCandidates.includes(e.title)) searchCandidates.push(e.title);
    }
  }

  // 候補を順に試す（Wikipedia + フェールバック）
  for (const cand of searchCandidates) {
    if (!cand || cand.trim().length === 0) continue;
    const wiki = await searchWikipediaBestMatch(cand);
    if (wiki && wiki.found) {
      // エンティティメタをコンテキストに保存（タイトル・タイプ）
      ctx.lastKeyword = cand;
      ctx.lastEntities.unshift({ title: wiki.title, type: predictTypeFromExtract(wiki.extract), ts: now });
      if (ctx.lastEntities.length > 10) ctx.lastEntities.pop();

      const reply = renderReplyFromWiki(cand, wiki);
      pushBot(ctx, reply);
      contextMap.set(userId, ctx);
      return { text: reply, meta: { source: 'wikipedia', title: wiki.title } };
    }
  }

  // ここまで来たら見つからなかった → ユーザーに聞き返す（超会話型）
  const ask = generateClarifyingQuestion(keywords, ctx);
  pushBot(ctx, ask);
  contextMap.set(userId, ctx);
  return { text: ask, meta: { source: 'clarify' } };
}

/* ------------------ ヘルパー群 ------------------ */

function pushBot(ctx, text) {
  ctx.history.push({ role: 'bot', text, ts: Date.now() });
  if (ctx.history.length > MAX_HISTORY) ctx.history.shift();
}

// ランダム選択
function choose(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 簡易意図検出（挨拶・感謝）
function detectIntent(text) {
  const g = ['こんにちは', 'こんばんは', 'おはよう', 'やあ', 'おっす'];
  const t = ['ありがとう', '感謝', '助かった', 'サンキュー', 'thanks'];
  const low = text.toLowerCase();
  if (g.some(w => text.includes(w))) return 'greeting';
  if (t.some(w => low.includes(w))) return 'thanks';
  return 'unknown';
}

// 複合キーワード抽出：連続する名詞／固有名詞／カタカナ／英数字をまとめる
function getCompoundKeywords(tokens) {
  const keywords = [];
  let cur = [];
  for (const t of tokens) {
    const isNoun = t.pos === '名詞';
    const isProper = t.pos_detail_1 === '固有名詞';
    const isKatakana = /^[\u30A0-\u30FF]+$/.test(t.surface_form);
    const isAlphaNum = /^[A-Za-z0-9\-\_]+$/.test(t.surface_form);
    // 接続詞的名詞は除外（例: の, もの が混入しないよう pos で弾く）
    if (isNoun || isProper || isKatakana || isAlphaNum) {
      // ただし '代名詞' は除外
      if (t.pos_detail_1 === '代名詞') {
        if (cur.length) { keywords.push(cur.join('')); cur = []; }
        continue;
      }
      cur.push(t.surface_form);
    } else {
      if (cur.length) { keywords.push(cur.join('')); cur = []; }
    }
  }
  if (cur.length) keywords.push(cur.join(''));
  // さらに長さでソート（長いものを先に）
  return Array.from(new Set(keywords)).sort((a,b)=>b.length-a.length);
}

// コア参照解決（単純ルールベース）
// 「それ」「あれ」「この国」「この島」「ここ」などを直近の対象にマッピング
function resolveCoref(text, ctx) {
  // 代表的代名詞
  const pronouns = ['それ','あれ','これ','こいつ','そいつ','この','その','あの','ここ','そこ','あそこ','どれ','どこ'];
  const matchedPron = pronouns.find(p => text.includes(p));
  if (!matchedPron) return null;

  // 「この国」「その島」などは "この"+"名詞" の形で解決
  const m = text.match(/(この|その|あの)([^\s　]+)/);
  if (m) {
    const targetNoun = m[2];
    // 履歴の lastEntities の中で type が近いものを探す
    if (ctx.lastEntities && ctx.lastEntities.length) {
      for (const ent of ctx.lastEntities) {
        if (ent.title.includes(targetNoun) || ent.type === guessTypeFromNoun(targetNoun)) {
          return ent.title;
        }
      }
    }
    // 無ければ targetNoun 自体を候補として返す
    return targetNoun;
  }

  // 単に「それ」など → 直近のエンティティを返す
  if (ctx.lastEntities && ctx.lastEntities.length) {
    return ctx.lastEntities[0].title;
  }
  if (ctx.lastKeyword) return ctx.lastKeyword;
  return null;
}

// 名詞語からタイプを軽く予測（国/島/人物/組織/概念）
function guessTypeFromNoun(noun) {
  if (/国|共和国|帝国|王国|州|県|省|島/.test(noun)) return 'country';
  if (/会社|社|株式会社|企業|団体/.test(noun)) return 'organization';
  if (/さん|氏|先生|将軍|天皇|皇帝/.test(noun)) return 'person';
  return 'thing';
}

// extract（Wikipedia の要約）からタイプ推定（弱いルール）
function predictTypeFromExtract(extract) {
  if (!extract) return 'thing';
  if (/日本|国|共和国|領土|自治/.test(extract)) return 'country';
  if (/会社|企業|社長|設立/.test(extract)) return 'organization';
  if (/(は|は、).+は日本の|は.+の.*人物/.test(extract)) return 'person';
  return 'thing';
}

/* ------------------ Wikipedia 検索＆取得 ------------------ */
/**
 * 候補キーワードに対して OpenSearch で最もらしいタイトルを探し、
 * 見つかれば extracts を返す
 * @param {string} keyword
 * @returns {Promise<{found:boolean,title:string,extract:string,pageid:number}>}
 */
async function searchWikipediaBestMatch(keyword) {
  try {
    // step1: opensearch で候補を取得
    const opensearchUrl = `https://ja.wikipedia.org/w/api.php?action=opensearch&limit=5&format=json&origin=*&search=${encodeURIComponent(keyword)}`;
    const opRes = await fetch(opensearchUrl);
    const opJson = await opRes.json(); // [search, titles[], descs[], urls[]]
    const titles = opJson[1] || [];

    // step2: 候補の中から最も関連が高そうなものを順に extract 取得して確認
    const candidates = titles.length ? titles : [keyword];
    for (const title of candidates) {
      const extractUrl = `https://ja.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&format=json&origin=*&titles=${encodeURIComponent(title)}`;
      const exRes = await fetch(extractUrl);
      const exJson = await exRes.json();
      if (!exJson.query || !exJson.query.pages) continue;
      const pages = exJson.query.pages;
      const pageId = Object.keys(pages)[0];
      if (pageId === '-1') continue;
      const page = pages[pageId];
      if (!page || !page.extract) continue;
      // 成功
      return { found: true, title: page.title, extract: page.extract, pageid: pageId };
    }
    // 見つからない
    return { found: false };
  } catch (err) {
    console.error('Wikipedia search error:', err);
    return { found: false };
  }
}

/* ------------------ 応答生成 ------------------ */
function renderReplyFromWiki(originalKeyword, wiki) {
  // 自然な導入とサマリを作る
  const introTemplates = [
    `お調べしました。「${wiki.title}」についてですね。`,
    `はい、「${wiki.title}」ですね。Wikipedia によると、`,
    `なるほど、「${wiki.title}」ですね。概要は次の通りです。`
  ];
  const outroTemplates = [
    '…こんな感じです。他に知りたいことはありますか？',
    '…ということが書かれています。もっと詳しく見ますか？',
    '…のようです。続けて別の質問もどうぞ。'
  ];
  const intro = choose(introTemplates);
  const outro = choose(outroTemplates);

  // 150~300 文字で切り取る（ユーザーフレンドリーに）
  const maxLen = 300;
  let summary = wiki.extract.replace(/\n+/g, ' ').trim();
  if (summary.length > maxLen) summary = summary.substring(0, maxLen) + '...';

  // ちょっと雑談要素を入れる（超会話型）
  const smallTalk = choose([
    '',
    '（ちなみに興味深い点としては…）',
    ''
  ]);

  return `${intro}${summary}${smallTalk} ${outro}`;
}

// キーワード見つからなかったときの聞き返し文
function generateClarifyingQuestion(keywords, ctx) {
  if (keywords && keywords.length) {
    return `「${keywords[0]}」についてですか？もう少し具体的に教えてください（例：「どの時代の〜？」、「どの国の〜？」）。`;
  }
  // 履歴があればそれに基づく聞き返し
  if (ctx.lastEntities && ctx.lastEntities.length) {
    return `さっきの「${ctx.lastEntities[0].title}」のことですか？それとも別の話題に移りますか？`;
  }
  // 完全に不明なとき
  return 'ごめんなさい、ちょっと分かりませんでした。もう少し詳しく説明してもらえますか？';
}

/* ------------------ Vercel ハンドラ ------------------ */
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { userId, message } = req.body || {};
    if (!userId || !message) return res.status(400).json({ error: 'userId and message are required' });

    const out = await getBotResponse(String(userId), String(message));
    return res.status(200).json(out);
  } catch (err) {
    console.error('chat handler error', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};