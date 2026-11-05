// Правка повторяющихся дел кодовыми словами: «навсегда» (перенос всей серии) и «переименуй» (новое название).
const db = require("../db");
const { sendMessage } = require("../telegram");
const { utcIsoToLocalParts, formatDateHuman, offsetMinutesToPhrase, nextNOccurrencesUtcIso } = require("../time");
const { WEEKDAY_NUM, RECURRING_BUFFER_SIZE } = require("../constants");
const { titleWordGroups, titleScore, resolveTarget } = require("./eventTarget");
const { handleRescheduleEvent } = require("./eventsEdit");
const { scheduleLabelFor } = require("./recurring");

// шаблоны повторяющихся дел по названию (с учётом падежей); лучшие — где совпало больше слов
async function findTemplates(chatId, titleSearch) {
  const variants = Array.from(new Set(titleWordGroups(titleSearch).flat()));
  const conditions = variants.map((_, i) => `title ILIKE $${i + 2}`).join(" OR ");
  const { rows } = await db.query(
    `SELECT * FROM recurring_events WHERE chat_id=$1 AND (${conditions}) ORDER BY id ASC LIMIT 20`,
    [chatId, ...variants.map((v) => `%${v}%`)]
  );
  const best = Math.max(0, ...rows.map((r) => titleScore(r.title, titleSearch)));
  const top = rows.filter((r) => titleScore(r.title, titleSearch) === best);
  // одинаковые названия считаем одним делом
  const seen = new Map();
  for (const r of top) {
    const k = r.title.trim().toLowerCase();
    if (!seen.has(k)) seen.set(k, r);
  }
  return Array.from(seen.values());
}

// шаблон по последнему делу из памяти (ответ на напоминание, кнопка «Перенос»)
async function templateOfLastEvent(chatId, ctx) {
  if (!ctx.last_event_id) return null;
  const { rows } = await db.query(
    `SELECT t.* FROM recurring_events t JOIN events e ON e.recurring_id = t.id WHERE e.id=$1 AND e.chat_id=$2`,
    [ctx.last_event_id, chatId]
  );
  return rows[0] || null;
}

async function replyAmbiguous(chatId, templates) {
  const lines = templates.slice(0, 5).map((t) => `• ${t.emoji || "📌"} ${t.title} (${scheduleLabelFor(t)} в ${t.time})`);
  await sendMessage(chatId, `❓ Нашёл несколько повторяющихся дел:\n\n${lines.join("\n")}\n\nНазови нужное точнее.`);
}

/* ---- «перенеси … навсегда»: меняем расписание всей серии и пересоздаём будущие повторы ---- */
async function handleRescheduleRecurring(chatId, parsed, ctx, patch, tz) {
  let tpl = null;
  if (parsed.title) {
    const found = await findTemplates(chatId, parsed.title);
    if (found.length > 1) {
      await replyAmbiguous(chatId, found);
      return;
    }
    tpl = found[0] || null;
  } else {
    tpl = await templateOfLastEvent(chatId, ctx);
  }

  if (!tpl) {
    // дело не повторяется (или не найдено) — переносим обычным способом
    await handleRescheduleEvent(chatId, parsed, ctx, patch, tz);
    if (patch.last_event_id) {
      await sendMessage(chatId, "ℹ️ Это дело не повторяется, поэтому «навсегда» не понадобилось.");
    }
    return;
  }

  const upd = { weekday: tpl.weekday, time: tpl.time, month_day: tpl.month_day, month: tpl.month };
  const d = parsed.event_date ? new Date(`${parsed.event_date}T12:00:00Z`) : null;
  const namedWeekday = WEEKDAY_NUM[parsed.weekday];
  let given = false;

  if (parsed.event_time) {
    upd.time = parsed.event_time;
    given = true;
  }
  if (tpl.frequency === "weekly") {
    if (namedWeekday !== undefined) {
      upd.weekday = namedWeekday;
      given = true;
    } else if (d) {
      upd.weekday = d.getUTCDay();
      given = true;
    }
  } else if (tpl.frequency === "monthly" && d) {
    upd.month_day = d.getUTCDate();
    given = true;
  } else if (tpl.frequency === "yearly" && d) {
    upd.month_day = d.getUTCDate();
    upd.month = d.getUTCMonth() + 1;
    given = true;
  }

  if (!given) {
    await sendMessage(
      chatId,
      `На какой день или время перенести все повторы «${tpl.title}»?\nНапиши, например: «перенеси ${tpl.title} на вторник в 16:00 навсегда».`
    );
    return;
  }

  // если что-то оборвётся на полпути, cron сам достроит будущие повторы по новому расписанию
  await db.query(`UPDATE recurring_events SET weekday=$1, time=$2, month_day=$3, month=$4 WHERE id=$5`, [
    upd.weekday,
    upd.time,
    upd.month_day,
    upd.month,
    tpl.id,
  ]);
  await db.query(`DELETE FROM events WHERE recurring_id=$1 AND event_at >= now()`, [tpl.id]);

  const newTpl = { ...tpl, ...upd };
  const occurrences = nextNOccurrencesUtcIso(newTpl, tz, RECURRING_BUFFER_SIZE);
  let firstId = null;
  for (const occIso of occurrences) {
    const remindIso = new Date(new Date(occIso).getTime() - tpl.remind_offset_minutes * 60000).toISOString();
    const ins = await db.query(
      `INSERT INTO events (chat_id, title, emoji, event_at, remind_at, recurring_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [chatId, tpl.title, tpl.emoji, occIso, remindIso, tpl.id]
    );
    if (firstId === null) firstId = ins.rows[0].id;
  }
  patch.last_event_id = firstId;

  const local = utcIsoToLocalParts(occurrences[0], tz);
  await sendMessage(
    chatId,
    `♾ Теперь: ${tpl.emoji || "📌"} ${tpl.title} — ${scheduleLabelFor(newTpl)} в ${newTpl.time}\n` +
      `📅 Ближайшее: ${formatDateHuman(local.dateStr, local.timeStr)}\n` +
      `⏰ Напомню ${offsetMinutesToPhrase(tpl.remind_offset_minutes)}`
  );
}

/* ---- «переименуй X в Y»: у повторяющегося дела название меняется у всей серии ---- */
async function handleRenameEvent(chatId, parsed, ctx, patch, tz) {
  const newTitle = String(parsed.new_title || "").trim();
  if (!newTitle) {
    await sendMessage(chatId, "Как переименовать? Например: «переименуй планёрку в совещание по маркетингу».");
    return;
  }

  let tpl = null;
  let ev = null;

  if (parsed.title) {
    // сравниваем лучшее повторяющееся и лучшее обычное дело: побеждает то, где совпало больше слов
    const found = await findTemplates(chatId, parsed.title);
    const res = await resolveTarget(chatId, { title: parsed.title, refers_to_last: false }, ctx);
    const tplScore = found.length ? titleScore(found[0].title, parsed.title) : 0;
    const evCands = res.ambiguous ? res.candidates : res.target ? [res.target] : [];
    const evScore = evCands.length ? titleScore(evCands[0].title, parsed.title) : 0;

    if (tplScore >= evScore && found.length) {
      if (found.length > 1) {
        await replyAmbiguous(chatId, found);
        return;
      }
      tpl = found[0];
    } else if (res.ambiguous) {
      const lines = res.candidates.slice(0, 5).map((e) => `• ${e.emoji || "📌"} ${e.title}`);
      await sendMessage(chatId, `❓ Нашёл несколько похожих дел:\n\n${lines.join("\n")}\n\nНазови нужное точнее.`);
      return;
    } else {
      ev = res.target;
    }
  } else if (ctx.last_event_id) {
    const { rows } = await db.query(`SELECT * FROM events WHERE id=$1 AND chat_id=$2`, [ctx.last_event_id, chatId]);
    ev = rows[0] || null;
    if (!ev) {
      await sendMessage(chatId, "Не помню, о каком деле речь — назови его: «переименуй планёрку в совещание».");
      return;
    }
  } else {
    await sendMessage(chatId, "Не помню, о каком деле речь — назови его: «переименуй планёрку в совещание».");
    return;
  }

  if (!tpl && ev && ev.recurring_id) {
    const { rows } = await db.query(`SELECT * FROM recurring_events WHERE id=$1 AND chat_id=$2`, [ev.recurring_id, chatId]);
    tpl = rows[0] || null;
  }

  if (tpl) {
    await db.query(`UPDATE recurring_events SET title=$1 WHERE id=$2`, [newTitle, tpl.id]);
    await db.query(`UPDATE events SET title=$1 WHERE recurring_id=$2 AND event_at >= now()`, [newTitle, tpl.id]);
    await sendMessage(chatId, `✏️ Переименовал все повторы: «${tpl.title}» → «${newTitle}»`);
    return;
  }
  if (ev) {
    await db.query(`UPDATE events SET title=$1 WHERE id=$2`, [newTitle, ev.id]);
    patch.last_event_id = ev.id;
    await sendMessage(chatId, `✏️ Переименовал: «${ev.title}» → «${newTitle}»`);
    return;
  }
  await sendMessage(chatId, `Не нашёл дело, похожее на «${parsed.title || ""}».`);
}

module.exports = { handleRescheduleRecurring, handleRenameEvent };
