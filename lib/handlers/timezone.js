// Обработчики часового пояса: ответ городом, команда /timezone, вопрос о городе новым пользователям.
const { sendMessage, answerCallbackQuery } = require("../telegram");
const { setTzOffset, hasTzSetting } = require("../settings");
const { loadContext, saveContext } = require("../context");
const { getTimezoneOffsetForCity } = require("../weather");
const { correctCityName } = require("../ai");

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

// похоже ли сообщение на название города (а не на обычную команду боту)
function looksLikeCity(text) {
  const t = text.trim();
  if (!t || t.startsWith("/")) return false;
  if (/\d/.test(t)) return false;
  return t.split(/\s+/).length <= 4;
}

// пользователь прислал город в ответ на вопрос о городе.
// Возвращает true, если сообщение обработано здесь; false — это не город, его надо разобрать как обычную команду.
async function handleTimezoneCityReply(chatId, text, ctx, patch) {
  if (!looksLikeCity(text)) return false;

  const cityName = text.trim();
  let result = await getTimezoneOffsetForCity(cityName);
  if (!result) {
    // не нашли — пробуем исправить опечатку (Новасибирск → Новосибирск) и искать заново
    try {
      const fixed = await correctCityName(cityName);
      if (fixed && fixed.toLowerCase() !== cityName.toLowerCase()) result = await getTimezoneOffsetForCity(fixed);
    } catch (e) {
      console.error("correctCityName error", e);
    }
  }
  if (!result && cityName.split(/\s+/).length >= 2) return false; // не нашли и это не одно слово — скорее всего обычная команда
  if (!result) {
    await sendMessage(chatId, `Не нашёл город «${cityName}». Напиши название ещё раз, например: Новосибирск.`);
    patch.pending = { type: "timezone_city" }; // продолжаем ждать
  } else {
    await setTzOffset(chatId, result.offset);
    await sendMessage(chatId, `✅ Часовой пояс установлен по городу «${result.placeName}»: ${result.offset}`);
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

module.exports = { handleCallbackQuery, handleTimezoneCityReply, handleTimezoneCommand, askCityIfNew, looksLikeCity };
