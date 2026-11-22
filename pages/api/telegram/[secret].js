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
const { prepareTarget, isNewCommand } = require("../../../lib/targetQuery");
const { commandOffset, OFF, AMBIGUOUS, INTERVAL_QUESTION, isIntervalOnly } = require("../../../lib/reminderSettings");
const { dateInputError } = require("../../../lib/dateInput");
const { historicalListScope } = require("../../../lib/time");
const { handlePlusCommand, handlePlusLink, handlePromo, handlePromoDuration } = require("../../../lib/handlers/plus");
const { charge, release } = require("../../../lib/plusPlans");
const { limitMessages } = require("../../../lib/plusPlanLimits");
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
      else if (String(cq.data || "").startsWith("promo:")) await handlePromoDuration(cq);
      else if (String(cq.data || "").startsWith("plus:")) await handlePlusLink(cq);
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
  const plusStart = /^\/start(?:@\w+)? plus_(\S+)$/.exec(message.text?.trim() || "");
  if (plusStart || /^\/plus(?:@\w+)?$/.test(message.text?.trim() || "")) {
    await handlePlusCommand(message, plusStart?.[1]);
    return;
  }

  const sharedPromo = /^\/start(?:@\w+)? promo_(PLUS-[A-F0-9]{24})$/i.exec(message.text?.trim() || "");
  if (sharedPromo) {
    await handlePromo(message, "promo", sharedPromo[1]);
    return;
  }
  const promo = /^\/(promo|promogive|promocampaign|myid)(?:@\w+)?(?:\s+([^\n]+))?$/.exec(message.text?.trim() || "");
  if (promo) {
    await handlePromo(message, promo[1], promo[2]);
    return;
  }

  // картинка (скриншот билета, талона, счёта): разбор документа; PDF и другие файлы не принимаем
  if (message.photo || message.document) {
    await handlePhoto(message, await getTzOffset(chatId));
    return;
  }

  let text = message.text;

  if (!text && message.voice) {
    const quota = process.env.PLUS_PLANS_ENABLED === "1" ? await charge(chatId, "voice") : { allowed: true };
    if (!quota.allowed) {
      await sendMessage(chatId, limitMessages.voice);
      return;
    }
    let errorText = "Не расслышал голосовое — попробуй ещё раз, покороче и чётче.";
    try {
      text = await transcribeVoice(message.voice.file_id);
    } catch (e) {
      console.error("transcribe error", e);
      errorText = "Не получилось распознать голосовое. Попробуй текстом.";
    }
    if (!text) {
      if (quota.id) await release(chatId, quota.id);
      await sendMessage(chatId, errorText);
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
    ctx = { ...ctx, pending: null }; // новая команда отменяет прежнее ожидающее действие
    await saveContext(chatId, ctx);
  }

  // часовой пояс этого конкретного чата — свой на каждого человека
  const tz = await getTzOffset(chatId);

  // Ответ на уточнение выполняет сохранённое действие, а не новую догадку модели.
  if (["reminder_interval", "reminder_offset"].includes(ctx.pending?.type)) {
    const pending = ctx.pending;
    if (/^(?:отмена|отмени|стоп)[.!?]*$/iu.test(text.trim())) {
      await sendMessage(chatId, "Хорошо, ничего не меняю.");
      await saveContext(chatId, { ...ctx, pending: null });
      return;
    }
    if (isNewCommand(text) && !isIntervalOnly(text)) {
      ctx = { ...ctx, pending: null };
      await saveContext(chatId, ctx);
    } else {
      const offset = commandOffset(text, { allowBare: true });
      if (offset === undefined || offset === AMBIGUOUS) {
        await sendMessage(chatId, INTERVAL_QUESTION);
        return;
      }
      const saved = pending.parsed || { intent: "set_reminder", refers_to_last: true,
        _selection: pending.selection || (ctx.last_event_id ? { kind: "event", id: ctx.last_event_id } : undefined) };
      const parsed = { ...saved, reminder_ambiguous: false, reminder_disabled: offset === OFF,
        remind_offset_minutes: offset === OFF ? null : offset };
      try {
        await dispatch(chatId, parsed, ctx, patch, tz, pending.text || text);
      } finally {
        await saveContext(chatId, { ...ctx, ...patch });
      }
      return;
    }
  }

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

  if (/^(?:create_|reschedule_)/.test(parsed.intent)) {
    const invalid = dateInputError(text, parsed.event_date, tz);
    if (invalid) { await sendMessage(chatId, invalid); return; }
  }
  if (parsed.intent === "list_events") parsed.list_scope = historicalListScope(text) || parsed.list_scope;

  prepareTarget(parsed, text, tz);
  if (parsed.intent === "reschedule_event" && parsed.refers_to_last &&
      ctx.pending?.type === "reschedule_time" && !isNewCommand(text)) {
    parsed.intent = ctx.pending.intent || "reschedule_event";
    parsed._selection = ctx.pending.selection;
  }

  // Состояние напоминания берём только из текущей команды, не из памяти модели.
  if (["create_event", "create_recurring_event", "reschedule_event", "reschedule_recurring_event", "set_reminder"].includes(parsed.intent)) {
    const offset = commandOffset(text);
    parsed.reminder_ambiguous = offset === AMBIGUOUS;
    parsed.reminder_disabled = offset === OFF;
    parsed.remind_offset_minutes = Number.isFinite(offset) && offset !== OFF ? offset : null;
    if (offset === undefined && /^reschedule_/.test(parsed.intent) && ctx.pending?.type === "reschedule_time" && parsed.refers_to_last && !isNewCommand(text)) {
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
  if (parsed.reminder_ambiguous) {
    await sendMessage(chatId, INTERVAL_QUESTION);
    patch.pending = { type: "reminder_interval", parsed: { ...parsed }, text };
    return;
  }
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
    await handleDeleteRecurringEvent(chatId, parsed, ctx, patch, tz);
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


