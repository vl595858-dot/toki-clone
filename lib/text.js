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
  const re = /(?:^|[^а-яё])за\s+(\d+|пол|полтора|час|сутки|день|неделю|минуту)?\s*(минут[а-я]*|час[а-я]*|дн[а-я]*|сут[а-я]*|недел[а-я]*)?/g;
  for (const m of t.matchAll(re)) {
    if (!m[1] && !m[2]) continue;
    let num = 1;
    if (/^\d+$/.test(m[1] || "")) num = Number(m[1]);
    else if (m[1] === "пол") num = 0.5;
    else if (m[1] === "полтора") num = 1.5;
    const unit = m[2] || m[1] || "";
    if (/^мин/.test(unit)) return Math.round(num);
    if (/^час/.test(unit)) return Math.round(num * 60);
    if (/^(дн|сут|день)/.test(unit)) return Math.round(num * 1440);
    if (/^недел/.test(unit)) return Math.round(num * 10080);
  }
  return null;
}

// «в момент события», «в само время», «когда начнётся» → напомнить ровно в момент дела
function isAtEventMoment(text) {
  return /в\s+момент|в\s+сам[оа]е?\s+(время|событи|дел)|в\s+назначенное\s+время|когда\s+начн[её]тся/.test(
    String(text || "").toLowerCase()
  );
}

module.exports = { wordTokens, sameWord, stripContextWords, extractOffsetMinutes, isAtEventMoment };
