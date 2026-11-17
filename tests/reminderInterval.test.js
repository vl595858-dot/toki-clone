const {test} = require('node:test');
const assert = require('node:assert/strict');
const {extractOffsetMinutes} = require('../lib/text');
const {commandOffset, AMBIGUOUS, eventOffset} = require('../lib/reminderSettings');
const {fixture} = require('./helpers/mockServices');
const {parseReminderInterval} = require('../lib/reminderInterval');

const intervals = [
  ['за тридцать минут', 30], ['за 1 час 30 минут', 90], ['за полтора часа', 90],
  ['за час тридцать минут', 90], ['за сутки и два часа', 1560],
  ['за двадцать пять минут', 25], ['за два часа сорок пять минут', 165],
  ['за полчаса', 30], ['за пару часов', 120], ['за ноль минут', 0],
  ['за один день два часа и пять минут', 1565], ['за сто двадцать минут', 120],
  ['за 1 ч. 30 мин.', 90], ['за две тысячи тридцать минут', 2030],
  ['за тридцать минут и час', 90], ['за ноль тысяч минут', 0],
];

test('extractOffsetMinutes supports spoken numbers, implicit one, fractions, and compound durations', () => {
  for (const [text, expected] of intervals) {
    assert.equal(extractOffsetMinutes(text), expected, text);
    assert.equal(extractOffsetMinutes(`Напомни ${text}`), expected, text);
  }
});

test('reminder scope wins over event timing, titles and unrelated durations', () => {
  for (const text of [
    'встреча за 2 дня до отпуска, напомни за час',
    'Сделать отчёт за два дня, напомни за час',
    'Встреча через тридцать минут, напомни за час',
    'Встреча в 23:30, напомни за час',
    'Встреча «за два дня до отпуска», напомни за час',
    'Встреча «напомни за два часа», напомни за час',
    'напомни про встречу за два дня до отпуска, напомни за час',
  ]) assert.equal(extractOffsetMinutes(text), 60, text);
  for (const text of ['Встреча за два дня до отпуска', 'Подготовить отчёт за два часа', 'Встреча через тридцать минут', 'Встреча в 23:30', 'Купить за часами', '«напомни за час»']) {
    assert.equal(extractOffsetMinutes(text), null, text);
    assert.equal(commandOffset(text), undefined, text);
  }
});

test('ambiguous or incomplete durations cannot silently fall back to an hour or at-event', () => {
  for (const text of ['напомни за час или за два часа', 'напомни за час или тридцать минут',
    'напомни за 1 час 30', 'напомни за полтора', 'напомни за двадцать-тридцать минут',
    'напомни за час и два часа', 'напомни за несколько минут', 'напомни за час, тридцать минут',
    'напомни за час в момент события', 'напомни за -5 минут']) {
    assert.equal(commandOffset(text), AMBIGUOUS, text);
    assert.equal(extractOffsetMinutes(text), text.includes('в момент') ? 60 : null, text);
  }
});

const create = {intent: 'create_event', title: 'Встреча', event_date: '2099-05-05', event_time: '12:00', remind_offset_minutes: 999};
for (const voice of [false, true]) {
  const mode = voice ? 'voice' : 'text';
  for (const [interval, expected] of intervals.slice(0, 8)) {
    test(`${mode}: creation and named reminder change use ${interval}`, async () => {
      const f = fixture();
      await f.send(`Создай встречу в 12:00, напомни ${interval}`, create, voice);
      const ev = f.events[0];
      assert.equal(eventOffset(ev), expected);
      await f.send(`измени напоминание про встречу ${interval}`, {intent: 'set_reminder', title: 'Встреча', remind_offset_minutes: 999}, voice);
      assert.equal(eventOffset(ev), expected);
      assert.equal(f.events.length, 1);
    });
  }
  test(`${mode}: standalone interval answers bypass model and target the selected event`, async () => {
    for (const [interval, expected] of intervals) {
      const f = fixture(); const ev = f.seed(60);
      await f.send('измени напоминание про встречу', {intent: 'set_reminder'}, voice);
      assert.equal(f.ctx.pending.type, 'reminder_offset');
      await f.send(interval.replace(/^за /, ''), {intent: 'delete_event'}, voice);
      assert.equal(eventOffset(ev), expected, interval);
      assert.equal(f.events.length, 1);
      assert.equal(f.ctx.pending, null);
    }
  });
  test(`${mode}: event description before vacation cannot replace a later reminder interval`, async () => {
    const f = fixture();
    await f.send('Встреча за 2 дня до отпуска, напомни за час', {...create, title: 'Встреча за 2 дня до отпуска'}, voice);
    assert.equal(eventOffset(f.events[0]), 60);
    assert.equal(f.events[0].title, 'Встреча за 2 дня до отпуска');
    await f.send('Создай «Напомни за два часа» в 12:00', {...create, title: 'Напомни за два часа'}, voice);
    assert.equal(eventOffset(f.events[1]), 60);
  });
  test(`${mode}: ambiguous creation asks then creates the saved event exactly once`, async () => {
    const f = fixture();
    await f.send('Создай встречу, напомни за час или за тридцать минут', create, voice);
    assert.equal(f.events.length, 0);
    assert.equal(f.ctx.pending.type, 'reminder_interval');
    assert.match(f.replies.at(-1), /За сколько напомнить/);
    await f.send('напомни за час или за два часа', {intent: 'delete_event'}, voice);
    assert.equal(f.events.length, 0); assert.equal(f.ctx.pending.type, 'reminder_interval');
    await f.send('тридцать минут', {intent: 'delete_event'}, voice);
    assert.equal(f.events.length, 1); assert.equal(f.events[0].title, 'Встреча');
    assert.equal(eventOffset(f.events[0]), 30); assert.equal(f.ctx.pending, null);
  });
  test(`${mode}: ambiguous reminder change retains target and waits for a valid interval`, async () => {
    const f = fixture(); const ev = f.seed(15);
    await f.send('измени напоминание про встречу за час или за тридцать минут', {intent: 'set_reminder'}, voice);
    assert.equal(eventOffset(ev), 15); assert.equal(f.ctx.pending.type, 'reminder_interval');
    await f.send('в 15:00', {intent: 'create_event'}, voice);
    assert.equal(eventOffset(ev), 15); assert.equal(f.ctx.pending.type, 'reminder_interval');
    await f.send('час тридцать минут', {intent: 'create_event'}, voice);
    assert.equal(eventOffset(ev), 90); assert.equal(f.ctx.pending, null);
  });
  test(`${mode}: clarification accepts disabled and at-event states`, async () => {
    for (const [answer, expected] of [['не напоминай', -1], ['в момент события', 0], ['за ноль минут', 0]]) {
      const f = fixture();
      await f.send('Создай встречу, напомни за час или за два часа', create, voice);
      await f.send(answer, {intent: 'unknown'}, voice);
      assert.equal(eventOffset(f.events[0]), expected);
      await f.send('измени напоминание про встречу, не напоминай за час', {intent: 'set_reminder'}, voice);
      assert.equal(eventOffset(f.events[0]), -1);
    }
  });
  test(`${mode}: document question accepts compound and word intervals and retries ambiguity`, async () => {
    for (const [interval, expected] of intervals.slice(0, 5)) {
      const f = fixture();
      f.ctx.pending = {type: 'doc', step: 'remind', docs: [{kind: 'appointment', title: 'Приём', date: '2099-05-05', time: '12:00', tz: '+00:00', emoji: '🩺'}]};
      await f.send('за час или за два часа', {}, voice);
      assert.equal(f.events.length, 0); assert.equal(f.ctx.pending.step, 'remind');
      await f.send(interval.replace(/^за /, ''), {}, voice);
      assert.equal(eventOffset(f.events[0]), expected);
    }
  });
  test(`${mode}: new independent command cancels the pending reminder draft`, async () => {
    const f = fixture();
    await f.send('Создай встречу, напомни за час или два часа', create, voice);
    await f.send('Создай другое дело, не напоминай', {...create, title: 'Другое дело'}, voice);
    assert.equal(f.events.length, 1); assert.equal(f.events[0].title, 'Другое дело');
    assert.equal(eventOffset(f.events[0]), -1); assert.equal(f.ctx.pending, null);
  });
}

test('snooze uses the same compound interval and can clarify without resetting the event time', async () => {
  const f = fixture(); const ev = f.seed(60); const original = ev.event_at;
  f.ctx.pending = {type: 'snooze', event_id: ev.id};
  await f.send('за час или за два часа', {});
  assert.equal(eventOffset(ev), 60); assert.equal(f.ctx.pending.interval_reply, true);
  await f.send('час тридцать минут', {});
  assert.equal(eventOffset(ev), 90); assert.equal(ev.event_at, original);
});

test('malformed intervals keep explicit uncertainty in structured parsing', () => {
  assert.equal(parseReminderInterval('напомни за 1 час 30').ambiguous, true);
});


test('duration words in a named event do not replace the requested reminder or the target', async () => {
  const f = fixture(); const selected = f.seed(15); selected.title = 'Встреча за 2 дня до отпуска';
  const other = f.seed(15); other.title = 'Встреча';
  await f.send('измени напоминание про встречу за 2 дня до отпуска, напомни за час', {intent: 'set_reminder', title: 'Встреча'});
  assert.equal(eventOffset(selected), 60); assert.equal(eventOffset(other), 15);
});

test('unknown quantity is clarified without losing the named reminder target', async () => {
  const f = fixture(); const selected = f.seed(15);
  await f.send('измени напоминание про встречу за несколько минут или за час', {intent: 'set_reminder'});
  assert.equal(eventOffset(selected), 15); assert.equal(f.ctx.pending.type, 'reminder_interval');
  await f.send('за тридцать минут', {});
  assert.equal(eventOffset(selected), 30);
});

test('ambiguous reschedule waits and retains destination and selected reminder setting', async () => {
  const f = fixture(); const ev = f.seed(-1); const before = ev.event_at;
  await f.send('перенеси встречу на завтра, напомни за час или за тридцать минут', {intent: 'reschedule_event', event_date: '2099-06-01', event_time: '15:00'});
  assert.equal(ev.event_at, before); assert.equal(ev.remind_at, null);
  await f.send('час тридцать минут', {});
  assert.equal(ev.event_at, '2099-06-01T15:00:00.000Z'); assert.equal(eventOffset(ev), 90);
});

test('interval clarification can be followed by event selection without losing the chosen interval', async () => {
  const f = fixture(); const first = f.seed(15); const second = f.seed(15);
  second.event_at = '2099-05-06T12:00:00.000Z'; second.remind_at = '2099-05-06T11:45:00.000Z';
  await f.send('измени напоминание про встречу за час или за тридцать минут', {intent: 'set_reminder'});
  assert.equal(f.ctx.pending.type, 'reminder_interval');
  await f.send('час тридцать минут', {});
  assert.equal(f.ctx.pending.type, 'choose_event'); assert.equal(eventOffset(first), 15);
  await f.send('1', {});
  assert.equal(eventOffset(first), 90); assert.equal(eventOffset(second), 15);
});

test('cancelling an ambiguous creation never leaves an event with default reminder', async () => {
  const f = fixture();
  await f.send('Создай встречу, напомни за час или за два часа', create);
  await f.send('отмена', {});
  assert.equal(f.events.length, 0); assert.equal(f.ctx.pending, null);
});

test('disabling versus a positive interval is an alternative, while plain disabling still wins', () => {
  assert.equal(commandOffset('не напоминай или за тридцать минут'), AMBIGUOUS);
  assert.equal(commandOffset('не напоминай за тридцать минут'), -1);
  assert.equal(commandOffset('«не напоминай»'), undefined);
});


test('snooze absolute reminder time remains separate from an at-event request', async () => {
  const f = fixture(); const ev = f.seed(-1); f.ctx.pending = {type: 'snooze', event_id: ev.id};
  await f.send('напомни 5 мая 2099 в 11:00', {event_date: '2099-05-05', event_time: '11:00'});
  assert.equal(eventOffset(ev), 60);
  assert.equal(ev.event_at, '2099-05-05T12:00:00.000Z');
  f.ctx.pending = {type: 'snooze', event_id: ev.id};
  await f.send('за ноль минут', {});
  assert.equal(eventOffset(ev), 0);
});
