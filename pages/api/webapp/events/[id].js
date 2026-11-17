const { requireTelegramUser } = require("../_auth");
const { toUtcIso, utcIsoToLocalParts } = require("../../../../lib/time");
const { getTzOffset } = require("../../../../lib/settings");
const db = require("../../../../lib/db");

const { OFF, apiOffset, eventOffset, reminderAt } = require("../../../../lib/reminderSettings");

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
    const { title, date, time, remindOffsetMinutes } = req.body || {};
    const tz = await getTzOffset(chatId);

    let eventAtIso = current.event_at;
    if (date || time !== undefined) {
      const oldLocal = utcIsoToLocalParts(current.event_at, tz);
      const newDate = date || oldLocal.dateStr;
      // пустое время («без времени») = 12:00, как и везде в проекте
      const newTime = time === "" ? "12:00" : time || oldLocal.timeStr;
      eventAtIso = toUtcIso(newDate, newTime, tz);
    }

    const previousOffset = eventOffset(current);
    let offset;
    try {
      offset = apiOffset(remindOffsetMinutes, previousOffset);
    } catch (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    const timeChanged = new Date(eventAtIso).getTime() !== new Date(current.event_at).getTime();
    const settingChanged = offset !== previousOffset;
    const remindAtIso = timeChanged || settingChanged ? reminderAt(eventAtIso, offset) : current.remind_at;
    // Переименование не сбрасывает ни отметки доставки, ни настройки.
    const reminded = timeChanged || settingChanged ? false : current.reminded;
    const reminded2 = timeChanged || (previousOffset === OFF && offset !== OFF) ? false : current.reminded2;
    if (!timeChanged && !settingChanged) {
      await db.query(`UPDATE events SET title=$1 WHERE id=$2`, [title ? title.trim() : current.title, id]);
    } else await db.query(
      `UPDATE events SET title=$1, event_at=$2, remind_at=$3, reminded=$4, reminded2=$5 WHERE id=$6`,
      [title ? title.trim() : current.title, eventAtIso, remindAtIso, reminded, reminded2, id]
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
