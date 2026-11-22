const { requireTelegramUser } = require("../_auth");
const { toUtcIso, todayInOffset, isValidDate, dateTimeError } = require("../../../../lib/time");
const { getTzOffset } = require("../../../../lib/settings");
const db = require("../../../../lib/db");
const { createEvents } = require("../../../../lib/plusPlans");
const { limitMessages } = require("../../../../lib/plusPlanLimits");

const { apiOffset, eventOffset, reminderAt } = require("../../../../lib/reminderSettings");

export default async function handler(req, res) {
  const chatId = requireTelegramUser(req, res);
  if (!chatId) return;

  if (req.method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    const { from, to } = req.query;
    const fromIso = from || new Date(Date.now() - 3 * 86400000).toISOString();
    const toIso = to || new Date(Date.now() + 90 * 86400000).toISOString();

    if (![fromIso, toIso].every(value => typeof value === "string" && isValidDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value))) ||
        Date.parse(fromIso) > Date.parse(toIso)) {
      res.status(400).json({ error: "Уточни корректные даты начала и конца периода." });
      return;
    }

    const { rows } = await db.query(
      `SELECT id, title, emoji, event_at, remind_at, recurring_id, done_at FROM events
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
        remindOffsetMinutes: eventOffset(e),
        recurring: !!e.recurring_id,
        done: !!e.done_at,
        doneAt: e.done_at || null,
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
    const timeStr = time || "12:00"; // без времени — полдень, как и в боте
    const invalid = dateTimeError(dateStr, timeStr);
    if (invalid) { res.status(400).json({ error: invalid }); return; }
    const eventAtIso = toUtcIso(dateStr, timeStr, tz);
    const eventMs = new Date(eventAtIso).getTime();

    // время уже прошло — не записываем, как и в боте
    if (eventMs <= Date.now()) {
      res.status(400).json({
        error: time
          ? "⚠️ Это время уже прошло — выбери другое."
          : "⚠️ Время не указано, а 12:00 этого дня уже прошло — укажи время или другой день.",
      });
      return;
    }

    // напоминание по умолчанию — за час; если за нужное время уже не успеть — напомним в момент дела
    let offsetMin;
    try {
      offsetMin = apiOffset(remindOffsetMinutes, 60);
    } catch (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    let remindAtIso = reminderAt(eventAtIso, offsetMin);
    if (remindAtIso !== null && new Date(remindAtIso).getTime() <= Date.now()) remindAtIso = eventAtIso;

    const ins = await createEvents(chatId, 1, client => client.query(
      `INSERT INTO events (chat_id, title, emoji, event_at, remind_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [chatId, title.trim(), emoji || "📌", eventAtIso, remindAtIso]
    ));
    if (!ins) return res.status(409).json({ error: limitMessages.event });
    res.status(200).json({ id: ins.rows[0].id, eventAt: eventAtIso });
    return;
  }

  res.status(405).end();
}
