// Признаки исходного события отделены от нового времени переноса и текста напоминания.
const { todayInOffset } = require('./time');
const { MONTHS_GEN } = require('./constants');
const { stripReminderIntervals } = require('./reminderInterval');

const normalize = s => String(s || '').toLowerCase().replace(/ё/g, 'е');
const STOP = new Set('с со в во на для по про о об к ко у от до из и а это его ее мне меня этот эту то пожалуйста'.split(' '));
const MODIFIERS = new Set('дело дела событие события все повторы повторения повторяющееся повторяющуюся повторяющиеся каждый каждую неделю еженедельную года году навсегда насовсем'.split(' '));
const tokens = s => (normalize(s).match(/[\p{L}\d]+/gu) || []).filter(w => !STOP.has(w));
function stem(word) {
  if (word.length < 4) return word;
  const base = word.replace(/(?:ами|ями|ого|ему|ому|ыми|ими|ией|ием|еем|аем|ая|яя|ую|юю|ое|ее|ые|ие|ый|ий|ых|их|ия|ию|ии|ея|ею|ай|ах|ях|ом|ем|ым|им|ой|ей|ою|ам|ям|а|я|у|ю|е|и|ы|о|ь)$/u, '');
  return base.length >= 2 ? base : word;
}
function titleWordGroups(text) {
  return tokens(text).map(w => [...new Set([w, stem(w)])]);
}
function titleMatches(title, query) {
  const wanted = tokens(query).map(stem);
  const actual = new Set(tokens(title).map(stem));
  return wanted.length > 0 && wanted.every(w => actual.has(w));
}
function titleScore(title, query) {
  return titleMatches(title, query) ? tokens(query).length : 0;
}

const DAYS = ['воскресень(?:е|я|ю|ям)', 'понедельник(?:ам|и|а|у)?', 'вторник(?:ам|и|а|у)?', 'сред(?:у|а|ы|ам|е)', 'четверг(?:ам|и|а|у)?', 'пятниц(?:у|а|ы|ам|е)', 'суббот(?:у|а|ы|ам|е)'];
function parseSelector(text, tz, keepTitleWords = false) {
  let rest = normalize(text).trim();
  const result = {};
  const put = (key, value) => {
    if (result[key] !== undefined && result[key] !== value) result.conflict = true;
    result[key] = value;
  };
  // Название в кавычках сохраняем дословно, в том числе числа внутри него.
  const quoted = [];
  rest = rest.replace(/«([^»]+)»|"([^"]+)"|“([^”]+)”|„([^”]+)”|'([^']+)'/gu, (_, ...parts) => {
    quoted.push(parts.slice(0, 5).find(Boolean)); return ' ';
  });
  // Числовое время после «в/с» разбираем раньше даты с точкой.
  rest = rest.replace(/(?:^|\s)(?:в|с)\s+(\d{1,2})[:.\-](\d{2})(?!\d)/gu, (all, h, m) => {
    if (+h > 23 || +m > 59) return all;
    put('time', `${h.padStart(2, '0')}:${m}`); return ' ';
  });
  rest = rest.replace(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/gu, (_, y, m, d) => {
    put('date', `${y}-${m}-${d}`); return ' ';
  });
  rest = rest.replace(/(?<!\d)(\d{1,2})[./\-](\d{1,2})(?:[./\-](\d{4}))?(?!\d)/gu, (all, d, m, y) => {
    if (+d < 1 || +d > 31 || +m < 1 || +m > 12) return all;
    put('monthDay', `${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
    if (y) put('date', `${y}-${result.monthDay}`);
    return ' ';
  });
  const monthPattern = new RegExp(`(?<![\\p{L}\\d])(\\d{1,2})\\s+(${MONTHS_GEN.join('|')})(?:\\s+(\\d{4}))?(?![\\p{L}\\d])`, 'gu');
  rest = rest.replace(monthPattern, (all, day, month, year) => {
    if (+day < 1 || +day > 31) return all;
    put('monthDay', `${String(MONTHS_GEN.indexOf(month) + 1).padStart(2, '0')}-${day.padStart(2, '0')}`);
    if (year) put('date', `${year}-${result.monthDay}`);
    return ' ';
  });
  rest = rest.replace(/(?<!\p{L})(послезавтра|завтра|сегодня|вчера)(?!\p{L})/gu, (_, day) => {
    const delta = {сегодня: 0, завтра: 1, послезавтра: 2, вчера: -1}[day];
    const today = Date.parse(`${todayInOffset(tz)}T12:00:00Z`);
    put('date', new Date(today + delta * 86400000).toISOString().slice(0, 10)); return ' ';
  });
  DAYS.forEach((day, index) => {
    rest = rest.replace(new RegExp(`(?<!\\p{L})${day}(?!\\p{L})`, 'gu'), () => { put('weekday', index); return ' '; });
  });
  rest = rest.replace(/(?<!\d)(\d{1,2})[:.\-](\d{2})(?!\d)/gu, (all, h, m) => {
    if (+h > 23 || +m > 59) return all;
    put('time', `${h.padStart(2, '0')}:${m}`); return ' ';
  });
  // «в 10» / «в 8 вечера» — тоже явно названное время исходного события.
  rest = rest.replace(/(?:^|\s)(?:в|с)\s+(\d{1,2})(?:\s+(утра|дня|вечера|ночи))?(?![\d:.\-])/gu, (all, h, part) => {
    let hour = +h;
    if (hour > 23) return all;
    if (part === 'вечера' || part === 'дня') { if (hour < 12) hour += 12; }
    if ((part === 'ночи' || part === 'утра') && hour === 12) hour = 0;
    put('time', `${String(hour).padStart(2, '0')}:00`); return ' ';
  });
  result.title = [...quoted, ...tokens(rest).filter(w => keepTitleWords || !MODIFIERS.has(w))].join(' ').trim() || null;
  return result;
}

function selectorText(parsed, text) {
  let raw = String(text || '').trim().replace(/[.!?]+$/g, '');
  if (/reminder$/.test(parsed.intent)) raw = stripReminderIntervals(raw);
  if (parsed.intent === 'rename_event') {
    // parseRename уже отделил старое название от нового.
    const quoted = raw.match(/^переименуй\S*\s+(«[^»]+»|"[^"]+"|“[^”]+”|„[^”]+”|'[^']+')/iu);
    if (quoted && normalize(quoted[1].slice(1, -1)) === normalize(parsed.title)) return quoted[1];
    return parsed.title || '';
  }
  const quoted = [];
  raw = raw.replace(/«[^»]+»|"[^"]+"|“[^”]+”|„[^”]+”|'[^']+'/gu, value => {
    quoted.push(value); return `__quoted_target_${quoted.length - 1}__`;
  });
  raw = raw.replace(/^(?:а\s+)?(?:пожалуйста[, ]+)?(?:перенеси|передвинь|перенести|удали|убери|отмени|останови|измени|установи|поставь|включи|отключи|не\s+напоминай|напоминай|напомни)(?!\p{L})\s*/iu, '');
  if (/^reschedule_/.test(parsed.intent)) {
    // «на/к ...» вводит НОВОЕ время; признаки до него относятся к старому событию.
    if (!/^(?:перенеси|передвинь|перенести)/iu.test(String(text).trim()) && /^(?:завтра|сегодня|послезавтра|вчера|на\s|в\s|\d)/iu.test(raw)) return '';
    const destination = /(?:^|\s)(?:на|к)\s+(?=завтра|послезавтра|сегодня|понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье|утро|вечер|ночь|\d)/iu.exec(raw);
    if (destination) raw = raw.slice(0, destination.index);
    else raw = raw.replace(/(?:^|\s)(?:в|через)\s+\d[\s\S]*$/iu, '');
  }
  if (/reminder$/.test(parsed.intent)) raw = raw.replace(/(?<!\p{L})напоминани[еяй](?!\p{L})/giu, '');
  raw = raw.replace(/[,;]?\s*(?:не\s+напоминай|без\s+напоминан|напомни|напоминай)[\s\S]*$/iu, '');
  raw = raw.replace(/(?:^|\s)в\s+момент\s+(?:события|дела)[\s\S]*$/iu, '');
  return raw.replace(/__quoted_target_(\d+)__/g, (_, index) => quoted[Number(index)]);
}

const TARGET_ACTIONS = new Set(['reschedule_event', 'reschedule_recurring_event', 'rename_event', 'delete_event', 'delete_recurring_event', 'set_reminder', 'cancel_reminder']);
function prepareTarget(parsed, text, tz) {
  delete parsed._selection; // ID может приходить только из сохранённого выбора, не из ответа модели.
  if (!TARGET_ACTIONS.has(parsed.intent)) return;
  const raw = selectorText(parsed, text);
  const selector = parseSelector(raw, tz, parsed.intent === 'rename_event');
  // Не используем название, которое модель могла подставить из контекста.
  parsed.title = selector.title;
  parsed.target = selector;
  parsed.refers_to_last = !selector.title && !selector.date && !selector.monthDay && !selector.time && selector.weekday === undefined;
}

function isNewCommand(text) {
  return /^(?:\/|(?:а\s+)?(?:пожалуйста[, ]+)?(?:перенеси|передвинь|переименуй|удали|убери|отмени|останови|создай|добавь|запиши|запомни|напомни|напоминай|не\s+напоминай|измени|установи|поставь|включи|отключи|покажи|какая|какой|погода)(?!\p{L}))/iu.test(String(text).trim());
}

module.exports = { isNewCommand, prepareTarget, parseSelector, titleWordGroups, titleMatches, titleScore };
