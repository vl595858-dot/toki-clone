const db = require("./db");

const FALLBACK_TZ = process.env.DEFAULT_TZ_OFFSET || "+03:00";

/* Часовой пояс конкретного чата. Если настройки ещё нет — отдаёт общий дефолт. */
async function getTzOffset(chatId) {
  try {
    const { rows } = await db.query(`SELECT tz_offset FROM user_settings WHERE chat_id=$1`, [chatId]);
    return rows.length ? rows[0].tz_offset : FALLBACK_TZ;
  } catch (e) {
    console.error("getTzOffset error", e);
    return FALLBACK_TZ;
  }
}

/* Сохраняет часовой пояс чата (вручную через /timezone или автоматически из приложения-календаря) */
async function setTzOffset(chatId, offset) {
  await db.query(
    `INSERT INTO user_settings (chat_id, tz_offset, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (chat_id) DO UPDATE SET tz_offset = EXCLUDED.tz_offset, updated_at = now()`,
    [chatId, offset]
  );
}

module.exports = { getTzOffset, setTzOffset, FALLBACK_TZ };
