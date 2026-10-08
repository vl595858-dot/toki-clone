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

module.exports = { handleCreateEvent, handleListEvents };
