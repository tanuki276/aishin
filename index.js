// /index.js (Vercel Node.js Serverless 対応版)

const express = require('express');
const path = require('path');
const app = express();
// VercelではPORTは自動設定される
const port = process.env.PORT || 3000; 

// 必須
app.use(express.json()); 

// 1. ルートパス (/) のハンドラ: index.htmlを返す
app.get('/', (req, res) => {
    // __dirname は Vercel 環境ではルートディレクトリを指すことが多い
    const htmlPath = path.join(__dirname, 'index.html');
    res.sendFile(htmlPath, (err) => {
        if (err) {
            console.error('Error sending index.html:', err);
            res.status(500).send('Server Error: index.htmlが見つかりません。');
        }
    });
});

// 2. APIエンドポイントの定義 (/api/chat)
app.post('/api/chat', (req, res) => {
    const { userId, message } = req.body; 

    if (!message) {
        return res.status(400).json({ error: "メッセージがありません。" });
    }
    
    const botResponse = `【Vercel応答成功】ユーザーID ${userId} のメッセージを受信しました。`; 
    
    // 💡 クライアントが期待する 'reply' キーで応答を返す
    res.json({ reply: botResponse });
});

// 3. Vercel では、この listen はほとんど無視されますが、ローカル実行のために必要です。
app.listen(port, () => {
    console.log(`Server running successfully at http://localhost:${port}`);
});

// 💡 Vercel のサーバーレス関数としてエクスポート (Vercel が Express を検出するために必要)
module.exports = app; 
