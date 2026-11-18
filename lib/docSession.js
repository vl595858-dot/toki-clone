// A consumed step and its event inserts commit together. Telegram calls run after commit.
const db = require('./db');
const { randomBytes } = require('crypto');
let ready;
async function ensure() {
  if (!ready) ready = db.query(`CREATE TABLE IF NOT EXISTS document_steps (
    token TEXT PRIMARY KEY, chat_id BIGINT NOT NULL, payload JSONB NOT NULL,
    consumed BOOLEAN NOT NULL DEFAULT FALSE, expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '60 minutes'
  )`).then(() => db.query('ALTER TABLE document_steps ENABLE ROW LEVEL SECURITY'))
    .then(() => db.query('CREATE INDEX IF NOT EXISTS document_steps_expiry_idx ON document_steps (expires_at)')).catch(e => { ready = null; throw e; });
  await ready;
}
async function transaction(chatId, fn) {
  await ensure();
  // Expired snapshots contain document details and are no longer needed.
  await db.query('DELETE FROM document_steps WHERE expires_at <= now()');
  const effects = [];
  const result = await db.withTransaction(async client => {
    await client.query(`INSERT INTO chat_context (chat_id, context) VALUES ($1, '{}'::jsonb) ON CONFLICT (chat_id) DO NOTHING`, [chatId]);
    const { rows } = await client.query('SELECT context FROM chat_context WHERE chat_id=$1 FOR UPDATE', [chatId]);
    const tx = { client, ctx: rows[0].context, effects };
    return fn(tx);
  });
  for (const effect of effects) {
    try { await effect(); } catch (e) { console.error('document response failed', e); }
  }
  return result;
}
async function setPending(chatId, pending, tx) {
  if (!tx) return transaction(chatId, t => setPending(chatId, pending, t));
  if (tx.ctx.pending?.type === 'doc' && tx.ctx.pending.token) {
    await tx.client.query('UPDATE document_steps SET consumed=TRUE WHERE token=$1 AND chat_id=$2', [tx.ctx.pending.token, chatId]);
  }
  if (pending) {
    pending = { ...pending, token: randomBytes(12).toString('hex') };
    await tx.client.query('INSERT INTO document_steps (token, chat_id, payload) VALUES ($1,$2,$3::jsonb)', [pending.token, chatId, JSON.stringify(pending)]);
  }
  tx.ctx = { ...tx.ctx, pending };
  await tx.client.query('UPDATE chat_context SET context=$2::jsonb, updated_at=now() WHERE chat_id=$1', [chatId, JSON.stringify(tx.ctx)]);
  return pending;
}
async function useStep(chatId, token, accepts, fn) {
  if (!token) return false;
  return transaction(chatId, async tx => {
    if (tx.ctx.pending?.type !== 'doc' || tx.ctx.pending.token !== token) return false;
    const { rows } = await tx.client.query(`SELECT payload FROM document_steps WHERE token=$1 AND chat_id=$2 AND consumed=FALSE AND expires_at > now()`, [token, chatId]);
    const p = rows[0]?.payload;
    if (!p || !accepts(p)) return false;
    await tx.client.query('UPDATE document_steps SET consumed=TRUE WHERE token=$1 AND chat_id=$2', [token, chatId]);
    await fn(tx, p);
    return true;
  });
}
const emit = (tx, fn) => tx.effects.push(fn);
module.exports = { transaction, setPending, useStep, emit };
