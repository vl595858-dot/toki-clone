// Работа с текстом: защита от слов из памяти диалога в названии нового дела.

function wordTokens(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^a-zа-я0-9]+/)
    .filter(Boolean);
}

// слова считаем одинаковыми, если совпадают целиком или первые буквы (учёт падежей: «зум» / «зуму»)
function sameWord(a, b) {
  if (a === b) return true;
  const n = Math.min(4, a.length, b.length);
  return n >= 3 && a.slice(0, n) === b.slice(0, n);
}

// убираем из названия слова, которых нет в сообщении пользователя, но есть в памяти диалога
function stripContextWords(title, messageText, contextText) {
  if (!title || !contextText) return title;
  const msg = wordTokens(messageText);
  const ctxWords = wordTokens(contextText);
  const kept = String(title)
    .split(/\s+/)
    .filter((word) => {
      const tokens = wordTokens(word);
      if (tokens.length === 0) return true;
      const inMessage = tokens.every((t) => msg.some((m) => sameWord(t, m)));
      if (inMessage) return true;
      const inContext = tokens.every((t) => ctxWords.some((c) => sameWord(t, c)));
      return !inContext;
    });
  const result = kept.join(" ").trim();
  return result || title;
}

// «за 2 часа», «за час», «за сутки», «за 30 минут» → минуты (или null, если интервал не назван)
function extractOffsetMinutes(text) {
  const t = String(text || "").toLowerCase();
  // «за» — отдельное слово; «за справкой», «за хлебом» пропускаем и ищем дальше («…, напомни за час»)
  const re = /(?:^|[^а-яё])за\s+(\d+|пол|полтора|пару|час|сутки|день|неделю|минуту|месяц)?\s*(минут[а-я]*|час[а-я]*|дн[а-я]*|сут[а-я]*|недел[а-я]*|месяц[а-я]*)?/g;
  for (const m of t.matchAll(re)) {
    if (!m[1] && !m[2]) continue;
    let num = 1;
    if (/^\d+$/.test(m[1] || "")) num = Number(m[1]);
    else if (m[1] === "пол") num = 0.5;
    else if (m[1] === "полтора") num = 1.5;
    else if (m[1] === "пару") num = 2;
    const unit = m[2] || m[1] || "";
    if (/^мин/.test(unit)) return Math.round(num);
    if (/^час/.test(unit)) return Math.round(num * 60);
    if (/^(дн|сут|день)/.test(unit)) return Math.round(num * 1440);
    if (/^недел/.test(unit)) return Math.round(num * 10080);
    if (/^месяц/.test(unit)) return Math.round(num * 43200);
  }
  return null;
}

// «в момент события», «в само время», «когда начнётся» → напомнить ровно в момент дела
function isAtEventMoment(text) {
  return /в\s+момент|в\s+сам[оа]е?\s+(время|событи|дел)|в\s+назначенное\s+время|когда\s+начн[её]тся/.test(
    String(text || "").toLowerCase()
  );
}

// кодовое слово «навсегда» / «насовсем»: перенос всей серии повторяющегося дела
function hasForeverWord(text) {
  return /навсегда|насовсем/i.test(String(text || ""));
}
function stripForeverWord(title) {
  const t = String(title || "").replace(/навсегда|насовсем/gi, "").replace(/\s+/g, " ").trim();
  return t || null;
}

// кодовое слово «переименуй»: «переименуй <старое> в <новое>» или «переименуй в <новое>» (про последнее дело).
// Название в кавычках «…» или "…" берём целиком, иначе делим по первому « в » / « на ».
function parseRename(text) {
  const t = String(text || "").trim().replace(/[.!?\s]+$/, "");
  if (!/переименуй/i.test(t)) return null;
  const unq = (s) => String(s).trim().replace(/^[«"“„']+|[»"”']+$/g, "").trim();
  const newTitle = (s) => unq(String(s).replace(/(?:\s+(?:навсегда|насовсем))+$/i, ""));

  let m = t.match(/переименуй\S*\s+(?:это\s+|его\s+|её\s+|дело\s+)?(?:в|на)\s+(.+)$/i);
  if (m) return { title: null, new_title: newTitle(m[1]), refers_to_last: true };

  m = t.match(/переименуй\S*\s+(«[^»]+»|"[^"]+"|“[^”]+”|„[^”]+”|'[^']+'|.+?)\s+(?:в|на)\s+(.+)$/i);
  if (m) return { title: unq(m[1]), new_title: newTitle(m[2]), refers_to_last: false };

  return { title: null, new_title: null, refers_to_last: false };
}

// Однозначное числовое время события; даты и отдельные просьбы о напоминании пропускаем.
function extractExplicitEventTime(text) {
  const t = String(text || "").toLowerCase();
  const times = new Set();
  const re = /(?<![\p{L}\d.:\-])(\d{1,2})([:.\-])(\d{2})(?![\p{L}\d]|[.\-]\d)/gu;
  let seenTime = false;
  for (const m of t.matchAll(re)) {
    const hour = Number(m[1]);
    const minute = Number(m[3]);
    if (hour > 23 || minute > 59) continue;
    const before = t.slice(0, m.index);
    // «23.11» может быть датой; «в 23.11» явно задаёт время.
    if (m[2] === "." && hour >= 1 && minute >= 1 && minute <= 12 && !/(?:^|\s)в\s*$/.test(before)) continue;
    const clause = before.split(/[,;!?\n]|(?:\s+[аи]\s+)(?=напом)/u).pop();
    const reminder = /напом(?:ни|нить|инание|инать)/u.test(clause);
    // Начальное «напомни завтра в 23:30 позвонить» — обычная просьба создать дело.
    const after = t.slice(m.index + m[0].length);
    const separateEvent = /[,;!?\n][\s\S]*\d{1,2}[:.\-]\d{2}/u.test(after);
    if (reminder && (seenTime || clause !== before || separateEvent || /напоминание/u.test(clause))) continue;
    times.add(`${String(hour).padStart(2, "0")}:${m[3]}`);
    seenTime = true;
  }
  return times.size === 1 ? [...times][0] : null;
}

// в сообщении речь про день рождения (для них напоминание по умолчанию за неделю)
function isBirthday(text) {
  return /день\s+рожд|дня\s+рожд|днюх/i.test(String(text || ""));
}

module.exports = {
  isBirthday,
  extractExplicitEventTime,
  wordTokens, sameWord, stripContextWords, extractOffsetMinutes, isAtEventMoment,
  hasForeverWord, stripForeverWord, parseRename,
};
