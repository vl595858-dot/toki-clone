const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;

async function sendMessage(chatId, text) {
  const res = await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: undefined }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("sendMessage failed", res.status, body);
  }
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

module.exports = { sendMessage, getFileUrl, downloadFile, setWebhook };
