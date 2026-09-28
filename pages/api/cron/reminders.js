const { sendMessage } = require("../../../lib/telegram");
const { formatDateHuman, utcIsoToLocalParts, nextWeekdayOccurrenceUtcIso } = require("../../../lib/time");
const db = require("../../../lib/db");

const TZ_OFFSET = process.env.DEFAULT_TZ_OFFSET || "+03:00";

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    let regenerated = 0;

    // для каждого повторяющегося шаблона — убедиться, что есть будущий экземпляр
    const { rows: templates } = await db.query(`SELECT * FROM recurring_events`);
    for (const tpl of templates) {
      const { rows: future } = await db.query(
        `SELECT id FROM events WHERE recurring_id=$1 AND event_at >= now() LIMIT 1`,
        [tpl.id]
      );
      if (future.length > 0) continue;

      const nextEventAtIso = nextWeekdayOccurrenceUtcIso(tpl.weekday, tpl.time, TZ_OFFSET);
      const remindAtIso = new Date(
        new Date(nextEventAtIso).getTime() - tpl.remind_offset_minutes * 60000
      ).toISOString();

      await db.query(
        `INSERT INTO events (chat_id, title, emoji, event_at, remind_at, recurring_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [tpl.chat_id, tpl.title, tpl.emoji, nextEventAtIso, remindAtIso, tpl.id]
      );
      regenerated += 1;
    }

    const { rows } = await db.query(
      `SELECT * FROM events WHERE reminded = FALSE AND remind_at <= now() ORDER BY remind_at LIMIT 50`
    );

    for (const ev of rows) {
      const { dateStr, timeStr } = utcIsoToLocalParts(ev.event_at, TZ_OFFSET);
      const text =
        `⏰ Напоминание: ${ev.emoji || "📌"} ${ev.title}\n` +
        `🗓 Событие: ${formatDateHuman(dateStr, timeStr)}`;
      try {
        await sendMessage(ev.chat_id, text);
        await db.query(`UPDATE events SET reminded = TRUE WHERE id = $1`, [ev.id]);
      } catch (e) {
        console.error("reminder send failed for", ev.id, e);
      }
    }

    res.status(200).json({ processed: rows.length, regenerated });
  } catch (e) {
    console.error("cron reminders error", e);
    res.status(500).json({ error: String(e) });
  }
}
