// Обработчики изменения дела: удаление и перенос.
const db = require("../db");
const { sendMessage } = require("../telegram");
const { utcIsoToLocalParts, formatDateHuman, toUtcIso } = require("../time");
const { resolveTarget, replyNotFound } = require("./eventTarget");

/* ---- удаление события ---- */
async function handleDeleteEvent(chatId, parsed, ctx, patch, tz) {
  const { target, matches } = await resolveTarget(chatId, parsed, ctx);
  if (!target) {
    await replyNotFound(chatId, parsed);
    return;
  }
  await db.query(`DELETE FROM events WHERE id=$1`, [target.id]);
  if (ctx.last_event_id === target.id) patch.last_event_id = null;
  const local = utcIsoToLocalParts(target.event_at, tz);
  const note = matches.length > 1 ? "\n\n(похожих было несколько — удалил ближайшее по времени)" : "";
  await sendMessage(
    chatId,
    `🗑 Удалил: ${target.emoji || "📌"} ${target.title} — ${formatDateHuman(local.dateStr, local.timeStr)}${note}`
  );
}

/* ---- перенос события ---- */
async function handleRescheduleEvent(chatId, parsed, ctx, patch, tz) {
  const { target, matches } = await resolveTarget(chatId, parsed, ctx);
  if (!target) {
    await replyNotFound(chatId, parsed);
    return;
  }
  patch.last_event_id = target.id;

  let newEventAtIso;
  let newDateForText;
  let newTimeForText;

  if (Number.isFinite(parsed.event_relative_minutes)) {
    const eventAt = new Date(Date.now() + parsed.event_relative_minutes * 60000);
    newEventAtIso = eventAt.toISOString();
    const local = utcIsoToLocalParts(newEventAtIso, tz);
    newDateForText = local.dateStr;
    newTimeForText = local.timeStr;
  } else if (parsed.event_date || parsed.event_time) {
    const oldLocal = utcIsoToLocalParts(target.event_at, tz);
    newDateForText = parsed.event_date || oldLocal.dateStr;
    newTimeForText = parsed.event_time || oldLocal.timeStr;
    newEventAtIso = toUtcIso(newDateForText, newTimeForText, tz);
  } else {
    await sendMessage(chatId, `На какое время перенести «${target.title}»? Напиши дату или время.`);
    patch.pending = { type: "reschedule_time" };
    return;
  }

  // сохраняем прежний интервал напоминания относительно события
  const oldOffsetMin = target.remind_at
    ? Math.round((new Date(target.event_at).getTime() - new Date(target.remind_at).getTime()) / 60000)
    : 0;
  const offsetMin = Number.isFinite(parsed.remind_offset_minutes) ? parsed.remind_offset_minutes : oldOffsetMin;
  const newRemindAtIso = new Date(new Date(newEventAtIso).getTime() - offsetMin * 60000).toISOString();

  await db.query(`UPDATE events SET event_at=$1, remind_at=$2, reminded=FALSE WHERE id=$3`, [
    newEventAtIso,
    newRemindAtIso,
    target.id,
  ]);

  const note = matches.length > 1 ? "\n\n(похожих было несколько — перенёс ближайшее по времени)" : "";
  await sendMessage(
    chatId,
    `↪️ Перенёс: ${target.emoji || "📌"} ${target.title}\n` +
      `📅 Новое время: ${formatDateHuman(newDateForText, newTimeForText)}${note}`
  );
}

module.exports = { handleDeleteEvent, handleRescheduleEvent };
