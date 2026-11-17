const { test } = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../lib/reminderSettings');
const { fixture } = require('./helpers/mockServices');

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
