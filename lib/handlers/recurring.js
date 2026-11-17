// Обработчики повторяющихся дел (день/неделя/месяц/год): создание и остановка.
const db = require("../db");
const { sendMessage } = require("../telegram");
const { utcIsoToLocalParts, formatDateHuman, nextNOccurrencesUtcIso, isValidDate, dateTimeError } = require("../time");
const { WEEKDAY_NUM, WEEKDAY_RU, MONTHS_GEN, RECURRING_BUFFER_SIZE } = require("../constants");
const { resolveTemplateTarget, replyNotFound, askWhich } = require("./eventTarget");

const { OFF, parsedOffset, reminderAt, reminderLine } = require("../reminderSettings");

// «в понедельник», «во вторник», «в среду»
const inDay = (n) => `${n === 2 ? "во" : "в"} ${WEEKDAY_RU[n]}`;

/* ---- создание регулярно повторяющегося дела (день/неделя/месяц/год) ---- */
async function handleCreateRecurringEvent(chatId, parsed, patch, tz) {
  const invalid = dateTimeError(parsed.event_date || "2000-01-01", parsed.event_time || "12:00");
  if (invalid) { await sendMessage(chatId, invalid); return; }
  const frequency = ["daily", "weekly", "monthly", "yearly"].includes(parsed.recurring_frequency)
    ? parsed.recurring_frequency
    : "weekly"; // на случай, если модель не прислала тип — самый безопасный дефолт

  let weekdayNum = null;
  let monthDay = null;
  let month = null;
  let scheduleLabel = "";

  if (frequency === "weekly") {
    weekdayNum = WEEKDAY_NUM[parsed.weekday];
    if (weekdayNum === undefined) {
      await sendMessage(chatId, "Не понял, на какой день недели. Уточни, пожалуйста.");
      return;
    }
    scheduleLabel = `каждую неделю ${inDay(weekdayNum)}`;
  } else if (frequency === "monthly") {
    monthDay = Number(parsed.recurring_month_day);
    if (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31) {
      await sendMessage(chatId, "Какого числа каждый месяц? Уточни число от 1 до 31.");
      return;
    }
    scheduleLabel = `каждый месяц ${monthDay}-го числа`;
  } else if (frequency === "yearly") {
    month = Number(parsed.recurring_month);
    monthDay = Number(parsed.recurring_month_day);
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31) {
      await sendMessage(chatId, "Уточни дату — число и месяц, например «5 мая».");
      return;
    }
    if (!isValidDate(`2000-${String(month).padStart(2, "0")}-${String(monthDay).padStart(2, "0")}`)) {
      await sendMessage(chatId, "Такой календарной даты нет. Уточни число и месяц.");
      return;
    }
    scheduleLabel = `каждый год ${monthDay} ${MONTHS_GEN[month - 1]}`;
  } else {
    scheduleLabel = "каждый день";
  }

  const defaultTime = parsed.is_birthday ? "10:00" : "12:00"; // без времени — полдень (у дней рождения 10:00)
  const time = parsed.event_time || defaultTime;
  const offsetMin = parsedOffset(parsed, parsed.is_birthday ? 10080 : 60);
  const emoji = parsed.emoji || "📌";

  const insertRes = await db.query(
    `INSERT INTO recurring_events (chat_id, title, emoji, frequency, weekday, month_day, month, time, remind_offset_minutes, day_before)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [chatId, parsed.title, emoji, frequency, weekdayNum, monthDay, month, time, offsetMin, parsed.is_birthday === true]
  );
  const recurringId = insertRes.rows[0].id;

  const tpl = { frequency, weekday: weekdayNum, month_day: monthDay, month, time };
  // сразу создаём запас из нескольких ближайших повторений, а не одно —
  // чтобы в календаре-приложении было видно наперёд, а не только ближайшее
  const occurrences = nextNOccurrencesUtcIso(tpl, tz, RECURRING_BUFFER_SIZE);
  let firstEventId = null;
  for (const occIso of occurrences) {
    const remindIso = reminderAt(occIso, offsetMin);
    const ev = await db.query(
      `INSERT INTO events (chat_id, title, emoji, event_at, remind_at, recurring_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [chatId, parsed.title, emoji, occIso, remindIso, recurringId]
    );
    if (firstEventId === null) firstEventId = ev.rows[0].id;
  }
  patch.last_event_id = firstEventId;

  const nextEventAtIso = occurrences[0];
  const local = utcIsoToLocalParts(nextEventAtIso, tz);
  const timeNote = parsed.event_time ? "" : ` (поставил на ${defaultTime})`;
  await sendMessage(
    chatId,
    `🔁 Буду повторять ${scheduleLabel} в ${time}${timeNote}: ${emoji} ${parsed.title}\n` +
      `📅 Ближайшее: ${formatDateHuman(local.dateStr, local.timeStr)}\n` +
      reminderLine(offsetMin) +
      (parsed.is_birthday && offsetMin !== OFF ? "\n⏰ И накануне в 12:00" : "")
  );
}

/* ---- остановка повторяющегося дела целиком ---- */
async function handleDeleteRecurringEvent(chatId, parsed, ctx, patch, tz) {
  const { target, ambiguous, candidates } = await resolveTemplateTarget(chatId, parsed, ctx, tz);
  if (ambiguous) return askWhich(chatId, parsed, candidates, patch, tz);
  if (!target) return replyNotFound(chatId, parsed);

  await db.query(`DELETE FROM events WHERE recurring_id=$1 AND event_at >= now()`, [target.id]);
  await db.query(`DELETE FROM recurring_events WHERE id=$1`, [target.id]);
  patch.last_event_id = null;

  await sendMessage(
    chatId,
    `⏹ Остановил повторение: ${target.emoji || "📌"} ${target.title} (было ${scheduleLabelFor(target)} в ${target.time})`
  );
}

/* ---- текстовое описание расписания шаблона для любого из четырёх типов ---- */
function scheduleLabelFor(tpl) {
  if (tpl.frequency === "daily") return "каждый день";
  if (tpl.frequency === "monthly") return `каждый месяц ${tpl.month_day}-го числа`;
  if (tpl.frequency === "yearly") return `каждый год ${tpl.month_day} ${MONTHS_GEN[tpl.month - 1]}`;
  return `каждую неделю ${inDay(tpl.weekday)}`;
}

module.exports = { handleCreateRecurringEvent, handleDeleteRecurringEvent, scheduleLabelFor };
