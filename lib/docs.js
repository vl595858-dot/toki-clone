// Документы по картинке: типы, проверка ответа модели, кнопки «за сколько напомнить», текст сводки.
const { toUtcIso, formatDateHuman, utcIsoToLocalParts, isValidDate } = require("./time");
const { MONTHS_GEN } = require("./constants");

const KINDS = ["transport", "event", "appointment", "expiry", "invoice", "parcel", "lodging"];
const VEHICLES = ["plane", "train", "bus", "ship"];
const NEEDS_TIME = new Set(["transport", "event", "appointment"]); // без времени такой документ бесполезен — спрашиваем
const USES_PLACE_TZ = new Set(["transport", "event", "lodging"]); // время на документе — местное для города события
const DEFAULT_TIME = { expiry: "09:00", invoice: "09:00", parcel: "09:00", lodging: "12:00" };
const DEFAULT_EMOJI = { transport: "🚆", event: "🎟", appointment: "🩺", expiry: "📄", invoice: "🧾", parcel: "📦", lodging: "🏨" };
const VEHICLE_EMOJI = { plane: "✈️", train: "🚆", bus: "🚌", ship: "⛴️" };

// кнопки «за сколько напомнить»: [минуты, подпись]
const PRESETS = {
  plane: [[1440, "за сутки"], [240, "за 4 часа"], [120, "за 2 часа"]],
  transport: [[1440, "за сутки"], [180, "за 3 часа"], [60, "за час"]],
  event: [[1440, "за сутки"], [180, "за 3 часа"], [60, "за час"]],
  appointment: [[1440, "за сутки"], [120, "за 2 часа"], [60, "за час"]],
  lodging: [[2880, "за 2 дня"], [1440, "за сутки"], [180, "за 3 часа"]],
  parcel: [[1440, "за сутки"], [180, "за 3 часа"], [60, "за час"]],
  expiry: [[43200, "за месяц"], [20160, "за 2 недели"], [10080, "за неделю"]],
  invoice: [[4320, "за 3 дня"], [1440, "за сутки"], [180, "за 3 часа"]],
};

function presetsFor(doc) {
  return doc.kind === "transport" && doc.vehicle === "plane" ? PRESETS.plane : PRESETS[doc.kind];
}

function phraseFor(min) {
  const known = { 43200: "за месяц", 20160: "за 2 недели", 10080: "за неделю", 4320: "за 3 дня", 2880: "за 2 дня", 1440: "за сутки", 60: "за час" };
  if (min === 0) return "в момент события";
  if (known[min]) return known[min];
  if (min % 1440 === 0) return `за ${min / 1440} дн.`;
  if (min % 60 === 0) return `за ${min / 60} ч.`;
  return `за ${min} мин.`;
}

// «через 5 ч.», «через 2 дн.» — сколько осталось до события
function humanUntil(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min >= 2880) return `${Math.round(min / 1440)} дн.`;
  if (min >= 120) return `${Math.round(min / 60)} ч.`;
  return `${min} мин.`;
}

// ответ модели -> список проверенных документов
function normalizeDocs(raw) {
  const list = Array.isArray(raw && raw.documents) ? raw.documents : [];
  const out = [];
  for (const d of list.slice(0, 6)) {
    if (!d || !KINDS.includes(d.kind)) continue;
    const title = typeof d.title === "string" ? d.title.trim().slice(0, 100) : "";
    const date = isValidDate(d.date) ? d.date : null;
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(d.time || "") ? d.time : null;
    if (!title && !date) continue;
    const vehicle = VEHICLES.includes(d.vehicle) ? d.vehicle : null;
    const emoji =
      d.kind === "transport"
        ? VEHICLE_EMOJI[vehicle] || DEFAULT_EMOJI.transport
        : typeof d.emoji === "string" && d.emoji.trim() && d.emoji.trim().length <= 8
        ? d.emoji.trim()
        : DEFAULT_EMOJI[d.kind];
    const city = typeof d.city === "string" && d.city.trim() ? d.city.trim().slice(0, 60) : null;
    out.push({ kind: d.kind, vehicle, title: title || null, date, time, city, emoji });
  }
  return out;
}

// в ответе человека действительно названа дата / время (модель иногда подставляет их сама)
const MONTH_WORDS = "января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря";
const mentionsDate = (t) =>
  new RegExp(`\\d{1,2}[./-]\\d{1,2}|\\d{1,2}\\s+(${MONTH_WORDS})|сегодня|завтра|послезавтра|понедельник|вторник|сред[уы]|четверг|пятниц|суббот|воскресень`, "i").test(String(t || ""));
const mentionsTime = (t) => /\d{1,2}[:.\-]\d{2}|(^|\s)в\s+\d{1,2}(\s|$)|\d{1,2}\s*(час|утра|вечера|дня|ночи)/i.test(String(t || ""));

const effectiveTime = (doc) => doc.time || DEFAULT_TIME[doc.kind] || null;

// чего не хватает: "title" | "date" | "time"
function missingFields(doc) {
  const m = [];
  if (!doc.title) m.push("title");
  if (!doc.date) m.push("date");
  if (NEEDS_TIME.has(doc.kind) && !doc.time) m.push("time");
  return m;
}

const eventAtIso = (doc) => toUtcIso(doc.date, effectiveTime(doc), doc.tz);

const dateOnly = (dateStr) => {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${d} ${MONTHS_GEN[m - 1]}`;
};

// строки сводки одного документа (userTz — пояс самого пользователя)
function summaryLines(doc, userTz) {
  const lines = [`${doc.emoji} ${doc.title}`];
  if (!doc.date) return lines;
  if (doc.time) {
    lines.push(`🗓 ${formatDateHuman(doc.date, doc.time)}${doc.tz && doc.tz !== userTz ? " (местное время)" : ""}`);
    if (doc.tz && doc.tz !== userTz) {
      const mine = utcIsoToLocalParts(eventAtIso(doc), userTz);
      lines.push(`🕒 В твоём часовом поясе: ${formatDateHuman(mine.dateStr, mine.timeStr)}`);
    }
  } else if (doc.kind === "lodging") {
    lines.push(`🗓 ${dateOnly(doc.date)} (время не указано, поставлю на ${effectiveTime(doc)})`);
  } else {
    lines.push(`🗓 ${dateOnly(doc.date)}`);
  }
  return lines;
}

// Interpret a short numeric answer in the scope of the question, before model fields.
function correctDocument(p, text, parsed, tz) {
  const { parseSelector } = require('./targetQuery');
  const { dateInputError } = require('./dateInput');
  const { dateTimeError, todayInOffset } = require('./time');
  const doc = { ...p.docs[0] };
  const t = text.trim().toLowerCase();
  let question = p.question || (p.step === 'missing' ? missingFields(doc)[0] : 'date_time');
  if (/^(дата|дату|время)$/.test(t)) {
    question = t === 'время' ? 'time' : 'date';
    if (p.numeric) text = p.numeric;
    else return { question: question === 'time' ? 'Укажи время, например 23-30.' : 'Укажи дату, например 12.11.', pending: { question } };
  }
  if (question === 'title') {
    doc.title = text.trim().slice(0, 100);
    return { doc };
  }
  const numeric = /^(?:(дата|дату|время|в)\s+)?(\d{1,2})([:.\/-])(\d{2})(?:[.\/-](\d{4}))?$/.exec(text.trim().toLowerCase());
  let date, time;
  if (numeric) {
    const [, prefix, a, sep, b, year] = numeric;
    const y = year || doc.date?.slice(0, 4) || todayInOffset(tz).slice(0, 4);
    const candidateDate = `${y}-${b}-${a.padStart(2, '0')}`;
    const candidateTime = `${a.padStart(2, '0')}:${b}`;
    const validTime = +a <= 23 && +b <= 59;
    const validDate = isValidDate(candidateDate);
    const scope = prefix === 'время' || prefix === 'в' || sep === ':' ? 'time'
      : prefix || year || sep === '/' ? 'date' : question;
    if (scope === 'date') date = candidateDate;
    else if (scope === 'time') time = candidateTime;
    else if (validTime && validDate) return { question: 'Это дата или время? Напиши «дата» или «время».', pending: { numeric: text, question: 'date_time' } };
    else if (validTime) time = candidateTime;
    else date = candidateDate;
    if (time && !validTime) return { error: 'Не получилось определить время. Укажи часы и минуты, например 23:30.' };
  } else {
    const selector = parseSelector(text, tz);
    if (selector.conflict) return { question: 'Какую дату и время поставить? Укажи один вариант.' };
    date = selector.date || (selector.monthDay ? `${doc.date?.slice(0, 4) || todayInOffset(tz).slice(0, 4)}-${selector.monthDay}` : undefined);
    time = selector.time;
    const invalid = dateInputError(text, date || parsed.event_date || doc.date, tz);
    if (invalid) return { error: invalid };
    if (!date && mentionsDate(text)) date = parsed.event_date;
    if (!time && mentionsTime(text)) time = parsed.event_time;
  }
  const invalid = dateTimeError(date || doc.date, time || effectiveTime(doc) || '12:00');
  // A document with a missing date can still receive its missing time.
  if (invalid && (date || doc.date)) return { error: invalid };
  if (date && (p.step === 'fix' || !doc.date)) doc.date = date;
  if (time && (p.step === 'fix' || !doc.time)) doc.time = time;
  if (doc.date === p.docs[0].date && doc.time === p.docs[0].time) return { question: 'Уточни дату или время, например «дата 12.11» или «время 23-30».' };
  return { doc };
}

module.exports = {
  correctDocument, NEEDS_TIME, USES_PLACE_TZ, presetsFor, phraseFor, humanUntil, normalizeDocs,
  effectiveTime, missingFields, eventAtIso, dateOnly, summaryLines, mentionsDate, mentionsTime,
};
