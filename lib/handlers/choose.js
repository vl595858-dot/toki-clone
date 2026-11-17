// Продолжение сохранённого действия после выбора события или серии.
const { sendMessage } = require('../telegram');
const { saveContext } = require('../context');
const { findCandidates, isSpecific, askWhich } = require('./eventTarget');
const { parseSelector, isNewCommand } = require('../targetQuery');
const { handleDeleteEvent, handleRescheduleEvent } = require('./eventsEdit');
const { handleCancelReminder, handleSetReminder } = require('./reminders');
const { handleDeleteRecurringEvent } = require('./recurring');
const { handleRescheduleRecurring, handleRenameEvent } = require('./recurringEdit');

const ACTIONS = {
  delete_event: handleDeleteEvent, reschedule_event: handleRescheduleEvent,
  cancel_reminder: handleCancelReminder, set_reminder: handleSetReminder,
  delete_recurring_event: handleDeleteRecurringEvent, reschedule_recurring_event: handleRescheduleRecurring,
  rename_event: handleRenameEvent,
};
const WORD_NUM = {первое: 1, первый: 1, первая: 1, второе: 2, второй: 2, вторая: 2,
  третье: 3, третий: 3, третья: 3, четвертое: 4, четвертый: 4, четвертая: 4, пятое: 5, пятый: 5, пятая: 5};

async function handleChooseEvent(chatId, text, ctx, patch, tz) {
  const pending = ctx.pending;
  const choices = pending.choices || (pending.ids || []).map(id => ({kind: 'event', id}));
  const t = text.trim().toLowerCase().replace(/ё/g, 'е').replace(/[.!?)]+$/, '');
  if (/^(отмена|отмени|не надо|ничего|стоп)$/.test(t)) {
    await sendMessage(chatId, '👌 Хорошо, ничего не меняю.');
    await saveContext(chatId, {...ctx, ...patch, pending: null});
    return true;
  }
  // Новая самостоятельная команда не является согласием на старое действие.
  if (isNewCommand(text)) return false;
  let selection;
  const num = /^\d+$/.test(t) ? Number(t) : WORD_NUM[t];
  if (num !== undefined) {
    if (num < 1 || num > Math.min(5, choices.length)) {
      await sendMessage(chatId, 'Выбери номер из списка или напиши «отмена».');
      await saveContext(chatId, {...ctx, pending});
      return true;
    }
    selection = choices[num - 1];
  } else {
    const query = parseSelector(text, tz);
    if (!isSpecific({target: query})) {
      await sendMessage(chatId, 'Выбери номер из списка или уточни название, дату либо время.');
      await saveContext(chatId, {...ctx, pending});
      return true;
    }
    const candidates = [];
    for (const kind of new Set(choices.map(c => c.kind))) {
      const ids = new Set(choices.filter(c => c.kind === kind).map(c => c.id));
      const matches = await findCandidates(chatId, {target: query}, tz, kind);
      candidates.push(...matches.filter(row => ids.has(row.id)));
    }
    if (!candidates.length) {
      await sendMessage(chatId, 'В этом списке совпадений нет. Уточни название или дату, выбери номер либо напиши «отмена».');
      await saveContext(chatId, {...ctx, pending});
      return true;
    }
    if (candidates.length > 1) {
      await askWhich(chatId, pending.parsed, candidates, patch, tz);
      await saveContext(chatId, {...ctx, ...patch});
      return true;
    }
    selection = {kind: candidates[0]._kind, id: candidates[0].id};
  }
  const action = ACTIONS[pending.parsed.intent];
  if (!action) return false;
  // Повторно читаем запись с проверкой владельца; исчезнувший вариант не заменяем контекстом.
  const chosenCtx = {...ctx, pending: null};
  const parsed = {...pending.parsed, _selection: selection};
  await action(chatId, parsed, chosenCtx, patch, tz);
  await saveContext(chatId, {...chosenCtx, ...patch});
  return true;
}

module.exports = { handleChooseEvent };
