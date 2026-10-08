const { sendMessage, answerCallbackQuery } = require("../../../lib/telegram");
const { transcribeVoice, parseMessage } = require("../../../lib/ai");
const { getWeatherText, getTimezoneOffsetForCity } = require("../../../lib/weather");
const {
  todayInOffset,
  toUtcIso,
  offsetMinutesToPhrase,
  formatDateHuman,
  utcIsoToLocalParts,
  nextRecurringOccurrenceUtcIso,
  nextNOccurrencesUtcIso,
} = require("../../../lib/time");
const db = require("../../../lib/db");
const { loadContext, saveContext } = require("../../../lib/context");
const { getTzOffset, setTzOffset } = require("../../../lib/settings");

const { WEEKDAY_NUM, WEEKDAY_RU, MONTHS_GEN, RECURRING_BUFFER_SIZE, TZ_CHOICES } = require("../../../lib/constants");

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
  }
  res.status(200).json({ ok: true });
}

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

    const ctx = await loadContext(chatId);
    if (ctx.pending && ctx.pending.type === "timezone_city") {
      await saveContext(chatId, { ...ctx, pending: null });
    }
  }
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
      "Привет! 👋 Я запомню твои дела и напомню о них.\n\n" +
        "Пиши или говори голосом, например:\n" +
        "«Встреча с юристом в четверг в 15:00, напомни за час»\n" +
        "«Каждый понедельник в 16:00 собрание с партнёрами»\n" +
        "«Каждый день в 8:00 зарядка»\n" +
        "«15-го числа каждого месяца оплатить аренду»\n" +
        "«У мамы день рождения 5 мая, напомни за неделю»\n" +
        "«Что у меня сегодня»\n" +
        "«Удали встречу с юристом»\n" +
        "«Перенеси встречу с юристом на пятницу в 18:00»\n" +
        "«Не напоминай про встречу с юристом»\n" +
        "«Останови повторяющееся собрание с партнёрами»\n\n" +
        "Я помню последний час разговора: после записи дела можно написать «перенеси его на пятницу» или «напомни за час».\n\n" +
        "Про погоду тоже можно спросить: «погода в Перми послезавтра», а потом «а завтра?»\n\n" +
        "Часовой пояс можно посмотреть и поменять командой /timezone."
    );
    return;
  }

  // память диалога нужна уже здесь, чтобы понять ответ на /timezone городом
  const ctx = await loadContext(chatId);
  const patch = { pending: null }; // ожидание живёт только один шаг, если хендлер не поставит новое

  if (ctx.pending && ctx.pending.type === "timezone_city") {
    const cityName = text.trim();
    const result = await getTimezoneOffsetForCity(cityName);
    if (!result) {
      await sendMessage(
        chatId,
        `Не нашёл город «${cityName}». Попробуй написать иначе, либо используй кнопки из /timezone.`
      );
      patch.pending = { type: "timezone_city" };
    } else {
      await setTzOffset(chatId, result.offset);
      await sendMessage(chatId, `✅ Часовой пояс установлен по городу «${result.placeName}»: ${result.offset}`);
    }
    await saveContext(chatId, { ...ctx, ...patch });
    return;
  }

  if (text.trim() === "/timezone") {
    await sendMessage(chatId, "Выбери часовой пояс кнопкой или просто напиши название своего города:", {
      replyMarkup: {
        inline_keyboard: [TZ_CHOICES.map((c) => ({ text: c.label, callback_data: `tz:${c.offset}` }))],
      },
    });
    patch.pending = { type: "timezone_city" };
    await saveContext(chatId, { ...ctx, ...patch });
    return;
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

/* ---- справка для модели о текущем состоянии разговора ---- */
async function buildContextText(chatId, ctx, tz) {
  try {
    const lines = [];
    const pending = ctx.pending;
    if (pending && pending.type === "weather_region") {
      lines.push(
        `Бот только что спросил у пользователя город для погоды и ждёт название места (weather_offset_days=${
          pending.weather_offset_days ?? 0
        }).`
      );
    }
    if (pending && pending.type === "reschedule_time") {
      lines.push("Бот только что спросил, на какое время перенести дело, и ждёт новую дату или время.");
    }
    if (pending && pending.type === "reminder_offset") {
      lines.push("Бот только что спросил, за сколько напомнить о деле, и ждёт интервал (например «за час»).");
    }
    if (ctx.last_event_id) {
      const { rows } = await db.query(`SELECT title, event_at FROM events WHERE id=$1 AND chat_id=$2`, [
        ctx.last_event_id,
        chatId,
      ]);
      if (rows.length) {
        const local = utcIsoToLocalParts(rows[0].event_at, tz);
        lines.push(
          `Последнее дело, о котором шла речь: «${rows[0].title}» — ${formatDateHuman(local.dateStr, local.timeStr)}.`
        );
      }
    }
    if (ctx.last_region) {
      lines.push(
        `Последний запрос погоды: город «${ctx.last_region}», weather_offset_days=${ctx.last_weather_offset_days ?? 0}.`
      );
    }
    return lines.join("\n");
  } catch (e) {
    console.error("buildContextText error", e);
    return "";
  }
}

/* ---- погода ---- */
async function handleWeather(chatId, parsed, ctx, patch) {
  const region = parsed.region || ctx.last_region || null;
  const offsetDays = Number.isFinite(parsed.weather_offset_days) ? parsed.weather_offset_days : 0;

  if (!region) {
    await sendMessage(chatId, "Для какого города показать погоду? Напиши название — например, «Пермь».");
    patch.pending = { type: "weather_region", weather_offset_days: offsetDays };
    return;
  }

  const reply = await getWeatherText(region, offsetDays, parsed.weather_part_of_day, parsed.weather_hour);
  await sendMessage(chatId, reply);
  if (reply.startsWith("📍")) {
    patch.last_region = region;
    patch.last_weather_offset_days = offsetDays;
  }
}

/* ---- создание события ---- */
async function handleCreateEvent(chatId, parsed, patch, tz) {
  let eventAtIso;
  let eventDateForText;
  let eventTimeForText;

  if (Number.isFinite(parsed.event_relative_minutes)) {
    const eventAt = new Date(Date.now() + parsed.event_relative_minutes * 60000);
    eventAtIso = eventAt.toISOString();
    const local = utcIsoToLocalParts(eventAtIso, tz);
    eventDateForText = local.dateStr;
    eventTimeForText = local.timeStr;
  } else {
    eventDateForText = parsed.event_date || todayInOffset(tz);
    eventTimeForText = parsed.event_time || "09:00";
    eventAtIso = toUtcIso(eventDateForText, eventTimeForText, tz);
  }

  const offsetMin = Number.isFinite(parsed.remind_offset_minutes) ? parsed.remind_offset_minutes : 0;
  const remindAtIso = new Date(new Date(eventAtIso).getTime() - offsetMin * 60000).toISOString();
  const emoji = parsed.emoji || "📌";

  const ins = await db.query(
    `INSERT INTO events (chat_id, title, emoji, event_at, remind_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [chatId, parsed.title, emoji, eventAtIso, remindAtIso]
  );
  patch.last_event_id = ins.rows[0].id;

  const timeNote =
    parsed.event_time || Number.isFinite(parsed.event_relative_minutes)
      ? ""
      : " (время не назвал — поставил на 09:00, можно написать «поставь на 18:00»)";
  await sendMessage(
    chatId,
    `✅ Записал: ${emoji} ${parsed.title}\n` +
      `📅 ${formatDateHuman(eventDateForText, eventTimeForText)}${timeNote}\n` +
      `⏰ Напомню ${offsetMinutesToPhrase(offsetMin)}`
  );
}

/* ---- список предстоящих дел ---- */
async function handleListEvents(chatId, scope, tz) {
  let from = new Date();
  let to = null;

  if (scope === "today") {
    const dateStr = todayInOffset(tz);
    from = new Date(toUtcIso(dateStr, "00:00", tz));
    to = new Date(toUtcIso(dateStr, "23:59", tz));
  } else if (scope === "tomorrow") {
    const tomorrow = new Date(Date.now() + 86400000);
    const local = utcIsoToLocalParts(tomorrow.toISOString(), tz);
    from = new Date(toUtcIso(local.dateStr, "00:00", tz));
    to = new Date(toUtcIso(local.dateStr, "23:59", tz));
  }

  const params = to ? [chatId, from.toISOString(), to.toISOString()] : [chatId, from.toISOString()];
  const sql = to
    ? `SELECT * FROM events WHERE chat_id=$1 AND event_at >= $2 AND event_at <= $3 ORDER BY event_at ASC LIMIT 30`
    : `SELECT * FROM events WHERE chat_id=$1 AND event_at >= $2 ORDER BY event_at ASC LIMIT 30`;

  const { rows } = await db.query(sql, params);

  if (rows.length === 0) {
    await sendMessage(chatId, "Пока ничего не запланировано на этот период 🗓");
    return;
  }

  const lines = rows.map((ev) => {
    const local = utcIsoToLocalParts(ev.event_at, tz);
    return `${ev.emoji || "📌"} ${ev.title} — ${formatDateHuman(local.dateStr, local.timeStr)}`;
  });

  await sendMessage(chatId, `Вот что запланировано:\n\n${lines.join("\n")}`);
}

/* ---- поиск ближайшего подходящего события по ключевым словам ---- */
async function findEventByTitle(chatId, titleSearch) {
  if (!titleSearch) return null;

  // разбиваем на слова и для каждого пробуем полную форму и укороченную основу —
  // это снимает часть проблем с падежами ("молоко" / "молока" / "молоку")
  const words = titleSearch
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);

  const variants = new Set();
  for (const w of words) {
    variants.add(w);
    if (w.length >= 5) variants.add(w.slice(0, -1));
    if (w.length >= 6) variants.add(w.slice(0, -2));
  }
  if (variants.size === 0) variants.add(titleSearch);

  const variantList = Array.from(variants);
  const conditions = variantList.map((_, i) => `title ILIKE $${i + 2}`).join(" OR ");
  const params = [chatId, ...variantList.map((v) => `%${v}%`)];

  const { rows } = await db.query(
    `SELECT * FROM events WHERE chat_id=$1 AND event_at >= now() AND (${conditions}) ORDER BY event_at ASC LIMIT 5`,
    params
  );
  return rows;
}

/* ---- определяем, о каком деле речь: последнее из памяти или найденное по названию ---- */
async function resolveTarget(chatId, parsed, ctx) {
  if (parsed.refers_to_last && ctx.last_event_id) {
    const { rows } = await db.query(`SELECT * FROM events WHERE id=$1 AND chat_id=$2`, [
      ctx.last_event_id,
      chatId,
    ]);
    if (rows.length) return { target: rows[0], matches: rows };
  }
  if (parsed.title) {
    const matches = await findEventByTitle(chatId, parsed.title);
    if (matches && matches.length) return { target: matches[0], matches };
  }
  return { target: null, matches: [] };
}

async function replyNotFound(chatId, parsed) {
  if (parsed.refers_to_last && !parsed.title) {
    await sendMessage(chatId, "Не помню, о каком деле речь — назови его, пожалуйста.");
  } else {
    await sendMessage(chatId, `Не нашёл дело, похожее на «${parsed.title || ""}» среди предстоящих.`);
  }
}

/* ---- удаление события ---- */
async function handleDeleteEvent(chatId, parsed, ctx, patch, tz) {
  const { target, matches } = await resolveTarget(chatId, parsed, ctx);
  if (!target) {
    await replyNotFound(chatId, parsed);
    return;
  }
  await db.query(`DELETE FROM events WHERE id=$1`, [target.id]);
  if (ctx.last_event_id === target.id) patch.last_event_id = null;
  const local = utcIsoToLocalParts(target.event_at, tz);
  const note = matches.length > 1 ? "\n\n(похожих было несколько — удалил ближайшее по времени)" : "";
  await sendMessage(
    chatId,
    `🗑 Удалил: ${target.emoji || "📌"} ${target.title} — ${formatDateHuman(local.dateStr, local.timeStr)}${note}`
  );
}

/* ---- перенос события ---- */
async function handleRescheduleEvent(chatId, parsed, ctx, patch, tz) {
  const { target, matches } = await resolveTarget(chatId, parsed, ctx);
  if (!target) {
    await replyNotFound(chatId, parsed);
    return;
  }
  patch.last_event_id = target.id;

  let newEventAtIso;
  let newDateForText;
  let newTimeForText;

  if (Number.isFinite(parsed.event_relative_minutes)) {
    const eventAt = new Date(Date.now() + parsed.event_relative_minutes * 60000);
    newEventAtIso = eventAt.toISOString();
    const local = utcIsoToLocalParts(newEventAtIso, tz);
    newDateForText = local.dateStr;
    newTimeForText = local.timeStr;
  } else if (parsed.event_date || parsed.event_time) {
    const oldLocal = utcIsoToLocalParts(target.event_at, tz);
    newDateForText = parsed.event_date || oldLocal.dateStr;
    newTimeForText = parsed.event_time || oldLocal.timeStr;
    newEventAtIso = toUtcIso(newDateForText, newTimeForText, tz);
  } else {
    await sendMessage(chatId, `На какое время перенести «${target.title}»? Напиши дату или время.`);
    patch.pending = { type: "reschedule_time" };
    return;
  }

  // сохраняем прежний интервал напоминания относительно события
  const oldOffsetMin = target.remind_at
    ? Math.round((new Date(target.event_at).getTime() - new Date(target.remind_at).getTime()) / 60000)
    : 0;
  const offsetMin = Number.isFinite(parsed.remind_offset_minutes) ? parsed.remind_offset_minutes : oldOffsetMin;
  const newRemindAtIso = new Date(new Date(newEventAtIso).getTime() - offsetMin * 60000).toISOString();

  await db.query(`UPDATE events SET event_at=$1, remind_at=$2, reminded=FALSE WHERE id=$3`, [
    newEventAtIso,
    newRemindAtIso,
    target.id,
  ]);

  const note = matches.length > 1 ? "\n\n(похожих было несколько — перенёс ближайшее по времени)" : "";
  await sendMessage(
    chatId,
    `↪️ Перенёс: ${target.emoji || "📌"} ${target.title}\n` +
      `📅 Новое время: ${formatDateHuman(newDateForText, newTimeForText)}${note}`
  );
}

/* ---- отмена только напоминания, событие остаётся ---- */
async function handleCancelReminder(chatId, parsed, ctx, patch, tz) {
  const { target, matches } = await resolveTarget(chatId, parsed, ctx);
  if (!target) {
    await replyNotFound(chatId, parsed);
    return;
  }
  patch.last_event_id = target.id;
  await db.query(`UPDATE events SET remind_at=NULL WHERE id=$1`, [target.id]);
  const local = utcIsoToLocalParts(target.event_at, tz);
  const note = matches.length > 1 ? "\n\n(похожих было несколько — снял напоминание с ближайшего)" : "";
  await sendMessage(
    chatId,
    `🔕 Напоминание отключено: ${target.emoji || "📌"} ${target.title} — ${formatDateHuman(
      local.dateStr,
      local.timeStr
    )}${note}\nСамо событие осталось в списке.`
  );
}

/* ---- поставить или изменить напоминание у существующего дела ---- */
async function handleSetReminder(chatId, parsed, ctx, patch, tz) {
  const { target, matches } = await resolveTarget(chatId, parsed, ctx);
  if (!target) {
    await replyNotFound(chatId, parsed);
    return;
  }
  patch.last_event_id = target.id;

  if (!Number.isFinite(parsed.remind_offset_minutes)) {
    await sendMessage(
      chatId,
      `За сколько напомнить о деле «${target.title}»? Например: «за час» или «за 30 минут».`
    );
    patch.pending = { type: "reminder_offset" };
    return;
  }

  const eventAtMs = new Date(target.event_at).getTime();
  if (eventAtMs <= Date.now()) {
    await sendMessage(chatId, `Дело «${target.title}» уже прошло — напоминание поставить нельзя.`);
    return;
  }

  let remindMs = eventAtMs - parsed.remind_offset_minutes * 60000;
  let note = "";
  if (remindMs <= Date.now()) {
    remindMs = eventAtMs;
    note = "\n(нужное время напоминания уже прошло — напомню в момент события)";
  }

  await db.query(`UPDATE events SET remind_at=$1, reminded=FALSE WHERE id=$2`, [
    new Date(remindMs).toISOString(),
    target.id,
  ]);

  const local = utcIsoToLocalParts(target.event_at, tz);
  const actualOffset = Math.round((eventAtMs - remindMs) / 60000);
  const multi = matches.length > 1 ? "\n\n(похожих было несколько — выбрал ближайшее по времени)" : "";
  await sendMessage(
    chatId,
    `⏰ Готово: ${target.emoji || "📌"} ${target.title} — ${formatDateHuman(local.dateStr, local.timeStr)}\n` +
      `Напомню ${offsetMinutesToPhrase(actualOffset)}${note}${multi}`
  );
}

/* ---- создание регулярно повторяющегося дела (день/неделя/месяц/год) ---- */
async function handleCreateRecurringEvent(chatId, parsed, patch, tz) {
  const frequency = ["daily", "weekly", "monthly", "yearly"].includes(parsed.recurring_frequency)
    ? parsed.recurring_frequency
    : "weekly"; // на случай, если модель не прислала тип — самый безопасный дефолт

  let weekdayNum = null;
  let monthDay = null;
  let month = null;
  let scheduleLabel = "";

  if (frequency === "weekly") {
    weekdayNum = WEEKDAY_NUM[parsed.weekday];
    if (weekdayNum === undefined) {
      await sendMessage(chatId, "Не понял, на какой день недели. Уточни, пожалуйста.");
      return;
    }
    scheduleLabel = `каждую неделю в ${WEEKDAY_RU[weekdayNum]}`;
  } else if (frequency === "monthly") {
    monthDay = Number(parsed.recurring_month_day);
    if (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31) {
      await sendMessage(chatId, "Какого числа каждый месяц? Уточни число от 1 до 31.");
      return;
    }
    scheduleLabel = `каждый месяц ${monthDay}-го числа`;
  } else if (frequency === "yearly") {
    month = Number(parsed.recurring_month);
    monthDay = Number(parsed.recurring_month_day);
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31) {
      await sendMessage(chatId, "Уточни дату — число и месяц, например «5 мая».");
      return;
    }
    scheduleLabel = `каждый год ${monthDay} ${MONTHS_GEN[month - 1]}`;
  } else {
    scheduleLabel = "каждый день";
  }

  const time = parsed.event_time || "09:00";
  const offsetMin = Number.isFinite(parsed.remind_offset_minutes) ? parsed.remind_offset_minutes : 0;
  const emoji = parsed.emoji || "📌";

  const insertRes = await db.query(
    `INSERT INTO recurring_events (chat_id, title, emoji, frequency, weekday, month_day, month, time, remind_offset_minutes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [chatId, parsed.title, emoji, frequency, weekdayNum, monthDay, month, time, offsetMin]
  );
  const recurringId = insertRes.rows[0].id;

  const tpl = { frequency, weekday: weekdayNum, month_day: monthDay, month, time };
  // сразу создаём запас из нескольких ближайших повторений, а не одно —
  // чтобы в календаре-приложении было видно наперёд, а не только ближайшее
  const occurrences = nextNOccurrencesUtcIso(tpl, tz, RECURRING_BUFFER_SIZE);
  let firstEventId = null;
  for (const occIso of occurrences) {
    const remindIso = new Date(new Date(occIso).getTime() - offsetMin * 60000).toISOString();
    const ev = await db.query(
      `INSERT INTO events (chat_id, title, emoji, event_at, remind_at, recurring_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [chatId, parsed.title, emoji, occIso, remindIso, recurringId]
    );
    if (firstEventId === null) firstEventId = ev.rows[0].id;
  }
  patch.last_event_id = firstEventId;

  const nextEventAtIso = occurrences[0];
  const local = utcIsoToLocalParts(nextEventAtIso, tz);
  const timeNote = parsed.event_time ? "" : " (время не назвал — поставил на 09:00, поправь, если не то)";
  await sendMessage(
    chatId,
    `🔁 Буду повторять ${scheduleLabel} в ${time}${timeNote}: ${emoji} ${parsed.title}\n` +
      `📅 Ближайшее: ${formatDateHuman(local.dateStr, local.timeStr)}\n` +
      `⏰ Напомню ${offsetMinutesToPhrase(offsetMin)}`
  );
}

/* ---- остановка повторяющегося дела целиком ---- */
async function handleDeleteRecurringEvent(chatId, titleSearch) {
  if (!titleSearch) {
    await sendMessage(chatId, "Какое повторяющееся дело остановить? Уточни название.");
    return;
  }

  const { rows } = await db.query(
    `SELECT * FROM recurring_events WHERE chat_id=$1 AND title ILIKE $2 ORDER BY id ASC LIMIT 5`,
    [chatId, `%${titleSearch}%`]
  );

  if (rows.length === 0) {
    await sendMessage(chatId, `Не нашёл повторяющееся дело, похожее на «${titleSearch}».`);
    return;
  }

  const target = rows[0];
  await db.query(`DELETE FROM events WHERE recurring_id=$1 AND event_at >= now()`, [target.id]);
  await db.query(`DELETE FROM recurring_events WHERE id=$1`, [target.id]);

  const note = rows.length > 1 ? "\n\n(похожих было несколько — остановил первое найденное)" : "";
  await sendMessage(
    chatId,
    `⏹ Остановил повторение: ${target.emoji || "📌"} ${target.title} (было ${scheduleLabelFor(target)} в ${target.time})${note}`
  );
}

/* ---- текстовое описание расписания шаблона для любого из четырёх типов ---- */
function scheduleLabelFor(tpl) {
  if (tpl.frequency === "daily") return "каждый день";
  if (tpl.frequency === "monthly") return `каждый месяц ${tpl.month_day}-го числа`;
  if (tpl.frequency === "yearly") return `каждый год ${tpl.month_day} ${MONTHS_GEN[tpl.month - 1]}`;
  return `каждую неделю в ${WEEKDAY_RU[tpl.weekday]}`;
}

/* ---- защита от слов из памяти в названии нового дела ---- */
function wordTokens(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^a-zа-я0-9]+/)
    .filter(Boolean);
}

// слова считаем одинаковыми, если совпадают целиком или первые буквы (учёт падежей: «зум» / «зуму»)
function sameWord(a, b) {
  if (a === b) return true;
  const n = Math.min(4, a.length, b.length);
  return n >= 3 && a.slice(0, n) === b.slice(0, n);
}

// убираем из названия слова, которых нет в сообщении пользователя, но есть в памяти диалога
function stripContextWords(title, messageText, contextText) {
  if (!title || !contextText) return title;
  const msg = wordTokens(messageText);
  const ctxWords = wordTokens(contextText);
  const kept = String(title)
    .split(/\s+/)
    .filter((word) => {
      const tokens = wordTokens(word);
      if (tokens.length === 0) return true;
      const inMessage = tokens.every((t) => msg.some((m) => sameWord(t, m)));
      if (inMessage) return true;
      const inContext = tokens.every((t) => ctxWords.some((c) => sameWord(t, c)));
      return !inContext;
    });
  const result = kept.join(" ").trim();
  return result || title;
}
