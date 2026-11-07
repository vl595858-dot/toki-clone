// Кнопки под напоминанием: «✅ Сделано» и «📅 Перенос».
const db = require("../db");
const { sendMessage, answerCallbackQuery, editMessageText } = require("../telegram");
const { loadContext, saveContext } = require("../context");

// клавиатура под напоминанием (callback_data: rem:<действие>:<id дела>)
// у дел из документов (билеты и т.п.) вместо «Перенос» — «Напомнить позже»: событие не двигается, сдвигается только напоминание
function reminderKeyboard(eventId, isDoc = false) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Сделано", callback_data: `rem:done:${eventId}` },
        isDoc
          ? { text: "⏰ Напомнить позже", callback_data: `rem:later:${eventId}` }
          : { text: "📅 Перенос", callback_data: `rem:move:${eventId}` },
      ],
    ],
  };
}

async function handleReminderButton(cq) {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const oldText = cq.message?.text || "";
  const [, action, idStr] = String(cq.data).split(":");
  const eventId = Number(idStr);
  if (!chatId || !Number.isInteger(eventId)) return;

  // дело должно принадлежать именно этому чату
  const { rows } = await db.query(`SELECT * FROM events WHERE id=$1 AND chat_id=$2`, [eventId, chatId]);
  if (rows.length === 0) {
    await answerCallbackQuery(cq.id, "Это дело уже удалено");
    await editMessageText(chatId, messageId, `${oldText}\n🗑 Дела уже нет`);
    return;
  }
  const ev = rows[0];

  if (action === "done") {
    // у повторяющегося дела отмечается только этот экземпляр, само повторяющееся дело продолжает жить
    await db.query(`UPDATE events SET done_at = now() WHERE id=$1`, [eventId]);
    await answerCallbackQuery(cq.id, "Отмечено ✅");
    await editMessageText(chatId, messageId, `${oldText}\n✅ Сделано`);
    return;
  }

  if (action === "later") {
    await answerCallbackQuery(cq.id);
    await editMessageText(chatId, messageId, `${oldText}\n⏰ Отложу напоминание`);
    await sendMessage(chatId, "⏰ Когда напомнить?\nНапиши или надиктуй, например: «через час», «за 3 часа до события», «завтра в 9:00».");
    const ctx = await loadContext(chatId);
    await saveContext(chatId, { ...ctx, last_event_id: ev.id, pending: { type: "snooze", event_id: ev.id } });
    return;
  }

  if (action === "move") {
    await answerCallbackQuery(cq.id);
    await editMessageText(chatId, messageId, `${oldText}\n📅 Переношу…`);
    const forever = ev.recurring_id ? "\n♾ Чтобы перенести все повторы, добавь «навсегда»." : "";
    await sendMessage(
      chatId,
      `📅 На когда перенести «${ev.title}»?\nНапиши или надиктуй, например: «завтра в 11:00» или «на пятницу».${forever}`
    );
    // дальше сообщение пользователя разберёт обычный разбор фразы: «последнее дело» + ожидание нового времени
    const ctx = await loadContext(chatId);
    await saveContext(chatId, { ...ctx, last_event_id: ev.id, pending: { type: "reschedule_time" } });
  }
}

module.exports = { reminderKeyboard, handleReminderButton };
