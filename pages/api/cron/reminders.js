const { sendMessage } = require("../../../lib/telegram");
const { formatDateHuman, utcIsoToLocalParts } = require("../../../lib/time");
const db = require("../../../lib/db");

const TZ_OFFSET = process.env.DEFAULT_TZ_OFFSET || "+03:00";

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
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

    res.status(200).json({ processed: rows.length });
  } catch (e) {
    console.error("cron reminders error", e);
    res.status(500).json({ error: String(e) });
  }
}
