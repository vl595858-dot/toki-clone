const { isValidDate, todayInOffset } = require("./time");
const { MONTHS_GEN } = require("./constants");

// Проверяем исходную дату, даже если модель уже нормализовала «30 февраля» в март.
function dateInputError(text, dateHint, tz) {
  let rest = String(text || "").toLowerCase().replace(/ё/g, "е")
    .replace(/«[^»]*»|"[^"]*"|“[^”]*”|„[^”]*”|'[^']*'/gu, s => " ".repeat(s.length));
  const hintYear = /^\d{4}-\d{2}-\d{2}$/.test(dateHint || "") ? dateHint.slice(0, 4) : todayInOffset(tz).slice(0, 4);
  const mentions = [];
  rest = rest.replace(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/gu, (raw, y, m, d) => {
    mentions.push({raw, y, m, d}); return " ".repeat(raw.length);
  });
  rest.replace(/(?<!\d)(\d{1,2})([./-])(\d{1,2})(?:[./-](\d{4}|\d{2}))?(?!\d)/gu, (raw, d, separator, m, y, index) => {
    const before = rest.slice(0, index);
    const after = rest.slice(index + raw.length);
    if (separator !== "/" && !y && +d <= 23 && +m <= 59 && (/(?:^|\s)в\s*$/u.test(before) || +m > 12)) return raw;
    if (separator === "-" && !y && /^(?:\s*)(?:минут|час|дн|день|сут)/u.test(after)) return raw;
    const year = y?.length === 2 ? (+hintYear % 100 === +y ? hintYear : `20${y}`) : y;
    mentions.push({raw, y: year, m, d}); return raw;
  });
  const monthRe = new RegExp(`(?<![\\p{L}\\d])(\\d{1,2})\\s*(${MONTHS_GEN.join("|")})(?:\\s*(\\d{4}))?(?![\\p{L}\\d])`, "gu");
  rest.replace(monthRe, (raw, d, month, y) => {
    mentions.push({raw, y, m: MONTHS_GEN.indexOf(month) + 1, d}); return raw;
  });
  for (const {raw, y, m, d} of mentions) {
    const canonical = `${y || hintYear}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (!isValidDate(canonical)) return `Такой календарной даты нет: «${raw}». Уточни число, месяц и год.`;
  }
  return null;
}

module.exports = { dateInputError };
