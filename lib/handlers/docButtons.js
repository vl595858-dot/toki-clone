const { sendMessage, answerCallbackQuery, editMessageText } = require('../telegram');
const { getTzOffset } = require('../settings');
const { askRemind, createDocEvents } = require('./docs');
const S = require('../docSession');
const STALE = 'Эта кнопка устарела или уже обработана. Используй кнопки под последним документом.';
async function handleDocButton(cq) {
  const chatId = cq.message?.chat?.id;
  if (!chatId) return;
  const match = /^doc:([a-f0-9]{24}):(ok|fix|no|pick|r)(?::(all|\d+))?$/.exec(String(cq.data));
  if (!match) return answerCallbackQuery(cq.id, STALE);
  const [, token, action, arg] = match;
  const tz = await getTzOffset(chatId);
  const used = await S.useStep(chatId, token, p => {
    if (['ok', 'fix', 'no'].includes(action)) return p.step === 'confirm' && arg === undefined;
    if (action === 'pick') return p.step === 'pick' && (arg === 'all' || /^\d+$/.test(arg || '') && Number(arg) < p.docs.length);
    return p.step === 'remind' && arg !== undefined && p.offsets?.includes(Number(arg));
  }, async (tx, p) => {
    S.emit(tx, () => answerCallbackQuery(cq.id));
    S.emit(tx, () => editMessageText(chatId, cq.message.message_id, `${cq.message.text || ''}\n✅ Обработано`));
    if (action === 'no') return S.setPending(chatId, null, tx);
    if (action === 'fix') {
      await S.setPending(chatId, { ...p, step: 'fix', question: 'date_time' }, tx);
      S.emit(tx, () => sendMessage(chatId, 'Что исправить: дату или время? Например «дата 12.11» или «время 23-30».'));
      return;
    }
    const docs = action === 'pick' && arg !== 'all' ? [p.docs[Number(arg)]] : p.docs;
    if (action === 'r' || Number.isFinite(p.remind)) return createDocEvents(chatId, docs, action === 'r' ? Number(arg) : p.remind, tz, tx);
    return askRemind(chatId, docs, undefined, tx);
  });
  if (!used) await answerCallbackQuery(cq.id, STALE);
}
module.exports = { handleDocButton };
