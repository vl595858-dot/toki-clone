// Второе напоминание «накануне в 12:00» (для дней рождения): у серии recurring_events.day_before = TRUE,
// отметка отправки — events.reminded2. Вызывается cron-ом каждую минуту.
const db = require("./db");
const { deliverReminder } = require("./reminderDelivery");
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
    try {
      const delivered = await deliverReminder(ev.id, "reminded2", async (current) => {
        const tz = await tzFor(current.chat_id);
        const { remindAt, dayStart } = dayBeforeTimes(current.event_at, tz);
        const now = new Date();
        if (now < remindAt || now >= dayStart) return false;
        const { dateStr, timeStr } = utcIsoToLocalParts(current.event_at, tz);
        const text = `⏰ Завтра: ${current.emoji || "📌"} ${current.title}\n🗓 Событие: ${formatDateHuman(dateStr, timeStr)}`;
        return sendMessage(current.chat_id, text);
      });
      if (delivered) sent += 1;
    } catch (e) {
      console.error("day-before reminder failed for", ev.id, e);
    }
  }
  return sent;
}

module.exports = { sendDayBeforeReminders, dayBeforeTimes };
