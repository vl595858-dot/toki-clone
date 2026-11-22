const { sendMessage, answerCallbackQuery, editMessageText } = require("../telegram");
const { UUID, config, linkOrder } = require("../plusPayments");
const { issuePromo, redeemPromo, planStatus, enabled, promoDurations } = require("../plusPlans");
const { limits } = require("../plusPlanLimits");

function authorized(settings, chat, user) {
  return settings && chat?.type === "private" &&
    String(user?.id) === settings.userId && String(chat.id) === settings.userId;
}

function formatAccess(date) {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Yekaterinburg",
  }).format(date);
}

async function handlePlusCommand(message, orderId) {
  const chatId = message.chat.id;
  if (message.chat.type !== "private") {
    await sendMessage(chatId, "Открой личный чат с ботом и отправь /plus.");
    return;
  }
  if (orderId) {
    if (!authorized(config(), message.chat, message.from) || !UUID.test(orderId)) {
      await sendMessage(chatId, "Тестовый заказ недоступен.");
      return;
    }
    await sendMessage(chatId, "Привязать этот Telegram-аккаунт к тестовому заказу на сайте «Мои делишки»?", {
      replyMarkup: { inline_keyboard: [[{ text: "Подтвердить аккаунт", callback_data: `plus:${orderId}` }]] },
    });
    return;
  }
  const { accessUntil, isTest, used } = await planStatus(chatId);
  const tier = limits[accessUntil ? "plus" : "free"];
  const heading = accessUntil
    ? `${isTest ? "Тестовый " : ""}Плюс активен до ${formatAccess(accessUntil)} (Пермь).`
    : "Твой тариф — Бесплатный.";
  const remaining = (action) => Math.max(0, tier[action] - (used[action] || 0));
  const summary = enabled() ? [
    heading,
    "",
    "Остаток по лимитам за последние 30 дней:",
    `• Новые дела: ${accessUntil ? "без лимита" : `${remaining("event")} из ${tier.event}`}`,
    `• Голосовые: ${remaining("voice")} из ${tier.voice}`,
    `• Фото и скриншоты: ${accessUntil ? `${remaining("image")} из ${tier.image}` : "доступны в Плюсе"}`,
  ] : [heading];
  const comparison = accessUntil
    ? []
    : ["", `Плюс: дела без лимита, ${limits.plus.voice} голосовых и ${limits.plus.image} фото или скриншотов за 30 дней.`];
  await sendMessage(chatId, [...summary, ...comparison, "", "Есть промокод? Отправь /promo КОД."].join("\n"));
}

async function handlePromo(message, command, code) {
  const { chat, from } = message;
  if (chat.type !== "private" || String(from?.id) !== String(chat.id)) return;
  if (command === "myid") {
    await sendMessage(chat.id, `Твой Telegram ID: ${from.id}`);
    return;
  }
  if (command === "promogive" || command === "promocampaign") {
    if (String(from.id) !== process.env.PLUS_ADMIN_TELEGRAM_ID) {
      await sendMessage(chat.id, "Команда доступна владельцу бота.");
      return;
    }
    if (command === "promocampaign") {
      const maxUses = /^\d{1,5}$/.test(code || "") ? Number(code) : 0;
      if (maxUses < 1 || maxUses > 10000) {
        await sendMessage(chat.id, "Укажи число активаций от 1 до 10 000. Например: /promocampaign 100");
        return;
      }
      const campaign = await issuePromo(from.id, promoDurations.month, maxUses);
      const bot = process.env.PLUS_BOT_USERNAME || config()?.bot || "moideladelishki_bot";
      await sendMessage(chat.id, [
        `Промокод кампании: до ${maxUses} активаций в течение 30 дней. Один аккаунт получает 30 дней Плюса один раз по этому коду.`,
        "",
        "Ссылка для рекламы:",
        `https://t.me/${bot}?start=promo_${campaign}`,
        "",
        "Команда для ручной активации:",
        `/promo ${campaign}`,
      ].join("\n"));
      return;
    }
    await sendMessage(chat.id, "На какой срок подарить Плюс?", {
      replyMarkup: { inline_keyboard: [[
        { text: "На 30 дней", callback_data: "promo:month" },
        { text: "На год", callback_data: "promo:year" },
      ]] },
    });
    return;
  }
  if (!code) {
    await sendMessage(chat.id, "Чтобы активировать промокод, отправь /promo и код в одном сообщении.");
    return;
  }
  const result = await redeemPromo(chat.id, code);
  if (result.status === "unavailable") {
    await sendMessage(chat.id, "Промокод недействителен, уже использован или просрочен.");
    return;
  }
  const prefix = result.status === "already" ? "Этот код ты уже активировал." : `Промокод принят. Добавил ${result.days} дней Плюса.`;
  await sendMessage(chat.id, `${prefix} Срок по этому коду до ${formatAccess(result.accessUntil)} (Пермь). Текущий статус — /plus.`);
}

async function handlePromoDuration(callback) {
  const chat = callback.message?.chat;
  const owner = process.env.PLUS_ADMIN_TELEGRAM_ID;
  const duration = /^promo:(month|year)$/.exec(callback.data)?.[1];
  if (!owner || chat?.type !== "private" || String(callback.from?.id) !== owner || String(chat.id) !== owner || !duration) {
    await answerCallbackQuery(callback.id, "Команда доступна владельцу бота.");
    return;
  }
  await answerCallbackQuery(callback.id);
  const code = await issuePromo(owner, promoDurations[duration]);
  await sendMessage(chat.id, `Одноразовый промокод на ${promoDurations[duration]} дней Плюса. Активировать можно в течение 30 дней.\n\nПерешли получателю эту команду:\n/promo ${code}`);
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

module.exports = { handlePlusCommand, handlePlusLink, handlePromo, handlePromoDuration };
