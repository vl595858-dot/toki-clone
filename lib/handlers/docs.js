// Документы по картинке: приём фото, сводка «что я увидел», вопрос «за сколько напомнить», создание дел.
const db = require("../db");
const { sendMessage } = require("../telegram");
const { loadContext, saveContext } = require("../context");
const { parseMessage } = require("../ai");
const { getTimezoneOffsetForCity } = require("../weather");
const { extractOffsetMinutes, isAtEventMoment } = require("../text");
const { recognizeImage } = require("../vision");
const { formatDateHuman, utcIsoToLocalParts } = require("../time");
const D = require("../docs");

const ONLY_IMAGES = "Я принимаю только картинки. Сделай скриншот документа и пришли его как фото.";
const NOT_RECOGNIZED =
  "Документ не распознал: нужных данных о времени не нашёл. Запиши словами или голосом, что за событие и когда, " +
  "например «Рейс на Москву 12 ноября в 06:40, напомни за сутки».";
const MISSING_RU = { title: "название", date: "дату", time: "время" };

const when = (d) => (d.time ? formatDateHuman(d.date, d.time) : D.dateOnly(d.date));

async function setPending(chatId, pending) {
  const ctx = await loadContext(chatId);
  await saveContext(chatId, { ...ctx, pending });
}

// время на билете — местное для города события, поэтому определяем пояс города
async function attachTimezones(docs, userTz) {
  const cache = new Map();
  for (const d of docs) {
    d.tz = userTz;
    if (!D.USES_PLACE_TZ.has(d.kind) || !d.city) continue;
    if (!cache.has(d.city)) {
      try {
        cache.set(d.city, await getTimezoneOffsetForCity(d.city));
      } catch (e) {
        cache.set(d.city, null);
      }
    }
    const r = cache.get(d.city);
    if (r) d.tz = r.offset;
  }
}

/* ---- пришла картинка ---- */
async function handlePhoto(message, tz) {
  const chatId = message.chat.id;
  const file = message.document;
  if (file && !/^image\//.test(file.mime_type || "")) {
    await sendMessage(chatId, ONLY_IMAGES);
    return;
  }
  const fileId = message.photo ? message.photo[message.photo.length - 1].file_id : file.file_id;
  await sendMessage(chatId, "🔎 Смотрю картинку…");

  let docs;
  try {
    docs = D.normalizeDocs(await recognizeImage(fileId, tz));
  } catch (e) {
    console.error("vision error", e);
    await sendMessage(chatId, "Не получилось прочитать картинку. Запиши словами или голосом, что за событие и когда.");
    return;
  }
  if (!docs.length) {
    await sendMessage(chatId, NOT_RECOGNIZED);
    return;
  }
  await attachTimezones(docs, tz);

  // подпись к картинке с интервалом («напомни за сутки») — спрашивать про интервал не нужно
  const caption = message.caption || "";
  const off = extractOffsetMinutes(caption);
  const remind = off ? off : isAtEventMoment(caption) ? 0 : null;

  const complete = docs.filter((d) => D.missingFields(d).length === 0);
  if (complete.length === 0) return askMissing(chatId, docs[0], remind);
  if (complete.length > 1) return askPick(chatId, complete, remind);
  return showSummary(chatId, [complete[0]], tz, remind, docs.length > complete.length);
}

/* ---- разобрал частично: говорим, что нашёл и чего не хватает ---- */
async function askMissing(chatId, doc, remind) {
  const missing = D.missingFields(doc);
  const found = [doc.title && `${doc.emoji} ${doc.title}`, doc.date && D.dateOnly(doc.date), doc.time].filter(Boolean).join(", ");
  await sendMessage(
    chatId,
    `Нашёл: ${found}.\nНе нашёл: ${missing.map((m) => MISSING_RU[m]).join(", ")}.\n` +
      `Напиши недостающее словами или голосом, например «12 ноября в 06:40».`
  );
  await setPending(chatId, { type: "doc", step: "missing", docs: [doc], remind });
}

/* ---- несколько событий (туда-обратно, заезд-выезд): какое ставить ---- */
async function askPick(chatId, docs, remind) {
  const lines = docs.map((d, i) => `${i + 1}) ${d.emoji} ${d.title}, ${when(d)}`);
  const only = docs.map((_, i) => ({ text: `Только ${i + 1}`, callback_data: `doc:pick:${i}` }));
  const all = { text: docs.length === 2 ? "Оба" : "Все", callback_data: "doc:pick:all" };
  await sendMessage(chatId, `Нашёл несколько событий:\n\n${lines.join("\n")}\n\nКакое поставить?`, {
    replyMarkup: { inline_keyboard: docs.length === 2 ? [[all, ...only]] : [[all], ...only.map((b) => [b])] },
  });
  await setPending(chatId, { type: "doc", step: "pick", docs, remind });
}

/* ---- сводка и вопрос «верно?» ---- */
async function showSummary(chatId, docs, tz, remind, hasUnread = false) {
  let text = `📎 Вот что я увидел:\n${D.summaryLines(docs[0], tz).join("\n")}`;
  if (hasUnread) text += "\n\n(Ещё одно событие с картинки не разобрал: добавь его словами.)";
  text += "\n\nВерно?";
  try {
    const { rows } = await db.query(`SELECT 1 FROM events WHERE chat_id=$1 AND is_doc = TRUE LIMIT 1`, [chatId]);
    if (!rows.length) text += "\n\n🔒 Картинку я не сохраняю, у меня остаются только найденные данные.";
  } catch (e) {
    console.error("first-doc check failed", e);
  }
  await sendMessage(chatId, text, {
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "✅ Верно", callback_data: "doc:ok" },
          { text: "✏️ Исправить", callback_data: "doc:fix" },
        ],
        [{ text: "❌ Отмена", callback_data: "doc:no" }],
      ],
    },
  });
  await setPending(chatId, { type: "doc", step: "confirm", docs, remind });
}

/* ---- вопрос «за сколько напомнить?» с кнопками по типу документа ---- */
async function askRemind(chatId, docs, note) {
  const minUntil = Math.min(...docs.map((d) => new Date(D.eventAtIso(d)).getTime() - Date.now()));
  if (minUntil <= 0) {
    await sendMessage(chatId, "⚠️ Это время уже прошло, ничего не записал. Проверь дату или запиши событие словами.");
    await setPending(chatId, null);
    return;
  }
  let presets = D.presetsFor(docs[0]).filter(([m]) => m * 60000 < minUntil); // только те, что ещё успеваем
  if (!presets.length) presets = [[0, "в момент события"]];
  await sendMessage(chatId, `${note ? note + "\n\n" : ""}За сколько напомнить?\nВыбери кнопкой или напиши свой вариант.`, {
    replyMarkup: { inline_keyboard: [presets.map(([m, label]) => ({ text: label, callback_data: `doc:r:${m}` }))] },
  });
  await setPending(chatId, { type: "doc", step: "remind", docs });
}

/* ---- создаём дела и напоминания ---- */
async function createDocEvents(chatId, docs, off, tz) {
  const now = Date.now();
  const future = docs.filter((d) => new Date(D.eventAtIso(d)).getTime() > now);
  if (!future.length) {
    await sendMessage(chatId, "⚠️ Это время уже прошло, ничего не записал.");
    await setPending(chatId, null);
    return;
  }
  const minUntil = Math.min(...future.map((d) => new Date(D.eventAtIso(d)).getTime() - now));
  if (off > 0 && off * 60000 >= minUntil) {
    await askRemind(chatId, future, `⚠️ ${D.phraseFor(off)[0].toUpperCase() + D.phraseFor(off).slice(1)} уже не успеть: до события осталось ${D.humanUntil(minUntil)}`);
    return;
  }

  const lines = [];
  let firstId = null;
  let lastRemind = null;
  for (const d of future) {
    const at = D.eventAtIso(d);
    const remindIso = new Date(new Date(at).getTime() - off * 60000).toISOString();
    const ins = await db.query(
      `INSERT INTO events (chat_id, title, emoji, event_at, remind_at, is_doc) VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id`,
      [chatId, d.title, d.emoji, at, remindIso]
    );
    if (firstId === null) firstId = ins.rows[0].id;
    lastRemind = remindIso;
    lines.push(`${d.emoji} ${d.title}\n📅 ${when(d)}${d.tz !== tz && d.time ? " (местное время)" : ""}`);
  }

  const rl = utcIsoToLocalParts(lastRemind, tz);
  const remindLine =
    off === 0
      ? "⏰ Напомню в момент события"
      : future.length === 1
      ? `⏰ Напомню ${D.phraseFor(off)} (${formatDateHuman(rl.dateStr, rl.timeStr)})`
      : `⏰ Напомню ${D.phraseFor(off)} до каждого события`;
  const skipped = docs.length > future.length ? "\n(Одно событие уже прошло, его не записал.)" : "";
  await sendMessage(chatId, `✅ Записал:\n${lines.join("\n\n")}\n${remindLine}${skipped}`);

  const ctx = await loadContext(chatId);
  await saveContext(chatId, { ...ctx, pending: null, last_event_id: firstId });
}

/* ---- текстовые ответы: недостающие данные, правка, свой интервал ---- */
async function handleDocText(chatId, text, ctx, tz) {
  const p = ctx.pending;
  if (!p || p.type !== "doc") return false;

  if (p.step === "remind") {
    const off = extractOffsetMinutes(text);
    const m = off ? off : isAtEventMoment(text) ? 0 : null;
    if (m === null) {
      await sendMessage(chatId, "Не понял интервал. Напиши, например: «за сутки» или «за 3 часа».");
      return true;
    }
    await createDocEvents(chatId, p.docs, m, tz);
    return true;
  }

  if (p.step === "missing" || p.step === "fix") {
    const doc = { ...p.docs[0] };
    let changed = false;
    if (p.step === "missing" && !doc.title) {
      doc.title = text.trim().slice(0, 100);
      changed = true;
    }
    let parsed = {};
    try {
      parsed = await parseMessage(text, doc.tz || tz, "");
    } catch (e) {
      console.error("doc text parse error", e);
    }
    if (parsed.event_date && D.mentionsDate(text) && (p.step === "fix" || !doc.date)) {
      doc.date = parsed.event_date;
      changed = true;
    }
    if (parsed.event_time && D.mentionsTime(text) && (p.step === "fix" || !doc.time)) {
      doc.time = parsed.event_time;
      changed = true;
    }
    if (!changed) {
      await sendMessage(
        chatId,
        p.step === "fix"
          ? "Не понял правку. Напиши дату или время, например «12 ноября в 07:40». Название можно поменять потом словом «переименуй»."
          : "Не понял. Напиши недостающее, например «12 ноября в 06:40»."
      );
      return true;
    }
    if (D.missingFields(doc).length) {
      await askMissing(chatId, doc, p.remind);
    } else {
      await showSummary(chatId, [doc], tz, p.remind);
    }
    return true;
  }
  return false;
}

module.exports = { handlePhoto, handleDocText, showSummary, askRemind, createDocEvents, setPending };
