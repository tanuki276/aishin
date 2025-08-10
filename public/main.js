let userId = 'user_' + Math.random().toString(36).substr(2, 9);
const apiEndpoint = '/api/chat';

// UI要素の取得
const chatInput = document.getElementById('user-input');
const sendButton = document.getElementById('send-button');

// 初期状態でチャット機能を無効化
chatInput.disabled = true;
sendButton.disabled = true;
chatInput.placeholder = "ボットの準備中です。少々お待ちください...";

// 初回メッセージ（準備中）をボットから送信
addMessageToChat("bot", "ボットを起動しています。準備ができるまでお待ちください...");

// APIからの初回応答を待つための関数
async function initializeChat() {
    try {
        const initialMessage = '起動'; // 最初のメッセージとしてAPIに送信
        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: userId,
                message: initialMessage
            })
        });

        if (response.ok) {
            const data = await response.json();
            // 準備完了後、UIを有効化
            chatInput.disabled = false;
            sendButton.disabled = false;
            chatInput.placeholder = "メッセージを入力...";
            // 初回応答を表示
            addMessageToChat("bot", data.response);
        } else {
            const errorData = await response.json();
            addMessageToChat("bot", `エラーが発生しました: ${errorData.error}`);
        }
    } catch (error) {
        console.error('API request failed:', error);
        addMessageToChat("bot", "サーバーとの通信に失敗しました。ページをリロードしてください。");
    }
}

// ページ読み込み時にチャットの初期化を開始
window.onload = initializeChat;

// イベントリスナー
document.getElementById('send-button').addEventListener('click', sendMessage);
document.getElementById('user-input').addEventListener('keypress', function(e) {
    if (e.key === 'Enter' && !chatInput.disabled) {
        sendMessage();
    }
});

async function sendMessage() {
    const userMessage = chatInput.value.trim();
    if (userMessage === '') return;

    addMessageToChat("user", userMessage);
    chatInput.value = '';

    try {
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

function addMessageToChat(sender, message) {
    const chatMessages = document.getElementById('chat-messages');
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}-message`;
    messageDiv.innerHTML = `<span class="bubble">${message}</span>`;
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}
