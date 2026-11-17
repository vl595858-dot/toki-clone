const { sendMessage } = require("../../../lib/telegram");
const { transcribeVoice, parseMessage } = require("../../../lib/ai");
const { loadContext, saveContext } = require("../../../lib/context");
const { getTzOffset } = require("../../../lib/settings");
const { stripContextWords, hasForeverWord, stripForeverWord, parseRename, isBirthday, extractExplicitEventTime } = require("../../../lib/text");
const { buildContextText } = require("../../../lib/contextText");
const { handleWeather } = require("../../../lib/handlers/weather");
const { handleCallbackQuery, handleTimezoneCityReply, handleTimezoneCommand, askCityIfNew } = require("../../../lib/handlers/timezone");
const { handleCreateRecurringEvent, handleDeleteRecurringEvent } = require("../../../lib/handlers/recurring");
const { resolveTarget, replyNotFound } = require("../../../lib/handlers/eventTarget");
const { handleCancelReminder, handleSetReminder } = require("../../../lib/handlers/reminders");
const { handleDeleteEvent, handleRescheduleEvent } = require("../../../lib/handlers/eventsEdit");
const { handleCreateEvent, handleListEvents } = require("../../../lib/handlers/events");
const { handleChooseEvent } = require("../../../lib/handlers/choose");
const { handleHelp } = require("../../../lib/handlers/help");
const { handleStart } = require("../../../lib/handlers/start");
const { handleConvert } = require("../../../lib/handlers/convert");
const { handlePhoto, handleDocText } = require("../../../lib/handlers/docs");
const { handleDocButton } = require("../../../lib/handlers/docButtons");
const { handleSnoozeReply } = require("../../../lib/handlers/snooze");
const { handleCalendar } = require("../../../lib/handlers/calendar");
const { handleSearchEvents } = require("../../../lib/handlers/search");
const { handleReminderButton } = require("../../../lib/handlers/reminderButtons");
const { handleRescheduleRecurring, handleRenameEvent } = require("../../../lib/handlers/recurringEdit");
const { commandOffset, OFF } = require("../../../lib/reminderSettings");
const { claimUpdate } = require("../../../lib/dedupe");


export const config = {
  api: { bodyParser: true },
};
export const maxDuration = 30; // чтение картинки моделью занимает до ~10–15 секунд

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(200).send("ok");
    return;
  }
  if (req.query.secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    res.status(403).end();
    return;
  }

  if (!(await claimUpdate(req.body.update_id))) {
    res.status(200).json({ ok: true, duplicate: true });
    return;
  }

  try {
    if (req.body.callback_query) {
      const cq = req.body.callback_query;
      if (String(cq.data || "").startsWith("rem:")) await handleReminderButton(cq);
      else if (String(cq.data || "").startsWith("doc:")) await handleDocButton(cq);
      else await handleCallbackQuery(cq);
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

  // картинка (скриншот билета, талона, счёта): разбор документа; PDF и другие файлы не принимаем
  if (message.photo || message.document) {
    await handlePhoto(message, await getTzOffset(chatId));
    return;
  }

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

  if (/^\/help(@\w+)?$/.test(text.trim())) {
    await handleHelp(chatId);
    return;
  }

  if (/^\/calendar(@\w+)?$/.test(text.trim())) {
    await handleCalendar(chatId);
    return;
  }

  if (/^\/convert(@\w+)?$/.test(text.trim())) {
    await handleConvert(chatId);
    return;
  }

  if (/^\/start(@\w+)?$/.test(text.trim())) {
    await handleStart(chatId);
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
  if (/^\/timezone(@\w+)?$/.test(text.trim())) {
    await handleTimezoneCommand(chatId, ctx, patch);
    return;
  }

  // диалог по картинке: недостающие данные, правка, свой интервал напоминания
  if (ctx.pending && ctx.pending.type === "doc") {
    if (await handleDocText(chatId, text, ctx, await getTzOffset(chatId))) return;
    ctx = { ...ctx, pending: null }; // это не ответ на вопрос — разбираем как обычную команду
  }
  // «Напомнить позже» под напоминанием: ждём, когда напомнить
  if (ctx.pending && ctx.pending.type === "snooze") {
    if (await handleSnoozeReply(chatId, text, ctx, await getTzOffset(chatId))) return;
    ctx = { ...ctx, pending: null };
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

  // кодовые слова решает код, а не модель:
  // «переименуй X в Y» — новое название; «навсегда» вместе с «перенеси» — перенос всей серии повторов
  const rename = parseRename(text);
  if (rename) {
    parsed = { ...parsed, ...rename, intent: "rename_event" };
  } else if (hasForeverWord(text) && parsed.intent === "reschedule_event") {
    parsed.intent = "reschedule_recurring_event";
    parsed.title = stripForeverWord(parsed.title);
  }

  // Состояние напоминания берём только из текущей команды, не из памяти модели.
  if (["create_event", "create_recurring_event", "reschedule_event", "reschedule_recurring_event", "set_reminder"].includes(parsed.intent)) {
    const offset = commandOffset(text);
    parsed.reminder_disabled = offset === OFF;
    parsed.remind_offset_minutes = offset !== undefined && offset !== OFF ? offset : null;
    if (offset === undefined && parsed.intent === "reschedule_event" && ctx.pending?.type === "reschedule_time") {
      parsed.reminder_disabled = ctx.pending.reminder_disabled === true;
      parsed.remind_offset_minutes = ctx.pending.remind_offset_minutes ?? null;
    }
    if (parsed.intent === "set_reminder" && offset === OFF) parsed.intent = "cancel_reminder";
    if (parsed.intent === "create_recurring_event" && isBirthday(text)) {
      parsed.is_birthday = true;
      if (offset === undefined) parsed.remind_offset_minutes = 10080;
    }
  }

  // модель иногда подмешивает в название нового дела слова из памяти диалога — убираем их
  if ((parsed.intent === "create_event" || parsed.intent === "create_recurring_event") && parsed.title) {
    parsed.title = stripContextWords(parsed.title, text, contextText);
  }

  if (parsed.intent === "create_event" || parsed.intent === "create_recurring_event") {
    const explicitTime = extractExplicitEventTime(text);
    if (explicitTime) {
      parsed.event_time = explicitTime;
      parsed.event_relative_minutes = null;
    }
  }

  try {
    await dispatch(chatId, parsed, ctx, patch, tz, text);
  } finally {
    await saveContext(chatId, { ...ctx, ...patch });
  }
}

async function dispatch(chatId, parsed, ctx, patch, tz, text) {
  if (parsed.intent === "weather") {
    await handleWeather(chatId, parsed, ctx, patch, text);
    return;
  }
  if (parsed.intent === "list_events") {
    await handleListEvents(chatId, parsed.list_scope, tz);
    return;
  }
  if (parsed.intent === "rename_event") {
    await handleRenameEvent(chatId, parsed, ctx, patch, tz);
    return;
  }
  if (parsed.intent === "reschedule_recurring_event") {
    await handleRescheduleRecurring(chatId, parsed, ctx, patch, tz);
    return;
  }
  if (parsed.intent === "search_events") {
    await handleSearchEvents(chatId, parsed, tz);
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


