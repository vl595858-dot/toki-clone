const { sendMessage } = require("../telegram");
const { linkEnabled, issueLink } = require("../webPlanner");

async function handleWebKey(message) {
  const { chat, from } = message;
  if (chat.type !== "private" || String(chat.id) !== String(from?.id)) return;
  if (!linkEnabled()) {
    await sendMessage(chat.id, "Привязка к веб-аккаунту пока недоступна.");
    return;
  }
  const code = await issueLink(chat.id);
  await sendMessage(chat.id, `Код привязки твоего Telegram-аккаунта:\n\n${code}\n\nВведи его в своём веб-кабинете. Код действует 10 минут. Храни его у себя.`);
}

module.exports = { handleWebKey };
