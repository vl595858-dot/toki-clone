// Кнопки диалога по картинке (callback_data: doc:ok | doc:fix | doc:no | doc:pick:<n|all> | doc:r:<минуты>).
const { sendMessage, answerCallbackQuery, editMessageText } = require("../telegram");
const { loadContext } = require("../context");
const { getTzOffset } = require("../settings");
const { askRemind, createDocEvents, setPending } = require("./docs");
const { phraseFor } = require("../docs");

async function handleDocButton(cq) {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const oldText = cq.message?.text || "";
  if (!chatId) return;
  const [, action, arg] = String(cq.data).split(":");

  const ctx = await loadContext(chatId);
  const p = ctx.pending;
  if (!p || p.type !== "doc") {
    await answerCallbackQuery(cq.id, "Это сообщение устарело — пришли картинку заново");
    await editMessageText(chatId, messageId, oldText);
    return;
  }
  await answerCallbackQuery(cq.id);
  const tz = await getTzOffset(chatId);

  // после «верно» и после выбора события: интервал уже назван в подписи к картинке — создаём, иначе спрашиваем
  const next = async (docs) => {
    if (Number.isFinite(p.remind)) await createDocEvents(chatId, docs, p.remind, tz);
    else await askRemind(chatId, docs);
  };

  if (action === "no") {
    await editMessageText(chatId, messageId, `${oldText}\n❌ Отменено`);
    await setPending(chatId, null);
    return;
  }
  if (action === "fix" && p.step === "confirm") {
    await editMessageText(chatId, messageId, `${oldText}\n✏️ Исправляю`);
    await sendMessage(chatId, "Что поправить? Напиши, например: «12 ноября в 07:40».");
    await setPending(chatId, { ...p, step: "fix" });
    return;
  }
  if (action === "ok" && p.step === "confirm") {
    await editMessageText(chatId, messageId, `${oldText}\n✅ Верно`);
    await next(p.docs);
    return;
  }
  if (action === "pick" && p.step === "pick") {
    const chosen = arg === "all" ? p.docs : [p.docs[Number(arg)]].filter(Boolean);
    if (!chosen.length) return;
    await editMessageText(chatId, messageId, `${oldText}\n✅ Выбрано: ${arg === "all" ? "все" : `№ ${Number(arg) + 1}`}`);
    await next(chosen);
    return;
  }
  if (action === "r" && p.step === "remind") {
    const off = Number(arg);
    if (!Number.isFinite(off)) return;
    await editMessageText(chatId, messageId, `${oldText}\n✅ ${phraseFor(off)}`);
    await createDocEvents(chatId, p.docs, off, tz);
    return;
  }
  // кнопка из другого шага (например, старое сообщение)
  await editMessageText(chatId, messageId, oldText);
}

module.exports = { handleDocButton };
