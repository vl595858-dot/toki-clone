const { randomBytes, createHash } = require("node:crypto");
const db = require("./db");
const { config: paymentConfig } = require("./plusPayments");
const { durationDays } = require("./plusPricing");
const { limits } = require("./plusPlanLimits");

const promoDurations = { month: durationDays, year: 365 };
const CODE_PATTERN = /^PLUS-[A-F0-9]{24}$/;

function hash(code) {
  return createHash("sha256").update(code).digest("hex");
}

async function lock(client, chatId) {
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [chatId]);
}

async function activeAccess(client, chatId) {
  const { rows: [access] } = await client.query(
    "SELECT expires_at FROM plus_access WHERE chat_id = $1 AND expires_at > statement_timestamp()",
    [chatId],
  );
  const test = paymentConfig();
  if (test?.userId !== String(chatId)) return { accessUntil: access?.expires_at || null, isTest: false };
  const { rows: [payment] } = await client.query(
    "SELECT max(access_until) AS expires_at FROM plus_test_orders WHERE telegram_user_id = $1 AND access_until > statement_timestamp()",
    [chatId],
  );
  const testExpiry = payment.expires_at;
  if (testExpiry && (!access || testExpiry > access.expires_at)) return { accessUntil: testExpiry, isTest: true };
  return { accessUntil: access?.expires_at || null, isTest: false };
}

async function usage(client, chatId) {
  const { rows } = await client.query(
    `SELECT action, SUM(units)::int AS used FROM plus_usage
     WHERE chat_id = $1 AND occurred_at > statement_timestamp() - interval '720 hours'
     GROUP BY action`,
    [chatId],
  );
  return Object.fromEntries(rows.map(({ action, used }) => [action, used]));
}

function enabled() {
  return process.env.PLUS_PLANS_ENABLED === "1";
}

async function planStatus(chatId) {
  return db.withTransaction(async client => {
    await lock(client, chatId);
    return { ...await activeAccess(client, chatId), used: enabled() ? await usage(client, chatId) : {} };
  });
}

async function issuePromo(adminId, days, maxUses = 1) {
  const code = `PLUS-${randomBytes(12).toString("hex").toUpperCase()}`;
  await db.query("INSERT INTO plus_promo_codes (code_hash, issued_by, duration_days, max_uses) VALUES ($1, $2, $3, $4)",
    [hash(code), adminId, days, maxUses]);
  return code;
}

async function redeemPromo(chatId, code) {
  const normalized = code.trim().toUpperCase();
  if (!CODE_PATTERN.test(normalized)) return { status: "unavailable" };
  return db.withTransaction(async client => {
    await lock(client, chatId);
    const codeHash = hash(normalized);
    const { rows: [promo] } = await client.query(
      `SELECT duration_days, uses, max_uses, expires_at > statement_timestamp() AS valid
       FROM plus_promo_codes WHERE code_hash = $1 FOR UPDATE`,
      [codeHash],
    );
    if (!promo) return { status: "unavailable" };
    const { rows: [redemption] } = await client.query(
      "SELECT granted_until FROM plus_promo_redemptions WHERE code_hash = $1 AND chat_id = $2",
      [codeHash, chatId],
    );
    if (redemption) return { status: "already", accessUntil: redemption.granted_until };
    if (!promo.valid || promo.uses >= promo.max_uses) return { status: "unavailable" };

    const { rows: [{ expires_at: accessUntil }] } = await client.query(
      `INSERT INTO plus_access (chat_id, expires_at)
       VALUES ($1, statement_timestamp() + $2::int * interval '24 hours')
       ON CONFLICT (chat_id) DO UPDATE
       SET expires_at = greatest(plus_access.expires_at, statement_timestamp()) + $2::int * interval '24 hours'
       RETURNING expires_at`,
      [chatId, promo.duration_days],
    );
    await client.query(
      "INSERT INTO plus_promo_redemptions (code_hash, chat_id, granted_until) VALUES ($1, $2, $3)",
      [codeHash, chatId, accessUntil],
    );
    await client.query("UPDATE plus_promo_codes SET uses = uses + 1 WHERE code_hash = $1", [codeHash]);
    return { status: "granted", accessUntil, days: promo.duration_days };
  });
}

async function charge(chatId, action, units = 1, client) {
  if (!enabled()) return { allowed: true };
  if (!client) return db.withTransaction(tx => charge(chatId, action, units, tx));
  await lock(client, chatId);
  const { accessUntil } = await activeAccess(client, chatId);
  const limit = limits[accessUntil ? "plus" : "free"][action];
  const used = (await usage(client, chatId))[action] || 0;
  if (used + units > limit) return { allowed: false };

  await client.query(
    "DELETE FROM plus_usage WHERE chat_id = $1 AND action = $2 AND occurred_at <= statement_timestamp() - interval '720 hours'",
    [chatId, action],
  );
  const { rows: [{ id }] } = await client.query(
    "INSERT INTO plus_usage (chat_id, action, units) VALUES ($1, $2, $3) RETURNING id",
    [chatId, action, units],
  );
  return { allowed: true, id };
}

async function release(chatId, id) {
  if (id) await db.query("DELETE FROM plus_usage WHERE chat_id = $1 AND id = $2", [chatId, id]);
}

async function createEvents(chatId, units, insert) {
  if (!enabled()) return insert(db);
  return db.withTransaction(async client => {
    const { allowed } = await charge(chatId, "event", units, client);
    return allowed ? insert(client) : null;
  });
}

module.exports = { promoDurations, enabled, planStatus, issuePromo, redeemPromo, charge, release, createEvents };
