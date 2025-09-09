// --- グローバル変数 ---
let kanjiDict = {};
let kanaDict = {};
let grammarList = {};
let tokenizer = null;

// --- DOM要素 ---
const $ = id => document.getElementById(id);
const convertBtn = $('convert');
const statusMessage = $('status-message');

// --- ユーザー辞書の読み込み ---
async function loadUserDicts() {
    try {
        const [kanjiRes, kanaRes, grammarRes] = await Promise.all([
            fetch('./data/kanji.json').then(res => res.json()),
            fetch('./data/kana.json').then(res => res.json()),
            fetch('./data/grammar.json').then(res => res.json()),
        ]);
        kanjiDict = kanjiRes;
        kanaDict = kanaRes;
        grammarList = grammarRes;
        statusMessage.textContent = 'ユーザー辞書の読み込みが完了しました。';
    } catch (e) {
        statusMessage.textContent = 'エラー: ユーザー辞書ファイルの読み込みに失敗しました。`./data/`フォルダにJSONファイルがあるか確認してください。';
        console.error(e);
    }
}

// --- 形態素解析器の初期化 ---
async function initTokenizer() {
    statusMessage.textContent = 'Kuromoji.js辞書を初期化中...';
    return new Promise((resolve, reject) => {
        kuromoji.builder({ dicPath: "/dict/" }).build((err, _tokenizer) => {
            if(err) {
                statusMessage.textContent = 'エラー: Kuromojiの辞書初期化に失敗しました。`/dict/`に辞書データがあるか確認してください。';
                reject(err);
            } else {
                tokenizer = _tokenizer;
                statusMessage.textContent = '準備完了です。テキストを入力してください。';
                convertBtn.disabled = false;
                resolve();
            }
        });
    });
}

// --- 変換エンジン ---
function convertText(src) {
    if (!src) return '';
    let result = '';
    const tokens = tokenizer.tokenize(src);

    tokens.forEach(token => {
        let surface = token.surface;
        let converted = surface;

        // 1. 形態素解析の読みを元に仮名辞書を適用
        if ($('opt-kana').checked && kanaDict[token.reading]) {
            converted = kanaDict[token.reading];
        } else if ($('opt-kana').checked && kanaDict[converted]) {
            converted = kanaDict[converted];
        }

        // 2. 漢字辞書を適用
        if ($('opt-kanji').checked && kanjiDict[token.surface]) {
            converted = kanjiDict[token.surface];
        }

        // 3. 文法辞書を適用（正規表現）
        if ($('opt-grammar').checked) {
            grammarList.forEach(g => {
                try {
                    const re = new RegExp(g.from, 'g');
                    converted = converted.replace(re, g.to);
                } catch (e) {
                    console.error('無効な正規表現:', g.from, e);
                }
            });
        }
        result += converted;
    });
    return result;
}

// --- イベントハンドラ ---
document.addEventListener('DOMContentLoaded', async () => {
    await initTokenizer();
    await loadUserDicts();

    $('convert').onclick = () => {
        $('output').value = convertText($('input').value);
    };
    $('clear').onclick = () => {
        $('input').value = '';
        $('output').value = '';
    };
    $('swap').onclick = () => {
        const t = $('input').value;
        $('input').value = $('output').value;
        $('output').value = t;
    };
    $('load-sample').onclick = () => {
        const sample = '今日は私の國學の話をします。私はおもいを語り、明日は學校へ行きます。';
        $('input').value = sample;
        $('output').value = convertText(sample);
    };
});