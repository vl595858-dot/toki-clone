const { sendMessage } = require("../../../lib/telegram");
const { transcribeVoice, parseMessage } = require("../../../lib/ai");
const { loadContext, saveContext } = require("../../../lib/context");
const { getTzOffset } = require("../../../lib/settings");
const { stripContextWords, extractOffsetMinutes } = require("../../../lib/text");
const { buildContextText } = require("../../../lib/contextText");
const { handleWeather } = require("../../../lib/handlers/weather");
const { handleCallbackQuery, handleTimezoneCityReply, handleTimezoneCommand, askCityIfNew } = require("../../../lib/handlers/timezone");
const { handleCreateRecurringEvent, handleDeleteRecurringEvent } = require("../../../lib/handlers/recurring");
const { resolveTarget, replyNotFound } = require("../../../lib/handlers/eventTarget");
const { handleCancelReminder, handleSetReminder } = require("../../../lib/handlers/reminders");
const { handleDeleteEvent, handleRescheduleEvent } = require("../../../lib/handlers/eventsEdit");
const { handleCreateEvent, handleListEvents } = require("../../../lib/handlers/events");
const { handleChooseEvent } = require("../../../lib/handlers/choose");


export const config = {
  api: { bodyParser: true },
};
export const maxDuration = 10; // потолок бесплатного тарифа Vercel

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(200).send("ok");
    return;
  }
  if (req.query.secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    res.status(403).end();
    return;
  }

  try {
    if (req.body.callback_query) {
      await handleCallbackQuery(req.body.callback_query);
    } else {
      await handleUpdate(req.body);
    }
  } catch (e) {
    console.error("handleUpdate error", e);
    // чтобы бот не молчал при сбое — коротко сообщаем человеку
    const errChatId = req.body?.message?.chat?.id || req.body?.callback_query?.message?.chat?.id;
    if (errChatId) {
      try {
        await sendMessage(errChatId, "Что-то пошло не так, попробуй ещё раз 🙏");
      } catch (e2) {
        console.error("error notice failed", e2);
      }
    }
  }
  res.status(200).json({ ok: true });
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message) return;
  const chatId = message.chat.id;

  let text = message.text;

  if (!text && message.voice) {
    try {
      text = await transcribeVoice(message.voice.file_id);
      if (!text) {
        await sendMessage(chatId, "Не расслышал голосовое — попробуй ещё раз, покороче и чётче.");
        return;
      }
    } catch (e) {
      console.error("transcribe error", e);
      await sendMessage(chatId, "Не получилось распознать голосовое. Попробуй текстом.");
      return;
    }
  }

  if (!text) return;

  if (text.trim() === "/start") {
    await sendMessage(
      chatId,
      "Привет! 👋 Я твой планировщик: запоминаю дела и вовремя напоминаю о них.\n\n" +
        "📝 Как записать дело. Напиши или надиктуй голосом:\n" +
        "• что за событие — коротко;\n" +
        "• когда оно будет — дата и время (без времени поставлю на 12:00);\n" +
        "• во сколько или за сколько напомнить (без уточнения напомню за час).\n" +
        "Например: «Встреча с юристом завтра в 15:00, напомни за сутки»\n\n" +
        "🔁 Повторяющееся дело. Добавь «каждый день», «каждую неделю», «каждый месяц» или «каждый год» — и я буду ставить его сам. " +
        "Например: «Каждый понедельник в 16:00 планёрка» или «У мамы день рождения 5 мая».\n\n" +
        "🎤 Голосом тоже можно. После записи я пришлю сводку — проверь, всё ли верно. " +
        "Если нет, сразу скажи, что поправить: «нет, напомни за сутки», «перенеси на пятницу», «поставь на 18:00».\n\n" +
        "📋 Ещё: «Что у меня сегодня», «Удали встречу с юристом», «Не напоминай про встречу».\n\n" +
        "🌦 Погода. Назови город и когда: «погода в Перми завтра вечером».\n\n" +
        "🌍 Часовой пояс. Чтобы напоминания приходили вовремя, напиши /timezone и свой город.\n\n" +
        "🗓 Календарь. Кнопка «Календарь» внизу покажет все дела в удобном виде."
    );
    await askCityIfNew(chatId);
    return;
  }

  // память диалога нужна уже здесь, чтобы понять ответ на /timezone городом
  let ctx = await loadContext(chatId);
  const patch = { pending: null }; // ожидание живёт только один шаг, если хендлер не поставит новое

  if (ctx.pending && ctx.pending.type === "timezone_city") {
    if (await handleTimezoneCityReply(chatId, text, ctx, patch)) return;
    ctx = { ...ctx, pending: null }; // это не город — разбираем как обычную команду
  }
  if (text.trim() === "/timezone") {
    await handleTimezoneCommand(chatId, ctx, patch);
    return;
  }

  // бот спросил «какое из нескольких дел?» — ждём номер
  if (ctx.pending && ctx.pending.type === "choose_event") {
    if (await handleChooseEvent(chatId, text, ctx, patch, await getTzOffset(chatId))) return;
    ctx = { ...ctx, pending: null }; // это не ответ на вопрос — разбираем как обычную команду
  }

  // часовой пояс этого конкретного чата — свой на каждого человека
  const tz = await getTzOffset(chatId);

  let parsed;
  let contextText = "";
  try {
    contextText = await buildContextText(chatId, ctx, tz);
    parsed = await parseMessage(text, tz, contextText);
  } catch (e) {
    console.error("parse error", e);
    await sendMessage(chatId, "Не разобрал сообщение. Попробуй сформулировать иначе.");
    return;
  }

  // интервал напоминания, названный в самом сообщении, модель иногда теряет — берём из текста
  if (parsed.intent === "set_reminder" && !Number.isFinite(parsed.remind_offset_minutes)) {
    const off = extractOffsetMinutes(text);
    if (off) parsed.remind_offset_minutes = off;
  }

  // модель иногда подмешивает в название нового дела слова из памяти диалога — убираем их
  if ((parsed.intent === "create_event" || parsed.intent === "create_recurring_event") && parsed.title) {
    parsed.title = stripContextWords(parsed.title, text, contextText);
  }

  try {
    await dispatch(chatId, parsed, ctx, patch, tz);
  } finally {
    await saveContext(chatId, { ...ctx, ...patch });
  }
}

async function dispatch(chatId, parsed, ctx, patch, tz) {
  if (parsed.intent === "weather") {
    await handleWeather(chatId, parsed, ctx, patch);
    return;
  }
  if (parsed.intent === "list_events") {
    await handleListEvents(chatId, parsed.list_scope, tz);
    return;
  }
  if (parsed.intent === "delete_event") {
    await handleDeleteEvent(chatId, parsed, ctx, patch, tz);
    return;
  }
  if (parsed.intent === "reschedule_event") {
    await handleRescheduleEvent(chatId, parsed, ctx, patch, tz);
    return;
  }
  if (parsed.intent === "cancel_reminder") {
    await handleCancelReminder(chatId, parsed, ctx, patch, tz);
    return;
  }
  if (parsed.intent === "set_reminder") {
    await handleSetReminder(chatId, parsed, ctx, patch, tz);
    return;
  }
  if (parsed.intent === "create_recurring_event" && parsed.title) {
    await handleCreateRecurringEvent(chatId, parsed, patch, tz);
    return;
  }
  if (parsed.intent === "delete_recurring_event") {
    await handleDeleteRecurringEvent(chatId, parsed.title);
    return;
  }
  if (parsed.intent === "create_event" && parsed.title) {
    await handleCreateEvent(chatId, parsed, patch, tz);
    return;
  }

  await sendMessage(
    chatId,
    "Не понял, о чём речь 🤔 Можешь переформулировать? Например: «Позвонить маме завтра в 12:00, напомни за 30 минут»."
  );
}


