// --- 変換エンジン（サーバーレス対応、安全版） ---
function convertText(src) {
    if (!src || !tokenizer) return '';

    let result = '';
    let tokens;
    try {
        tokens = tokenizer.tokenize(src);
    } catch (e) {
        console.error('Tokenizer 未初期化または無効な入力:', e);
        return src; // 元の文字列を返す
    }

    tokens.forEach(token => {
        const surface = token?.surface || '';
        let converted = surface;

        // 1. 仮名辞書適用
        if ($('opt-kana').checked && token?.reading) {
            converted = kanaDict[token.reading] || kanaDict[converted] || converted;
        }

        // 2. 漢字辞書適用
        if ($('opt-kanji').checked) {
            converted = kanjiDict[token.surface] || converted;
        }

        // 3. 文法辞書適用（正規表現）
        if ($('opt-grammar').checked && Array.isArray(grammarList)) {
            grammarList.forEach(g => {
                if (!g?.from || !g?.to) return;
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