const { randomUUID, randomBytes, createHash } = require("node:crypto");
const db = require("./webPlannerDb");
const { config } = require("./webPlannerAuth");
const { limits } = require("./plusPlanLimits");

const hash = (code) => createHash("sha256").update(code).digest("hex");

async function lock(client, userId) {
  await client.query("SELECT pg_advisory_xact_lock(23871, hashtext($1))", [userId]);
}

async function status(client, userId, allowTest = false) {
  const { rows: [row] } = await client.query(
    `SELECT (SELECT max(expires_at) FROM web_plus_access
              WHERE user_id = $1 AND (NOT is_test OR $2) AND expires_at > statement_timestamp()) AS "accessUntil",
            (SELECT count(*)::int FROM web_planner_creations
              WHERE user_id = $1 AND created_at > statement_timestamp() - interval '720 hours') AS used,
            EXISTS (SELECT 1 FROM web_telegram_links WHERE user_id = $1) AS linked`,
    [userId, allowTest],
  );
  return row;
}

async function insertTask(userId, title, date, allowTest) {
  return db.withTransaction(async client => {
    await lock(client, userId);
    const plan = await status(client, userId, allowTest);
    if (!plan.accessUntil && plan.used >= limits.free.event) return false;
    await client.query("INSERT INTO web_planner_tasks(id,user_id,title,due_on) VALUES ($1,$2,$3,$4)",
      [randomUUID(), userId, title, date]);
    await client.query("INSERT INTO web_planner_creations(user_id) VALUES ($1)", [userId]);
    await client.query("DELETE FROM web_planner_creations WHERE user_id = $1 AND created_at <= statement_timestamp() - interval '720 hours'", [userId]);
    return true;
  });
}

const linkEnabled = () => process.env.WEB_TELEGRAM_LINK === "1" && process.env.VERCEL_ENV === "production" && Boolean(config());

async function issueLink(chatId) {
  const code = randomBytes(18).toString("base64url");
  await db.query(`INSERT INTO web_telegram_codes(chat_id,code_hash,expires_at)
    VALUES ($1,$2,statement_timestamp() + interval '10 minutes')
    ON CONFLICT(chat_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at`, [chatId, hash(code)]);
  return code;
}

async function link(userId, code) {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{24}$/.test(code)) return false;
  return db.withTransaction(async client => {
    await lock(client, userId);
    const { rows: [row] } = await client.query(
      "SELECT chat_id FROM web_telegram_codes WHERE code_hash = $1 AND expires_at > statement_timestamp() FOR UPDATE", [hash(code)]);
    if (!row) return false;
    const result = await client.query("INSERT INTO web_telegram_links(user_id,chat_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [userId, row.chat_id]);
    if (!result.rowCount) return false;
    await client.query("DELETE FROM web_telegram_codes WHERE chat_id = $1", [row.chat_id]);
    return true;
  });
}

async function unlink(userId) {
  await db.withTransaction(async client => {
    await lock(client, userId);
    await client.query("DELETE FROM web_telegram_links WHERE user_id = $1", [userId]);
  });
}

async function botAccess(chatId) {
  if (!linkEnabled()) return null;
  const { rows: [row] } = await db.query(
    `SELECT a.expires_at FROM web_telegram_links l JOIN web_plus_access a USING (user_id)
     WHERE l.chat_id = $1 AND NOT a.is_test AND a.expires_at > statement_timestamp()`, [chatId]);
  return row?.expires_at || null;
}

module.exports = { lock, status, insertTask, linkEnabled, issueLink, link, unlink, botAccess };
