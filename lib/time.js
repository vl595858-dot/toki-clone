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
  return new Date(`${dateStr}T${timeStr}:00${offset}`).toISOString();
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
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
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
  const offsetMin = parseOffsetMinutes(offset);
  const fromMs = afterIso ? new Date(afterIso).getTime() : Date.now();
  const localNow = new Date(fromMs + offsetMin * 60000);
  const [th, tm] = timeStr.split(":").map(Number);

  let y = localNow.getUTCFullYear();
  let m = localNow.getUTCMonth();
  let day = Math.min(monthDay, daysInMonth(y, m));
  let candidate = new Date(Date.UTC(y, m, day, th, tm, 0, 0));

  if (candidate.getTime() <= localNow.getTime()) {
    m += 1;
    if (m > 11) { m = 0; y += 1; }
    day = Math.min(monthDay, daysInMonth(y, m));
    candidate = new Date(Date.UTC(y, m, day, th, tm, 0, 0));
  }
  return new Date(candidate.getTime() - offsetMin * 60000).toISOString();
}

function nextYearlyOccurrenceUtcIso(month, monthDay, timeStr, offset, afterIso) {
  const offsetMin = parseOffsetMinutes(offset);
  const fromMs = afterIso ? new Date(afterIso).getTime() : Date.now();
  const localNow = new Date(fromMs + offsetMin * 60000);
  const [th, tm] = timeStr.split(":").map(Number);
  const mi = month - 1;

  let y = localNow.getUTCFullYear();
  let day = Math.min(monthDay, daysInMonth(y, mi));
  let candidate = new Date(Date.UTC(y, mi, day, th, tm, 0, 0));

  if (candidate.getTime() <= localNow.getTime()) {
    y += 1;
    day = Math.min(monthDay, daysInMonth(y, mi));
    candidate = new Date(Date.UTC(y, mi, day, th, tm, 0, 0));
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
