// --- 変換エンジン ---
function convertText(src) {
    if (!src || !tokenizer) return '';
    let result = '';
    const tokens = tokenizer.tokenize(src);

    tokens.forEach(token => {
        let surface = token.surface || '';
        let converted = surface;

        // 1. 形態素解析の読みを元に仮名辞書を適用
        if ($('opt-kana').checked && token.reading && kanaDict[token.reading]) {
            converted = kanaDict[token.reading] || converted;
        } else if ($('opt-kana').checked && kanaDict[converted]) {
            converted = kanaDict[converted] || converted;
        }

        // 2. 漢字辞書を適用
        if ($('opt-kanji').checked && kanjiDict[token.surface]) {
            converted = kanjiDict[token.surface] || converted;
        }

        // 3. 文法辞書を適用（正規表現）
        if ($('opt-grammar').checked && Array.isArray(grammarList)) {
            grammarList.forEach(g => {
                if (!g || !g.from || !g.to) return; // undefined 回避
                try {
                    const re = new RegExp(g.from, 'g');
                    converted = converted.replace(re, g.to);
                } catch (e) {
                    console.error('無効な正規表現:', g.from, e);
                }
            });
        }

        result += converted || '';
    });

    return result;
}