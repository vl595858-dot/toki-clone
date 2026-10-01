const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;

async function sendMessage(chatId, text, options = {}) {
  const body = { chat_id: chatId, text };
  if (options.replyMarkup) body.reply_markup = options.replyMarkup;
  const res = await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.text();
    console.error("sendMessage failed", res.status, b);
  }
  return res.ok;
}

/* Подтверждает Telegram, что нажатие кнопки обработано (убирает "часики" на кнопке) */
async function answerCallbackQuery(callbackQueryId, text) {
  const res = await fetch(`${API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
  if (!res.ok) console.error("answerCallbackQuery failed", res.status, await res.text());
  return res.ok;
}

async function getFileUrl(fileId) {
  const res = await fetch(`${API}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const data = await res.json();
  if (!data.ok) throw new Error("getFile failed: " + JSON.stringify(data));
  return `${FILE_API}/${data.result.file_path}`;
}

async function downloadFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не удалось скачать файл: ${res.status}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

async function setWebhook(url) {
  const res = await fetch(`${API}/setWebhook?url=${encodeURIComponent(url)}`);
  return res.json();
}

module.exports = { sendMessage, answerCallbackQuery, getFileUrl, downloadFile, setWebhook };
