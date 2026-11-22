// Обработчики дел: создание одного дела и список предстоящих.
const db = require("../db");
const { createEvents } = require("../plusPlans");
const { limitMessages } = require("../plusPlanLimits");
const { sendMessage } = require("../telegram");
const {
  todayInOffset, dateTimeError, eventListPeriod,
  toUtcIso,
  offsetMinutesToPhrase,
  formatDateHuman,
  utcIsoToLocalParts,
} = require("../time");

const { OFF, parsedOffset, reminderAt, reminderLine } = require("../reminderSettings");

/* ---- создание события ---- */
const DEFAULT_TIME = "12:00"; // время дела, если пользователь его не назвал
const DEFAULT_REMIND_MIN = 60; // напоминание по умолчанию — за час

async function handleCreateEvent(chatId, parsed, patch, tz) {
  if (parsed.event_date && dateTimeError(parsed.event_date, parsed.event_time || DEFAULT_TIME)) {
    await sendMessage(chatId, dateTimeError(parsed.event_date, parsed.event_time || DEFAULT_TIME));
    return;
  }
  let eventAtIso;
  let eventDateForText;
  let eventTimeForText;
  const relative = Number.isFinite(parsed.event_relative_minutes);
  const timeNamed = relative || !!parsed.event_time;

  if (relative) {
    const eventAt = new Date(Date.now() + parsed.event_relative_minutes * 60000);
    eventAtIso = eventAt.toISOString();
    const local = utcIsoToLocalParts(eventAtIso, tz);
    eventDateForText = local.dateStr;
    eventTimeForText = local.timeStr;
  } else {
    eventDateForText = parsed.event_date || todayInOffset(tz);
    eventTimeForText = parsed.event_time || DEFAULT_TIME;
    const invalid = dateTimeError(eventDateForText, eventTimeForText);
    if (invalid) { await sendMessage(chatId, invalid); return; }
    eventAtIso = toUtcIso(eventDateForText, eventTimeForText, tz);
  }

  const eventMs = new Date(eventAtIso).getTime();
  const emoji = parsed.emoji || "📌";

  // время уже прошло — не записываем, а честно говорим об ошибке
  if (eventMs <= Date.now()) {
    await sendMessage(
      chatId,
      timeNamed
        ? `⚠️ Это время уже прошло, дело «${parsed.title}» не записано.\n` +
            `🔁 Попробуй ещё раз: назови дату и время, например «завтра в 15:00».`
        : `⚠️ Время ты не назвал, а такие дела я ставлю на ${DEFAULT_TIME} — это время уже прошло, дело «${parsed.title}» не записано.\n` +
            `🔁 Напиши время, например «сегодня в 18:00», или другой день: «завтра».`
    );
    return;
  }

  // напоминание: названное пользователем или за час по умолчанию
  const requestedOffset = parsedOffset(parsed, DEFAULT_REMIND_MIN);
  let offsetMin = requestedOffset;
  let remindMs = offsetMin === OFF ? null : eventMs - offsetMin * 60000;
  let tooLate = false;
  if (remindMs !== null && remindMs <= Date.now()) {
    // нужное время напоминания уже прошло, а само дело ещё впереди — напомню в момент дела
    offsetMin = 0;
    remindMs = eventMs;
    tooLate = true;
  }
  const remindAtIso = reminderAt(eventAtIso, offsetMin);

  const ins = await createEvents(chatId, 1, client => client.query(
    `INSERT INTO events (chat_id, title, emoji, event_at, remind_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [chatId, parsed.title, emoji, eventAtIso, remindAtIso]
  ));
  if (!ins) {
    await sendMessage(chatId, limitMessages.event);
    return;
  }
  patch.last_event_id = ins.rows[0].id;

  const timeNote = timeNamed ? "" : ` (поставил на ${DEFAULT_TIME})`;
  let remindLine = reminderLine(offsetMin);
  if (tooLate) {
    remindLine += ` (${offsetMinutesToPhrase(requestedOffset)} уже не успеть)`;
  } else if (offsetMin > 0) {
    const rl = utcIsoToLocalParts(remindAtIso, tz);
    remindLine += rl.dateStr === eventDateForText ? ` (в ${rl.timeStr})` : ` (${formatDateHuman(rl.dateStr, rl.timeStr)})`;
  }
  await sendMessage(
    chatId,
    `✅ Записал: ${emoji} ${parsed.title}\n` +
      `📅 ${formatDateHuman(eventDateForText, eventTimeForText)}${timeNote}\n` +
      `${remindLine}\n` +
      `💡 Поправь, если видишь неточность`
  );
}

/* ---- список предстоящих дел ---- */
async function handleListEvents(chatId, scope, tz) {
  const period = eventListPeriod(scope, tz);

  // прошедшие периоды: берём последние 30 дел и показываем по порядку времени
  const past = ["yesterday", "last_week", "last_seven_days"].includes(scope);
  const order = past ? "DESC" : "ASC";
  const params = period.to ? [chatId, period.from, period.to] : [chatId, period.from];
  const sql = period.to
    ? `SELECT * FROM events WHERE chat_id=$1 AND event_at >= $2 AND event_at ${period.exclusiveEnd ? "<" : "<="} $3 ORDER BY event_at ${order} LIMIT 30`
    : `SELECT * FROM events WHERE chat_id=$1 AND event_at >= $2 ORDER BY event_at ${order} LIMIT 30`;

  const { rows } = await db.query(sql, params);
  if (past) rows.reverse();

  if (rows.length === 0) {
    await sendMessage(
      chatId,
      past ? "За этот период дел не было 🗓" : "Пока ничего не запланировано на этот период 🗓"
    );
    return;
  }

  const lines = rows.map((ev) => {
    const local = utcIsoToLocalParts(ev.event_at, tz);
    return `${ev.done_at ? "✅" : ev.emoji || "📌"} ${ev.title} — ${formatDateHuman(local.dateStr, local.timeStr)}`;
  });

  await sendMessage(chatId, `${past ? "Вот что было:" : "Вот что запланировано:"}\n\n${lines.join("\n")}`);
}

module.exports = { handleCreateEvent, handleListEvents };
