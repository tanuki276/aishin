// kuromoji.jsの初期化を一度だけ実行
let tokenizer = null;
const analyzeBtn = document.getElementById('analyzeBtn');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');

// 読み込み中のプログレスバーをアニメーションさせる関数
function animateProgressBar() {
    progressContainer.style.display = 'block';
    
    let progress = 0;
    const update = () => {
        // 95%で一旦止めて、完了を待つ
        if (progress < 95) {
            progress += Math.random() * 2;
            if (progress > 95) progress = 95;
            progressBar.style.width = `${progress}%`;
            progressText.textContent = `ライブラリをダウンロードしています... ${Math.floor(progress)}%`;
            requestAnimationFrame(update);
        }
    };
    requestAnimationFrame(update);
}

// kuromoji.jsの初期化
analyzeBtn.textContent = '辞書ダウンロード中...';
animateProgressBar();

kuromoji.builder({ dicPath: './dict/' }).build(function (err, _tokenizer) {
    if (err) {
        console.error('ライブラリの初期化に失敗しました:', err);
        analyzeBtn.textContent = '初期化失敗';
        progressContainer.style.display = 'none';
        return;
    }
    tokenizer = _tokenizer;
    progressBar.style.width = '100%';
    progressText.textContent = `ライブラリのダウンロードは一度だけです。準備完了！`;
    analyzeBtn.textContent = '判定する';
    analyzeBtn.disabled = false;
    setTimeout(() => {
        progressContainer.style.display = 'none';
    }, 2000);
});

function countMorpheme(morphemes, partOfSpeech) {
    return morphemes.filter(m => m.pos === partOfSpeech).length;
}

function countPhrases(text, phrases) {
    let count = 0;
    phrases.forEach(phrase => {
        const regex = new RegExp(phrase, "g");
        count += (text.match(regex) || []).length;
    });
    return count;
}

function analyzeSentenceEndVariety(text) {
    const sentences = text.split(/[。！？]/);
    const uniqueEnds = new Set();
    sentences.forEach(s => {
        s = s.trim();
        if (s.length > 0) {
            const lastTwoChars = s.slice(-2);
            uniqueEnds.add(lastTwoChars);
        }
    });
    return uniqueEnds.size;
}

function analyzeAIStyle(text) {
    const length = text.length || 1;
    let aiScore = 50;
    
    const addScore = (key, value, text) => {
        const weights = {
            'punctuationRate': 20, 'spaceRate': 20, 'connectorCount': 10,
            'bracketsCount': 3, 'mixedNumber': 8, 'markdownRate': 15,
            'nounRateAI': 25, 'nounRateHuman': 25, 'particleUsageAI': 30,
            'complexConnectors': 20, 'idiomCount': 30, 'sentenceEndVariety': 15,
            'shortText': 15, 'simpleSentenceEnd': 25, 'diverseSentenceEnd': 25,
            'complexSentenceStructure': 20, 'specializedTerms': 20,
            'excessivePunctuation': 15, 'balancedConnectors': 15
        };
        const weight = weights[key] || 1;
        aiScore += value * weight;
        if (text.length < 50) aiScore += 10;
    };

    // 1. 基本的な文字・記号の分析を強化
    const punctuationRate = (text.match(/、/g) || []).length / length;
    const spaceRate = (text.match(/ /g) || []).length / length;
    const connectors = ["しかし", "だから", "つまり", "そして", "ところで"];
    const connectorCount = countPhrases(text, connectors);
    const bracketsCount = (text.match(/[（）]/g) || []).length;
    const hasKanjiNum = /[一二三四五六七八九十]/.test(text) ? 1 : 0;
    const hasArabicNum = /[0-9]/.test(text) ? 1 : 0;
    const mixedNumber = hasKanjiNum && hasArabicNum ? 1 : 0;
    const markdownSymbols = /[#*_`>-]/g;
    const markdownCount = (text.match(markdownSymbols) || []).length;
    const markdownRate = markdownCount / length;

    addScore('punctuationRate', punctuationRate > 0.015 ? 1 : -1, text);
    addScore('spaceRate', spaceRate > 0.01 ? 1 : -1, text);
    addScore('connectorCount', connectorCount > 0 ? 1 : -1, text);
    addScore('bracketsCount', bracketsCount > 2 ? 1 : -1, text);
    addScore('mixedNumber', mixedNumber > 0 ? 1 : -1, text);
    addScore('markdownRate', markdownRate > 0.01 ? 1 : -1, text);
    addScore('excessivePunctuation', (text.match(/[！？…]/g) || []).length > 2 ? -1 : 1, text);

    // 2. 形態素解析による高度な分析を強化
    const morphemes = tokenizer.tokenize(text);
    if (morphemes && morphemes.length > 10) {
        const nounRate = countMorpheme(morphemes, '名詞') / morphemes.length;
        if (nounRate > 0.45) addScore('nounRateAI', 1, text);
        else if (nounRate < 0.2) addScore('nounRateHuman', 1, text);
        else addScore('nounRateAI', -1, text);

        const particleUsage = (morphemes.filter(m => m.pos === '助詞' && (m.surface_form === 'について' || m.surface_form === 'によって')).length / morphemes.filter(m => m.pos === '助詞').length) || 0;
        if (particleUsage > 0.1) addScore('particleUsageAI', 1, text);
        else addScore('particleUsageAI', -1, text);

        const idioms = ["猫の手も借りたい", "雨後の筍", "情けは人のためならず", "顔が広い", "喉から手が出る"];
        const idiomCount = countPhrases(text, idioms);
        addScore('idiomCount', idiomCount > 0 ? -1 : 1, text);

        const complexConnectors = ["その一方で", "したがって", "具体的には", "一般的に", "鑑みるに", "総じて"];
        const complexConnectorCount = countPhrases(text, complexConnectors);
        if (complexConnectorCount > 0) addScore('complexConnectors', 1, text);
        else addScore('complexConnectors', -1, text);
        
        const simpleConnectors = ["しかし", "そして", "だから"];
        const simpleConnectorCount = countPhrases(text, simpleConnectors);
        if (simpleConnectorCount > 0) addScore('balancedConnectors', -1, text);
        else addScore('balancedConnectors', 1, text);

        const sentenceEndVariety = analyzeSentenceEndVariety(text);
        if (sentenceEndVariety < 3) addScore('simpleSentenceEnd', 1, text);
        else addScore('diverseSentenceEnd', -1, text);

        const specializedTerms = ["アルゴリズム", "プロトコル", "パラダイム", "メタデータ", "フレームワーク"];
        const specializedTermCount = countPhrases(text, specializedTerms);
        if (specializedTermCount > 0) addScore('specializedTerms', 1, text);
        else addScore('specializedTerms', -1, text);

    } else {
        addScore('shortText', 1, text);
    }

    // スコアの最終調整
    aiScore = Math.max(0, Math.min(100, aiScore));
    const humanScore = 100 - aiScore;

    return {
        aiPercent: aiScore.toFixed(1),
        humanPercent: humanScore.toFixed(1),
    };
}

// イベントリスナー
document.getElementById('analyzeBtn').addEventListener('click', () => {
    const inputText = document.getElementById('inputText').value.trim();
    if (!inputText) {
        alert('文章を入力してください');
        return;
    }

    if (!tokenizer) {
        alert('形態素解析がまだ準備できていません。しばらくお待ちください。');
        return;
    }

    const result = analyzeAIStyle(inputText);
    document.getElementById('aiScore').textContent = result.aiPercent;
    document.getElementById('humanScore').textContent = result.humanPercent;
    document.getElementById('result').style.display = 'block';
});
