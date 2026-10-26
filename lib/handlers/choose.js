// Ответ на вопрос «какое из нескольких похожих дел?»: номер, «отмена» или (если это не ответ) обычная команда.
const { sendMessage } = require("../telegram");
const { saveContext } = require("../context");
const { handleDeleteEvent, handleRescheduleEvent } = require("./eventsEdit");
const { handleCancelReminder, handleSetReminder } = require("./reminders");

const ACTIONS = {
  delete_event: handleDeleteEvent,
  reschedule_event: handleRescheduleEvent,
  cancel_reminder: handleCancelReminder,
  set_reminder: handleSetReminder,
};

const WORD_NUM = { первое: 1, первый: 1, первая: 1, второе: 2, второй: 2, вторая: 2, третье: 3, третий: 3, третья: 3 };

// возвращает true, если сообщение обработано здесь; false — это не ответ на вопрос, разбираем как обычную команду
async function handleChooseEvent(chatId, text, ctx, patch, tz) {
  const pend = ctx.pending;
  const t = text.trim().toLowerCase().replace(/[.!)]+$/, "");

  if (/^(отмена|отмени|не надо|ничего|стоп)$/.test(t)) {
    await sendMessage(chatId, "👌 Хорошо, ничего не меняю.");
    await saveContext(chatId, { ...ctx, ...patch });
    return true;
  }

  const num = /^\d$/.test(t) ? Number(t) : WORD_NUM[t];
  if (!num || num < 1 || num > pend.ids.length) return false;

  const action = ACTIONS[pend.parsed.intent];
  if (!action) return false;

  const chosenCtx = { ...ctx, last_event_id: pend.ids[num - 1], pending: null };
  await action(chatId, pend.parsed, chosenCtx, patch, tz);
  await saveContext(chatId, { ...chosenCtx, ...patch });
  return true;
}

module.exports = { handleChooseEvent };
