const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const settings = require('../lib/reminderSettings');
const root = path.resolve(__dirname, '..');

// Runs real handlers and SQL construction against an in-memory service substitute.
function fixture() {
  const state = { events: [], templates: [], ctx: {}, replies: [], queries: [], model: {}, text: '', voice: false };
  let nextId = 1;
  function matches(row, where, args) {
    for (const match of where.matchAll(/(?:\w+\.)?(id|chat_id|recurring_id)\s*=\s*\$(\d+)/g)) {
      if (row[match[1]] !== args[Number(match[2]) - 1]) return false;
    }
    if (/remind_at IS NOT NULL/.test(where) && row.remind_at == null) return false;
    if (/reminded = FALSE/.test(where) && row.reminded) return false;
    if (/done_at IS NULL/.test(where) && row.done_at != null) return false;
    if (/remind_at <= now\(\)/.test(where) && (row.remind_at == null || Date.parse(row.remind_at) > Date.now())) return false;
    if (/event_at <= now\(\) \+ interval '3 days'/.test(where) && Date.parse(row.event_at) > Date.now() + 3 * 86400000) return false;
    return true;
  }
  const db = {async query(sql, args = []) {
    state.queries.push({sql, args});
    if (sql.startsWith('SELECT t.* FROM recurring_events t JOIN events')) {
      const ev = state.events.find(e => e.id === args[0]);
      return {rows: state.templates.filter(t => t.id === ev?.recurring_id).map(t => ({...t}))};
    }
    const table = /(?:FROM|INTO|UPDATE)\s+(recurring_events|events)/.exec(sql)?.[1];
    if (!table) throw new Error(`Unhandled query ${sql}`);
    const store = table === 'events' ? state.events : state.templates;
    if (sql.startsWith('SELECT')) {
      const where = sql.split('WHERE')[1] || '';
      let rows = store.filter(r => matches(r, where, args)).map(r => ({...r}));
      if (/ORDER BY event_at DESC/.test(sql)) rows.sort((a, b) => Date.parse(b.event_at) - Date.parse(a.event_at));
      else if (/ORDER BY event_at ASC/.test(sql)) rows.sort((a, b) => Date.parse(a.event_at) - Date.parse(b.event_at));
      return {rows};
    }
    if (sql.startsWith('INSERT')) {
      const columns = sql.match(/\(([^)]+)\)\s+VALUES/)[1].split(',').map(s => s.trim());
      const values = sql.match(/VALUES\s*\(([^)]+)\)/)[1].split(',').map(s => s.trim());
      const row = {id: nextId++, reminded: false, reminded2: false, done_at: null};
      columns.forEach((column, i) => {row[column] = values[i] === 'TRUE' ? true : args[Number(values[i].slice(1)) - 1];});
      store.push(row);
      return {rows: [{id: row.id}]};
    }
    const where = sql.split('WHERE')[1];
    if (sql.startsWith('DELETE')) {
      for (let i = store.length - 1; i >= 0; i--) if (matches(store[i], where, args)) store.splice(i, 1);
      return {rows: []};
    }
    assert.ok(sql.startsWith('UPDATE'), sql);
    for (const row of store.filter(r => matches(r, where, args))) {
      const previous = {...row};
      const assignments = sql.split(' SET ')[1].split(' WHERE')[0].split(',');
      for (const assignment of assignments) {
        const [column, ...pieces] = assignment.trim().split('=');
        const value = pieces.join('=').trim();
        row[column.trim()] = value.startsWith('$') ? args[Number(value.slice(1)) - 1]
          : value === 'NULL' ? null : value === 'FALSE' ? false : value === 'TRUE' ? true
          : value.startsWith('CASE WHEN remind_at IS NULL') ? previous.remind_at == null ? false : previous.reminded2
          : (() => {throw new Error(`Unhandled assignment ${value}`);})();
      }
    }
    return {rows: []};
  }};
  const telegram = {sendMessage: async (id, text) => {state.replies.push(text); return true;}};
  const cache = new Map();
  const mocks = new Map([
    ['lib/db.js', db], ['lib/telegram.js', telegram],
    ['lib/context.js', {loadContext: async () => state.ctx, saveContext: async (id, ctx) => {state.ctx = ctx;}}],
    ['lib/settings.js', {getTzOffset: async () => '+00:00'}],
    ['lib/ai.js', {transcribeVoice: async () => state.text, parseMessage: async () => ({...state.model})}],
    ['lib/contextText.js', {buildContextText: async () => ''}],
    ['lib/handlers/eventTarget.js', {
      resolveTarget: async () => ({target: state.events.find(e => e.id === state.ctx.last_event_id) || state.events[0], matches: []}),
      titleWordGroups: t => [[t]], titleScore: (a, b) => a === b ? 1 : 0,
      askWhich: async () => {throw new Error('Unexpected ambiguity');}, replyNotFound: async () => {throw new Error('Target missing');},
    }],
    ['pages/api/webapp/_auth.js', {requireTelegramUser: () => 1}],
  ]);
  function load(relative) {
    if (mocks.has(relative)) return mocks.get(relative);
    if (cache.has(relative)) return cache.get(relative).exports;
    const filename = path.join(root, relative);
    const module = {exports: {}};
    cache.set(relative, module);
    let source = fs.readFileSync(filename, 'utf8')
      .replace('export const config', 'const config').replace('export const maxDuration', 'const maxDuration')
      .replace('export default async function handler', 'module.exports = async function handler');
    if (relative === 'pages/api/telegram/[secret].js') source += '\nmodule.exports.runUpdate = handleUpdate;';
    vm.runInNewContext(source, {module, exports: module.exports, console, process, AbortSignal,
      require: name => name.startsWith('.') ? load(path.relative(root, path.resolve(path.dirname(filename), name)) + '.js') : require(name),
    }, {filename});
    return module.exports;
  }
  state.load = load;
  state.send = async (text, model, voice = false) => {
    state.text = text; state.model = model;
    await load('pages/api/telegram/[secret].js').runUpdate({message: {chat: {id: 1}, ...(voice ? {voice: {file_id: 'mock'}} : {text})}});
  };
  state.api = async (method, body, id) => {
    let status, response;
    const res = {status(code) {status = code; return this;}, json(value) {response = value;}, end() {}};
    await load(`pages/api/webapp/events/${id ? '[id]' : 'index'}.js`)({method, body, query: {id, from: '2099-01-01', to: '2100-01-01'}}, res);
    return {status, response};
  };
  state.seed = offset => {
    const event = {id: nextId++, chat_id: 1, title: 'Встреча', event_at: '2099-05-05T12:00:00.000Z',
      remind_at: settings.reminderAt('2099-05-05T12:00:00.000Z', offset), reminded: true, reminded2: true, done_at: null};
    state.events.push(event); state.ctx.last_event_id = event.id;
    return event;
  };
  state.cron = async () => {
    let status;
    await load('pages/api/cron/reminders.js')({headers: {authorization: `Bearer ${process.env.CRON_SECRET}`}},
      {status(code) {status = code; return this;}, json() {}});
    assert.equal(status, 200);
  };
  return state;
}

const create = {intent: 'create_event', title: 'Встреча', event_date: '2099-05-05', event_time: '12:00', remind_offset_minutes: 600};
const move = {intent: 'reschedule_event', event_date: '2099-05-06', event_time: '14:00', remind_offset_minutes: 600};

test('command distinguishes off, at event, interval, zero, and unspecified', () => {
  assert.equal(settings.commandOffset('не напоминай за час'), -1);
  assert.equal(settings.commandOffset('без напоминаний'), -1);
  assert.equal(settings.commandOffset('напомни в момент события'), 0);
  assert.equal(settings.commandOffset('за 0 минут'), 0);
  assert.equal(settings.commandOffset('за 30 минут'), 30);
  assert.equal(settings.commandOffset('перенеси на завтра'), undefined);
});

for (const voice of [false, true]) {
  const mode = voice ? 'voice' : 'text';
  test(`${mode}: creation respects off, at event, interval, and default despite model values`, async () => {
    for (const [suffix, expected] of [['не напоминай', -1], ['без напоминаний', -1], ['напомни в момент события', 0], ['напомни за 30 минут', 30], ['', 60]]) {
      const f = fixture();
      await f.send(`Создай встречу 5 мая в 12:00 ${suffix}`, create, voice);
      assert.equal(settings.eventOffset(f.events[0]), expected, suffix);
      if (expected === -1) assert.match(f.replies.at(-1), /отключены/);
    }
  });
  test(`${mode}: move preserves legacy off, at-event and interval, and honors explicit replacement`, async () => {
    for (const offset of [-1, 0, 95]) {
      const f = fixture(); const ev = f.seed(offset);
      await f.send('перенеси на завтра в 14:00', move, voice);
      assert.equal(settings.eventOffset(ev), offset);
      assert.equal(ev.reminded, false);
      assert.equal(ev.reminded2, false);
      await f.send('перенеси на завтра в 14:00, напомни за 30 минут', move, voice);
      assert.equal(settings.eventOffset(ev), 30);
      await f.send('перенеси на завтра в 14:00, не напоминай', move, voice);
      assert.equal(settings.eventOffset(ev), -1);
      await f.send('перенеси на завтра в 14:00, напомни в момент события', move, voice);
      assert.equal(settings.eventOffset(ev), 0);
    }
  });
  test(`${mode}: cancel birthday disables both and explicit setting can enable again`, async () => {
    const f = fixture(); const ev = f.seed(10080); ev.recurring_id = 10; ev.reminded2 = false;
    f.templates.push({id: 10, chat_id: 1, day_before: true});
    await f.send('не напоминай', {intent: 'cancel_reminder', refers_to_last: true}, voice);
    assert.equal(ev.remind_at, null);
    const {sendDayBeforeReminders} = f.load('lib/dayBefore.js');
    assert.equal(await sendDayBeforeReminders(async () => '+00:00'), 0);
    await f.send('напомни за 20 минут', {intent: 'set_reminder', refers_to_last: true}, voice);
    assert.equal(settings.eventOffset(ev), 20);
    assert.equal(ev.reminded2, false);
  });
  test(`${mode}: rename changes title alone for disabled or delivered records`, async () => {
    for (const offset of [-1, 0, 60]) {
      const f = fixture(); const ev = f.seed(offset);
      const before = {...ev};
      await f.send('переименуй в «Новое название»', {intent: 'rename_event'}, voice);
      assert.equal(ev.title, 'Новое название');
      assert.deepEqual({...ev, title: before.title}, before);
    }
  });
}

test('calendar creates all states and returns the offset for editing', async () => {
  const f = fixture();
  for (const [value, expected] of [[undefined, 60], [null, -1], [-1, -1], [0, 0], [35, 35]]) {
    const result = await f.api('POST', {title: 'Календарь', date: '2099-05-05', time: '12:00', remindOffsetMinutes: value});
    assert.equal(result.status, 200);
    assert.equal(settings.eventOffset(f.events.at(-1)), expected);
  }
  const {response} = await f.api('GET');
  assert.deepEqual(Array.from(response.events, e => e.remindOffsetMinutes), [60, -1, -1, 0, 35]);
});

test('calendar move preserves all states; title-only patch preserves delivery flags', async () => {
  for (const offset of [-1, 0, 95]) {
    const f = fixture(); const ev = f.seed(offset);
    assert.equal((await f.api('PATCH', {title: 'Новое'}, ev.id)).status, 200);
    assert.equal(settings.eventOffset(ev), offset);
    assert.equal(ev.reminded, true); assert.equal(ev.reminded2, true);
    assert.equal((await f.api('PATCH', {date: '2099-05-06'}, ev.id)).status, 200);
    assert.equal(settings.eventOffset(ev), offset);
    assert.equal(ev.reminded, false); assert.equal(ev.reminded2, false);
    await f.api('PATCH', {remindOffsetMinutes: null}, ev.id);
    assert.equal(ev.remind_at, null);
    await f.api('PATCH', {remindOffsetMinutes: 0}, ev.id);
    assert.equal(settings.eventOffset(ev), 0);
    await f.api('PATCH', {remindOffsetMinutes: 30}, ev.id);
    assert.equal(settings.eventOffset(ev), 30);
  }
});

test('calendar rejects invalid reminder values without modifying the event', async () => {
  const f = fixture(); const ev = f.seed(-1);
  for (const value of [-2, '60', 1.5]) {
    assert.equal((await f.api('PATCH', {remindOffsetMinutes: value}, ev.id)).status, 400);
    assert.equal(ev.remind_at, null);
    assert.equal((await f.api('POST', {title: 'x', date: '2099-01-01', remindOffsetMinutes: value})).status, 400);
  }
  assert.equal(f.events.length, 1);
});

test('birthday created disabled stays disabled on regeneration, series move, and rename', async () => {
  const f = fixture();
  await f.send('День рождения 5 мая каждый год, не напоминай', {intent: 'create_recurring_event', title: 'День рождения', recurring_frequency: 'yearly', recurring_month: 5, recurring_month_day: 5});
  const tpl = f.templates[0];
  assert.equal(tpl.remind_offset_minutes, -1);
  assert.equal(tpl.day_before, true);
  assert.ok(f.events.every(ev => ev.remind_at === null));
  f.events.splice(1);
  await f.cron();
  assert.equal(f.events.length, 8);
  assert.ok(f.events.every(ev => ev.remind_at === null));
  await f.send('перенеси на 6 мая в 14:00 навсегда', {...move, event_date: '2099-05-06'});
  assert.equal(tpl.remind_offset_minutes, -1);
  assert.ok(f.events.every(ev => ev.remind_at === null));
  f.ctx.last_event_id = f.events[0].id;
  await f.send('переименуй в «Праздник»', {intent: 'rename_event'});
  assert.equal(tpl.title, 'Праздник');
  assert.ok(f.events.every(ev => ev.remind_at === null));
  await f.send('перенеси на 7 мая в 14:00 навсегда, напомни за час', {...move, event_date: '2099-05-07'});
  assert.equal(tpl.remind_offset_minutes, 60);
  assert.ok(f.events.every(ev => settings.eventOffset(ev) === 60));
});

test('series move preserves disabled and custom intervals of existing occurrences', async () => {
  const f = fixture(); const ev = f.seed(-1); ev.recurring_id = 10;
  const second = f.seed(95); second.recurring_id = 10; second.event_at = '2099-05-06T12:00:00.000Z'; second.remind_at = settings.reminderAt(second.event_at, 95);
  f.ctx.last_event_id = ev.id;
  f.templates.push({id: 10, chat_id: 1, title: 'Встреча', frequency: 'daily', time: '12:00', remind_offset_minutes: 60});
  await f.send('перенеси в 14:00 навсегда', move);
  assert.equal(settings.eventOffset(f.events[0]), -1);
  assert.equal(settings.eventOffset(f.events[1]), 95);
  assert.equal(settings.eventOffset(f.events[2]), 60);
});

test('reminder setting survives the question asking for reschedule time', async () => {
  const f = fixture(); const ev = f.seed(60);
  await f.send('перенеси встречу, не напоминай', {intent: 'reschedule_event'});
  assert.equal(f.ctx.pending.type, 'reschedule_time');
  assert.equal(f.ctx.pending.reminder_disabled, true);
  await f.send('завтра в 14:00', move);
  assert.equal(ev.remind_at, null);
});

test('document reminder dialogue accepts disabled, at-event and interval states', async () => {
  for (const [text, expected] of [['не напоминай', -1], ['в момент события', 0], ['за 30 минут', 30]]) {
    const f = fixture();
    f.ctx.pending = {type: 'doc', step: 'remind', docs: [{kind: 'appointment', title: 'Приём', date: '2099-05-05', time: '12:00', tz: '+00:00', emoji: '🩺'}]};
    await f.send(text, {});
    assert.equal(settings.eventOffset(f.events[0]), expected);
    assert.equal(f.ctx.pending, null);
  }
});

test('snooze dialogue allows explicit cancellation rather than creating an at-event reminder', async () => {
  const f = fixture(); const ev = f.seed(60);
  f.ctx.pending = {type: 'snooze', event_id: ev.id};
  await f.send('не напоминай', {});
  assert.equal(ev.remind_at, null);
  assert.equal(f.ctx.pending, null);
});

test('calendar title-only edit preserves PostgreSQL Date timestamps with seconds and sent flags', async () => {
  const f = fixture(); const ev = f.seed(95);
  ev.event_at = new Date('2099-05-05T12:00:37.000Z');
  ev.remind_at = new Date(settings.reminderAt(ev.event_at, 95));
  const before = {...ev};
  await f.api('PATCH', {title: 'Новое'}, ev.id);
  assert.deepEqual({...ev, title: before.title}, before);
});
