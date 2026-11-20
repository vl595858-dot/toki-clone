const { sendMessage, answerCallbackQuery, editMessageText } = require("../telegram");
const { UUID, config, linkOrder, accessUntil } = require("../plusPayments");

function authorized(settings, chat, user) {
  return settings && chat?.type === "private" &&
    String(user?.id) === settings.userId && String(chat.id) === settings.userId;
}

async function handlePlusCommand(message, orderId) {
  const chatId = message.chat.id;
  const settings = config();
  if (!authorized(settings, message.chat, message.from)) {
    await sendMessage(chatId, "Плюс пока недоступен.");
    return;
  }
  if (orderId) {
    if (!UUID.test(orderId)) {
      await sendMessage(chatId, "Ссылка устарела. Создай новый тестовый заказ на сайте.");
    } else {
      await sendMessage(chatId, "Привязать этот Telegram-аккаунт к тестовому заказу на сайте «Мои делишки»?", {
        replyMarkup: { inline_keyboard: [[{ text: "Подтвердить аккаунт", callback_data: `plus:${orderId}` }]] },
      });
    }
    return;
  }
  const expires = await accessUntil(settings.userId);
  if (!expires) {
    await sendMessage(chatId, "Тестовый Плюс пока не активирован.");
    return;
  }
  const date = new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeZone: "Asia/Yekaterinburg" }).format(expires);
  await sendMessage(chatId, `Тестовый Плюс активен до ${date} по времени Перми.`);
}

async function handlePlusLink(callback) {
  const id = callback.data.slice("plus:".length);
  const settings = config();
  const message = callback.message;
  if (!authorized(settings, message?.chat, callback.from) || !UUID.test(id)) {
    await answerCallbackQuery(callback.id, "Заказ недоступен.");
    return;
  }
  const linked = await linkOrder(id, settings.userId);
  const text = linked ? "Аккаунт подтверждён. Вернись во вкладку сайта." : "Ссылка устарела. Создай новый тестовый заказ на сайте.";
  await answerCallbackQuery(callback.id, text);
  await editMessageText(message.chat.id, message.message_id, text);
}

module.exports = { handlePlusCommand, handlePlusLink };
