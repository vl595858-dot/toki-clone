// Обработчики часового пояса: кнопки из /timezone, ответ городом, команда /timezone.
const { sendMessage, answerCallbackQuery } = require("../telegram");
const { setTzOffset } = require("../settings");
const { loadContext, saveContext } = require("../context");
const { TZ_CHOICES } = require("../constants");
const { getTimezoneOffsetForCity } = require("../weather");

/* ---- нажатие кнопки под сообщением (пока только выбор часового пояса) ---- */
async function handleCallbackQuery(cq) {
  const chatId = cq.message?.chat?.id;
  if (!chatId || !cq.data) return;

  if (cq.data.startsWith("tz:")) {
    const offset = cq.data.slice(3);
    await setTzOffset(chatId, offset);
    const label = TZ_CHOICES.find((c) => c.offset === offset)?.label || offset;
    await answerCallbackQuery(cq.id, "Часовой пояс сохранён");
    await sendMessage(chatId, `✅ Часовой пояс установлен: ${label}`);

    // если бот ждал ввода города — нажатие кнопки тоже закрывает это ожидание
    const ctx = await loadContext(chatId);
    if (ctx.pending && ctx.pending.type === "timezone_city") {
      await saveContext(chatId, { ...ctx, pending: null });
    }
  }
}

// пользователь прислал город в ответ на /timezone
async function handleTimezoneCityReply(chatId, text, ctx, patch) {
  const cityName = text.trim();
  const result = await getTimezoneOffsetForCity(cityName);
  if (!result) {
    await sendMessage(
      chatId,
      `Не нашёл город «${cityName}». Попробуй написать иначе, либо используй кнопки из /timezone.`
    );
    patch.pending = { type: "timezone_city" }; // продолжаем ждать
  } else {
    await setTzOffset(chatId, result.offset);
    await sendMessage(chatId, `✅ Часовой пояс установлен по городу «${result.placeName}»: ${result.offset}`);
  }
  await saveContext(chatId, { ...ctx, ...patch });
}

// команда /timezone: показать кнопки и ждать город
async function handleTimezoneCommand(chatId, ctx, patch) {
  await sendMessage(chatId, "Выбери часовой пояс кнопкой или просто напиши название своего города:", {
    replyMarkup: {
      inline_keyboard: [TZ_CHOICES.map((c) => ({ text: c.label, callback_data: `tz:${c.offset}` }))],
    },
  });
  patch.pending = { type: "timezone_city" };
  await saveContext(chatId, { ...ctx, ...patch });
}

module.exports = { handleCallbackQuery, handleTimezoneCityReply, handleTimezoneCommand };
