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

module.exports = { wordTokens, sameWord, stripContextWords };
