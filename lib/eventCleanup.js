const db = require('./db');

// Retention is measured from the scheduled event instant, including completed
// events and past instances of series. Never delete the recurrence templates.
async function cleanupOldEvents() {
  const result = await db.query(`DELETE FROM events WHERE event_at < now() - interval '30 days'`);
  return result.rowCount || 0;
}

module.exports = { cleanupOldEvents };
