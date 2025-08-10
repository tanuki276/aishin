let userId = 'user_' + Math.random().toString(36).substr(2, 9); // ユーザーを識別するためのユニークIDを生成

// `index.html`に書かれた要素へのイベントリスナー設定
document.getElementById('send-button').addEventListener('click', sendMessage);
document.getElementById('user-input').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
        sendMessage();
    }
});

// 初回メッセージの表示
addMessageToChat("bot", "こんにちは！何かお調べしましょうか？");

/**
 * ユーザーメッセージをAPIに送信し、ボットの応答を表示する
 */
async function sendMessage() {
    const userInput = document.getElementById('user-input');
    const userMessage = userInput.value.trim();
    if (userMessage === '') return;

    addMessageToChat("user", userMessage);
    userInput.value = '';

    // APIサーバーへリクエストを送信
    try {
        // !!! ここをデプロイしたAPIのURLに書き換えてください !!!
        const apiEndpoint = 'https://[your-vercel-domain]/api/chat';
        
        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: userId,
                message: userMessage
            })
        });

        const data = await response.json();
        if (response.ok) {
            addMessageToChat("bot", data.response);
        } else {
            addMessageToChat("bot", `エラーが発生しました: ${data.error}`);
        }
    } catch (error) {
        console.error('API request failed:', error);
        addMessageToChat("bot", "サーバーとの通信に失敗しました。");
    }
}

/**
 * チャット画面にメッセージを追加する
 * @param {string} sender - "user" または "bot"
 * @param {string} message - 表示するメッセージテキスト
 */
function addMessageToChat(sender, message) {
    const chatMessages = document.getElementById('chat-messages');
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}-message`;
    messageDiv.innerHTML = `<span class="bubble">${message}</span>`;
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight; // 自動スクロール
}
