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

// ヘルパー関数群
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

/**
 * 日本語の文章を分析し、AIが生成した可能性を判定します。
 */
function analyzeAIStyle(text) {
    const length = text.length || 1;
    let aiScore = 50;
    
    // スコア調整を統一的に行うヘルパー関数
    const addScore = (key, value, text, morphemes = null) => {
        const weights = {
            'punctuationRate': 25, 'connectorCount': 15, 'sentenceEndSetSize': 20,
            'bracketsCount': 10, 'mixedNumber': 15, 'markdownRate': 20,
            'nounRateAI': 30, 'nounRateHuman': 30, 'particleVariety': 35,
            'complexConnectors': 25, 'idiomCount': 35, 'sentenceEndVariety': 25,
            'shortText': 20, 'jargonCount': 30, 'grammaticalErrors': -20
        };
        const weight = weights[key] || 1;
        aiScore += value * weight;
        if (text.length < 50) aiScore += 10;
    };

    // 1. 基本的な文字・記号の分析
    const punctuationRate = (text.match(/[。、]/g) || []).length / length;
    const connectors = ["しかし", "したがって", "また", "そして", "さらに"];
    const connectorCount = countPhrases(text, connectors);
    const bracketsCount = (text.match(/[（）「」『』]/g) || []).length;
    const hasKanjiNum = /[一二三四五六七八九十]/.test(text) ? 1 : 0;
    const hasArabicNum = /[0-9]/.test(text) ? 1 : 0;
    const mixedNumber = hasKanjiNum && hasArabicNum ? 1 : 0;
    const markdownCount = (text.match(/[#*_`>-]/g) || []).length;
    const markdownRate = markdownCount / length;

    if (punctuationRate > 0.02) addScore('punctuationRate', 1, text);
    else if (punctuationRate < 0.005) addScore('punctuationRate', 1, text);
    else addScore('punctuationRate', -1, text);

    if (connectorCount > 2) addScore('connectorCount', 1, text);
    else addScore('connectorCount', -1, text);

    if (bracketsCount > 3) addScore('bracketsCount', 1, text);
    else addScore('bracketsCount', -1, text);

    if (mixedNumber > 0) addScore('mixedNumber', 1, text);
    else addScore('mixedNumber', -1, text);

    if (markdownRate > 0.01) addScore('markdownRate', 1, text);
    else addScore('markdownRate', -1, text);

    // 2. 形態素解析による高度な分析を強化
    const morphemes = tokenizer.tokenize(text);
    if (morphemes && morphemes.length > 10) {
        const nounRate = countMorpheme(morphemes, '名詞') / morphemes.length;
        if (nounRate > 0.45) addScore('nounRateAI', 1, text, morphemes);
        else if (nounRate < 0.2) addScore('nounRateHuman', 1, text, morphemes);
        else addScore('nounRateAI', -1, text, morphemes);

        const particleVariety = new Set(morphemes.filter(m => m.pos === '助詞').map(m => m.surface_form)).size;
        const totalParticles = countMorpheme(morphemes, '助詞');
        if (totalParticles > 0 && particleVariety / totalParticles < 0.4) {
            addScore('particleVariety', 1, text, morphemes);
        } else {
            addScore('particleVariety', -1, text, morphemes);
        }

        const idioms = ["猫の手も借りたい", "雨後の筍", "情けは人のためならず", "顔が広い", "喉から手が出る"];
        const idiomCount = countPhrases(text, idioms);
        addScore('idiomCount', idiomCount > 0 ? -1 : 1, text, morphemes);

        const complexConnectors = ["その一方で", "したがって", "具体的には", "一般的に", "鑑みるに", "総じて"];
        const complexConnectorCount = countPhrases(text, complexConnectors);
        if (complexConnectorCount > 0) addScore('complexConnectors', 1, text, morphemes);
        else addScore('complexConnectors', -1, text, morphemes);
        
        const sentenceEndVariety = analyzeSentenceEndVariety(text);
        if (sentenceEndVariety < 3) addScore('sentenceEndVariety', 1, text, morphemes);
        else addScore('sentenceEndVariety', -1, text, morphemes);

        const jargonList = ["アルゴリズム", "プロトコル", "パラダイム", "メタデータ", "フレームワーク", "イノベーション", "レガシー"];
        const jargonCount = countPhrases(text, jargonList);
        if (jargonCount > 0) addScore('jargonCount', 1, text, morphemes);
        else addScore('jargonCount', -1, text, morphemes);

        // 人間特有の非文法的な表現を検出
        const casualEnds = ["だよね", "じゃん", "みたいな"];
        const hasCasualEnd = casualEnds.some(end => text.includes(end));
        if (hasCasualEnd) aiScore -= 30;

    } else {
        addScore('shortText', 1, text, morphemes);
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
