// Обработчики дел: создание одного дела и список предстоящих.
const db = require("../db");
const { sendMessage } = require("../telegram");
const {
  todayInOffset,
  toUtcIso,
  offsetMinutesToPhrase,
  formatDateHuman,
  utcIsoToLocalParts,
} = require("../time");

/* ---- создание события ---- */
const DEFAULT_TIME = "12:00"; // время дела, если пользователь его не назвал
const DEFAULT_REMIND_MIN = 60; // напоминание по умолчанию — за час

async function handleCreateEvent(chatId, parsed, patch, tz) {
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
  const requestedOffset = Number.isFinite(parsed.remind_offset_minutes) ? parsed.remind_offset_minutes : DEFAULT_REMIND_MIN;
  let offsetMin = requestedOffset;
  let remindMs = eventMs - offsetMin * 60000;
  let tooLate = false;
  if (remindMs <= Date.now()) {
    // нужное время напоминания уже прошло, а само дело ещё впереди — напомню в момент дела
    offsetMin = 0;
    remindMs = eventMs;
    tooLate = true;
  }
  const remindAtIso = new Date(remindMs).toISOString();

  const ins = await db.query(
    `INSERT INTO events (chat_id, title, emoji, event_at, remind_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [chatId, parsed.title, emoji, eventAtIso, remindAtIso]
  );
  patch.last_event_id = ins.rows[0].id;

  const timeNote = timeNamed ? "" : ` (время не назвал — поставил на ${DEFAULT_TIME})`;
  let remindLine = `⏰ Напомню ${offsetMinutesToPhrase(offsetMin)}`;
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
      `💡 Поправить: «напомни за сутки», «перенеси на пятницу», «поставь на 18:00»`
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

module.exports = { handleCreateEvent, handleListEvents };
