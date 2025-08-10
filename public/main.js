let userId = 'user_' + Math.random().toString(36).substr(2, 9); // ユーザーを識別するためのユニークID

document.getElementById('send-button').addEventListener('click', sendMessage);
document.getElementById('user-input').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
        sendMessage();
    }
});

addMessageToChat("bot", "こんにちは！何かお調べしましょうか？");

async function sendMessage() {
    const userInput = document.getElementById('user-input');
    const userMessage = userInput.value.trim();
    if (userMessage === '') return;

    addMessageToChat("user", userMessage);
    userInput.value = '';

    // APIサーバーへリクエストを送信
    try {
        const response = await fetch('http://localhost:3000/api/chat', {
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
