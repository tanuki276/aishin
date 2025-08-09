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
function initializeTokenizer() {
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

// 新しい特徴量抽出ロジック
function extractFeatures(text) {
    const morphemes = tokenizer.tokenize(text);
    if (!morphemes || morphemes.length === 0) {
        return null;
    }

    const totalMorphemes = morphemes.length;

    // 1. 語彙の多様度 (Type-Token Ratio)
    const allWords = morphemes.map(m => m.surface_form);
    const uniqueWords = new Set(allWords);
    const ttr = uniqueWords.size / totalMorphemes;

    // 2. 品詞別の出現比率
    const nounRatio = countMorpheme(morphemes, '名詞') / totalMorphemes;
    const verbRatio = countMorpheme(morphemes, '動詞') / totalMorphemes;
    const adjectiveRatio = countMorpheme(morphemes, '形容詞') / totalMorphemes;
    const particleRatio = countMorpheme(morphemes, '助詞') / totalMorphemes;
    
    // 3. 固有名詞の比率 (AIは固有名詞を避ける傾向)
    const properNounRatio = countSubMorpheme(morphemes, '固有名詞') / totalMorphemes;

    // 4. 文の複雑さ
    const sentences = text.split(/[。！？]/).filter(s => s.trim().length > 0);
    const averageSentenceLength = sentences.length > 0 ? text.length / sentences.length : 0;
    const sentenceLengthStdDev = sentences.length > 1 ?
        Math.sqrt(sentences.map(s => Math.pow(s.length - averageSentenceLength, 2)).reduce((a, b) => a + b) / sentences.length)
        : 0;
    
    // 5. 接続詞の多様性と頻度
    const connectors = ["しかし", "したがって", "また", "そして", "さらに"];
    const complexConnectors = ["その一方で", "具体的には", "鑑みるに"];
    const connectorCount = countPhrases(text, connectors) + countPhrases(text, complexConnectors);
    const connectorRatio = connectorCount / totalMorphemes;

    // 6. メタな表現の有無
    const metaPhrases = ["AIの文章", "この記事では", "本稿では"];
    const hasMetaPhrase = countPhrases(text, metaPhrases) > 0;

    // 7. リズミカルな反復表現 (スイミーのような文章に特徴的)
    const rhythmicRepetitions = ["こわかった。 さびしかった。 とてもかなしかった。", "考えた。 うんと考えた。"];
    const hasRhythmicRepetition = countPhrases(text, rhythmicRepetitions) > 0;

    return {
        ttr: ttr.toFixed(4),
        nounRatio: nounRatio.toFixed(4),
        verbRatio: verbRatio.toFixed(4),
        adjectiveRatio: adjectiveRatio.toFixed(4),
        properNounRatio: properNounRatio.toFixed(4),
        averageSentenceLength: averageSentenceLength.toFixed(2),
        sentenceLengthStdDev: sentenceLengthStdDev.toFixed(2),
        connectorRatio: connectorRatio.toFixed(4),
        hasMetaPhrase: hasMetaPhrase,
        hasRhythmicRepetition: hasRhythmicRepetition
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

    // 結果表示
    resultsDiv.innerHTML = `
        <h3>AI判定に利用できる特徴量</h3>
        <p><strong>語彙の多様度 (TTR):</strong> ${features.ttr} <br>
           ※ 人間は一般的に0.45〜0.65程度</p>
        <p><strong>名詞比率:</strong> ${features.nounRatio} <br>
           ※ AIは高くなりがち</p>
        <p><strong>動詞比率:</strong> ${features.verbRatio} </p>
        <p><strong>形容詞比率:</strong> ${features.adjectiveRatio} </p>
        <p><strong>固有名詞比率:</strong> ${features.properNounRatio} <br>
           ※ AIは低くなりがち</p>
        <p><strong>平均文長:</strong> ${features.averageSentenceLength} <br>
           ※ AIは一定の長さに収束しがち</p>
        <p><strong>文長の標準偏差:</strong> ${features.sentenceLengthStdDev} <br>
           ※ 人間はばらつきが大きい</p>
        <p><strong>接続詞比率:</strong> ${features.connectorRatio} </p>
        <p><strong>メタな表現の有無:</strong> ${features.hasMetaPhrase ? 'あり' : 'なし'} </p>
        <p><strong>リズミカルな反復表現の有無:</strong> ${features.hasRhythmicRepetition ? 'あり' : 'なし'} </p>
    `;
    
    resultsDiv.style.display = 'block';
});

