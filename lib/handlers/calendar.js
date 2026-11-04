// Команда /calendar — присылает кнопку, которая открывает Mini App «Календарь».
// Telegram не даёт открыть приложение прямо из команды, только по нажатию кнопки.
const { sendMessage } = require("../telegram");

const CALENDAR_URL = "https://toki-clone.vercel.app/calendar";

async function handleCalendar(chatId) {
  await sendMessage(chatId, "🗓 Твой календарь:", {
    replyMarkup: {
      inline_keyboard: [[{ text: "🗓 Открыть календарь", web_app: { url: CALENDAR_URL } }]],
    },
  });
}

module.exports = { handleCalendar };
