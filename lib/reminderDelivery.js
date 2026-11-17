const db = require("./db");

// Держим блокировку до подтверждения отправки и фиксации отметки.
// При отказе или исключении отметка остаётся FALSE для следующего запуска.
async function deliverReminder(id, column, send) {
  if (!["reminded", "reminded2"].includes(column)) throw new Error("Invalid reminder column");
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM events WHERE id = $1 AND ${column} = FALSE AND done_at IS NULL
       FOR UPDATE SKIP LOCKED`,
      [id]
    );
    if (!rows.length || !await send(rows[0])) return false;
    await client.query(`UPDATE events SET ${column} = TRUE WHERE id = $1`, [id]);
    return true;
  });
}

module.exports = { deliverReminder };
