const MONTHS_GEN = [
  "января","февраля","марта","апреля","мая","июня",
  "июля","августа","сентября","октября","ноября","декабря",
];

function todayInOffset(offset) {
  const sign = offset[0] === "-" ? -1 : 1;
  const [h, m] = offset.slice(1).split(":").map(Number);
  const offsetMin = sign * (h * 60 + m);
  const local = new Date(Date.now() + offsetMin * 60000);
  return local.toISOString().slice(0, 10);
}

function toUtcIso(dateStr, timeStr, offset) {
  const error = dateTimeError(dateStr, timeStr);
  if (error) {
    const invalid = new RangeError(error);
    invalid.code = "INVALID_DATE_TIME";
    throw invalid;
  }
  return new Date(`${dateStr}T${timeStr}:00${offset}`).toISOString();
}

function isValidDate(dateStr) {
  if (typeof dateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [year, month, day] = dateStr.split("-").map(Number);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month - 1);
}

function dateTimeError(dateStr, timeStr) {
  if (!isValidDate(dateStr)) return `Такой календарной даты нет: «${dateStr}». Уточни число, месяц и год.`;
  if (typeof timeStr !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(timeStr)) return "Уточни время: от 00:00 до 23:59.";
  return null;
}

function shiftCalendarDate(dateStr, days) {
  const date = new Date(`${dateStr}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Календарные периоды имеют исключённую верхнюю границу: следующий день/понедельник.
function eventListPeriod(scope, offset, nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();
  const today = utcIsoToLocalParts(now, offset).dateStr;
  if (scope === "last_seven_days") return { from: new Date(nowMs - 7 * 86400000).toISOString(), to: now, exclusiveEnd: false };
  let fromDate;
  let toDate;
  if (scope === "last_week") {
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
    toDate = shiftCalendarDate(today, -((weekday + 6) % 7));
    fromDate = shiftCalendarDate(toDate, -7);
  } else if (["today", "tomorrow", "yesterday"].includes(scope)) {
    fromDate = shiftCalendarDate(today, {today: 0, tomorrow: 1, yesterday: -1}[scope]);
    toDate = shiftCalendarDate(fromDate, 1);
  } else return { from: now, to: null, exclusiveEnd: false };
  return { from: toUtcIso(fromDate, "00:00", offset), to: toUtcIso(toDate, "00:00", offset), exclusiveEnd: true };
}

function historicalListScope(text) {
  const t = String(text || "").toLowerCase().replace(/ё/g, "е");
  if (/(?:прошл(?:ую|ая|ой)|предыдущ(?:ую|ая|ей))\s+(?:календарн(?:ую|ая|ой)\s+)?недел/u.test(t)) return "last_week";
  if (/(?:последни[ех]|прошедши[ех])\s+(?:семь|семи|7)\s*дн|за\s+(?:семь|7)\s*дней/u.test(t)) return "last_seven_days";
  return null;
}

function offsetMinutesToPhrase(min) {
  if (min === 0) return "в момент события";
  if (min === 60) return "за час до события";
  if (min === 1440) return "за сутки до события";
  if (min === 10080) return "за неделю до события";
  if (min % 1440 === 0) return `за ${min / 1440} дн. до события`;
  if (min % 60 === 0) return `за ${min / 60} ч. до события`;
  return `за ${min} мин. до события`;
}

function formatDateHuman(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${d} ${MONTHS_GEN[m - 1]} в ${timeStr}`;
}

function utcIsoToLocalParts(isoUtc, offset) {
  const sign = offset[0] === "-" ? -1 : 1;
  const [oh, om] = offset.slice(1).split(":").map(Number);
  const offsetMin = sign * (oh * 60 + om);
  const local = new Date(new Date(isoUtc).getTime() + offsetMin * 60000);
  const dateStr = local.toISOString().slice(0, 10);
  const timeStr = local.toISOString().slice(11, 16);
  return { dateStr, timeStr };
}

function parseOffsetMinutes(offset) {
  const sign = offset[0] === "-" ? -1 : 1;
  const [h, m] = offset.slice(1).split(":").map(Number);
  return sign * (h * 60 + m);
}

function nextWeekdayOccurrenceUtcIso(weekdayNum, timeStr, offset, afterIso) {
  const offsetMin = parseOffsetMinutes(offset);
  const fromMs = afterIso ? new Date(afterIso).getTime() : Date.now();
  const localNow = new Date(fromMs + offsetMin * 60000);

  const [th, tm] = timeStr.split(":").map(Number);
  const currentWeekday = localNow.getUTCDay();
  let diffDays = (weekdayNum - currentWeekday + 7) % 7;

  const candidate = new Date(localNow.getTime());
  candidate.setUTCDate(candidate.getUTCDate() + diffDays);
  candidate.setUTCHours(th, tm, 0, 0);

  if (candidate.getTime() <= localNow.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 7);
  }

  const trueUtcMs = candidate.getTime() - offsetMin * 60000;
  return new Date(trueUtcMs).toISOString();
}

function daysInMonth(year, monthIndex0) {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][monthIndex0];
}

function nextDailyOccurrenceUtcIso(timeStr, offset, afterIso) {
  const offsetMin = parseOffsetMinutes(offset);
  const fromMs = afterIso ? new Date(afterIso).getTime() : Date.now();
  const localNow = new Date(fromMs + offsetMin * 60000);
  const [th, tm] = timeStr.split(":").map(Number);

  const candidate = new Date(localNow.getTime());
  candidate.setUTCHours(th, tm, 0, 0);
  if (candidate.getTime() <= localNow.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return new Date(candidate.getTime() - offsetMin * 60000).toISOString();
}

function nextMonthlyOccurrenceUtcIso(monthDay, timeStr, offset, afterIso) {
  toUtcIso(`2000-01-${String(monthDay).padStart(2, "0")}`, timeStr, offset);
  const offsetMin = parseOffsetMinutes(offset);
  const fromMs = afterIso ? new Date(afterIso).getTime() : Date.now();
  const localNow = new Date(fromMs + offsetMin * 60000);
  const [th, tm] = timeStr.split(":").map(Number);

  let y = localNow.getUTCFullYear();
  let m = localNow.getUTCMonth();
  let candidate;
  for (let attempt = 0; attempt < 12; attempt++) {
    if (monthDay <= daysInMonth(y, m)) {
      candidate = new Date(Date.UTC(y, m, monthDay, th, tm, 0, 0));
      if (candidate.getTime() > localNow.getTime()) break;
    }
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }

  if (!candidate || !Number.isFinite(candidate.getTime()) || !(candidate.getTime() > localNow.getTime())) {
    const invalid = new RangeError("Не удалось определить следующую дату. Уточни дату события.");
    invalid.code = "INVALID_DATE_TIME";
    throw invalid;
  }
  return new Date(candidate.getTime() - offsetMin * 60000).toISOString();
}

function nextYearlyOccurrenceUtcIso(month, monthDay, timeStr, offset, afterIso) {
  // 2000 — високосный год: 29 февраля допустимо в ежегодном шаблоне, 30 — нет.
  toUtcIso(`2000-${String(month).padStart(2, "0")}-${String(monthDay).padStart(2, "0")}`, timeStr, offset);
  const offsetMin = parseOffsetMinutes(offset);
  const fromMs = afterIso ? new Date(afterIso).getTime() : Date.now();
  const localNow = new Date(fromMs + offsetMin * 60000);
  const [th, tm] = timeStr.split(":").map(Number);
  const mi = month - 1;

  let y = localNow.getUTCFullYear();
  let candidate;
  for (let attempt = 0; attempt < 9; attempt++) {
    if (monthDay <= daysInMonth(y, mi)) {
      candidate = new Date(Date.UTC(y, mi, monthDay, th, tm, 0, 0));
      if (candidate.getTime() > localNow.getTime()) break;
    }
    y += 1;
  }

  if (!candidate || !Number.isFinite(candidate.getTime()) || !(candidate.getTime() > localNow.getTime())) {
    const invalid = new RangeError("Не удалось определить следующую дату. Уточни дату события.");
    invalid.code = "INVALID_DATE_TIME";
    throw invalid;
  }
  return new Date(candidate.getTime() - offsetMin * 60000).toISOString();
}

function nextRecurringOccurrenceUtcIso(tpl, offset, afterIso) {
  if (tpl.frequency === "daily") return nextDailyOccurrenceUtcIso(tpl.time, offset, afterIso);
  if (tpl.frequency === "monthly") return nextMonthlyOccurrenceUtcIso(tpl.month_day, tpl.time, offset, afterIso);
  if (tpl.frequency === "yearly") return nextYearlyOccurrenceUtcIso(tpl.month, tpl.month_day, tpl.time, offset, afterIso);
  return nextWeekdayOccurrenceUtcIso(tpl.weekday, tpl.time, offset, afterIso);
}

function nextNOccurrencesUtcIso(tpl, offset, count, afterIso) {
  const result = [];
  let cursor = afterIso || null;
  for (let i = 0; i < count; i++) {
    const next = nextRecurringOccurrenceUtcIso(tpl, offset, cursor || undefined);
    result.push(next);
    cursor = new Date(new Date(next).getTime() + 60000).toISOString();
  }
  return result;
}

module.exports = {
  isValidDate, dateTimeError, shiftCalendarDate, eventListPeriod, historicalListScope,
  todayInOffset,
  toUtcIso,
  offsetMinutesToPhrase,
  formatDateHuman,
  utcIsoToLocalParts,
  parseOffsetMinutes,
  nextWeekdayOccurrenceUtcIso,
  nextDailyOccurrenceUtcIso,
  nextMonthlyOccurrenceUtcIso,
  nextYearlyOccurrenceUtcIso,
  nextRecurringOccurrenceUtcIso,
  nextNOccurrencesUtcIso,
};
