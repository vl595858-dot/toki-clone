const { verifyInitData } = require("../../../lib/telegramAuth");

/* Общая проверка для всех /api/webapp/* маршрутов: достаёт initData из заголовка
   Authorization, проверяет подпись и возвращает chat_id пользователя (= его
   Telegram user id — в приватном чате с ботом это одно и то же число). */
function requireTelegramUser(req, res) {
  const header = req.headers.authorization || "";
  const initData = header.startsWith("tma ") ? header.slice(4) : header;

  const result = verifyInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
  if (!result.ok || !result.user || !result.user.id) {
    res.status(401).json({ error: "Не удалось подтвердить пользователя Telegram" });
    return null;
  }
  return result.user.id;
}

module.exports = { requireTelegramUser };
