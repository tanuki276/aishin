const { getBotResponse } = require('../Chat/generateLogic');

// Vercelのサーバーレス関数としてエクスポート
module.exports = async (req, res) => {
  // CORSヘッダーを設定
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // OPTIONSリクエスト（プリフライトリクエスト）に対応
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // POSTリクエストのみを処理
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  
  try {
    const { userId, message } = req.body;

    if (!userId || !message) {
      return res.status(400).json({ error: 'userId and message are required.' });
    }

    const response = await getBotResponse(userId, message);
    return res.status(200).json({ response });
  } catch (error) {
    console.error('Error processing chat request:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};
