// /index.js

const express = require('express');
const path = require('path');
const app = express();
const port = 3000;

// --- APIエンドポイント (以前と同じ) ---
app.post('/api/chat', (req, res) => {
    // ... API処理ロジック ...
    const botResponse = "サーバーからの応答。";
    res.json({ response: botResponse });
});

// --- 💡 最重要: ルート (/) のカスタムハンドラを最初に定義 ---
app.get('/', (req, res) => {
    // public/main.html を読み込み、クライアントに返す
    const htmlPath = path.join(__dirname, 'public', 'main.html'); // 💡 public/main.html を指定
    res.sendFile(htmlPath, (err) => {
        if (err) {
            console.error('Error sending public/main.html:', err);
            res.status(500).send('Server Error');
        }
    });
});

// --- 静的ファイル提供ミドルウェア ---
// public フォルダ内の /index.html や /main.js を提供するために必要。
// ただし、/main.html は上記のカスタムルートで先にキャッチされます。
app.use(express.static('public')); 

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
