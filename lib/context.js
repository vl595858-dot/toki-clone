const db = require("./db");

// Сколько живёт память диалога с момента последнего сообщения в чате
const TTL_MINUTES = 60;

/* Возвращает сохранённый контекст чата или {} (если его нет / он устарел / база недоступна) */
async function loadContext(chatId) {
  try {
    const { rows } = await db.query(
      `SELECT context FROM chat_context
       WHERE chat_id = $1 AND updated_at >= now() - interval '${TTL_MINUTES} minutes'`,
      [chatId]
    );
    return rows.length ? rows[0].context || {} : {};
  } catch (e) {
    console.error("loadContext error", e);
    return {};
  }
}

/* Сохраняет контекст целиком и обновляет время (срок жизни отсчитывается заново) */
async function saveContext(chatId, ctx) {
  try {
    await db.query(
      `INSERT INTO chat_context (chat_id, context, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (chat_id) DO UPDATE SET context = EXCLUDED.context, updated_at = now()`,
      [chatId, JSON.stringify(ctx)]
    );
  } catch (e) {
    console.error("saveContext error", e);
  }
}

module.exports = { loadContext, saveContext, TTL_MINUTES };
