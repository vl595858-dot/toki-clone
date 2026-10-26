// Общий поиск дела: по названию или «последнее из памяти». Используется обработчиками удаления, переноса и напоминаний.
const db = require("../db");
const { sendMessage } = require("../telegram");
const { utcIsoToLocalParts, formatDateHuman } = require("../time");

/* ---- поиск ближайшего подходящего события по ключевым словам ---- */
async function findEventByTitle(chatId, titleSearch) {
  if (!titleSearch) return null;

  // разбиваем на слова и для каждого пробуем полную форму и укороченную основу —
  // это снимает часть проблем с падежами ("молоко" / "молока" / "молоку")
  const words = titleSearch
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);

  const variants = new Set();
  for (const w of words) {
    variants.add(w);
    if (w.length >= 5) variants.add(w.slice(0, -1));
    if (w.length >= 6) variants.add(w.slice(0, -2));
  }
  if (variants.size === 0) variants.add(titleSearch);

  const variantList = Array.from(variants);
  const conditions = variantList.map((_, i) => `title ILIKE $${i + 2}`).join(" OR ");
  const params = [chatId, ...variantList.map((v) => `%${v}%`)];

  const { rows } = await db.query(
    `SELECT * FROM events WHERE chat_id=$1 AND event_at >= now() AND (${conditions}) ORDER BY event_at ASC LIMIT 5`,
    params
  );
  return rows;
}

/* ---- определяем, о каком деле речь: последнее из памяти или найденное по названию ---- */
async function resolveTarget(chatId, parsed, ctx) {
  if (parsed.refers_to_last && ctx.last_event_id) {
    const { rows } = await db.query(`SELECT * FROM events WHERE id=$1 AND chat_id=$2`, [
      ctx.last_event_id,
      chatId,
    ]);
    if (rows.length) return { target: rows[0], matches: rows };
  }
  if (parsed.title) {
    const matches = await findEventByTitle(chatId, parsed.title);
    if (matches && matches.length) {
      // точное совпадение названия — это то самое дело, переспрашивать не нужно
      const wanted = parsed.title.trim().toLowerCase();
      const exact = matches.find((m) => m.title.trim().toLowerCase() === wanted);
      if (exact) return { target: exact, matches: matches.filter((m) => m.title === exact.title) };

      // разные названия — непонятно, какое имел в виду человек; одинаковые (повторы) — берём ближайшее
      const candidates = distinctByTitle(matches);
      if (candidates.length > 1) return { target: null, matches, ambiguous: true, candidates };
      return { target: matches[0], matches };
    }
  }
  return { target: null, matches: [] };
}

// по одному (ближайшему) делу на каждое отличающееся название
function distinctByTitle(rows) {
  const seen = new Map();
  for (const r of rows) {
    const k = r.title.trim().toLowerCase();
    if (!seen.has(k)) seen.set(k, r);
  }
  return Array.from(seen.values());
}

const NUMBER_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];

/* ---- несколько похожих дел: показываем список и ждём номер ---- */
async function askWhich(chatId, parsed, candidates, patch, tz) {
  const list = candidates.slice(0, NUMBER_EMOJI.length);
  const lines = list.map((ev, i) => {
    const local = utcIsoToLocalParts(ev.event_at, tz);
    return `${NUMBER_EMOJI[i]} ${ev.emoji || "📌"} ${ev.title} — ${formatDateHuman(local.dateStr, local.timeStr)}`;
  });
  await sendMessage(chatId, `❓ Нашёл несколько похожих дел:\n\n${lines.join("\n")}\n\nНапиши номер (или «отмена»).`);
  // запоминаем исходную просьбу — после выбора номера выполним её над выбранным делом
  patch.pending = {
    type: "choose_event",
    parsed: { ...parsed, title: null, refers_to_last: true },
    ids: list.map((e) => e.id),
  };
}

async function replyNotFound(chatId, parsed) {
  if (parsed.refers_to_last && !parsed.title) {
    await sendMessage(chatId, "Не помню, о каком деле речь — назови его, пожалуйста.");
  } else {
    await sendMessage(chatId, `Не нашёл дело, похожее на «${parsed.title || ""}» среди предстоящих.`);
  }
}

module.exports = { resolveTarget, replyNotFound, askWhich };
