const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file, mocks, globals = {}) {
  const filename = path.resolve(__dirname, '..', file);
  const module = { exports: {} };
  const source = fs.readFileSync(filename, 'utf8').replace('export default async function handler', 'module.exports = async function handler');
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require: name => {
      if (!(name in mocks)) throw new Error(`Unexpected dependency: ${name}`);
      return mocks[name];
    },
    console: { error() {} }, process: { env: { CRON_SECRET: 'test' } }, AbortSignal,
    ...globals,
  }, { filename });
  return module.exports;
}

function fixture(count = 1, clock = Date) {
  const rows = Array.from({length: count}, (_, i) => ({
    id: i + 1, chat_id: i + 1, title: 'Test', reminded: false, reminded2: false,
    remind_at: new Date(Date.now() - 60000).toISOString(),
    event_at: new Date(Date.now() + 3600000).toISOString(), done_at: null,
  }));
  const locks = new Set();
  const calls = [];
  let releases = 0;
  let commits = 0;
  let rollbacks = 0;
  const state = { rows, locks, calls, contextsFail: false, timezoneFail: null, dayBefore: false,
    response: async () => ({ ok: true, status: 200, json: async () => ({ok: true}) }) };
  const pool = {
    async query(sql) {
      if (sql.includes('SELECT * FROM recurring_events')) return {rows: []};
      if (sql.includes('JOIN recurring_events')) return {rows: state.dayBefore ? rows.filter(r => !r.reminded2) : []};
      if (sql.includes('SELECT * FROM events')) return { rows: rows.filter(r => !r.reminded && !r.done_at).map(r => ({...r})) };
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    async connect() {
      let locked;
      let update;
      return {
        async query(sql, args) {
          if (sql === 'BEGIN') return {};
          if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            if (sql === 'COMMIT') { commits++; if (update) rows.find(r => r.id === update.id)[update.column] = true; }
            else rollbacks++;
            if (locked !== undefined) locks.delete(locked);
            return {};
          }
          const column = sql.includes('reminded2') ? 'reminded2' : 'reminded';
          const row = rows.find(r => r.id === args[0]);
          if (sql.startsWith('SELECT')) {
            assert.match(sql, /FOR UPDATE SKIP LOCKED/);
            if (!row || row[column] || row.done_at || row.remind_at == null || locks.has(row.id)) return {rows: []};
            locks.add(row.id); locked = row.id;
            return {rows: [{...row}]};
          }
          assert.match(sql, /^UPDATE events SET reminded2? = TRUE/);
          assert.ok(locks.has(row.id));
          update = {id: row.id, column};
          return {};
        },
        release() { releases++; },
      };
    },
  };
  const db = load('lib/db.js', {pg: {Pool: function () { return pool; }}});
  const telegram = load('lib/telegram.js', {}, {fetch: async (url, options) => {
    assert.ok(options.signal, 'Telegram requests must have a timeout');
    const body = JSON.parse(options.body);
    calls.push(body);
    assert.equal(rows.find(r => r.chat_id === body.chat_id)[state.dayBefore ? 'reminded2' : 'reminded'], false, 'must not mark before Telegram acknowledges');
    return state.response(body);
  }});
  const delivery = load('lib/reminderDelivery.js', {'./db': db});
  const time = require('../lib/time');
  const dayBefore = load('lib/dayBefore.js', {'./db': db, './telegram': telegram, './time': time, './reminderDelivery': delivery}, {Date: clock});
  const handler = load('pages/api/cron/reminders.js', {
    '../../../lib/db': db, '../../../lib/telegram': telegram, '../../../lib/time': time,
    '../../../lib/settings': {getTzOffset: async id => { if (id === state.timezoneFail) throw new Error('timezone failed'); return '+05:00'; }},
    '../../../lib/context': {loadContext: async () => { if (state.contextsFail) throw new Error('context failed'); return {}; }, saveContext: async () => {}},
    '../../../lib/handlers/reminderButtons': {reminderKeyboard: () => ({inline_keyboard: []})},
    '../../../lib/dayBefore': dayBefore, '../../../lib/reminderDelivery': delivery,
    '../../../lib/reminderSettings': require('../lib/reminderSettings'),
  });
  state.run = async () => {
    let status;
    let body;
    await handler({headers: {authorization: 'Bearer test'}}, {status(code) {status = code; return this;}, json(value) {body = value;}});
    assert.equal(status, 200, JSON.stringify(body));
    return body;
  };
  state.dayBeforeRun = () => dayBefore.sendDayBeforeReminders(async () => '+05:00');
  state.stats = () => ({releases, commits, rollbacks});
  return state;
}

test('successful Telegram confirmation marks sent and prevents a later resend', async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.rows[0].reminded, true);
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.stats().releases, 1);
});

for (const failure of ['http', 'api', 'network', 'invalid-json']) {
  test(`${failure} failure stays pending, other reminder succeeds, next run retries`, async () => {
    const f = fixture(2);
    f.response = async body => {
      if (body.chat_id === 2) return {ok: true, status: 200, json: async () => ({ok: true})};
      if (failure === 'network') throw new Error('connection reset');
      return {ok: failure !== 'http', status: failure === 'http' ? 429 : 200,
        json: async () => { if (failure === 'invalid-json') throw new Error('invalid JSON'); return {ok: false, description: 'temporary failure'}; }};
    };
    await f.run();
    assert.equal(f.rows[0].reminded, false);
    assert.equal(f.rows[1].reminded, true);
    assert.equal(f.locks.size, 0);
    f.response = async () => ({ok: true, status: 200, json: async () => ({ok: true})});
    await f.run();
    assert.equal(f.rows[0].reminded, true);
    assert.deepEqual(f.calls.map(c => c.chat_id), [1, 2, 1]);
  });
}

test('two overlapping cron runs send a reminder only once', async () => {
  const f = fixture();
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  f.response = async () => { started(); await new Promise(resolve => { release = resolve; }); return {ok: true, status: 200, json: async () => ({ok: true})}; };
  const first = f.run();
  await ready;
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.rows[0].reminded, false);
  release();
  await first;
  assert.equal(f.rows[0].reminded, true);
  assert.equal(f.locks.size, 0);
});

test('context failure after delivery does not reset sent or stop the batch', async () => {
  const f = fixture(2);
  f.contextsFail = true;
  await f.run();
  await f.run();
  assert.ok(f.rows.every(r => r.reminded));
  assert.equal(f.calls.length, 2);
});

test('pre-send failure releases transaction and allows remaining reminders', async () => {
  const f = fixture(2);
  f.timezoneFail = 1;
  await f.run();
  assert.equal(f.rows[0].reminded, false);
  assert.equal(f.rows[1].reminded, true);
  assert.equal(f.stats().rollbacks, 1);
  assert.equal(f.stats().releases, 2);
  f.timezoneFail = null;
  await f.run();
  assert.equal(f.rows[0].reminded, true);
});

test('day-before reminders also retry failures and serialize overlapping runs', async () => {
  const now = Date.parse('2099-11-22T13:00:00Z');
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const f = fixture(1, FixedDate);
  f.dayBefore = true;
  f.rows[0].event_at = '2099-11-23T10:00:00Z';
  f.response = async () => ({ok: false, status: 503, json: async () => ({ok:false})});
  assert.equal(await f.dayBeforeRun(), 0);
  assert.equal(f.rows[0].reminded2, false);
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  f.response = async () => {
    started();
    await new Promise(resolve => { release = resolve; });
    return {ok: true, status: 200, json: async () => ({ok:true})};
  };
  const first = f.dayBeforeRun();
  await ready;
  assert.equal(await f.dayBeforeRun(), 0);
  assert.equal(f.rows[0].reminded2, false);
  release();
  assert.equal(await first, 1);
  assert.equal(f.rows[0].reminded2, true);
  assert.equal(f.calls.length, 2);
});

// Legacy disabled rows may still have reminded2=FALSE after an old cancellation.
test('disabled legacy birthday never sends either notification', async () => {
  const now = Date.parse('2099-11-22T13:00:00Z');
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const f = fixture(1, FixedDate);
  f.rows[0].event_at = '2099-11-23T10:00:00Z';
  f.dayBefore = true;
  f.rows[0].remind_at = null;
  f.rows[0].reminded2 = false;
  await f.run();
  assert.equal(f.calls.length, 0);
  assert.equal(f.rows[0].reminded, false);
  assert.equal(f.rows[0].reminded2, false);
});
