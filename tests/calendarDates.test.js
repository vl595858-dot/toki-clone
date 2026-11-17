const {test} = require('node:test');
const assert = require('node:assert/strict');
const {fixture} = require('./helpers/mockServices');
const {isValidDate, toUtcIso, utcIsoToLocalParts, eventListPeriod, historicalListScope} = require('../lib/time');
const {dateInputError} = require('../lib/dateInput');

const create = {intent: 'create_event', title: 'Встреча', event_date: '2099-02-28', event_time: '12:00'};
const move = {...create, intent: 'reschedule_event', refers_to_last: true};
const invalidInputs = ['30 февраля 2099', '30.02.2099', '30/02/2099', '30-02-2099', '2099-02-30', '31 апреля 2099', '29 февраля 2100', '30февраля2099', '30 февраля', '30.02', '30/02', '30-02'];
const validInputs = ['28 февраля 2099', '28.02.2099', '28/02/2099', '28-02-2099', '2099-02-28'];

test('strict Gregorian date validation handles leap years and refuses normalization', () => {
  for (const day of ['2099-02-30', '2099-04-31', '2100-02-29', '1900-02-29', '2099-00-01', '2099-13-01', '2099-01-00', '2099-01-32', '0000-01-01', '2099-2-28']) {
    assert.equal(isValidDate(day), false, day);
    assert.throws(() => toUtcIso(day, '12:00', '+05:00'), /календарной даты нет/, day);
  }
  for (const day of ['2000-02-29', '2096-02-29', '2400-02-29', '2099-02-28', '2099-04-30']) {
    assert.equal(isValidDate(day), true, day);
    for (const tz of ['+14:00', '-12:00', '+05:45']) assert.equal(utcIsoToLocalParts(toUtcIso(day, '00:15', tz), tz).dateStr, day);
  }
});

test('raw input validation catches invalid named, numeric and ISO dates even after model normalization', () => {
  for (const text of invalidInputs) assert.match(dateInputError(`встреча ${text}`, '2099-03-02', '+05:00'), /календарной даты нет/, text);
  for (const text of validInputs) assert.equal(dateInputError(`встреча ${text}`, '2099-02-28', '+05:00'), null, text);
  for (const text of ['встреча в 23:30', 'встреча в 23-30', 'встреча в 23.30', 'напомни за 20-30 минут', 'Создай «30 февраля»']) assert.equal(dateInputError(text, '2099-02-28', '+05:00'), null, text);
  assert.equal(dateInputError('29 февраля', '2096-02-29', '+05:00'), null);
  assert.match(dateInputError('29 февраля', '2100-03-01', '+05:00'), /Уточни/);
});

for (const voice of [false, true]) {
  const mode = voice ? 'voice' : 'text';
  test(`${mode}: impossible raw dates cannot become March during creation`, async () => {
    for (const date of invalidInputs) {
      const f = fixture();
      await f.send(`Создай встречу ${date} в 12:00`, {...create, event_date: '2099-03-02'}, voice);
      assert.equal(f.events.length, 0, date); assert.match(f.replies.at(-1), /календарной даты нет/);
    }
  });
  test(`${mode}: reschedule rejects impossible dates and keeps reminder settings and delivery flags`, async () => {
    for (const date of invalidInputs) {
      const f = fixture(); const ev = f.seed(-1); const before = {...ev};
      await f.send(`перенеси его на ${date} в 12:00`, {...move, event_date: '2099-03-02'}, voice);
      assert.deepEqual(ev, before, date); assert.match(f.replies.at(-1), /календарной даты нет/);
    }
  });
  test(`${mode}: existing date formats and a future leap date remain usable`, async () => {
    for (const date of validInputs) {
      const f = fixture();
      await f.send(`Создай встречу ${date} в 12:00`, create, voice);
      assert.equal(f.events[0].event_at, '2099-02-28T12:00:00.000Z', date);
      await f.send('перенеси его на 29 февраля 2096 в 12:00', {...move, event_date: '2096-02-29'}, voice);
      assert.equal(f.events[0].event_at, '2096-02-29T12:00:00.000Z');
    }
  });
  test(`${mode}: invalid model date is rejected even when input contains only a relative date`, async () => {
    const f = fixture(); const ev = f.seed(60); const before = {...ev};
    await f.send('перенеси его на завтра', {...move, event_date: '2100-02-29'}, voice);
    assert.deepEqual(ev, before); assert.match(f.replies.at(-1), /календарной даты нет/);
    await f.send('создай встречу завтра', {...create, event_date: '2099-02-30'}, voice);
    assert.equal(f.events.length, 1);
  });
}

test('calendar POST and PATCH refuse invalid dates with HTTP 400 without writes', async () => {
  for (const date of ['2099-02-30', '2100-02-29', '2099-04-31', '2099-13-01', 'bad']) {
    const f = fixture(); const ev = f.seed(-1); const before = {...ev};
    let result = await f.api('POST', {title: 'Новое', date, time: '12:00'});
    assert.equal(result.status, 400); assert.match(result.response.error, /календарной даты нет/);
    result = await f.api('PATCH', {date}, ev.id);
    assert.equal(result.status, 400); assert.deepEqual(ev, before);
    assert.equal(f.events.length, 1);
    assert.ok(!f.queries.some(q => /^(INSERT|UPDATE|DELETE)/.test(q.sql)));
  }
});

test('calendar supports leap dates and preserves disabled reminders when moving', async () => {
  const f = fixture();
  const created = await f.api('POST', {title: 'Високосный', date: '2096-02-29', time: '00:15', remindOffsetMinutes: null});
  assert.equal(created.status, 200); const ev = f.events[0];
  assert.equal(ev.event_at, '2096-02-29T00:15:00.000Z'); assert.equal(ev.remind_at, null);
  assert.equal((await f.api('PATCH', {date: '2400-02-29'}, ev.id)).status, 200);
  assert.equal(ev.event_at, '2400-02-29T00:15:00.000Z'); assert.equal(ev.remind_at, null);
});

test('calendar GET rejects impossible date boundaries and reversed ranges', async () => {
  const f = fixture();
  for (const query of [{from: '2099-02-30T00:00:00Z'}, {to: '2100-02-29'}, {from: '2100-01-01', to: '2099-01-01'}]) {
    assert.equal((await f.api('GET', undefined, undefined, query)).status, 400);
  }
  assert.equal(f.queries.length, 0);
});

test('yearly creation and series reschedule reject an impossible explicit date before changing records', async () => {
  const f = fixture();
  await f.load('lib/handlers/recurring.js').handleCreateRecurringEvent(1, {title: 'День рождения', recurring_frequency: 'yearly', recurring_month: 2, recurring_month_day: 30}, {}, '+05:00');
  assert.equal(f.templates.length, 0); assert.equal(f.events.length, 0);
  const tpl = {id: 101, chat_id: 1, title: 'Встреча', frequency: 'yearly', month: 5, month_day: 5, time: '12:00', remind_offset_minutes: 60};
  f.templates.push(tpl); const ev = f.seed(60); ev.recurring_id = tpl.id;
  const before = {...tpl}; const beforeEvent = {...ev};
  await f.send('перенеси его на завтра навсегда', {...move, event_date: '2100-02-29'});
  assert.deepEqual(tpl, before); assert.deepEqual(ev, beforeEvent);
});

test('document correction and snooze cannot normalize an impossible date into March', async () => {
  const f = fixture(); const ev = f.seed(60); const before = {...ev};
  f.ctx.pending = {type: 'snooze', event_id: ev.id};
  await f.send('напомни 30 февраля 2099 в 11:00', {event_date: '2099-03-02', event_time: '11:00'});
  assert.deepEqual(ev, before); assert.match(f.replies.at(-1), /календарной даты нет/);
  const doc = {kind: 'appointment', title: 'Приём', date: '2099-05-05', time: '12:00', tz: '+00:00'};
  f.ctx.pending = {type: 'doc', step: 'fix', docs: [doc]};
  await f.send('30 февраля 2099', {event_date: '2099-03-02'});
  assert.equal(f.ctx.pending.docs[0].date, '2099-05-05');
  const normalized = f.load('lib/docs.js').normalizeDocs({documents: [{...doc, date: '2099-02-30'}]});
  assert.equal(normalized[0].date, null);
});

const weekCases = [
  ['2026-11-18T10:15:00Z', '+05:00', '2026-11-08T19:00:00.000Z', '2026-11-15T19:00:00.000Z'],
  ['2026-11-15T21:00:00Z', '+05:00', '2026-11-08T19:00:00.000Z', '2026-11-15T19:00:00.000Z'],
  ['2026-11-16T01:00:00Z', '-05:00', '2026-11-02T05:00:00.000Z', '2026-11-09T05:00:00.000Z'],
  ['2027-01-01T10:00:00Z', '+05:00', '2026-12-20T19:00:00.000Z', '2026-12-27T19:00:00.000Z'],
];

test('last_week is Monday to Sunday in the user timezone including UTC and year boundaries', () => {
  for (const [now, tz, from, to] of weekCases) {
    const period = eventListPeriod('last_week', tz, Date.parse(now));
    assert.equal(period.from, from); assert.equal(period.to, to); assert.equal(period.exclusiveEnd, true);
  }
});

test('last_seven_days is a distinct rolling 168-hour period ending now', () => {
  const now = Date.parse('2026-11-18T10:15:00Z');
  for (const tz of ['+05:00', '-12:00', '+14:00']) {
    const period = eventListPeriod('last_seven_days', tz, now);
    assert.equal(period.from, '2026-11-11T10:15:00.000Z');
    assert.equal(period.to, '2026-11-18T10:15:00.000Z'); assert.equal(period.exclusiveEnd, false);
  }
  assert.equal(historicalListScope('покажи за прошлую неделю'), 'last_week');
  assert.equal(historicalListScope('покажи последние семь дней'), 'last_seven_days');
  assert.equal(historicalListScope('за последние 7 дней'), 'last_seven_days');
});

for (const voice of [false, true]) {
  test(`${voice ? 'voice' : 'text'}: actual list query excludes this week and handles rolling requests separately despite model scope`, async () => {
    const f = fixture({now: '2026-11-18T10:15:00Z'}); f.tz = '+05:00';
    for (const [title, at] of [
      ['До прошлой недели', '2026-11-08T18:59:59.999Z'],
      ['Прошлый понедельник', '2026-11-08T19:00:00.000Z'],
      ['Семь суток назад', '2026-11-11T10:15:00.000Z'],
      ['Прошлое воскресенье', '2026-11-15T18:59:59.999Z'],
      ['Текущий понедельник', '2026-11-15T19:00:00.000Z'],
      ['Сейчас', '2026-11-18T10:15:00.000Z'],
      ['Будущее', '2026-11-18T10:15:00.001Z'],
    ]) {const ev = f.seed(-1); ev.title = title; ev.event_at = at;}
    await f.send('Покажи дела за прошлую неделю', {intent: 'list_events', list_scope: 'last_seven_days'}, voice);
    const calendar = f.replies.at(-1);
    assert.match(calendar, /Прошлый понедельник/); assert.match(calendar, /Прошлое воскресенье/);
    assert.doesNotMatch(calendar, /До прошлой недели|Текущий понедельник|Сейчас|Будущее/);
    const query = f.queries.at(-1); assert.match(query.sql, /event_at < \$3/);
    assert.equal(query.args[1], '2026-11-08T19:00:00.000Z');
    assert.equal(query.args[2], '2026-11-15T19:00:00.000Z');
    await f.send('Покажи последние семь дней', {intent: 'list_events', list_scope: 'last_week'}, voice);
    const rolling = f.replies.at(-1);
    assert.match(rolling, /Семь суток назад/); assert.match(rolling, /Текущий понедельник/); assert.match(rolling, /Сейчас/);
    assert.doesNotMatch(rolling, /До прошлой недели|Прошлый понедельник|Будущее/);
    assert.equal(f.queries.at(-1).args[1], '2026-11-11T10:15:00.000Z');
  });
}


test('invalid legacy recurring patterns are not silently clamped or allowed to block healthy series', async () => {
  const f = fixture();
  f.templates.push({id: 101, chat_id: 1, title: 'Невозможная', frequency: 'yearly', month: 2, month_day: 30, time: '12:00', remind_offset_minutes: -1});
  f.templates.push({id: 102, chat_id: 1, title: 'Корректная', frequency: 'yearly', month: 5, month_day: 5, time: '12:00', remind_offset_minutes: -1});
  await f.cron();
  assert.equal(f.events.length, 8);
  assert.ok(f.events.every(ev => ev.recurring_id === 102));
  const time = require('../lib/time');
  assert.throws(() => time.nextMonthlyOccurrenceUtcIso(32, '12:00', '+05:00'), /календарной даты нет/);
  assert.throws(() => time.nextYearlyOccurrenceUtcIso(2, 30, '12:00', '+05:00'), /календарной даты нет/);
});

test('local day intervals include the entire last minute and exclude the following midnight', () => {
  const period = eventListPeriod('yesterday', '+05:00', Date.parse('2026-11-18T10:15:00Z'));
  assert.equal(period.from, '2026-11-16T19:00:00.000Z');
  assert.equal(period.to, '2026-11-17T19:00:00.000Z'); assert.equal(period.exclusiveEnd, true);
  assert.equal(historicalListScope('за прошлую календарную неделю'), 'last_week');
});


test('leap-day recurrence skips non-leap years including 2100 without changing the requested day', () => {
  const time = require('../lib/time');
  assert.equal(time.nextYearlyOccurrenceUtcIso(2, 29, '12:00', '+00:00', '2096-03-01T00:00:00Z'), '2104-02-29T12:00:00.000Z');
  assert.equal(time.nextYearlyOccurrenceUtcIso(2, 29, '12:00', '+05:00', '2096-02-28T00:00:00Z'), '2096-02-29T07:00:00.000Z');
});

test('monthly recurrence skips a month without the chosen day instead of clamping it', () => {
  const time = require('../lib/time');
  assert.equal(time.nextMonthlyOccurrenceUtcIso(31, '12:00', '+00:00', '2099-01-31T13:00:00Z'), '2099-03-31T12:00:00.000Z');
});

test('invalid recurrence cursor is rejected rather than entering a date-search loop', () => {
  const time = require('../lib/time');
  assert.throws(() => time.nextMonthlyOccurrenceUtcIso(31, '12:00', '+00:00', 'invalid'), /дат/);
  assert.throws(() => time.nextYearlyOccurrenceUtcIso(2, 29, '12:00', '+00:00', 'invalid'), /дат/);
});
