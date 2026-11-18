const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const settings = require('../../lib/reminderSettings');
const root = path.resolve(__dirname, '../..');

// Runs real handlers and SQL construction against an in-memory service substitute.
function fixture(options = {}) {
  const now = options.now ? Date.parse(options.now) : null;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const Clock = now === null ? Date : FixedDate;
  const state = { events: [], templates: [], ctx: {}, replies: [], queries: [], model: {}, text: '', voice: false, errors: [], tz: '+00:00' };
  let nextId = 1;
  state.steps = {}; state.sent = []; state.answers = []; state.edits = [];
  function matches(row, where, args) {
    for (const match of where.matchAll(/(?:\w+\.)?(id|chat_id|recurring_id)\s*=\s*\$(\d+)/g)) {
      if (row[match[1]] !== args[Number(match[2]) - 1]) return false;
    }
    for (const match of where.matchAll(/(?:\w+\.)?event_at\s*(>=|<=|<|>)\s*\$(\d+)/g)) {
      const actual = Date.parse(row.event_at), boundary = Date.parse(args[Number(match[2]) - 1]);
      if (!(match[1] === ">=" ? actual >= boundary : match[1] === "<=" ? actual <= boundary : match[1] === "<" ? actual < boundary : actual > boundary)) return false;
    }
    if (/remind_at IS NOT NULL/.test(where) && row.remind_at == null) return false;
    if (/reminded = FALSE/.test(where) && row.reminded) return false;
    if (/event_at < now\(\) - interval '30 days'/.test(where) && Date.parse(row.event_at) >= Clock.now() - 30 * 86400000) return false;
    if (/done_at IS NULL/.test(where) && row.done_at != null) return false;
    if (/remind_at <= now\(\)/.test(where) && (row.remind_at == null || Date.parse(row.remind_at) > Date.now())) return false;
    if (/event_at <= now\(\) \+ interval '3 days'/.test(where) && Date.parse(row.event_at) > Date.now() + 3 * 86400000) return false;
    return true;
  }
  const db = {async query(sql, args = []) {
    state.queries.push({sql, args});
    if (/^(CREATE TABLE|ALTER TABLE|CREATE INDEX)/.test(sql)) return {rows: []};
    if (sql.startsWith('DELETE FROM document_steps')) return {rows: []};
    if (sql.startsWith('INSERT INTO chat_context')) return {rows: []};
    if (sql.startsWith('SELECT context FROM chat_context')) return {rows: [{context: JSON.parse(JSON.stringify(state.ctx))}]};
    if (sql.startsWith('UPDATE chat_context')) { state.ctx = JSON.parse(args[1]); return {rows: []}; }
    if (sql.startsWith('INSERT INTO document_steps')) { state.steps[args[0]] = {chat: args[1], payload: JSON.parse(args[2]), consumed: false}; return {rows: []}; }
    if (sql.startsWith('UPDATE document_steps')) { const row = state.steps[args[0]]; if (row && row.chat === args[1]) row.consumed = true; return {rows: []}; }
    if (sql.startsWith('SELECT payload FROM document_steps')) { const row = state.steps[args[0]]; return {rows: row && row.chat === args[1] && !row.consumed && !row.expired ? [{payload: JSON.parse(JSON.stringify(row.payload))}] : []}; }
    if (state.failInsert && sql.startsWith('INSERT INTO events')) { if (--state.failInsert === 0) throw new Error('Mock insert failed'); }

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
      const before = store.length;
      for (let i = store.length - 1; i >= 0; i--) if (matches(store[i], where, args)) store.splice(i, 1);
      return {rows: [], rowCount: before - store.length};
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
  let lock = Promise.resolve();
  db.withTransaction = async fn => {
    const previous = lock; let release;
    lock = new Promise(resolve => {release = resolve;});
    await previous;
    const snapshot = JSON.parse(JSON.stringify({events: state.events, ctx: state.ctx, steps: state.steps}));
    try { return await fn(db); }
    catch (e) { Object.assign(state, snapshot); throw e; }
    finally { release(); }
  };
  const telegram = {
    sendMessage: async (id, text, options) => {state.replies.push(text); state.sent.push({id, text, options}); return true;},
    answerCallbackQuery: async (id, text) => {state.answers.push({id, text}); return true;},
    editMessageText: async (...args) => {state.edits.push(args); return true;},
  };
  const cache = new Map();
  const mocks = new Map([
    ['lib/vision.js', {recognizeImage: async () => typeof state.image === 'function' ? state.image() : state.image}],
    ['lib/dedupe.js', {claimUpdate: async () => true}],
    ['lib/db.js', db], ['lib/telegram.js', telegram],
    ['lib/context.js', {loadContext: async () => state.ctx, saveContext: async (id, ctx) => {state.ctx = ctx;}}],
    ['lib/settings.js', {getTzOffset: async () => state.tz}],
    ['lib/ai.js', {transcribeVoice: async () => state.text, parseMessage: async () => { if (state.parseHook) return state.parseHook(); if (state.parseFailure) throw new Error('Mock model unavailable'); return {...state.model}; }}],
    ['lib/contextText.js', {buildContextText: async () => ''}],
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
    vm.runInNewContext(source, {module, exports: module.exports, console: {...console, error: (...args) => state.errors.push(args)}, process: {...process, env: {...process.env, CRON_SECRET: process.env.CRON_SECRET || "mock-cron"}}, AbortSignal, Date: Clock,
      require: name => name.startsWith('.') ? load(path.relative(root, path.resolve(path.dirname(filename), name)) + '.js') : require(name),
    }, {filename});
    return module.exports;
  }
  state.load = load;
  state.photo = async (docs, caption) => {
    state.image = {documents: docs};
    await load('pages/api/telegram/[secret].js').runUpdate({message: {chat: {id: 1}, photo: [{file_id: 'mock'}], caption}});
  };
  state.callback = async data => {
    await load('pages/api/telegram/[secret].js')({method: 'POST', query: {secret: process.env.TELEGRAM_WEBHOOK_SECRET}, body: {callback_query: {id: 'cq', data, message: {chat: {id: 1}, message_id: 10, text: 'Документ'}}}},
      {status() {return this;}, json() {}, end() {}});
  };
  state.send = async (text, model, voice = false) => {
    state.text = text; state.model = model;
    await load('pages/api/telegram/[secret].js').runUpdate({message: {chat: {id: 1}, ...(voice ? {voice: {file_id: 'mock'}} : {text})}});
  };
  state.api = async (method, body, id, query = {}) => {
    let status, response;
    const headers = {};
    const res = {setHeader(name, value) {headers[name] = value;}, status(code) {status = code; return this;}, json(value) {response = value;}, end() {}};
    await load(`pages/api/webapp/events/${id ? '[id]' : 'index'}.js`)({method, body, query: {id, from: '2099-01-01', to: '2100-01-01', ...query}}, res);
    return {status, response, headers};
  };
  state.seed = offset => {
    const event = {id: nextId++, chat_id: 1, title: 'Встреча', event_at: '2099-05-05T12:00:00.000Z',
      remind_at: settings.reminderAt('2099-05-05T12:00:00.000Z', offset), reminded: true, reminded2: true, done_at: null};
    state.events.push(event); state.ctx.last_event_id = event.id;
    return event;
  };
  state.cron = async () => {
    let status;
    await load('pages/api/cron/reminders.js')({headers: {authorization: `Bearer ${process.env.CRON_SECRET || "mock-cron"}`}},
      {status(code) {status = code; return this;}, json() {}});
    assert.equal(status, 200);
  };
  return state;
}

module.exports = { fixture };
