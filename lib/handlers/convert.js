// Команда /convert — присылает кнопку, которая открывает Mini App «Конвертация».
const { sendMessage } = require("../telegram");

const CONVERT_URL = "https://toki-clone.vercel.app/convert";

async function handleConvert(chatId) {
  await sendMessage(chatId, "💱 Конвертация валют:", {
    replyMarkup: {
      inline_keyboard: [[{ text: "💱 Открыть конвертер", web_app: { url: CONVERT_URL } }]],
    },
  });
}

module.exports = { handleConvert };
