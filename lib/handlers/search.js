// Поиск дел по названию: «когда у меня встреча с Иваном?», «когда день рождения мамы?».
const db = require("../db");
const { sendMessage } = require("../telegram");
const { utcIsoToLocalParts, formatDateHuman } = require("../time");
const { titleWordGroups, titleScore } = require("./eventTarget");

const MAX_SHOWN = 5;

// ищем дела, где встречается хотя бы одно слово запроса; оставляем те, где совпало больше всего слов
async function findMatches(chatId, query, upcoming) {
  const variants = Array.from(new Set(titleWordGroups(query).flat()));
  const conditions = variants.map((_, i) => `title ILIKE $${i + 2}`).join(" OR ");
  const params = [chatId, ...variants.map((v) => `%${v}%`)];
  const sql = upcoming
    ? `SELECT * FROM events WHERE chat_id=$1 AND event_at >= now() AND (${conditions}) ORDER BY event_at ASC LIMIT 60`
    : `SELECT * FROM events WHERE chat_id=$1 AND event_at < now() AND (${conditions}) ORDER BY event_at DESC LIMIT 60`;
  const { rows } = await db.query(sql, params);
  const best = Math.max(0, ...rows.map((r) => titleScore(r.title, query)));
  return rows.filter((r) => titleScore(r.title, query) === best);
}

// по одному (ближайшему) делу на каждое отличающееся название — повторы не засоряют ответ
function onePerTitle(rows) {
  const seen = new Map();
  for (const r of rows) {
    const k = r.title.trim().toLowerCase();
    if (!seen.has(k)) seen.set(k, r);
  }
  return Array.from(seen.values());
}

function line(ev, tz) {
  const local = utcIsoToLocalParts(ev.event_at, tz);
  const repeat = ev.recurring_id ? " ↻" : "";
  return `${ev.emoji || "📌"} ${ev.title} — ${formatDateHuman(local.dateStr, local.timeStr)}${repeat}`;
}

async function handleSearchEvents(chatId, parsed, tz) {
  const query = (parsed.title || "").trim();
  if (!query) {
    await sendMessage(chatId, "🔎 Назови, какое дело искать, например: «когда у меня встреча с Иваном?»");
    return;
  }

  const upcoming = onePerTitle(await findMatches(chatId, query, true)).slice(0, MAX_SHOWN);
  if (upcoming.length) {
    await sendMessage(chatId, `🔎 Нашёл:\n\n${upcoming.map((ev) => line(ev, tz)).join("\n")}`);
    return;
  }

  // впереди ничего нет — подскажем, когда это было в последний раз
  const past = await findMatches(chatId, query, false);
  if (past.length) {
    await sendMessage(chatId, `🔎 Впереди такого нет. Последний раз было:\n\n${line(past[0], tz)}`);
    return;
  }
  await sendMessage(chatId, `🔎 Не нашёл дел, похожих на «${query}».`);
}

module.exports = { handleSearchEvents };
