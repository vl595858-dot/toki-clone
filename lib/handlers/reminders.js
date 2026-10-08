// Обработчики напоминаний: отмена и установка напоминания у существующего дела.
const db = require("../db");
const { sendMessage } = require("../telegram");
const { utcIsoToLocalParts, formatDateHuman, offsetMinutesToPhrase } = require("../time");
const { resolveTarget, replyNotFound } = require("./eventTarget");

/* ---- отмена только напоминания, событие остаётся ---- */
async function handleCancelReminder(chatId, parsed, ctx, patch, tz) {
  const { target, matches } = await resolveTarget(chatId, parsed, ctx);
  if (!target) {
    await replyNotFound(chatId, parsed);
    return;
  }
  patch.last_event_id = target.id;
  await db.query(`UPDATE events SET remind_at=NULL WHERE id=$1`, [target.id]);
  const local = utcIsoToLocalParts(target.event_at, tz);
  const note = matches.length > 1 ? "\n\n(похожих было несколько — снял напоминание с ближайшего)" : "";
  await sendMessage(
    chatId,
    `🔕 Напоминание отключено: ${target.emoji || "📌"} ${target.title} — ${formatDateHuman(
      local.dateStr,
      local.timeStr
    )}${note}\nСамо событие осталось в списке.`
  );
}

/* ---- поставить или изменить напоминание у существующего дела ---- */
async function handleSetReminder(chatId, parsed, ctx, patch, tz) {
  const { target, matches } = await resolveTarget(chatId, parsed, ctx);
  if (!target) {
    await replyNotFound(chatId, parsed);
    return;
  }
  patch.last_event_id = target.id;

  if (!Number.isFinite(parsed.remind_offset_minutes)) {
    await sendMessage(
      chatId,
      `За сколько напомнить о деле «${target.title}»? Например: «за час» или «за 30 минут».`
    );
    patch.pending = { type: "reminder_offset" };
    return;
  }

  const eventAtMs = new Date(target.event_at).getTime();
  if (eventAtMs <= Date.now()) {
    await sendMessage(chatId, `Дело «${target.title}» уже прошло — напоминание поставить нельзя.`);
    return;
  }

  let remindMs = eventAtMs - parsed.remind_offset_minutes * 60000;
  let note = "";
  if (remindMs <= Date.now()) {
    remindMs = eventAtMs;
    note = "\n(нужное время напоминания уже прошло — напомню в момент события)";
  }

  await db.query(`UPDATE events SET remind_at=$1, reminded=FALSE WHERE id=$2`, [
    new Date(remindMs).toISOString(),
    target.id,
  ]);

  const local = utcIsoToLocalParts(target.event_at, tz);
  const actualOffset = Math.round((eventAtMs - remindMs) / 60000);
  const multi = matches.length > 1 ? "\n\n(похожих было несколько — выбрал ближайшее по времени)" : "";
  await sendMessage(
    chatId,
    `⏰ Готово: ${target.emoji || "📌"} ${target.title} — ${formatDateHuman(local.dateStr, local.timeStr)}\n` +
      `Напомню ${offsetMinutesToPhrase(actualOffset)}${note}${multi}`
  );
}

module.exports = { handleCancelReminder, handleSetReminder };
