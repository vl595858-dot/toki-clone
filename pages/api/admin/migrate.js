// ВРЕМЕННЫЙ маршрут: перенос данных из старой базы (Neon) в текущую (Supabase).
// После переноса файл и переменные MIGRATE_TOKEN / OLD_DATABASE_URL удалить.
//   GET  — пробный режим: ничего не пишет, показывает, что будет перенесено
//   POST — настоящий перенос одной транзакцией (повторный запуск дублей не создаёт)
// Доступ: заголовок Authorization: Bearer <MIGRATE_TOKEN>
const crypto = require("crypto");
const { Pool } = require("pg");

const pool = (url) => new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });
const evKey = (e) => `${e.chat_id}|${e.title}|${new Date(e.event_at).toISOString()}`;
const recKey = (r) => [r.chat_id, r.title, r.frequency, r.weekday, r.time, r.month_day, r.month].join("|");

function authorized(req) {
  const want = process.env.MIGRATE_TOKEN;
  if (!want) return false;
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function buildPlan(oldDb, newDb) {
  const [oRec, oEv, oSet] = await Promise.all([
    oldDb.query("SELECT * FROM recurring_events ORDER BY id"),
    oldDb.query("SELECT * FROM events ORDER BY id"),
    oldDb.query("SELECT * FROM user_settings"),
  ]);
  const [nRec, nEv, nSet] = await Promise.all([
    newDb.query("SELECT id, chat_id, title, frequency, weekday, time, month_day, month FROM recurring_events"),
    newDb.query("SELECT chat_id, title, event_at FROM events"),
    newDb.query("SELECT chat_id FROM user_settings"),
  ]);
  const haveRec = new Map(nRec.rows.map((r) => [recKey(r), r.id]));
  const haveEv = new Set(nEv.rows.map(evKey));
  const haveSet = new Set(nSet.rows.map((r) => String(r.chat_id)));
  const now = Date.now();
  return {
    rec: oRec.rows,
    ev: oEv.rows,
    set: oSet.rows,
    haveRec,
    haveEv,
    haveSet,
    now,
    stats: {
      old: { recurring: oRec.rowCount, events: oEv.rowCount, settings: oSet.rowCount },
      new_before: { recurring: nRec.rowCount, events: nEv.rowCount, settings: nSet.rowCount },
      will_add: {
        recurring: oRec.rows.filter((r) => !haveRec.has(recKey(r))).length,
        events: oEv.rows.filter((e) => !haveEv.has(evKey(e))).length,
        settings: oSet.rows.filter((s) => !haveSet.has(String(s.chat_id))).length,
      },
      // уже прошедшие дела переносятся с отметкой «напомнено», чтобы не было лавины напоминаний
      past_events_marked_reminded: oEv.rows.filter((e) => new Date(e.event_at).getTime() <= now).length,
    },
  };
}

async function runPlan(client, p) {
  const recMap = new Map(); // старый id повтора → id в новой базе
  for (const r of p.rec) {
    const k = recKey(r);
    if (p.haveRec.has(k)) {
      recMap.set(r.id, p.haveRec.get(k));
      continue;
    }
    const res = await client.query(
      `INSERT INTO recurring_events (chat_id, title, emoji, weekday, time, remind_offset_minutes, frequency, month_day, month, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [r.chat_id, r.title, r.emoji, r.weekday, r.time, r.remind_offset_minutes, r.frequency, r.month_day, r.month, r.created_at]
    );
    recMap.set(r.id, res.rows[0].id);
  }
  let events = 0;
  for (const e of p.ev) {
    if (p.haveEv.has(evKey(e))) continue;
    const past = new Date(e.event_at).getTime() <= p.now;
    await client.query(
      `INSERT INTO events (chat_id, title, emoji, event_at, remind_at, reminded, created_at, recurring_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [e.chat_id, e.title, e.emoji, e.event_at, e.remind_at, past ? true : e.reminded, e.created_at, e.recurring_id ? recMap.get(e.recurring_id) || null : null]
    );
    events++;
  }
  let settings = 0;
  for (const s of p.set) {
    if (p.haveSet.has(String(s.chat_id))) continue; // в новой базе пояс свежее — не затираем
    await client.query(`INSERT INTO user_settings (chat_id, tz_offset, updated_at) VALUES ($1,$2,$3)`, [s.chat_id, s.tz_offset, s.updated_at]);
    settings++;
  }
  return { recurring: recMap.size, events_inserted: events, settings_inserted: settings };
}

export default async function handler(req, res) {
  if (!process.env.MIGRATE_TOKEN || !process.env.OLD_DATABASE_URL) {
    return res.status(503).json({ error: "Не заданы MIGRATE_TOKEN и/или OLD_DATABASE_URL" });
  }
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).end();

  const oldDb = pool(process.env.OLD_DATABASE_URL);
  const newDb = pool(process.env.DATABASE_URL);
  try {
    const plan = await buildPlan(oldDb, newDb);
    if (req.method === "GET") return res.status(200).json({ mode: "dry-run (ничего не записано)", ...plan.stats });

    const client = await newDb.connect();
    try {
      await client.query("BEGIN");
      const done = await runPlan(client, plan);
      await client.query("COMMIT");
      return res.status(200).json({ mode: "done", ...plan.stats, done });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("migrate error", e.message);
    return res.status(500).json({ error: e.message });
  } finally {
    await Promise.all([oldDb.end(), newDb.end()]).catch(() => {});
  }
}
