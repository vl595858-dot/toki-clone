// Документы по картинке: приём фото, сводка «что я увидел», вопрос «за сколько напомнить», создание дел.
const { sendMessage } = require("../telegram");
const S = require("../docSession");
const { setPending } = S;
const { parseMessage } = require("../ai");
const { offsetForZone, offsetAtLocalTime, placeLabel } = require("../places");
const { cityAnswer } = require("../placeDialog");
const { OFF, AMBIGUOUS, INTERVAL_QUESTION, isIntervalOnly, commandOffset, reminderAt } = require("../reminderSettings");
const { recognizeImage } = require("../vision");
const { formatDateHuman, utcIsoToLocalParts, dateTimeError } = require("../time");
const D = require("../docs");
const { charge, release } = require("../plusPlans");
const { limitMessages } = require("../plusPlanLimits");
const { isNewCommand } = require("../targetQuery");

const ONLY_IMAGES = "Я принимаю только картинки. Сделай скриншот документа и пришли его как фото.";
const NOT_RECOGNIZED =
  "Документ не распознал: нужных данных о времени не нашёл. Запиши словами или голосом, что за событие и когда, " +
  "например «Рейс на Москву 12 ноября в 06:40, напомни за сутки».";
const MISSING_RU = { title: "название", date: "дату", time: "время" };

const when = (d) => (d.time ? formatDateHuman(d.date, d.time) : D.dateOnly(d.date));

const needsPlaceZone = doc => Boolean(doc.city) || D.USES_PLACE_TZ.has(doc.kind);

function documentOffset(doc) {
  if (doc.explicitOffset) return doc.explicitOffset;
  const time = D.effectiveTime(doc);
  return doc.date && time ? offsetAtLocalTime(doc.zone, doc.date, time) : offsetForZone(doc.zone);
}

async function resolveDocumentCities(docs, userTz) {
  const cache = new Map();
  await Promise.all(docs.map(async doc => {
    if (!needsPlaceZone(doc)) { doc.tz = userTz; return; }
    if (!doc.city) return;
    if (!cache.has(doc.city)) cache.set(doc.city, cityAnswer(doc.city));
    const result = await cache.get(doc.city);
    if (result.place) {
      doc.city = placeLabel(result.place);
      doc.zone = result.place.timezone || null;
      doc.tz = documentOffset(doc);
    } else doc.cityDialog = result;
  }));
}

async function continueDocuments(chatId, docs, tz, remind, tx) {
  const index = docs.findIndex(d => D.USES_PLACE_TZ.has(d.kind) && !documentOffset(d));
  if (index !== -1) {
    const doc = docs[index];
    const dialog = doc.cityDialog;
    delete doc.cityDialog;
    await setPending(chatId, {type:"doc", step:"city", docs, index, remind, city:dialog?.state}, tx);
    const instruction = dialog?.reply || (doc.zone
      ? "Не могу однозначно перевести это местное время. Укажи смещение для события, например UTC+03:00."
      : "Напиши город события или его смещение на дату события, например UTC+03:00.");
    S.emit(tx, () => sendMessage(chatId, (doc.title ? doc.title + "\n" : "") + instruction));
    return;
  }
  for (const doc of docs) {
    if (needsPlaceZone(doc)) doc.tz = documentOffset(doc);
  }
  const complete = docs.filter(d => !D.missingFields(d).length);
  if (!complete.length) return askMissing(chatId, docs[0], remind, tx);
  if (complete.length > 1) return askPick(chatId, complete, remind, tx);
  return showSummary(chatId, [complete[0]], tz, remind, docs.length > complete.length, tx);
}

async function documentCityReply(chatId, text, p, tz) {
  const offset = /^(?:UTC|GMT)\s*([+-](?:0\d|1[0-4]):[0-5]\d)[.!?]*$/iu.exec(text.trim())?.[1];
  const result = offset ? {} : await cityAnswer(text, p.city);
  return S.useStep(chatId, p.token, current => current.step === "city", async (tx, current) => {
    if (result.closed) {
      await setPending(chatId, null, tx);
      S.emit(tx, () => sendMessage(chatId, result.reply));
      return;
    }
    if (!offset && !result.place) {
      await setPending(chatId, {...current, city:result.state}, tx);
      S.emit(tx, () => sendMessage(chatId, result.reply));
      return;
    }
    const doc = current.docs[current.index];
    doc.explicitOffset = offset;
    if (result.place) {
      doc.city = placeLabel(result.place);
      doc.zone = result.place.timezone || null;
    }
    return continueDocuments(chatId, current.docs, tz, current.remind, tx);
  });
}

/* ---- пришла картинка ---- */
async function handlePhoto(message, tz) {
  const chatId = message.chat.id;
  const file = message.document;
  if (file && !/^image\//.test(file.mime_type || "")) {
    await sendMessage(chatId, ONLY_IMAGES);
    return;
  }
  const quota = await charge(chatId, "image");
  if (!quota.allowed) {
    await sendMessage(chatId, limitMessages.image);
    return;
  }
  const fileId = message.photo ? message.photo[message.photo.length - 1].file_id : file.file_id;
  const reading = await setPending(chatId, { type: "doc", step: "reading" });
  await sendMessage(chatId, "🔎 Смотрю картинку…");

  let docs;
  try {
    docs = D.normalizeDocs(await recognizeImage(fileId, tz));
  } catch (e) {
    console.error("vision error", e);
    await release(chatId, quota.id);
    await S.useStep(chatId, reading.token, p => p.step === "reading", async tx => {
      await setPending(chatId, null, tx);
      S.emit(tx, () => sendMessage(chatId, "Не получилось прочитать картинку. Запиши словами или голосом, что за событие и когда."));
    });
    return;
  }
  if (!docs.length) {
    await S.useStep(chatId, reading.token, p => p.step === "reading", async tx => {
      await setPending(chatId, null, tx);
      S.emit(tx, () => sendMessage(chatId, NOT_RECOGNIZED));
    });
    return;
  }
  await resolveDocumentCities(docs, tz);

  // подпись к картинке с интервалом («напомни за сутки») — спрашивать про интервал не нужно
  const caption = message.caption || "";
  const offset = commandOffset(caption);
  const remind = offset === undefined ? null : offset;

  return S.useStep(chatId, reading.token, p => p.step === "reading",
    tx => continueDocuments(chatId, docs, tz, remind, tx));
}

/* ---- разобрал частично: говорим, что нашёл и чего не хватает ---- */
async function askMissing(chatId, doc, remind, tx) {
  if (!tx) return S.transaction(chatId, t => askMissing(chatId, doc, remind, t));
  const missing = D.missingFields(doc);
  const found = [doc.title && `${doc.emoji} ${doc.title}`, doc.date && D.dateOnly(doc.date), doc.time].filter(Boolean).join(", ");
  await setPending(chatId, { type: "doc", step: "missing", docs: [doc], remind, question: missing[0] }, tx);
  S.emit(tx, () => sendMessage(
    chatId,
    `Нашёл: ${found}.\nНе нашёл: ${missing.map((m) => MISSING_RU[m]).join(", ")}.\n` +
      `Укажи ${MISSING_RU[missing[0]]} словами или голосом.`
  ));

}

/* ---- несколько событий (туда-обратно, заезд-выезд): какое ставить ---- */
async function askPick(chatId, docs, remind, tx) {
  if (!tx) return S.transaction(chatId, t => askPick(chatId, docs, remind, t));
  const lines = docs.map((d, i) => `${i + 1}) ${d.emoji} ${d.title}, ${when(d)}`);
  const pending = await setPending(chatId, { type: "doc", step: "pick", docs, remind }, tx);
  const only = docs.map((_, i) => ({ text: `Только ${i + 1}`, callback_data: `doc:${pending.token}:pick:${i}` }));
  const all = { text: docs.length === 2 ? "Оба" : "Все", callback_data: `doc:${pending.token}:pick:all` };
  S.emit(tx, () => sendMessage(chatId, `Нашёл несколько событий:\n\n${lines.join("\n")}\n\nКакое поставить?`, {
    replyMarkup: { inline_keyboard: docs.length === 2 ? [[all, ...only]] : [[all], ...only.map((b) => [b])] },
  }));

}

/* ---- сводка и вопрос «верно?» ---- */
async function showSummary(chatId, docs, tz, remind, hasUnread = false, tx) {
  if (!tx) return S.transaction(chatId, t => showSummary(chatId, docs, tz, remind, hasUnread, t));
  let text = `📎 Вот что я увидел:\n${D.summaryLines(docs[0], tz).join("\n")}`;
  if (hasUnread) text += "\n\n(Ещё одно событие с картинки не разобрал: добавь его словами.)";
  text += "\n\nВерно?";
  try {
    const { rows } = await tx.client.query(`SELECT 1 FROM events WHERE chat_id=$1 AND is_doc = TRUE LIMIT 1`, [chatId]);
    if (!rows.length) text += "\n\n🔒 Картинку я не сохраняю, у меня остаются только найденные данные.";
  } catch (e) {
    console.error("first-doc check failed", e);
  }
  const pending = await setPending(chatId, { type: "doc", step: "confirm", docs, remind }, tx);
  S.emit(tx, () => sendMessage(chatId, text, {
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "✅ Верно", callback_data: `doc:${pending.token}:ok` },
          { text: "✏️ Исправить", callback_data: `doc:${pending.token}:fix` },
        ],
        [{ text: "❌ Отмена", callback_data: `doc:${pending.token}:no` }],
      ],
    },
  }));

}

/* ---- вопрос «за сколько напомнить?» с кнопками по типу документа ---- */
async function askRemind(chatId, docs, note, tx) {
  if (!tx) return S.transaction(chatId, t => askRemind(chatId, docs, note, t));
  const invalid = docs.map(d => dateTimeError(d.date, D.effectiveTime(d))).find(Boolean);
  if (invalid) { S.emit(tx, () => sendMessage(chatId, invalid)); return; }
  const minUntil = Math.min(...docs.map((d) => new Date(D.eventAtIso(d)).getTime() - Date.now()));
  if (minUntil <= 0) {
    S.emit(tx, () => sendMessage(chatId, "⚠️ Это время уже прошло, ничего не записал. Проверь дату или запиши событие словами."));
    await setPending(chatId, null, tx);
    return;
  }
  let presets = D.presetsFor(docs[0]).filter(([m]) => m * 60000 < minUntil); // только те, что ещё успеваем
  if (!presets.length) presets = [[0, "в момент события"]];
  const pending = await setPending(chatId, { type: "doc", step: "remind", docs, offsets: presets.map(([m]) => m) }, tx);
  S.emit(tx, () => sendMessage(chatId, `${note ? note + "\n\n" : ""}За сколько напомнить?\nВыбери кнопкой или напиши свой вариант.`, {
    replyMarkup: { inline_keyboard: [presets.map(([m, label]) => ({ text: label, callback_data: `doc:${pending.token}:r:${m}` }))] },
  }));

}

/* ---- создаём дела и напоминания ---- */
async function createDocEvents(chatId, docs, off, tz, tx) {
  if (!tx) return S.transaction(chatId, t => createDocEvents(chatId, docs, off, tz, t));
  if (docs.some(doc => needsPlaceZone(doc) && !documentOffset(doc))) {
    return continueDocuments(chatId, docs, tz, off, tx);
  }
  const invalid = docs.map(d => dateTimeError(d.date, D.effectiveTime(d))).find(Boolean);
  if (invalid) { S.emit(tx, () => sendMessage(chatId, invalid)); return; }
  const now = Date.now();
  const future = docs.filter((d) => new Date(D.eventAtIso(d)).getTime() > now);
  if (!future.length) {
    S.emit(tx, () => sendMessage(chatId, "⚠️ Это время уже прошло, ничего не записал."));
    await setPending(chatId, null, tx);
    return;
  }
  const minUntil = Math.min(...future.map((d) => new Date(D.eventAtIso(d)).getTime() - now));
  if (off > 0 && off * 60000 >= minUntil) {
    await askRemind(chatId, future, `⚠️ ${D.phraseFor(off)[0].toUpperCase() + D.phraseFor(off).slice(1)} уже не успеть: до события осталось ${D.humanUntil(minUntil)}`, tx);
    return;
  }

  if (!(await charge(chatId, "event", future.length, tx.client)).allowed) {
    await setPending(chatId, null, tx);
    S.emit(tx, () => sendMessage(chatId, limitMessages.event));
    return;
  }
  const lines = [];
  let firstId = null;
  let lastRemind = null;
  for (const d of future) {
    const at = D.eventAtIso(d);
    const remindIso = reminderAt(at, off);
    const ins = await tx.client.query(
      `INSERT INTO events (chat_id, title, emoji, event_at, remind_at, is_doc) VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id`,
      [chatId, d.title, d.emoji, at, remindIso]
    );
    if (firstId === null) firstId = ins.rows[0].id;
    lastRemind = remindIso;
    lines.push(`${d.emoji} ${d.title}\n📅 ${when(d)}${d.tz !== tz && d.time ? " (местное время)" : ""}`);
  }

  const rl = lastRemind ? utcIsoToLocalParts(lastRemind, tz) : null;
  const remindLine =
    off === OFF
      ? "🔕 Напоминания отключены"
      : off === 0
      ? "⏰ Напомню в момент события"
      : future.length === 1
      ? `⏰ Напомню ${D.phraseFor(off)} (${formatDateHuman(rl.dateStr, rl.timeStr)})`
      : `⏰ Напомню ${D.phraseFor(off)} до каждого события`;
  const skipped = docs.length > future.length ? "\n(Одно событие уже прошло, его не записал.)" : "";
  S.emit(tx, () => sendMessage(chatId, `✅ Записал:\n${lines.join("\n\n")}\n${remindLine}${skipped}`));

  tx.ctx.last_event_id = firstId;
  await setPending(chatId, null, tx);
}

/* ---- текстовые ответы: недостающие данные, правка, свой интервал ---- */
async function handleDocText(chatId, text, ctx, tz) {
  let p = ctx.pending;
  if (!p || p.type !== "doc") return false;
  if (p.step === "city") {
    if (isNewCommand(text) && !/^(?:отмена|отмени|стоп)[.!?]*$/iu.test(text.trim())) return false;
    if (!await documentCityReply(chatId, text, p, tz)) {
      await sendMessage(chatId, "Этот документ уже сменился. Ответь на вопрос под последней картинкой.");
    }
    return true;
  }
  if (!["remind", "missing", "fix"].includes(p.step)) return false;
  if (p.step === "remind" && isNewCommand(text) && !isIntervalOnly(text)) return false;
  // Existing text dialogs can continue; old unbound buttons are never accepted.
  if (!p.token) {
    p = await S.transaction(chatId, async tx => {
      if (JSON.stringify(tx.ctx.pending) !== JSON.stringify(p)) return null;
      return setPending(chatId, p, tx);
    });
    if (!p) return true;
  }
  let parsed = {};
  if (p.step !== "remind") {
    try { parsed = await parseMessage(text, p.docs[0].tz || tz, ""); }
    catch (e) { console.error("doc text parse error", e); }
  }
  const used = await S.useStep(chatId, p.token, current => current.step === p.step, async (tx, current) => {
    const retry = async (message, patch = {}) => {
      await setPending(chatId, { ...current, ...patch }, tx);
      S.emit(tx, () => sendMessage(chatId, message));
    };
    if (current.step === "remind") {
      const m = commandOffset(text, { allowBare: true });
      if (m === undefined || m === AMBIGUOUS) return retry(INTERVAL_QUESTION);
      return createDocEvents(chatId, current.docs, m, tz, tx);
    }
    const result = D.correctDocument(current, text, parsed, tz);
    if (result.question) return retry(result.question, result.pending);
    if (result.error) return retry(result.error);
    const doc = result.doc;
    if (needsPlaceZone(doc)) return continueDocuments(chatId, [doc], tz, current.remind, tx);
    if (D.missingFields(doc).length) return askMissing(chatId, doc, current.remind, tx);
    return showSummary(chatId, [doc], tz, current.remind, false, tx);
  });
  if (!used) await sendMessage(chatId, "Этот документ уже сменился. Ответь на вопрос под последней картинкой.");
  return true;
}

module.exports = { handlePhoto, handleDocText, showSummary, askRemind, createDocEvents, setPending };
