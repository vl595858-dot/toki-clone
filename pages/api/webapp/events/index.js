const { requireTelegramUser } = require("../_auth");
const { toUtcIso, todayInOffset } = require("../../../../lib/time");
const { getTzOffset } = require("../../../../lib/settings");
const db = require("../../../../lib/db");

export default async function handler(req, res) {
  const chatId = requireTelegramUser(req, res);
  if (!chatId) return;

  if (req.method === "GET") {
    const { from, to } = req.query;
    const fromIso = from || new Date(Date.now() - 3 * 86400000).toISOString();
    const toIso = to || new Date(Date.now() + 90 * 86400000).toISOString();

    const { rows } = await db.query(
      `SELECT id, title, emoji, event_at, remind_at, recurring_id FROM events
       WHERE chat_id=$1 AND event_at >= $2 AND event_at <= $3
       ORDER BY event_at ASC LIMIT 500`,
      [chatId, fromIso, toIso]
    );
    res.status(200).json({
      events: rows.map((e) => ({
        id: e.id,
        title: e.title,
        emoji: e.emoji || "📌",
        eventAt: e.event_at,
        hasReminder: !!e.remind_at,
        recurring: !!e.recurring_id,
      })),
    });
    return;
  }

  if (req.method === "POST") {
    const { title, emoji, date, time, remindOffsetMinutes } = req.body || {};
    if (!title) {
      res.status(400).json({ error: "Нужно название дела" });
      return;
    }
    const tz = await getTzOffset(chatId);
    const dateStr = date || todayInOffset(tz);
    const timeStr = time || "09:00";
    const eventAtIso = toUtcIso(dateStr, timeStr, tz);
    const offsetMin = Number.isFinite(remindOffsetMinutes) ? remindOffsetMinutes : 0;
    const remindAtIso = new Date(new Date(eventAtIso).getTime() - offsetMin * 60000).toISOString();

    const ins = await db.query(
      `INSERT INTO events (chat_id, title, emoji, event_at, remind_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [chatId, title.trim(), emoji || "📌", eventAtIso, remindAtIso]
    );
    res.status(200).json({ id: ins.rows[0].id, eventAt: eventAtIso });
    return;
  }

  res.status(405).end();
}
