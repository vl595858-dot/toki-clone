const MONTHS_GEN = [
  "января","февраля","марта","апреля","мая","июня",
  "июля","августа","сентября","октября","ноября","декабря",
];

function todayInOffset(offset) {
  // offset вида "+03:00"; вычисляем "сегодня" в этом смещении
  const sign = offset[0] === "-" ? -1 : 1;
  const [h, m] = offset.slice(1).split(":").map(Number);
  const offsetMin = sign * (h * 60 + m);
  const local = new Date(Date.now() + offsetMin * 60000);
  return local.toISOString().slice(0, 10);
}

function toUtcIso(dateStr, timeStr, offset) {
  // dateStr "YYYY-MM-DD", timeStr "HH:MM", offset "+03:00"
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

module.exports = { todayInOffset, toUtcIso, offsetMinutesToPhrase, formatDateHuman, utcIsoToLocalParts };
