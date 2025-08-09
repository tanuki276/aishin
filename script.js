Let tokenizer = null;
const analyzeBtn = document.getElementById('analyzeBtn');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const resultsDiv = document.getElementById('result');
const inputText = document.getElementById('inputText');
const aiScore = document.getElementById('aiScore');
const humanScore = document.getElementById('humanScore');

// プログレスバー（擬似進行）
function animateProgressBar() {
    progressContainer.style.display = 'block';
    let progress = 0;
    const update = () => {
        if (progress < 95) {
            progress += Math.random() * 10;
            if (progress > 95) progress = 95;
            progressBar.style.width = `${progress}%`;
            progressText.textContent = `${Math.floor(progress)}%`;
            requestAnimationFrame(update);
        }
    };
    requestAnimationFrame(update);
}

// Kuromoji初期化（リトライ付き）
function initializeTokenizer(retryCount = 0, maxRetries = 3) {
    return new Promise((resolve, reject) => {
        analyzeBtn.textContent = `準備中... (試行${retryCount + 1}/${maxRetries})`;
        analyzeBtn.disabled = true;
        animateProgressBar();
        const dicPath = './dict/'; // ローカル辞書パス
        try {
            kuromoji.builder({ dicPath }).build((err, _tokenizer) => {
                if (err) {
                    progressContainer.style.display = 'none';
                    if (retryCount < maxRetries - 1) {
                        console.warn(`初期化失敗、リトライ ${retryCount + 2}/${maxRetries}:`, err);
                        setTimeout(() => initializeTokenizer(retryCount + 1, maxRetries).then(resolve).catch(reject), 1000);
                        return;
                    }
                    analyzeBtn.textContent = '初期化失敗';
                    let errorMsg = 'エラー: 辞書ファイルの読み込みに失敗しました。';
                    if (err.message.includes('not found')) errorMsg += ' ./dict/フォルダ内のファイルを確認してください。';
                    else if (err.message.includes('CORS')) errorMsg += ' CORSエラー。ローカルサーバー（例: python -m http.server）で実行してください。';
                    else errorMsg += ` 詳細: ${err.message}`;
                    resultsDiv.innerHTML = `<p class="error">${errorMsg}</p>`;
                    resultsDiv.style.display = 'block';
                    console.error('Kuromojiエラー:', err);
                    reject(err);
                    return;
                }
                tokenizer = _tokenizer;
                progressBar.style.width = '100%';
                progressText.textContent = '100%';
                analyzeBtn.textContent = '分析する';
                analyzeBtn.disabled = false;
                setTimeout(() => progressContainer.style.display = 'none', 1000);
                resolve();
            });
        } catch (err) {
            progressContainer.style.display = 'none';
            analyzeBtn.textContent = '初期化失敗';
            resultsDiv.innerHTML = `<p class="error">エラー: Kuromojiの初期化に失敗しました。CDN（kuromoji.js）または./dict/を確認してください。詳細: ${err.message}</p>`;
            resultsDiv.style.display = 'block';
            console.error('Kuromoji初期化エラー:', err);
            reject(err);
        }
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

// 【強化】特徴量抽出
function extractFeatures(text) {
    try {
        const morphemes = tokenizer.tokenize(text);
        if (!morphemes || morphemes.length < 3) {
            return null;
        }
        const totalMorphemes = morphemes.length;

        const uniqueWords = new Set(morphemes.map(m => m.surface_form));
        const ttr = uniqueWords.size / totalMorphemes;

        const nounRatio = countMorpheme(morphemes, '名詞') / totalMorphemes;
        const verbRatio = countMorpheme(morphemes, '動詞') / totalMorphemes;
        const adjectiveRatio = countMorpheme(morphemes, '形容詞') / totalMorphemes;
        const properNounRatio = countSubMorpheme(morphemes, '固有名詞') / totalMorphemes;

        const subjectiveMorphemes = morphemes.filter(m => ['私', '私は', '〜と思う', '〜と感じる', '〜と考える'].some(p => m.surface_form.includes(p)));
        const subjectiveRatio = subjectiveMorphemes.length / totalMorphemes;

        const sentences = text.split(/[。！？]/).filter(s => s.trim().length > 0);
        const averageSentenceLength = sentences.length > 0 ? text.length / sentences.length : 0;
        const sentenceLengthStdDev = sentences.length > 1
            ? Math.sqrt(sentences.map(s => Math.pow(s.length - averageSentenceLength, 2)).reduce((a, b) => a + b, 0) / sentences.length)
            : 0;

        const chatgptPhrases = ['と言えるでしょう', 'の観点から', '包括的に', '多角的に', '〜ということが重要です', '〜に焦点を当てて'];
        const chatgptPhraseCount = countPhrases(text, chatgptPhrases);
        const chatgptPhraseRatio = totalMorphemes > 0 ? chatgptPhraseCount / totalMorphemes : 0;

        // 【追加】肯定的な表現の検出
        const affirmativePhrases = ['〜と考えられます', '〜が期待されます', '〜が可能です', '〜は非常に有効です'];
        const affirmativeCount = countPhrases(text, affirmativePhrases);
        const affirmativeRatio = totalMorphemes > 0 ? affirmativeCount / totalMorphemes : 0;

        const connectors = ['しかし', 'したがって', 'また', 'そして', 'さらに', 'ゆえに', '一方で', '例えば'];
        const complexConnectors = ['その一方で', '具体的には', '鑑みるに', '加えて', 'その結果'];
        const connectorCount = countPhrases(text, [...connectors, ...complexConnectors]);
        const connectorRatio = totalMorphemes > 0 ? connectorCount / totalMorphemes : 0;

        const metaPhrases = ['AIの文章', 'この記事では', '本稿では', '以下に説明する', '我々は'];
        const rhythmicRepetitions = ['とても.*とても', '考えた。.*考えた。', '美しい.*美しい'];
        const hasMetaPhrase = countPhrases(text, metaPhrases) > 0;
        const hasRhythmicRepetition = countPhrases(text, rhythmicRepetitions) > 0;

        return {
            ttr,
            nounRatio,
            verbRatio,
            adjectiveRatio,
            properNounRatio,
            subjectiveRatio,
            averageSentenceLength,
            sentenceLengthStdDev,
            connectorRatio,
            chatgptPhraseRatio,
            affirmativeRatio, // 【追加】
            hasMetaPhrase,
            hasRhythmicRepetition
        };
    } catch (err) {
        console.error('特徴量抽出エラー:', err);
        return null;
    }
}

// 【強化】AI vs 人間のスコアリング
function calculateScore(features) {
    if (!features) return { ai: 50, human: 50 };

    let aiScore = 0;
    let humanScore = 0;

    // 基本ロジック（重み調整）
    aiScore += features.ttr < 0.45 ? 20 : 0;
    humanScore += features.ttr >= 0.45 && features.ttr <= 0.65 ? 20 : 0;
    aiScore += features.nounRatio > 0.4 ? 15 : 0;
    humanScore += features.nounRatio <= 0.4 ? 15 : 0;
    humanScore += features.properNounRatio > 0.05 ? 15 : 0;
    aiScore += features.properNounRatio <= 0.05 ? 15 : 0;
    humanScore += features.sentenceLengthStdDev > 10 ? 15 : 0;
    aiScore += features.sentenceLengthStdDev <= 10 ? 15 : 0;
    aiScore += features.connectorRatio > 0.03 ? 15 : 0;
    humanScore += features.connectorRatio <= 0.03 ? 15 : 0;
    aiScore += features.hasMetaPhrase ? 20 : 0;
    humanScore += !features.hasMetaPhrase ? 20 : 0;
    humanScore += !features.hasRhythmicRepetition ? 5 : 0;

    // ChatGPT特有の傾向に対するスコアリング
    aiScore += features.chatgptPhraseRatio > 0.005 ? 30 : 0;
    humanScore += features.chatgptPhraseRatio === 0 ? 30 : 0;

    aiScore += features.subjectiveRatio < 0.01 ? 25 : 0;
    humanScore += features.subjectiveRatio >= 0.01 ? 25 : 0;

    // 【追加】肯定度が高い表現に対するスコアリング
    aiScore += features.affirmativeRatio > 0.01 ? 40 : 0;
    humanScore += features.affirmativeRatio === 0 ? 40 : 0;

    // スコアの正規化
    const total = aiScore + humanScore;
    if (total === 0) return { ai: 50, human: 50 };
    return {
        ai: Math.round((aiScore / total) * 100),
        human: Math.round((humanScore / total) * 100)
    };
}

// 分析実行
analyzeBtn.addEventListener('click', async () => {
    const text = inputText.value.trim();
    if (!text) {
        resultsDiv.innerHTML = '<p class="error">文章を入力してください。</p>';
        resultsDiv.style.display = 'block';
        return;
    }
    if (!tokenizer) {
        resultsDiv.innerHTML = '<p class="error">形態素解析が準備できていません。ページをリロードしてください。</p>';
        resultsDiv.style.display = 'block';
        return;
    }

    const features = extractFeatures(text);
    if (!features) {
        resultsDiv.innerHTML = '<p class="error">文章が短すぎます。もう少し長い文章を入力してください。</p>';
        resultsDiv.style.display = 'block';
        return;
    }

    const scores = calculateScore(features);
    aiScore.textContent = scores.ai;
    humanScore.textContent = scores.human;
    resultsDiv.innerHTML = `
        <p>AI生成度：<span class="score ai">${scores.ai}</span>%</p>
        <p>人間度：<span class="score human">${scores.human}</span>%</p>
        <h4>特徴量</h4>
        <p>語彙の多様度 (TTR): ${features.ttr.toFixed(4)} (人間: 0.45〜0.65)</p>
        <p>名詞比率: ${features.nounRatio.toFixed(4)} (AI: 高め)</p>
        <p>動詞比率: ${features.verbRatio.toFixed(4)}</p>
        <p>形容詞比率: ${features.adjectiveRatio.toFixed(4)}</p>
        <p>固有名詞比率: ${features.properNounRatio.toFixed(4)} (人間: 高め)</p>
        <p>主観的表現比率: ${features.subjectiveRatio.toFixed(4)} (人間: 高め) **NEW**</p>
        <p>平均文長: ${features.averageSentenceLength.toFixed(2)}</p>
        <p>文長の標準偏差: ${features.sentenceLengthStdDev.toFixed(2)} (人間: 大きめ)</p>
        <p>接続詞比率: ${features.connectorRatio.toFixed(4)} (AI: 高め)</p>
        <p>ChatGPT頻出フレーズ比率: ${features.chatgptPhraseRatio.toFixed(4)} (AI: 高め) **NEW**</p>
        <p>肯定度が高い表現比率: ${features.affirmativeRatio.toFixed(4)} (AI: 高め) **NEW**</p>
        <p>メタな表現: ${features.hasMetaPhrase ? 'あり' : 'なし'}</p>
        <p>リズミカルな反復: ${features.hasRhythmicRepetition ? 'あり' : 'なし'}</p>
    `;
    resultsDiv.style.display = 'block';
});

// 初期化実行（3回リトライ）
initializeTokenizer().catch(() => {
    resultsDiv.innerHTML = '<p class="error">初期化に失敗しました。./dict/フォルダとネットワークを確認し、ページをリロードしてください。</p>';
    resultsDiv.style.display = 'block';
});
