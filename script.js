// kuromoji.jsの初期化を一度だけ実行
let tokenizer = null;
const analyzeBtn = document.getElementById('analyzeBtn');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const resultsDiv = document.getElementById('result');

// プログレスバーのアニメーション
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

// kuromoji.jsの初期化 (Promise化してモダンな非同期処理に)
async function initializeTokenizer() {
    return new Promise((resolve, reject) => {
        analyzeBtn.textContent = '辞書ダウンロード中...';
        animateProgressBar();
        kuromoji.builder({ dicPath: './dict/' }).build(function (err, _tokenizer) {
            if (err) {
                console.error('ライブラリの初期化に失敗しました:', err);
                analyzeBtn.textContent = '初期化失敗';
                progressContainer.style.display = 'none';
                reject(err);
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
            resolve();
        });
    });
}
initializeTokenizer();

// ヘルパー関数
function countMorpheme(morphemes, partOfSpeech) {
    return morphemes.filter(m => m.pos === partOfSpeech).length;
}

function countSubMorpheme(morphemes, subPartOfSpeech) {
    return morphemes.filter(m => m.pos_detail_1 === subPartOfSpeech).length;
}

function countPhrases(text, phrases) {
    let count = 0;
    phrases.forEach(phrase => {
        const regex = new RegExp(phrase, "g");
        count += (text.match(regex) || []).length;
    });
    return count;
}

// 特徴量抽出ロジック
function extractFeatures(text) {
    const morphemes = tokenizer.tokenize(text);
    if (!morphemes || morphemes.length === 0) {
        return null;
    }
    const totalMorphemes = morphemes.length;

    const allWords = morphemes.map(m => m.surface_form);
    const uniqueWords = new Set(allWords);
    const ttr = uniqueWords.size / totalMorphemes;
    const nounRatio = countMorpheme(morphemes, '名詞') / totalMorphemes;
    const verbRatio = countMorpheme(morphemes, '動詞') / totalMorphemes;
    const adjectiveRatio = countMorpheme(morphemes, '形容詞') / totalMorphemes;
    const properNounRatio = countSubMorpheme(morphemes, '固有名詞') / totalMorphemes;
    const sentences = text.split(/[。！？]/).filter(s => s.trim().length > 0);
    const averageSentenceLength = sentences.length > 0 ? text.length / sentences.length : 0;
    const sentenceLengthStdDev = sentences.length > 1 ?
        Math.sqrt(sentences.map(s => Math.pow(s.length - averageSentenceLength, 2)).reduce((a, b) => a + b) / sentences.length)
        : 0;
    const connectors = ["しかし", "したがって", "また", "そして", "さらに"];
    const complexConnectors = ["その一方で", "具体的には", "鑑みるに"];
    const connectorCount = countPhrases(text, connectors) + countPhrases(text, complexConnectors);
    const connectorRatio = connectorCount / totalMorphemes;
    const metaPhrases = ["AIの文章", "この記事では", "本稿では"];
    const hasMetaPhrase = countPhrases(text, metaPhrases) > 0;
    const rhythmicRepetitions = ["こわかった。 さびしかった。 とてもかなしかった。", "考えた。 うんと考えた。"];
    const hasRhythmicRepetition = countPhrases(text, rhythmicRepetitions) > 0;

    return {
        ttr, nounRatio, verbRatio, adjectiveRatio, properNounRatio,
        averageSentenceLength, sentenceLengthStdDev, connectorRatio,
        hasMetaPhrase, hasRhythmicRepetition
    };
}

// AI判定ロジック (特徴量に基づいてスコアを算出)
function analyzeAIStyle(features) {
    let aiScore = 50; // 基準点を50%に設定

    // TTR: AIは高くなりがち。人間の範囲(0.45〜0.65)から外れると加点
    if (features.ttr < 0.4 || features.ttr > 0.7) aiScore += 10;
    else aiScore -= 5;

    // 名詞比率: AIは高くなりがち。
    if (features.nounRatio > 0.35) aiScore += 10;
    else if (features.nounRatio < 0.2) aiScore -= 10;

    // 固有名詞比率: AIは低くなりがち。
    if (features.properNounRatio < 0.001) aiScore += 10;
    else aiScore -= 5;
    
    // 文長の標準偏差: 人間はばらつきが大きい。標準偏差が低いとAIの可能性。
    if (features.sentenceLengthStdDev < 5) aiScore += 10;
    else aiScore -= 5;

    // 接続詞比率: AIは論理的な接続詞を使いがち。
    if (features.connectorRatio > 0.01) aiScore += 10;
    
    // メタな表現: AIが人間を装う際に使うことがあるため加点。
    if (features.hasMetaPhrase) aiScore += 20;

    // リズミカルな反復表現: 人間の作家が使う表現のため減点。
    if (features.hasRhythmicRepetition) aiScore -= 20;

    aiScore = Math.max(0, Math.min(100, aiScore));
    const humanScore = 100 - aiScore;

    return {
        aiPercent: aiScore.toFixed(1),
        humanPercent: humanScore.toFixed(1),
    };
}

analyzeBtn.addEventListener('click', async () => {
    const inputText = document.getElementById('inputText').value.trim();
    if (!inputText) {
        alert('文章を入力してください');
        return;
    }

    if (!tokenizer) {
        alert('形態素解析がまだ準備できていません。しばらくお待ちください。');
        return;
    }

    const features = extractFeatures(inputText);
    if (!features) {
        resultsDiv.innerHTML = '<p>分析できませんでした。より長い文章を入力してください。</p>';
        return;
    }

    const result = analyzeAIStyle(features);

    // 結果表示を「AI〇〇%と人間〇〇%」に絞り込む
    resultsDiv.innerHTML = `
        <h3>AI判定結果</h3>
        <p><strong>AI生成度:</strong> ${result.aiPercent}%</p>
        <p><strong>人間度:</strong> ${result.humanPercent}%</p>
    `;
    
    resultsDiv.style.display = 'block';
});
