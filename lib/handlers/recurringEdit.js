// Правка повторяющихся дел кодовыми словами: «навсегда» (перенос всей серии) и «переименуй» (новое название).
const db = require("../db");
const { sendMessage } = require("../telegram");
const { utcIsoToLocalParts, formatDateHuman, nextNOccurrencesUtcIso } = require("../time");
const { WEEKDAY_NUM, RECURRING_BUFFER_SIZE } = require("../constants");
const { resolveTarget, resolveTemplateTarget, findCandidates, selectedTarget, isSpecific, replyNotFound, askWhich } = require("./eventTarget");
const { handleRescheduleEvent } = require("./eventsEdit");
const { scheduleLabelFor } = require("./recurring");

const { parsedOffset, eventOffset, templateOffset, reminderAt, reminderLine } = require("../reminderSettings");

/* ---- «перенеси … навсегда»: меняем расписание всей серии и пересоздаём будущие повторы ---- */
async function handleRescheduleRecurring(chatId, parsed, ctx, patch, tz) {
  const resolution = await resolveTemplateTarget(chatId, parsed, ctx, tz);
  if (resolution.ambiguous) return askWhich(chatId, parsed, resolution.candidates, patch, tz);
  const tpl = resolution.target;
  if (!tpl) {
    if (parsed._selection?.kind === 'template') return replyNotFound(chatId, parsed);
    await handleRescheduleEvent(chatId, parsed, ctx, patch, tz);
    return;
  }

  const upd = { weekday: tpl.weekday, time: tpl.time, month_day: tpl.month_day, month: tpl.month };
  const d = parsed.event_date ? new Date(`${parsed.event_date}T12:00:00Z`) : null;
  const namedWeekday = WEEKDAY_NUM[parsed.weekday];
  let given = false;

  if (parsed.event_time) {
    upd.time = parsed.event_time;
    given = true;
  }
  if (tpl.frequency === "weekly") {
    if (namedWeekday !== undefined) {
      upd.weekday = namedWeekday;
      given = true;
    } else if (d) {
      upd.weekday = d.getUTCDay();
      given = true;
    }
  } else if (tpl.frequency === "monthly" && d) {
    upd.month_day = d.getUTCDate();
    given = true;
  } else if (tpl.frequency === "yearly" && d) {
    upd.month_day = d.getUTCDate();
    upd.month = d.getUTCMonth() + 1;
    given = true;
  }

  if (!given) {
    await sendMessage(
      chatId,
      `На какой день или время перенести все повторы «${tpl.title}»?\nНапиши, например: «перенеси ${tpl.title} на вторник в 16:00 навсегда».`
    );
    patch.pending = {
      type: "reschedule_time", intent: "reschedule_recurring_event",
      selection: { kind: "template", id: tpl.id },
      reminder_disabled: parsed.reminder_disabled, remind_offset_minutes: parsed.remind_offset_minutes,
    };
    return;
  }

  const offsetMin = parsedOffset(parsed, templateOffset(tpl));
  const settingsGiven = parsed.reminder_disabled === true || Number.isFinite(parsed.remind_offset_minutes);
  // У отдельных экземпляров уже могли отключить или изменить напоминание.
  const { rows: previous } = await db.query(
    `SELECT * FROM events WHERE recurring_id=$1 AND event_at >= now() ORDER BY event_at ASC`, [tpl.id]
  );

  // если что-то оборвётся на полпути, cron сам достроит будущие повторы по новому расписанию
  await db.query(`UPDATE recurring_events SET weekday=$1, time=$2, month_day=$3, month=$4, remind_offset_minutes=$5 WHERE id=$6`, [
    upd.weekday,
    upd.time,
    upd.month_day,
    upd.month,
    offsetMin,
    tpl.id,
  ]);
  await db.query(`DELETE FROM events WHERE recurring_id=$1 AND event_at >= now()`, [tpl.id]);

  const newTpl = { ...tpl, ...upd };
  const occurrences = nextNOccurrencesUtcIso(newTpl, tz, RECURRING_BUFFER_SIZE);
  let firstId = null;
  for (const [index, occIso] of occurrences.entries()) {
    const instanceOffset = !settingsGiven && previous[index] ? eventOffset(previous[index]) : offsetMin;
    const remindIso = reminderAt(occIso, instanceOffset);
    const ins = await db.query(
      `INSERT INTO events (chat_id, title, emoji, event_at, remind_at, recurring_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [chatId, tpl.title, tpl.emoji, occIso, remindIso, tpl.id]
    );
    if (firstId === null) firstId = ins.rows[0].id;
  }
  patch.last_event_id = firstId;

  const local = utcIsoToLocalParts(occurrences[0], tz);
  const reminderNote = !settingsGiven && previous.some(ev => eventOffset(ev) !== offsetMin)
    ? "⏰ Сохранил настройки напоминаний каждого повтора" : reminderLine(offsetMin);
  await sendMessage(
    chatId,
    `♾ Теперь: ${tpl.emoji || "📌"} ${tpl.title} — ${scheduleLabelFor(newTpl)} в ${newTpl.time}\n` +
      `📅 Ближайшее: ${formatDateHuman(local.dateStr, local.timeStr)}\n` +
      reminderNote
  );
}

/* ---- «переименуй X в Y»: у повторяющегося дела название меняется у всей серии ---- */
async function handleRenameEvent(chatId, parsed, ctx, patch, tz) {
  const newTitle = String(parsed.new_title || "").trim();
  if (!newTitle) {
    await sendMessage(chatId, "Как переименовать? Например: «переименуй планёрку в совещание по маркетингу».");
    return;
  }

  let chosen;
  if (parsed._selection) {
    chosen = (await selectedTarget(chatId, parsed._selection)).target;
  } else if (isSpecific(parsed)) {
    const templates = await findCandidates(chatId, parsed, tz, 'template');
    const events = await findCandidates(chatId, parsed, tz);
    const candidates = new Map(templates.map(t => [`template:${t.id}`, t]));
    for (const ev of events) {
      if (ev.recurring_id) {
        const key = `template:${ev.recurring_id}`;
        if (!candidates.has(key)) {
          const linked = await selectedTarget(chatId, {kind: 'template', id: ev.recurring_id});
          if (linked.target) candidates.set(key, linked.target);
        }
      } else candidates.set(`event:${ev.id}`, ev);
    }
    const list = [...candidates.values()];
    if (list.length > 1) return askWhich(chatId, parsed, list, patch, tz);
    chosen = list[0];
  } else {
    chosen = (await resolveTarget(chatId, parsed, ctx, tz)).target;
  }
  if (!chosen) return replyNotFound(chatId, parsed);
  let tpl = chosen._kind === 'template' ? chosen : null;
  const ev = chosen._kind === 'event' ? chosen : null;
  if (ev?.recurring_id) tpl = (await selectedTarget(chatId, {kind: 'template', id: ev.recurring_id})).target;

  if (tpl) {
    await db.query(`UPDATE recurring_events SET title=$1 WHERE id=$2`, [newTitle, tpl.id]);
    await db.query(`UPDATE events SET title=$1 WHERE recurring_id=$2 AND event_at >= now()`, [newTitle, tpl.id]);
    const next = await db.query(`SELECT * FROM events WHERE recurring_id=$1 AND chat_id=$2 AND event_at >= now() ORDER BY event_at ASC LIMIT 1`, [tpl.id, chatId]);
    patch.last_event_id = next.rows[0]?.id || null;
    await sendMessage(chatId, `✏️ Переименовал все повторы: «${tpl.title}» → «${newTitle}»`);
    return;
  }
  if (ev) {
    await db.query(`UPDATE events SET title=$1 WHERE id=$2`, [newTitle, ev.id]);
    patch.last_event_id = ev.id;
    await sendMessage(chatId, `✏️ Переименовал: «${ev.title}» → «${newTitle}»`);
    return;
  }
  await sendMessage(chatId, `Не нашёл дело, похожее на «${parsed.title || ""}».`);
}

module.exports = { handleRescheduleRecurring, handleRenameEvent };
