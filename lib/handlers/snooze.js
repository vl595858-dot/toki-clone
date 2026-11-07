// «⏰ Напомнить позже»: сдвигает только напоминание, само событие остаётся на месте.
const db = require("../db");
const { sendMessage } = require("../telegram");
const { saveContext } = require("../context");
const { parseMessage } = require("../ai");
const { extractOffsetMinutes, isAtEventMoment } = require("../text");
const { todayInOffset, toUtcIso, formatDateHuman, utcIsoToLocalParts } = require("../time");
const { mentionsDate, mentionsTime } = require("../docs");

// «через час», «через 30 минут», «через 2 дня» → минуты
function relativeMinutes(text) {
  const m = String(text).toLowerCase().match(/через\s+(полчаса|час|минуту|пару\s+часов|пару\s+минут|(\d+)\s*(мин\S*|час\S*|ч|дн\S*|день|сутки))/);
  if (!m) return null;
  if (m[1] === "полчаса") return 30;
  if (m[1] === "час") return 60;
  if (m[1] === "минуту") return 1;
  if (/^пару\s+часов/.test(m[1])) return 120;
  if (/^пару\s+минут/.test(m[1])) return 2;
  const n = Number(m[2]);
  if (/^мин/.test(m[3])) return n;
  if (/^(час|ч$)/.test(m[3])) return n * 60;
  return n * 1440;
}

// когда напомнить (мс) по словам человека; null — не похоже на время
async function resolveRemindTime(text, eventMs, tz) {
  if (isAtEventMoment(text)) return eventMs;
  const rel = relativeMinutes(text);
  if (rel) return Date.now() + rel * 60000;
  const off = extractOffsetMinutes(text);
  if (off) return eventMs - off * 60000;

  let parsed = {};
  try {
    parsed = await parseMessage(text, tz, "");
  } catch (e) {
    console.error("snooze parse error", e);
    return null;
  }
  const dateNamed = parsed.event_date && mentionsDate(text);
  const timeNamed = parsed.event_time && mentionsTime(text);
  if (!dateNamed && !timeNamed) return null;
  const date = dateNamed ? parsed.event_date : todayInOffset(tz);
  let ms = new Date(toUtcIso(date, timeNamed ? parsed.event_time : "09:00", tz)).getTime();
  if (!dateNamed && ms <= Date.now()) ms += 86400000; // «в 9:00», когда 9:00 сегодня уже прошло — завтра
  return ms;
}

async function handleSnoozeReply(chatId, text, ctx, tz) {
  const p = ctx.pending;
  if (!p || p.type !== "snooze") return false;
  const { rows } = await db.query(`SELECT * FROM events WHERE id=$1 AND chat_id=$2`, [p.event_id, chatId]);
  const ev = rows[0];
  if (!ev) {
    await sendMessage(chatId, "Этого дела уже нет.");
    await saveContext(chatId, { ...ctx, pending: null });
    return true;
  }
  const eventMs = new Date(ev.event_at).getTime();
  const remindMs = await resolveRemindTime(text, eventMs, tz);
  if (remindMs === null) return false; // не про время — пусть разберёт обычный разбор фразы

  if (remindMs <= Date.now()) {
    await sendMessage(chatId, "Это время уже прошло. Назови другое, например «через час» или «завтра в 9:00».");
    return true;
  }
  if (remindMs > eventMs) {
    await sendMessage(chatId, "Это уже после самого события. Назови время до него, например «за час до события».");
    return true;
  }

  await db.query(`UPDATE events SET remind_at=$1, reminded=FALSE WHERE id=$2`, [new Date(remindMs).toISOString(), ev.id]);
  const rl = utcIsoToLocalParts(new Date(remindMs).toISOString(), tz);
  const el = utcIsoToLocalParts(ev.event_at, tz);
  await sendMessage(
    chatId,
    `⏰ Хорошо, напомню ${formatDateHuman(rl.dateStr, rl.timeStr)}.\n${ev.emoji || "📌"} ${ev.title} — ${formatDateHuman(el.dateStr, el.timeStr)}`
  );
  await saveContext(chatId, { ...ctx, pending: null, last_event_id: ev.id });
  return true;
}

module.exports = { handleSnoozeReply };
