// Обработчики часового пояса: ответ городом, команда /timezone, вопрос о городе новым пользователям.
const { sendMessage, answerCallbackQuery } = require("../telegram");
const { setTzOffset, hasTzSetting } = require("../settings");
const { loadContext, saveContext } = require("../context");
const { placeLabel, offsetForZone } = require("../places");
const { cityAnswer } = require("../placeDialog");

/* ---- нажатие кнопки под сообщением (кнопок выбора пояса больше нет; обрабатываем только старые, уже отправленные) ---- */
async function handleCallbackQuery(cq) {
  const chatId = cq.message?.chat?.id;
  if (!chatId || !cq.data) return;

  if (cq.data.startsWith("tz:")) {
    const offset = cq.data.slice(3);
    await setTzOffset(chatId, offset);
    const label = offset;
    await answerCallbackQuery(cq.id, "Часовой пояс сохранён");
    await sendMessage(chatId, `✅ Часовой пояс установлен: ${label}`);

    // если бот ждал ввода города — нажатие кнопки тоже закрывает это ожидание
    const ctx = await loadContext(chatId);
    if (ctx.pending && ctx.pending.type === "timezone_city") {
      await saveContext(chatId, { ...ctx, pending: null });
    }
  }
}

async function handleTimezoneCityReply(chatId, text, ctx, patch) {
  const result = await cityAnswer(text, ctx.pending.city);
  if (!result.place) {
    if (!result.closed) patch.pending = { type: "timezone_city", city: result.state };
    await sendMessage(chatId, result.reply);
  } else {
    const offset = offsetForZone(result.place.timezone);
    if (!offset) {
      patch.pending = {type:"timezone_city"};
      await sendMessage(chatId, "Не удалось определить часовой пояс этого места. Укажи другой населённый пункт поблизости.");
    } else {
      await setTzOffset(chatId, offset);
      await sendMessage(chatId, "✅ Часовой пояс установлен по городу «" + placeLabel(result.place) + "»: UTC" + offset);
    }
  }
  await saveContext(chatId, { ...ctx, ...patch });
  return true;
}

// команда /timezone: спросить город
async function handleTimezoneCommand(chatId, ctx, patch) {
  await sendMessage(chatId, "В каком ты городе? Напиши название, например: Новосибирск.");
  patch.pending = { type: "timezone_city" };
  await saveContext(chatId, { ...ctx, ...patch });
}

// после /start: если пояс ещё не задан — спросить город
async function askCityIfNew(chatId) {
  if (await hasTzSetting(chatId)) return;
  await sendMessage(
    chatId,
    "Чтобы напоминания приходили вовремя, напиши свой город, например: Новосибирск."
  );
  const ctx = await loadContext(chatId);
  await saveContext(chatId, { ...ctx, pending: { type: "timezone_city" } });
}

module.exports = { handleCallbackQuery, handleTimezoneCityReply, handleTimezoneCommand, askCityIfNew };
