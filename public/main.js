// --- グローバル変数 ---
let kanjiDict = {};
let kanaDict = {};
let grammarList = {};
let tokenizer = null;

// --- DOM ---
const $ = id => document.getElementById(id);
const convertBtn = $('convert');
const statusMessage = $('status-message');

// --- ユーザー辞書の読み込み ---
async function loadUserDicts() {
    try {
        const [kanjiRes, kanaRes, grammarRes] = await Promise.all([
            fetch('/api/abcd?type=data&file=kanji.json').then(r => r.json()),
            fetch('/api/abcd?type=data&file=kana.json').then(r => r.json()),
            fetch('/api/abcd?type=data&file=grammar.json').then(r => r.json())
        ]);
        kanjiDict = kanjiRes;
        kanaDict = kanaRes;
        grammarList = grammarRes;
        statusMessage.textContent = 'ユーザー辞書の読み込みが完了しました。';
    } catch (e) {
        console.error(e);
        statusMessage.textContent = 'ユーザー辞書の読み込みに失敗しました';
    }
}

// --- 形態素解析器の初期化 ---
async function initTokenizer() {
    statusMessage.textContent = 'Kuromoji.js辞書を初期化中...';
    return new Promise(resolve => {
        const baseFiles = ['base.dat.gz', 'cc.dat.gz', 'tid.dat.gz', 'tid_map.dat.gz', 'tid_pos.dat.gz', 'unk.dat.gz', 'unk_char.dat.gz', 'unk_compat.dat.gz', 'unk_invoke.dat.gz', 'unk_map.dat.gz', 'unk_pos.dat.gz'];
        let index = 0;

        const fetchDic = () => {
            if (index >= baseFiles.length) {
                statusMessage.textContent = '準備完了です。';
                convertBtn.disabled = false;
                resolve();
                return;
            }
            const file = baseFiles[index++];
            const url = `/api/abcd?type=dict&file=${file}`;
            fetch(url)
                .then(r => r.arrayBuffer())
                .then(() => fetchDic()) // 実際の Kuromoji 内部で使う場合は arrayBuffer を渡す
                .catch(e => {
                    console.error('辞書取得失敗:', file, e);
                    fetchDic(); // 失敗しても次に進む
                });
        };

        fetchDic();
    });
}

// --- 変換エンジン ---
function convertText(src) {
    if (!src || !tokenizer) return '';
    let result = '';
    const tokens = tokenizer.tokenize(src);

    tokens.forEach(token => {
        const surface = token?.surface || '';
        let converted = surface;

        if ($('opt-kana').checked && token?.reading) {
            converted = kanaDict[token.reading] || kanaDict[converted] || converted;
        }
        if ($('opt-kanji').checked) {
            converted = kanjiDict[token.surface] || converted;
        }
        if ($('opt-grammar').checked && Array.isArray(grammarList)) {
            grammarList.forEach(g => {
                if (!g?.from || !g?.to) return;
                try { converted = converted.replace(new RegExp(g.from, 'g'), g.to); }
                catch(e) { console.error('無効な正規表現:', g.from, e); }
            });
        }

        result += converted;
    });

    return result;
}

// --- イベント ---
document.addEventListener('DOMContentLoaded', async () => {
    await initTokenizer();
    await loadUserDicts();

    $('convert').onclick = () => $('output').value = convertText($('input').value);
    $('clear').onclick = () => { $('input').value = ''; $('output').value = ''; };
    $('swap').onclick = () => { const t = $('input').value; $('input').value = $('output').value; $('output').value = t; };
    $('load-sample').onclick = () => {
        const sample = '今日は私の國學の話をします。私はおもいを語り、明日は學校へ行きます。';
        $('input').value = sample;
        $('output').value = convertText(sample);
    };
});