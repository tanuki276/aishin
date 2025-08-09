let tokenizer = null;
const analyzeBtn = document.getElementById('analyzeBtn');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const resultsDiv = document.getElementById('result');
const inputText = document.getElementById('inputText');
let chartInstance = null;

// プログレスバーアニメーション
function animateProgressBar() {
    progressContainer.style.display = 'block';
    let progress = 0;
    const update = () => {
        if (progress < 95) {
            progress += Math.random() * 5;
            if (progress > 95) progress = 95;
            progressBar.style.width = `${progress}%`;
            progressText.textContent = `ライブラリをダウンロードしています... ${Math.floor(progress)}%`;
            requestAnimationFrame(update);
        }
    };
    requestAnimationFrame(update);
}

// Kuromoji初期化
function initializeTokenizer() {
    return new Promise((resolve, reject) => {
        analyzeBtn.textContent = '辞書ダウンロード中...';
        analyzeBtn.disabled = true;
        animateProgressBar();
        kuromoji.builder({ dicPath: 'https://unpkg.com/kuromoji@0.1.2/dict/' }).build((err, _tokenizer) => {
            if (err) {
                progressContainer.style.display = 'none';
                analyzeBtn.textContent = '初期化失敗';
                resultsDiv.innerHTML = `<p class="error">エラー: 辞書ファイルの読み込みに失敗しました。ネットワークを確認してください。</p>`;
                reject(err);
                return;
            }
            tokenizer = _tokenizer;
            progressBar.style.width = '100%';
            progressText.textContent = '準備完了！';
            analyzeBtn.textContent = '判定する';
            analyzeBtn.disabled = false;
            setTimeout(() => progressContainer.style.display = 'none', 1000);
            resolve();
        });
    });
}

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
        const regex = new RegExp(phrase, 'g');
        count += (text.match(regex) || []).length;
    });
    return count;
}

// 特徴量抽出
function extractFeatures(text) {
    const morphemes = tokenizer.tokenize(text);
    if (!morphemes || morphemes.length < 3) {
        return null; // 短すぎる場合はnull
    }
    const totalMorphemes = morphemes.length;

    // 語彙の多様度 (TTR)
    const uniqueWords = new Set(morphemes.map(m => m.surface_form));
    const ttr = uniqueWords.size / totalMorphemes;

    // 品詞比率
    const nounRatio = countMorpheme(morphemes, '名詞') / totalMorphemes;
    const verbRatio = countMorpheme(morphemes, '動詞') / totalMorphemes;
    const adjectiveRatio = countMorpheme(morphemes, '形容詞') / totalMorphemes;
    const particleRatio = countMorpheme(morphemes, '助詞') / totalMorphemes;
    const properNounRatio = countSubMorpheme(morphemes, '固有名詞') / totalMorphemes;

    // 文の複雑さ
    const sentences = text.split(/[。！？]/).filter(s => s.trim().length > 0);
    const averageSentenceLength = sentences.length > 0 ? text.length / sentences.length : 0;
    const sentenceLengthStdDev = sentences.length > 1
        ? Math.sqrt(sentences.map(s => Math.pow(s.length - averageSentenceLength, 2)).reduce((a, b) => a + b, 0) / sentences.length)
        : 0;

    // 接続詞
    const connectors = ['しかし', 'したがって', 'また', 'そして', 'さらに', 'ゆえに', '一方で'];
    const complexConnectors = ['その一方で', '具体的には', '鑑みるに', '加えて'];
    const connectorCount = countPhrases(text, [...connectors, ...complexConnectors]);
    const connectorRatio = totalMorphemes > 0 ? connectorCount / totalMorphemes : 0;

    // メタ表現とリズミカルな表現
    const metaPhrases = ['AIの文章', 'この記事では', '本稿では', '以下に説明する'];
    const rhythmicRepetitions = ['とても.*とても', '考えた。.*考えた。'];
    const hasMetaPhrase = countPhrases(text, metaPhrases) > 0;
    const hasRhythmicRepetition = countPhrases(text, rhythmicRepetitions) > 0;

    return {
        ttr,
        nounRatio,
        verbRatio,
        adjectiveRatio,
        properNounRatio,
        averageSentenceLength,
        sentenceLengthStdDev,
        connectorRatio,
        hasMetaPhrase,
        hasRhythmicRepetition
    };
}

// AI vs 人間のスコアリング
function calculateScore(features) {
    if (!features) return { ai: 50, human: 50 }; // 短文すぎる場合は中立

    let aiScore = 0;
    let humanScore = 0;

    // TTR: 人間は0.45〜0.65、AIは低め
    aiScore += features.ttr < 0.45 ? 20 : 0;
    humanScore += features.ttr >= 0.45 && features.ttr <= 0.65 ? 20 : 0;

    // 名詞比率: AIは高め
    aiScore += features.nounRatio > 0.4 ? 15 : 0;
    humanScore += features.nounRatio <= 0.4 ? 15 : 0;

    // 固有名詞: 人間は多め
    humanScore += features.properNounRatio > 0.05 ? 15 : 0;
    aiScore += features.properNounRatio <= 0.05 ? 15 : 0;

    // 文長のばらつき: 人間は大きめ
    humanScore += features.sentenceLengthStdDev > 10 ? 15 : 0;
    aiScore += features.sentenceLengthStdDev <= 10 ? 15 : 0;

    // 接続詞: AIは高め
    aiScore += features.connectorRatio > 0.03 ? 15 : 0;
    humanScore += features.connectorRatio <= 0.03 ? 15 : 0;

    // メタ表現: AIに多い
    aiScore += features.hasMetaPhrase ? 20 : 0;
    humanScore += !features.hasMetaPhrase ? 20 : 0;

    // 合計を正規化してパーセンテージに
    const total = aiScore + humanScore;
    if (total === 0) return { ai: 50, human: 50 }; // 極端な場合の中立
    return {
        ai: Math.round((aiScore / total) * 100),
        human: Math.round((humanScore / total) * 100)
    };
}

// グラフ描画
function renderChart(scores) {
    if (chartInstance) chartInstance.destroy();
    const ctx = document.getElementById('resultChart').getContext('2d');
    chartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['AI生成', '人間'],
            datasets: [{
                label: '確率 (%)',
                data: [scores.ai, scores.human],
                backgroundColor: ['#ff6384', '#36a2eb'],
                borderColor: ['#ff6384', '#36a2eb'],
                borderWidth: 1
            }]
        },
        options: {
            scales: { y: { beginAtZero: true, max: 100 } },
            plugins: { legend: { display: false } }
        }
    });
}

// 分析実行
analyzeBtn.addEventListener('click', async () => {
    const text = inputText.value.trim();
    if (!text) {
        resultsDiv.innerHTML = '<p class="error">文章を入力してください。</p>';
        return;
    }
    if (!tokenizer) {
        resultsDiv.innerHTML = '<p class="error">形態素解析が準備できていません。しばらくお待ちください。</p>';
        return;
    }

    // Web Workerで重い処理をオフロード
    const worker = new Worker(URL.createObjectURL(new Blob([`
        ${extractFeatures.toString()}
        ${countMorpheme.toString()}
        ${countSubMorpheme.toString()}
        ${countPhrases.toString()}
        self.onmessage = (e) => {
            const features = extractFeatures(e.data.text);
            self.postMessage(features);
        };
    `], { type: 'text/javascript' })));

    worker.postMessage({ text, tokenizer });
    worker.onmessage = (e) => {
        const features = e.data;
        if (!features) {
            resultsDiv.innerHTML = '<p class="error">文章が短すぎます。もう少し長い文章を入力してください。</p>';
            worker.terminate();
            return;
        }

        const scores = calculateScore(features);
        resultsDiv.innerHTML = `
            <h3>判定結果</h3>
            <p><strong>AI生成:</strong> ${scores.ai}%</p>
            <p><strong>人間:</strong> ${scores.human}%</p>
            <h4>特徴量</h4>
            <p>語彙の多様度 (TTR): ${features.ttr.toFixed(4)} (人間: 0.45〜0.65)</p>
            <p>名詞比率: ${features.nounRatio.toFixed(4)} (AI: 高め)</p>
            <p>動詞比率: ${features.verbRatio.toFixed(4)}</p>
            <p>形容詞比率: ${features.adjectiveRatio.toFixed(4)}</p>
            <p>固有名詞比率: ${features.properNounRatio.toFixed(4)} (人間: 高め)</p>
            <p>平均文長: ${features.averageSentenceLength.toFixed(2)}</p>
            <p>文長の標準偏差: ${features.sentenceLengthStdDev.toFixed(2)} (人間: 大きめ)</p>
            <p>接続詞比率: ${features.connectorRatio.toFixed(4)} (AI: 高め)</p>
            <p>メタな表現: ${features.hasMetaPhrase ? 'あり' : 'なし'}</p>
            <p>リズミカルな反復: ${features.hasRhythmicRepetition ? 'あり' : 'なし'}</p>
        `;
        resultsDiv.style.display = 'block';
        renderChart(scores);
        worker.terminate();
    };
});

// 初期化実行
initializeTokenizer();