const { extractOffsetMinutes, isAtEventMoment } = require("./text");
const { offsetMinutesToPhrase } = require("./time");

// Три состояния: -1 — выключено, 0 — в момент события, >0 — за N минут.
// Старые events с remind_at=NULL уже означают «выключено», независимо от reminded.
const OFF = -1;

function commandOffset(text) {
  const t = String(text || "");
  if (/не\s+(?:надо\s+)?напомин(?:ай|ать)|не\s+напомни|без\s+напоминан|(?:отключи|убери|отмени)\s+напоминан/iu.test(t)) return OFF;
  const offset = extractOffsetMinutes(t);
  if (offset !== null) return offset;
  if (isAtEventMoment(t) || /(?<!\p{L})(?:напомни|напоминай)(?!\p{L})/iu.test(t)) return 0;
  return undefined; // настройки не названы: при переносе сохраняем прежние
}

function parsedOffset(parsed, fallback = 60) {
  if (parsed.reminder_disabled === true) return OFF;
  return Number.isFinite(parsed.remind_offset_minutes) && parsed.remind_offset_minutes >= 0
    ? parsed.remind_offset_minutes : fallback;
}

function eventOffset(event) {
  return event.remind_at == null ? OFF : Math.max(0, Math.round(
    (new Date(event.event_at).getTime() - new Date(event.remind_at).getTime()) / 60000
  ));
}

function templateOffset(template) {
  return Number.isFinite(template.remind_offset_minutes) && template.remind_offset_minutes >= 0
    ? template.remind_offset_minutes : OFF;
}

function reminderAt(eventAt, offset) {
  return offset === OFF ? null : new Date(new Date(eventAt).getTime() - offset * 60000).toISOString();
}

function reminderLine(offset) {
  return offset === OFF ? "🔕 Напоминания отключены" : `⏰ Напомню ${offsetMinutesToPhrase(offset)}`;
}

// В API null/-1 — явное отключение, отсутствие поля — сохранить/использовать значение по умолчанию.
function apiOffset(value, fallback) {
  if (value === undefined) return fallback;
  if (value === null || value === OFF) return OFF;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Некорректный интервал напоминания");
  return value;
}

module.exports = { OFF, commandOffset, parsedOffset, eventOffset, templateOffset, reminderAt, reminderLine, apiOffset };
