const { sendMessage } = require("../../../lib/telegram");
const { formatDateHuman, utcIsoToLocalParts, nextNOccurrencesUtcIso } = require("../../../lib/time");
const db = require("../../../lib/db");
const { getTzOffset } = require("../../../lib/settings");

const RECURRING_BUFFER_SIZE = 8;

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const tzCache = new Map();
  const tzFor = async (chatId) => {
    if (!tzCache.has(chatId)) tzCache.set(chatId, await getTzOffset(chatId));
    return tzCache.get(chatId);
  };

  try {
    let regenerated = 0;

    const { rows: templates } = await db.query(`SELECT * FROM recurring_events`);
    for (const tpl of templates) {
      const { rows: future } = await db.query(
        `SELECT event_at FROM events WHERE recurring_id=$1 AND event_at >= now() ORDER BY event_at DESC`,
        [tpl.id]
      );
      const missing = RECURRING_BUFFER_SIZE - future.length;
      if (missing <= 0) continue;

      const tz = await tzFor(tpl.chat_id);
      const afterIso = future.length > 0 ? future[0].event_at : undefined;
      const newOccurrences = nextNOccurrencesUtcIso(tpl, tz, missing, afterIso);

      for (const occIso of newOccurrences) {
        const remindIso = new Date(
          new Date(occIso).getTime() - tpl.remind_offset_minutes * 60000
        ).toISOString();
        await db.query(
          `INSERT INTO events (chat_id, title, emoji, event_at, remind_at, recurring_id) VALUES ($1,$2,$3,$4,$5,$6)`,
          [tpl.chat_id, tpl.title, tpl.emoji, occIso, remindIso, tpl.id]
        );
        regenerated += 1;
      }
    }

    const { rows } = await db.query(
      `SELECT * FROM events WHERE reminded = FALSE AND remind_at <= now() ORDER BY remind_at LIMIT 50`
    );

    for (const ev of rows) {
      const tz = await tzFor(ev.chat_id);
      const { dateStr, timeStr } = utcIsoToLocalParts(ev.event_at, tz);
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
