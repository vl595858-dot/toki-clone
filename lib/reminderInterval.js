// Длительности и их связь с просьбой о напоминании. Не используем догадки модели.
const NUMBERS = {
  ноль: 0, нуль: 0, один: 1, одна: 1, одно: 1, одну: 1, одной: 1,
  два: 2, две: 2, двух: 2, три: 3, трех: 3, четыре: 4, четырех: 4,
  пять: 5, пяти: 5, шесть: 6, шести: 6, семь: 7, семи: 7, восемь: 8, восьми: 8, девять: 9, девяти: 9,
  десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15,
  шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
  двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90,
  сто: 100, двести: 200, триста: 300, четыреста: 400, пятьсот: 500, шестьсот: 600, семьсот: 700, восемьсот: 800, девятьсот: 900,
  тысяча: 1000, тысячу: 1000, тысячи: 1000, тысяч: 1000,
  двадцати: 20, тридцати: 30, сорока: 40, пятидесяти: 50, шестидесяти: 60, семидесяти: 70, восьмидесяти: 80, девяноста: 90,
  пол: 0.5, полтора: 1.5, полторы: 1.5, пару: 2, пара: 2,
};
const UNITS = [
  [/^(?:минут(?:а|у|ы|ой)?|мин)$/u, 1], [/^(?:час(?:а|ов|ом)?|ч)$/u, 60],
  [/^(?:день|дня|дней|днем|дни|сутки|суток)$/u, 1440],
  [/^недел(?:я|ю|и|ь)$/u, 10080], [/^месяц(?:а|ев)?$/u, 43200],
];
const SHORT = {полчаса: [30, 60], полминуты: [0.5, 1], полдня: [720, 1440], полсуток: [720, 1440]};
const unit = word => UNITS.find(([re]) => re.test(word || ''))?.[1];
const number = word => /^\d+(?:[.,]\d+)?$/.test(word || '') ? Number(word.replace(',', '.'))
  : Object.hasOwn(NUMBERS, word) ? NUMBERS[word] : undefined;
const shortcutFor = word => Object.hasOwn(SHORT, word) ? SHORT[word] : undefined;
const REMINDER = /(?<!\p{L})(?:напомни|напоминай|напомнить|напоминани[еяй])(?!\p{L})/gu;

function unquotedText(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/«[^»]*»|"[^"]*"|“[^”]*”|„[^”]*”|'[^']*'/gu, s => ' '.repeat(s.length));
}
function amount(tokens, start) {
  let end = start;
  let value = 0;
  let thousands = 0;
  let hasThousands = false;
  let previous = Infinity;
  while (end < tokens.length) {
    const n = number(tokens[end].word);
    if (n === undefined) break;
    if (n === 1000) {
      if (hasThousands || value >= 1000) return null;
      thousands = (end === start ? 1 : value) * 1000; hasThousands = true;
      value = 0; previous = Infinity; end++;
      continue;
    }
    if (previous !== Infinity && (previous < 20 || n >= Math.min(previous, previous >= 100 ? 100 : 10))) return null;
    value += n; previous = n; end++;
  }
  return end > start ? {value: thousands + value, end} : null;
}
function duration(tokens, start) {
  let index = start;
  let total = 0;
  const usedUnits = new Set();
  let found = false;
  let malformed = false;
  while (index < tokens.length) {
    const shortcut = shortcutFor(tokens[index].word);
    let scale, value, end;
    if (shortcut) { [value, scale] = shortcut; end = index + 1; }
    else {
      const a = amount(tokens, index);
      if (a) { scale = unit(tokens[a.end]?.word); value = a.value * scale; end = a.end + 1; }
      else { scale = unit(tokens[index].word); value = scale; end = index + 1; }
    }
    if (!scale || !Number.isFinite(value)) {
      malformed = found || number(tokens[index]?.word) !== undefined;
      break;
    }
    if (usedUnits.has(scale)) { malformed = true; break; }
    total += value; usedUnits.add(scale); found = true; index = end;
    if (tokens[index]?.word === '.' && ['ч', 'мин'].includes(tokens[index - 1]?.word)) index++;
    if (tokens[index]?.word === 'и') {
      const next = tokens[index + 1]?.word;
      if (number(next) !== undefined || unit(next) || shortcutFor(next)) index++;
      else break;
    }
    if (['или', 'либо', '/'].includes(tokens[index]?.word)) { malformed = true; break; }
    if (number(tokens[index]?.word) === undefined && !unit(tokens[index]?.word) && !shortcutFor(tokens[index]?.word)) break;
  }
  const minutes = Math.round(total);
  if (tokens[index]?.word === ',' && (number(tokens[index + 1]?.word) !== undefined || unit(tokens[index + 1]?.word))) malformed = true;
  if (malformed) {
    while (index < tokens.length && (number(tokens[index].word) !== undefined || unit(tokens[index].word) ||
      shortcutFor(tokens[index].word) || ['и', 'или', 'либо', 'за', '/', '-', ','].includes(tokens[index].word))) index++;
  }
  return {found, malformed: malformed || !Number.isSafeInteger(minutes), minutes, end: index};
}

function parseReminderInterval(text, {allowBare = false} = {}) {
  const t = unquotedText(text);
  const tokens = [...t.matchAll(/\d+(?:[.,]\d+)?|[\p{L}]+|[^\s]/gu)]
    .map(m => ({word: m[0], start: m.index, end: m.index + m[0].length}));
  const anchors = [...t.matchAll(REMINDER)].map(m => ({start: m.index, end: m.index + m[0].length}));
  const values = new Set();
  const spans = [];
  let ambiguous = false;
  let unclearReference = false;
  for (let i = 0; i < tokens.length; i++) {
    const bare = allowBare && i === 0 && tokens[i].word !== 'за';
    if (tokens[i].word !== 'за' && !bare) continue;
    const start = bare ? i : i + 1;
    const parsed = duration(tokens, start);
    const last = tokens[Math.max(start, parsed.end - 1)];
    const end = last?.end || tokens[i].end;
    const prior = anchors.filter(a => a.end <= tokens[i].start).at(-1);
    const later = anchors.find(a => a.start >= end);
    const standalone = !t.slice(0, tokens[i].start).trim();
    const clauseStartsHere = !t.slice(0, tokens[i].start).split(/[,;.!?\n]/u).at(-1).trim();
    const bound = !!prior || !!(later && clauseStartsHere && !t.slice(end, later.start).replace(/[,;:]/g, '').trim());
    const tail = t.slice(end).trimStart();
    // «за два дня до отпуска» описывает событие, а не напоминание о нём.
    const otherReference = /^до\s+(?!(?:событи|начал|дела|встреч|него|нее|этого|вылет|отправлен))/u.test(tail);
    if (otherReference) {
      if (bound) unclearReference = true;
      continue;
    }
    if (!bound && !standalone) continue;
    if (!parsed.found) {
      if (parsed.malformed || /^(?:несколько|сколько|пару|полтора|полторы)$/u.test(tokens[start]?.word || '') ||
          (bound && tokens.slice(start, start + 4).some(x => unit(x.word)))) {
        ambiguous = true;
        const nearbyUnit = tokens.slice(start, start + 4).find(x => unit(x.word));
        const remainder = nearbyUnit ? duration(tokens, tokens.indexOf(nearbyUnit)) : null;
        const remainderEnd = remainder ? tokens[remainder.end - 1]?.end : end;
        spans.push({start: tokens[i].start, end: Math.max(end, nearbyUnit?.end || end, remainderEnd || end)});
      }
      continue;
    }
    // После одиночного ответа допускаем лишь «до события», не описание другого действия.
    if (bare && tail.replace(/^до\s+(?:события|начала|дела|встречи|него|нее)/u, '').replace(/[.!?\s]+/g, '')) continue;
    if (parsed.malformed) ambiguous = true;
    else values.add(parsed.minutes);
    spans.push({start: tokens[i].start, end});
  }
  if (values.size > 1) ambiguous = true;
  if (!values.size && unclearReference) ambiguous = true;
  return {minutes: !ambiguous && values.size === 1 ? [...values][0] : null, ambiguous, spans};
}

function stripReminderIntervals(text) {
  const parsed = parseReminderInterval(text);
  let result = String(text || '');
  for (const span of [...parsed.spans].reverse()) result = result.slice(0, span.start) + ' '.repeat(span.end - span.start) + result.slice(span.end);
  return result;
}

// Ответ на вопрос об интервале может не содержать «за», но не должен быть новой командой о другом деле.
function isIntervalOnly(text) {
  const t = unquotedText(text).trim();
  if (/^(?:не\s+(?:надо\s+)?напомин(?:ай|ать)|не\s+напомни|без\s+напоминаний|(?:отключи|убери|отмени)\s+напоминани[ея])[.!?]*$/u.test(t)) return true;
  if (/^(?:(?:напомни|напоминай)\s+)?в\s+момент(?:\s+события)?[.!?]*$/u.test(t)) return true;
  const stripped = t.replace(/^(?:напомни|напоминай)\s+/u, '');
  const bare = stripped.replace(/^за\s+/u, '');
  const ts = [...bare.matchAll(/\d+(?:[.,]\d+)?|[\p{L}]+|[^\s]/gu)].map(m => ({word: m[0]}));
  const extras = new Set(['за', 'и', 'или', 'либо', 'до', 'события', 'начала', 'дела', 'встречи', 'него', 'нее',
    'в', 'момент', 'утра', 'дня', 'вечера', 'ночи', 'несколько', 'сколько', 'не', 'напоминай', 'напомни', 'без', 'напоминаний', ',', '.', '!', '?', '/', '-', ':']);
  return ts.length > 0 && ts.every(x => number(x.word) !== undefined || unit(x.word) || shortcutFor(x.word) || extras.has(x.word));
}

module.exports = {parseReminderInterval, stripReminderIntervals, unquotedText, isIntervalOnly};
