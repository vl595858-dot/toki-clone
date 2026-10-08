// Обработчики повторяющихся дел (день/неделя/месяц/год): создание и остановка.
const db = require("../db");
const { sendMessage } = require("../telegram");
const { utcIsoToLocalParts, formatDateHuman, offsetMinutesToPhrase, nextNOccurrencesUtcIso } = require("../time");
const { WEEKDAY_NUM, WEEKDAY_RU, MONTHS_GEN, RECURRING_BUFFER_SIZE } = require("../constants");

/* ---- создание регулярно повторяющегося дела (день/неделя/месяц/год) ---- */
async function handleCreateRecurringEvent(chatId, parsed, patch, tz) {
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
    scheduleLabel = `каждую неделю в ${WEEKDAY_RU[weekdayNum]}`;
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
    scheduleLabel = `каждый год ${monthDay} ${MONTHS_GEN[month - 1]}`;
  } else {
    scheduleLabel = "каждый день";
  }

  const time = parsed.event_time || "09:00";
  const offsetMin = Number.isFinite(parsed.remind_offset_minutes) ? parsed.remind_offset_minutes : 0;
  const emoji = parsed.emoji || "📌";

  const insertRes = await db.query(
    `INSERT INTO recurring_events (chat_id, title, emoji, frequency, weekday, month_day, month, time, remind_offset_minutes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [chatId, parsed.title, emoji, frequency, weekdayNum, monthDay, month, time, offsetMin]
  );
  const recurringId = insertRes.rows[0].id;

  const tpl = { frequency, weekday: weekdayNum, month_day: monthDay, month, time };
  // сразу создаём запас из нескольких ближайших повторений, а не одно —
  // чтобы в календаре-приложении было видно наперёд, а не только ближайшее
  const occurrences = nextNOccurrencesUtcIso(tpl, tz, RECURRING_BUFFER_SIZE);
  let firstEventId = null;
  for (const occIso of occurrences) {
    const remindIso = new Date(new Date(occIso).getTime() - offsetMin * 60000).toISOString();
    const ev = await db.query(
      `INSERT INTO events (chat_id, title, emoji, event_at, remind_at, recurring_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [chatId, parsed.title, emoji, occIso, remindIso, recurringId]
    );
    if (firstEventId === null) firstEventId = ev.rows[0].id;
  }
  patch.last_event_id = firstEventId;

  const nextEventAtIso = occurrences[0];
  const local = utcIsoToLocalParts(nextEventAtIso, tz);
  const timeNote = parsed.event_time ? "" : " (время не назвал — поставил на 09:00, поправь, если не то)";
  await sendMessage(
    chatId,
    `🔁 Буду повторять ${scheduleLabel} в ${time}${timeNote}: ${emoji} ${parsed.title}\n` +
      `📅 Ближайшее: ${formatDateHuman(local.dateStr, local.timeStr)}\n` +
      `⏰ Напомню ${offsetMinutesToPhrase(offsetMin)}`
  );
}

/* ---- остановка повторяющегося дела целиком ---- */
async function handleDeleteRecurringEvent(chatId, titleSearch) {
  if (!titleSearch) {
    await sendMessage(chatId, "Какое повторяющееся дело остановить? Уточни название.");
    return;
  }

  const { rows } = await db.query(
    `SELECT * FROM recurring_events WHERE chat_id=$1 AND title ILIKE $2 ORDER BY id ASC LIMIT 5`,
    [chatId, `%${titleSearch}%`]
  );

  if (rows.length === 0) {
    await sendMessage(chatId, `Не нашёл повторяющееся дело, похожее на «${titleSearch}».`);
    return;
  }

  const target = rows[0];
  await db.query(`DELETE FROM events WHERE recurring_id=$1 AND event_at >= now()`, [target.id]);
  await db.query(`DELETE FROM recurring_events WHERE id=$1`, [target.id]);

  const note = rows.length > 1 ? "\n\n(похожих было несколько — остановил первое найденное)" : "";
  await sendMessage(
    chatId,
    `⏹ Остановил повторение: ${target.emoji || "📌"} ${target.title} (было ${scheduleLabelFor(target)} в ${target.time})${note}`
  );
}

/* ---- текстовое описание расписания шаблона для любого из четырёх типов ---- */
function scheduleLabelFor(tpl) {
  if (tpl.frequency === "daily") return "каждый день";
  if (tpl.frequency === "monthly") return `каждый месяц ${tpl.month_day}-го числа`;
  if (tpl.frequency === "yearly") return `каждый год ${tpl.month_day} ${MONTHS_GEN[tpl.month - 1]}`;
  return `каждую неделю в ${WEEKDAY_RU[tpl.weekday]}`;
}

module.exports = { handleCreateRecurringEvent, handleDeleteRecurringEvent };
