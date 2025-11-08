/**
 * public/main.js
 * クライアントサイドのチャットロジック
 */

// UI要素の取得
const messagesContainer = document.getElementById('messages');
const inputElement = document.getElementById('input');
const composerForm = document.getElementById('composer');
const sendButton = document.getElementById('send');
const clearButton = document.getElementById('clear-btn');

// ===================================
// 1. メッセージ表示ヘルパー関数
// ===================================

/**
 * 新しいメッセージをDOMに追加し、スクロールを一番下にする
 * @param {string} text - メッセージ本文
 * @param {string} senderClass - 'msg-user' または 'msg-bot'
 */
function displayMessage(text, senderClass) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${senderClass}`;
    
    const content = document.createElement('p');
    // セキュリティのため、textContentを使用
    content.textContent = text; 
    
    // 時間表示メタデータ
    const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const metaDiv = document.createElement('div');
    metaDiv.className = 'msg-meta';
    metaDiv.innerHTML = `<span class="msg-time">${time}</span>`;

    messageDiv.appendChild(content);
    messageDiv.appendChild(metaDiv);
    messagesContainer.appendChild(messageDiv);

    // スクロールを一番下へ
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}


// ===================================
// 2. フォーム送信処理
// ===================================

/**
 * ユーザーのメッセージをサーバーAPIに送信し、応答を待つ
 * @param {string} userMessage - ユーザーが入力したメッセージ
 */
async function sendMessage(userMessage) {
    if (!userMessage.trim()) return; // 空のメッセージは送信しない

    // 1. ユーザーメッセージを画面に表示
    displayMessage(userMessage, 'msg-user');
    inputElement.value = ''; // 入力欄をクリア

    // 2. ボットの「入力中」インジケーターを表示 (簡易版)
    const typingIndicator = document.createElement('div');
    typingIndicator.className = 'typing msg-bot message';
    typingIndicator.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
    messagesContainer.appendChild(typingIndicator);
    messagesContainer.scrollTop = messagesContainer.scrollHeight; // スクロール

    try {
        // 3. サーバーのAPIエンドポイントにメッセージを送信
        const response = await fetch('/api/chat', { // サーバー側の /api/chat エンドポイントを叩く
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ message: userMessage }),
        });

        if (!response.ok) {
            throw new Error(`APIリクエスト失敗: ${response.status}`);
        }

        const data = await response.json();
        const botMessage = data.response || "サーバーからの応答が得られませんでした。";

        // 4. 入力中インジケーターを削除
        messagesContainer.removeChild(typingIndicator);

        // 5. ボットの応答を画面に表示
        displayMessage(botMessage, 'msg-bot');

    } catch (error) {
        console.error("チャット処理エラー:", error);
        // エラーメッセージを表示
        if (messagesContainer.contains(typingIndicator)) {
             messagesContainer.removeChild(typingIndicator);
        }
        displayMessage("エラーが発生しました。サーバーを確認してください。", 'msg-bot');
    }
}

// フォームの送信イベントリスナー
composerForm.addEventListener('submit', (e) => {
    e.preventDefault(); // フォームのデフォルト送信（ページ遷移）を防止
    sendMessage(inputElement.value);
});


// ===================================
// 3. その他のUIイベント処理
// ===================================

// Enterキーでの送信、Shift+Enterでの改行
inputElement.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); // デフォルトの改行を防止
        sendButton.click(); // 送信ボタンをクリック
    }
});

// チャットクリアボタン
clearButton.addEventListener('click', () => {
    if (confirm("本当にチャット履歴をクリアしますか？")) {
        messagesContainer.innerHTML = ''; // メッセージコンテナの内容を空にする
        // 必要に応じて、localStorageやサーバー側のセッションもクリアするロジックを追加
    }
});

// 初期ウェルカムメッセージの表示 (ページロード時)
document.addEventListener('DOMContentLoaded', () => {
    // 最初の起動時に一度だけ表示
    if (messagesContainer.children.length === 0) {
        displayMessage("ようこそ！nodenへ。何でも質問してください。", 'msg-bot');
    }
});
