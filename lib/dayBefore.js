// Второе напоминание «накануне в 12:00» (для дней рождения): у серии recurring_events.day_before = TRUE,
// отметка отправки — events.reminded2. Вызывается cron-ом каждую минуту.
const db = require("./db");
const { sendMessage } = require("./telegram");
const { toUtcIso, utcIsoToLocalParts, formatDateHuman } = require("./time");

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// когда напомнить (накануне 12:00 местного времени) и когда наступает день события (после этого «завтра» уже неверно)
function dayBeforeTimes(eventAtIso, tz) {
  const { dateStr } = utcIsoToLocalParts(eventAtIso, tz);
  return {
    remindAt: new Date(toUtcIso(shiftDate(dateStr, -1), "12:00", tz)),
    dayStart: new Date(toUtcIso(dateStr, "00:00", tz)),
  };
}

async function sendDayBeforeReminders(tzFor) {
  const { rows } = await db.query(
    `SELECT e.* FROM events e JOIN recurring_events t ON t.id = e.recurring_id
     WHERE t.day_before = TRUE AND e.reminded2 = FALSE AND e.done_at IS NULL
       AND e.event_at > now() AND e.event_at <= now() + interval '3 days'`
  );
  let sent = 0;
  for (const ev of rows) {
    const tz = await tzFor(ev.chat_id);
    const { remindAt, dayStart } = dayBeforeTimes(ev.event_at, tz);
    const now = new Date();
    if (now < remindAt) continue; // ещё рано
    // «занимаем» дело: два одновременных запуска не отправят одно и то же дважды
    const claim = await db.query(`UPDATE events SET reminded2 = TRUE WHERE id = $1 AND reminded2 = FALSE RETURNING id`, [ev.id]);
    if (!claim.rows.length) continue;
    if (now >= dayStart) continue; // день события уже наступил — «завтра» неверно, молча пропускаем
    const { dateStr, timeStr } = utcIsoToLocalParts(ev.event_at, tz);
    const text = `⏰ Завтра: ${ev.emoji || "📌"} ${ev.title}\n🗓 Событие: ${formatDateHuman(dateStr, timeStr)}`;
    try {
      if (await sendMessage(ev.chat_id, text)) sent += 1;
      else await db.query(`UPDATE events SET reminded2 = FALSE WHERE id = $1`, [ev.id]);
    } catch (e) {
      console.error("day-before reminder failed for", ev.id, e);
      await db.query(`UPDATE events SET reminded2 = FALSE WHERE id = $1`, [ev.id]);
    }
  }
  return sent;
}

module.exports = { sendDayBeforeReminders, dayBeforeTimes };
