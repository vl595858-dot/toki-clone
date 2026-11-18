const {test} = require('node:test');
const assert = require('node:assert/strict');
const {fixture} = require('./helpers/mockServices');
const doc = (title = 'Первый', patch = {}) => ({kind: 'appointment', title, date: '2099-11-12', time: '12:00', emoji: '🩺', ...patch});
const button = (f, action) => f.sent.flatMap(m => m.options?.replyMarkup?.inline_keyboard?.flat() || []).filter(b => b.callback_data.includes(`:${action}`)).at(-1).callback_data;

test('actual callback route: two images, old and legacy buttons preserve the newest document', async () => {
  const f = fixture();
  await f.photo([doc()], 'не напоминай');
  const first = button(f, 'ok');
  await f.photo([doc('Второй')], 'не напоминай');
  const second = button(f, 'ok');
  const pending = JSON.stringify(f.ctx.pending);
  await f.callback(first);
  await f.callback('doc:ok');
  assert.equal(JSON.stringify(f.ctx.pending), pending);
  assert.equal(f.events.length, 0);
  assert.match(f.answers.at(-1).text, /устарела/);
  await f.callback(second);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].title, 'Второй');
  assert.equal(f.events[0].remind_at, null);
  await f.callback(second);
  assert.equal(f.events.length, 1);
});

test('parallel confirmation clicks create one batch; old pick cannot affect reminder step', async () => {
  const f = fixture();
  await f.photo([doc(), doc('Обратно')]);
  const pick = button(f, 'pick:all');
  await f.callback(pick);
  const pending = JSON.stringify(f.ctx.pending);
  await f.callback(pick);
  assert.equal(JSON.stringify(f.ctx.pending), pending);
  const remind = button(f, 'r');
  await Promise.all([f.callback(remind), f.callback(remind)]);
  assert.equal(f.events.length, 2);
  await f.callback(remind);
  assert.equal(f.events.length, 2);
});

test('batch insert failure rolls back consumed step and all events, retry succeeds once', async () => {
  const f = fixture();
  await f.photo([doc(), doc('Обратно')], 'напомни в момент события');
  const pick = button(f, 'pick:all');
  f.failInsert = 2;
  await f.callback(pick);
  assert.equal(f.events.length, 0);
  assert.equal(f.ctx.pending.step, 'pick');
  await f.callback(pick);
  assert.equal(f.events.length, 2);
  assert.ok(f.events.every(e => e.remind_at === e.event_at));
  await f.callback(pick);
  assert.equal(f.events.length, 2);
});

test('wrong-step and forged reminder values are rejected without changing pending', async () => {
  const f = fixture();
  await f.photo([doc()]);
  const key = f.ctx.pending.token;
  const snapshot = JSON.stringify(f.ctx.pending);
  await f.callback(`doc:${key}:r:60`);
  assert.equal(JSON.stringify(f.ctx.pending), snapshot);
  await f.callback(button(f, 'ok'));
  const snapshot2 = JSON.stringify(f.ctx.pending);
  await f.callback(`doc:${f.ctx.pending.token}:r:999999`);
  assert.equal(JSON.stringify(f.ctx.pending), snapshot2);
});

for (const voice of [false, true]) {
  test(`corrections respect requested date/time, voice=${voice}`, async () => {
    const f = fixture();
    await f.photo([doc('Без времени', {time: null})]);
    assert.equal(f.ctx.pending.question, 'time');
    await f.send('23-30', {event_date: '2099-12-30', event_time: '08:00'}, voice);
    assert.equal(f.ctx.pending.docs[0].time, '23:30');
    assert.equal(f.ctx.pending.docs[0].date, '2099-11-12');
    await f.photo([doc('Без даты', {date: null})]);
    assert.equal(f.ctx.pending.question, 'date');
    await f.send('12.11', {event_time: '12:11', event_date: '2099-01-01'}, voice);
    assert.match(f.ctx.pending.docs[0].date, /-11-12$/);
    assert.equal(f.ctx.pending.docs[0].time, '12:00');
  });
  test(`ambiguous fix asks date or time and keeps the document, voice=${voice}`, async () => {
    const f = fixture();
    await f.photo([doc()], 'не напоминай');
    const ok = button(f, 'ok');
    await f.callback(button(f, 'fix'));
    await f.callback(ok);
    assert.equal(f.ctx.pending.step, 'fix');
    await f.send('12.11', {event_time: '12:11', event_date: '2099-11-12'}, voice);
    assert.match(f.replies.at(-1), /дата или время/);
    assert.equal(f.ctx.pending.docs[0].time, '12:00');
    await f.send('время', {}, voice);
    assert.equal(f.ctx.pending.docs[0].time, '12:11');
    assert.equal(f.ctx.pending.docs[0].date, '2099-11-12');
    await f.callback(button(f, 'fix'));
    await f.send('23-30', {event_time: '08:00', event_date: '2099-12-30'}, voice);
    assert.equal(f.ctx.pending.docs[0].time, '23:30');
    assert.equal(f.ctx.pending.docs[0].date, '2099-11-12');
    assert.equal(f.ctx.pending.remind, -1);
  });
}

test('slow first image recognition cannot replace a newer image', async () => {
  const f = fixture();
  let release, started;
  const waiting = new Promise(resolve => {started = resolve;});
  f.image = () => new Promise(resolve => { release = resolve; started(); });
  const first = f.load('lib/handlers/docs.js').handlePhoto({chat: {id: 1}, photo: [{file_id: 'first'}]}, '+00:00');
  await waiting;
  await f.photo([doc('Второй')]);
  const pending = JSON.stringify(f.ctx.pending);
  release({documents: [doc('Первый')]});
  await first;
  assert.equal(JSON.stringify(f.ctx.pending), pending);
});

test('expired steps cannot create events or clear the current document', async () => {
  const f = fixture();
  await f.photo([doc()], 'не напоминай');
  const ok = button(f, 'ok');
  f.steps[f.ctx.pending.token].expired = true;
  await f.callback(ok);
  assert.equal(f.events.length, 0);
  assert.equal(f.ctx.pending.step, 'confirm');
});

test('ambiguous date choice and explicit question prevent model time from overwriting the document', async () => {
  const f = fixture();
  await f.photo([doc('Документ', {date: '2099-10-10'})]);
  await f.callback(button(f, 'fix'));
  await f.send('12.11', {event_date: '2099-11-12', event_time: '12:11'});
  await f.send('дата', {});
  assert.equal(f.ctx.pending.docs[0].date, '2099-11-12');
  assert.equal(f.ctx.pending.docs[0].time, '12:00');
  await f.callback(button(f, 'fix'));
  await f.send('время', {});
  await f.send('12.11', {event_date: '2099-11-12', event_time: '09:00'});
  assert.equal(f.ctx.pending.docs[0].time, '12:11');
  await f.callback(button(f, 'fix'));
  await f.send('дата 30.02', {event_date: '2099-03-02'});
  assert.equal(f.ctx.pending.docs[0].date, '2099-11-12');
  assert.match(f.replies.at(-1), /дат/i);
});

test('durable consumed marker rejects a stale context writer resurrecting an old confirmation', async () => {
  const f = fixture();
  await f.photo([doc()], 'не напоминай');
  const old = JSON.parse(JSON.stringify(f.ctx));
  const ok = button(f, 'ok');
  await f.callback(ok);
  f.ctx = old;
  await f.callback(ok);
  assert.equal(f.events.length, 1);
  assert.match(f.answers.at(-1).text, /устарела/);
});

test('correction parsed slowly cannot change a newer image', async () => {
  const f = fixture();
  await f.photo([doc()]);
  await f.callback(button(f, 'fix'));
  let release, started;
  const waiting = new Promise(resolve => {started = resolve;});
  f.parseHook = async () => new Promise(resolve => {release = resolve; started();});
  const correction = f.send('23-30', {});
  await waiting;
  await f.photo([doc('Новый')]);
  const pending = JSON.stringify(f.ctx.pending);
  release({event_time: '23:30'});
  await correction;
  assert.equal(JSON.stringify(f.ctx.pending), pending);
  assert.equal(f.events.length, 0);
});
