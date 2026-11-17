// Обработчики изменения дела: удаление и перенос.
const db = require("../db");
const { sendMessage } = require("../telegram");
const { utcIsoToLocalParts, formatDateHuman, toUtcIso } = require("../time");
const { resolveTarget, replyNotFound, askWhich } = require("./eventTarget");

const { parsedOffset, eventOffset, reminderAt, reminderLine } = require("../reminderSettings");

/* ---- удаление события ---- */
async function handleDeleteEvent(chatId, parsed, ctx, patch, tz) {
  const { target, ambiguous, candidates } = await resolveTarget(chatId, parsed, ctx, tz);
  if (ambiguous) {
    await askWhich(chatId, parsed, candidates, patch, tz);
    return;
  }
  if (!target) {
    await replyNotFound(chatId, parsed);
    return;
  }
  await db.query(`DELETE FROM events WHERE id=$1`, [target.id]);
  patch.last_event_id = null;
  const local = utcIsoToLocalParts(target.event_at, tz);
  await sendMessage(
    chatId,
    `🗑 Удалил: ${target.emoji || "📌"} ${target.title} — ${formatDateHuman(local.dateStr, local.timeStr)}`
  );
}

/* ---- перенос события ---- */
async function handleRescheduleEvent(chatId, parsed, ctx, patch, tz) {
  const { target, ambiguous, candidates } = await resolveTarget(chatId, parsed, ctx, tz);
  if (ambiguous) {
    await askWhich(chatId, parsed, candidates, patch, tz);
    return;
  }
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
    patch.pending = {
      type: "reschedule_time",
      intent: "reschedule_event",
      selection: { kind: "event", id: target.id },
      reminder_disabled: parsed.reminder_disabled,
      remind_offset_minutes: parsed.remind_offset_minutes,
    };
    return;
  }

  // новое время уже в прошлом — не переносим
  if (new Date(newEventAtIso).getTime() <= Date.now()) {
    await sendMessage(
      chatId,
      `⚠️ Это время уже прошло, «${target.title}» не перенесено — осталось как было.\n` +
        `🔁 Попробуй ещё раз: назови дату и время, например «перенеси на завтра в 15:00».`
    );
    return;
  }

  // сохраняем прежний интервал напоминания относительно события
  const offsetMin = parsedOffset(parsed, eventOffset(target));
  const newRemindAtIso = reminderAt(newEventAtIso, offsetMin);

  await db.query(`UPDATE events SET event_at=$1, remind_at=$2, reminded=FALSE, reminded2=FALSE, done_at=NULL WHERE id=$3`, [
    newEventAtIso,
    newRemindAtIso,
    target.id,
  ]);

  await sendMessage(
    chatId,
    `↪️ Перенёс: ${target.emoji || "📌"} ${target.title}\n` +
      `📅 Новое время: ${formatDateHuman(newDateForText, newTimeForText)}\n` +
      `${reminderLine(offsetMin)}`
  );
}

module.exports = { handleDeleteEvent, handleRescheduleEvent };
