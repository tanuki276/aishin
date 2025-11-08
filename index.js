document.addEventListener('DOMContentLoaded', () => {
    const chatWindow = document.getElementById('chat-window');
    const userInput = document.getElementById('user-input');
    const sendButton = document.getElementById('send-button');

    // 修正: APIエンドポイントを /api/chat に変更
    const API_ENDPOINT = '/api/chat';

    /**
     * メッセージをチャットウィンドウに追加する関数
     * @param {string} text - 表示するテキスト
     * @param {string} role - 'user' または 'bot'
     */
    function appendMessage(text, role) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}-message`;
        messageDiv.textContent = text;
        chatWindow.appendChild(messageDiv);
        chatWindow.scrollTop = chatWindow.scrollHeight; // スクロールを最下部に移動
    }

    /**
     * APIにメッセージを送信し、応答を取得する
     * @param {string} message - ユーザーが入力したメッセージ
     */
    async function sendMessage(message) {
        if (!message.trim()) return;

        // ユーザーメッセージを表示
        appendMessage(message, 'user');
        userInput.value = ''; // 入力フィールドをクリア

        // 送信ボタンを無効化
        sendButton.disabled = true;
        userInput.disabled = true;
        userInput.placeholder = '応答待機中...';

        try {
            const userId = 'anon_user'; // 簡易的なユーザーID

            const response = await fetch(API_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    userId: userId,
                    message: message
                })
            });

            if (!response.ok) {
                throw new Error(`APIエラー: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            const botReply = data.reply || '応答がありませんでした。';

            // ボットの応答を表示
            appendMessage(botReply, 'bot');

        } catch (error) {
            console.error('通信エラー:', error);
            appendMessage('エラーが発生しました。しばらくしてから再度お試しください。', 'bot');
        } finally {
            // 送信ボタンを再有効化
            sendButton.disabled = false;
            userInput.disabled = false;
            userInput.placeholder = 'メッセージを入力してください...';
            userInput.focus();
        }
    }

    // 送信ボタンクリック時のイベントリスナー
    sendButton.addEventListener('click', () => {
        sendMessage(userInput.value);
    });

    // Enterキー押下時のイベントリスナー
    userInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault(); // デフォルトの改行を防ぐ
            sendMessage(userInput.value);
        }
    });
});
