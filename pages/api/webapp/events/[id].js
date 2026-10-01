const { requireTelegramUser } = require("../_auth");
const { toUtcIso, utcIsoToLocalParts } = require("../../../../lib/time");
const { getTzOffset } = require("../../../../lib/settings");
const db = require("../../../../lib/db");

export default async function handler(req, res) {
  const chatId = requireTelegramUser(req, res);
  if (!chatId) return;

  const id = Number(req.query.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Некорректный id" });
    return;
  }

  // убеждаемся, что дело принадлежит именно этому пользователю — чужое изменить нельзя
  const own = await db.query(`SELECT * FROM events WHERE id=$1 AND chat_id=$2`, [id, chatId]);
  if (own.rows.length === 0) {
    res.status(404).json({ error: "Дело не найдено" });
    return;
  }
  const current = own.rows[0];

  if (req.method === "PATCH") {
    const { title, date, time } = req.body || {};
    const tz = await getTzOffset(chatId);

    let eventAtIso = current.event_at;
    if (date || time) {
      const oldLocal = utcIsoToLocalParts(current.event_at, tz);
      const newDate = date || oldLocal.dateStr;
      const newTime = time || oldLocal.timeStr;
      eventAtIso = toUtcIso(newDate, newTime, tz);
    }

    // сохраняем прежний интервал напоминания относительно события, как и в боте
    let remindAtIso = current.remind_at;
    if (current.remind_at && eventAtIso !== current.event_at) {
      const offsetMin = Math.round(
        (new Date(current.event_at).getTime() - new Date(current.remind_at).getTime()) / 60000
      );
      remindAtIso = new Date(new Date(eventAtIso).getTime() - offsetMin * 60000).toISOString();
    }

    await db.query(
      `UPDATE events SET title=$1, event_at=$2, remind_at=$3, reminded=FALSE WHERE id=$4`,
      [title ? title.trim() : current.title, eventAtIso, remindAtIso, id]
    );
    res.status(200).json({ ok: true, eventAt: eventAtIso });
    return;
  }

  if (req.method === "DELETE") {
    await db.query(`DELETE FROM events WHERE id=$1`, [id]);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).end();
}
