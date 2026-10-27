// Защита от повторной обработки одного и того же сообщения Telegram (повтор вебхука при медленном ответе).
const db = require("./db");

let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await db.query(
    `CREATE TABLE IF NOT EXISTS processed_updates (
       update_id BIGINT PRIMARY KEY,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  tableReady = true;
}

// true — обработку можно начинать; false — это повтор, пока первая попытка ещё идёт
async function claimUpdate(updateId) {
  if (!Number.isFinite(updateId)) return true;
  try {
    await ensureTable();
    // если первая попытка оборвалась (лимит 10 с) и Telegram повторил позже 15 с — даём обработать заново
    const r = await db.query(
      `INSERT INTO processed_updates (update_id) VALUES ($1)
       ON CONFLICT (update_id) DO UPDATE SET created_at = now()
         WHERE processed_updates.created_at < now() - interval '15 seconds'
       RETURNING update_id`,
      [updateId]
    );
    if (Math.random() < 0.02) {
      await db.query(`DELETE FROM processed_updates WHERE created_at < now() - interval '1 day'`);
    }
    return r.rowCount > 0;
  } catch (e) {
    console.error("dedupe error", e.message); // при сбое проверки лучше обработать, чем потерять сообщение
    return true;
  }
}

module.exports = { claimUpdate };
