const {test} = require('node:test');
const assert = require('node:assert/strict');
const {fixture} = require('./helpers/mockServices');
const {eventOffset} = require('../lib/reminderSettings');
const {parseSelector, titleMatches} = require('../lib/targetQuery');
const {parseRename} = require('../lib/text');

const move = {intent: 'reschedule_event', title: 'встреча', refers_to_last: true,
  event_date: '2099-12-01', event_time: '15:00'};
function event(f, title, at = '2099-11-23T10:00:00.000Z') {
  const ev = f.seed(60); ev.title = title; ev.event_at = at;
  ev.remind_at = new Date(Date.parse(at) - 3600000).toISOString(); return ev;
}
function template(f, id, weekday = 1, time = '10:00', title = 'Встреча с Иваном') {
  const tpl = {id, chat_id: 1, title, frequency: 'weekly', weekday, time, remind_offset_minutes: 60};
  f.templates.push(tpl); return tpl;
}
function pending(f, kind = 'event') {
  assert.equal(f.ctx.pending?.type, 'choose_event');
  assert.ok(f.ctx.pending.choices.every(c => c.kind === kind));
}

for (const voice of [false, true]) {
  const mode = voice ? 'voice' : 'text';
  for (const action of ['reschedule_event', 'rename_event', 'delete_event', 'cancel_reminder', 'set_reminder']) {
    test(`${mode}: ${action} uses Ivan rather than Peter from context, even if model drops the name`, async () => {
      const f = fixture();
      const ivan = event(f, 'Встреча с Иваном');
      const peter = event(f, 'Встреча с Петром');
      const before = {...peter};
      const commands = {
        reschedule_event: 'перенеси встречу с Иваном на 1 декабря в 15:00',
        rename_event: 'переименуй встречу с Иваном в «Обсуждение»',
        delete_event: 'удали встречу с Иваном',
        cancel_reminder: 'не напоминай про встречу с Иваном',
        set_reminder: 'измени напоминание про встречу с Иваном за 30 минут',
      };
      await f.send(commands[action], {...move, intent: action}, voice);
      assert.deepEqual(peter, before);
      assert.equal(f.ctx.pending, null);
      if (action === 'reschedule_event') assert.equal(ivan.event_at, '2099-12-01T15:00:00.000Z');
      if (action === 'rename_event') assert.equal(ivan.title, 'Обсуждение');
      if (action === 'delete_event') assert.ok(!f.events.includes(ivan));
      if (action === 'cancel_reminder') assert.equal(ivan.remind_at, null);
      if (action === 'set_reminder') assert.equal(eventOffset(ivan), 30);
    });
    test(`${mode}: ${action} with no full name match never touches context`, async () => {
      const f = fixture(); const peter = event(f, 'Встреча с Петром'); const before = {...peter};
      const commands = {
        reschedule_event: 'перенеси встречу с Иваном на завтра',
        rename_event: 'переименуй встречу с Иваном в Обсуждение',
        delete_event: 'удали встречу с Иваном', cancel_reminder: 'не напоминай про встречу с Иваном',
        set_reminder: 'измени напоминание про встречу с Иваном за 30 минут',
      };
      await f.send(commands[action], {...move, intent: action}, voice);
      assert.deepEqual(peter, before);
      assert.match(f.replies.at(-1), /Не нашёл/);
    });
  }
  test(`${mode}: source date/time select the old event and destination stays separate`, async () => {
    const f = fixture();
    const old = event(f, 'Встреча с Иваном', '2099-11-23T10:00:00.000Z');
    const later = event(f, 'Встреча с Иваном', '2099-11-24T11:00:00.000Z');
    const wrongTime = event(f, 'Встреча с Иваном', '2099-11-23T11:00:00.000Z');
    await f.send('перенеси встречу с Иваном 23 ноября 2099 в 10:00 на 1 декабря в 15:00', move, voice);
    assert.equal(old.event_at, '2099-12-01T15:00:00.000Z');
    assert.equal(later.event_at, '2099-11-24T11:00:00.000Z');
    assert.equal(wrongTime.event_at, '2099-11-23T11:00:00.000Z');
  });
  test(`${mode}: duplicate titles need selection; numeric reply resumes original move exactly once`, async () => {
    const f = fixture();
    const first = event(f, 'Встреча с Иваном');
    const second = event(f, 'Встреча с Иваном', '2099-11-24T10:00:00.000Z');
    await f.send('перенеси встречу с Иваном на 1 декабря в 15:00', move, voice);
    pending(f); assert.match(f.replies.at(-1), /23 ноября[\s\S]*24 ноября/);
    assert.equal(first.event_at, '2099-11-23T10:00:00.000Z');
    await f.send('2', {intent: 'delete_event'}, voice);
    assert.equal(first.event_at, '2099-11-23T10:00:00.000Z');
    assert.equal(second.event_at, '2099-12-01T15:00:00.000Z');
    assert.equal(f.ctx.pending, null);
  });
  test(`${mode}: date clarification resumes a saved deletion and wrong clarification changes nothing`, async () => {
    const f = fixture(); const first = event(f, 'Встреча с Иваном'); const second = event(f, 'Встреча с Иваном', '2099-11-24T10:00:00.000Z');
    await f.send('удали встречу с Иваном', {intent: 'delete_event', title: 'встреча', refers_to_last: true}, voice);
    pending(f);
    await f.send('с Петром', {}, voice);
    pending(f); assert.equal(f.events.length, 2); assert.match(f.replies.at(-1), /совпадений нет/);
    await f.send('24 ноября в 10:00', {}, voice);
    assert.ok(f.events.includes(first)); assert.ok(!f.events.includes(second));
  });
  test(`${mode}: pronoun uses unambiguous last event, new independent command cancels old selection`, async () => {
    const f = fixture(); const first = event(f, 'Встреча с Иваном'); const second = event(f, 'Встреча с Иваном', '2099-11-24T10:00:00.000Z');
    await f.send('удали встречу с Иваном', {intent: 'delete_event', title: 'встреча', refers_to_last: true}, voice);
    pending(f);
    await f.send('создай задачу в 12:00', {intent: 'create_event', title: 'Новая задача', event_date: '2099-12-05', event_time: '12:00'}, voice);
    assert.equal(f.ctx.pending, null); assert.equal(f.events.length, 3);
    await f.send('перенеси его на завтра', {...move, title: 'Встреча с Иваном'}, voice);
    assert.equal(f.events[2].event_at, '2099-12-01T15:00:00.000Z');
    assert.equal(first.event_at, '2099-11-23T10:00:00.000Z'); assert.equal(second.event_at, '2099-11-24T10:00:00.000Z');
  });
  for (const action of ['delete_recurring_event', 'reschedule_recurring_event', 'rename_event']) {
    test(`${mode}: ${action} never picks the first of two identically named series`, async () => {
      const f = fixture(); const first = template(f, 101, 1, '10:00'); const second = template(f, 102, 4, '18:00');
      const raw = action === 'delete_recurring_event' ? 'удали все повторы встречи с Иваном'
        : action === 'rename_event' ? 'переименуй встречу с Иваном в «Совещание»'
        : 'перенеси встречу с Иваном на 1 декабря в 15:00 навсегда';
      const before = {...first};
      await f.send(raw, {...move, intent: action === 'reschedule_recurring_event' ? 'reschedule_event' : action}, voice);
      pending(f, 'template'); assert.match(f.replies.at(-1), /10:00[\s\S]*18:00/);
      assert.deepEqual(first, before); assert.equal(f.templates.length, 2);
      await f.send('в 18:00', {}, voice);
      assert.deepEqual(first, before);
      if (action === 'delete_recurring_event') assert.ok(!f.templates.includes(second));
      if (action === 'reschedule_recurring_event') assert.equal(second.time, '15:00');
      if (action === 'rename_event') assert.equal(second.title, 'Совещание');
    });
  }
}

test('strict word matching allows cases, short names, and distinguishes Ivan from Ivanov', () => {
  assert.ok(titleMatches('Встреча с Иваном', 'встречу Иваном'));
  assert.ok(titleMatches('Встреча с Яном', 'встреча Ян'));
  assert.equal(titleMatches('Встреча с Ивановым', 'встреча Иваном'), false);
  assert.equal(titleMatches('Встреча с Петром', 'встреча Иваном'), false);
});

test('numeric dates, source times and quoted office names parse without losing constraints', () => {
  const q = parseSelector('встреча с Иваном 23.11.2099 в 10-30', '+05:00');
  assert.equal(q.date, '2099-11-23'); assert.equal(q.time, '10:30');
  const renamed = parseRename('переименуй встречу 23 ноября 2099 в 10:00 в Обсуждение');
  assert.equal(renamed.new_title, 'Обсуждение');
  assert.equal(parseSelector(renamed.title, '+05:00').time, '10:00');
  assert.equal(parseRename('переименуй «встреча в офисе» в «Друзья навсегда» навсегда').new_title, 'Друзья навсегда');
});

test('deleted selected record is not replaced with a context event', async () => {
  const f = fixture(); const first = event(f, 'Встреча с Иваном'); const second = event(f, 'Встреча с Иваном', '2099-11-24T10:00:00.000Z');
  await f.send('удали встречу с Иваном', {intent: 'delete_event'}); pending(f);
  f.events.splice(f.events.indexOf(first), 1);
  await f.send('1', {});
  assert.ok(f.events.includes(second)); assert.equal(f.events.length, 1);
  assert.match(f.replies.at(-1), /Не нашёл/);
});

test('cancellation and invalid number cannot execute a pending action', async () => {
  const f = fixture(); event(f, 'Встреча'); event(f, 'Встреча', '2099-11-24T10:00:00.000Z');
  await f.send('удали встречу', {intent: 'delete_event'}); pending(f);
  await f.send('9', {}); pending(f); assert.equal(f.events.length, 2);
  await f.send('отмена', {}); assert.equal(f.ctx.pending, null); assert.equal(f.events.length, 2);
});


test('selected event is retained through a second question for reschedule time', async () => {
  const f = fixture(); const first = event(f, 'Встреча с Иваном'); const second = event(f, 'Встреча с Иваном', '2099-11-24T10:00:00.000Z');
  await f.send('перенеси встречу с Иваном', {intent: 'reschedule_event'}); pending(f);
  await f.send('1', {});
  assert.equal(f.ctx.pending.type, 'reschedule_time');
  await f.send('завтра в 15:00', move);
  assert.equal(first.event_at, '2099-12-01T15:00:00.000Z');
  assert.equal(second.event_at, '2099-11-24T10:00:00.000Z');
});

test('selected series is retained through a second question for new schedule', async () => {
  const f = fixture(); const first = template(f, 101, 1); const second = template(f, 102, 4);
  await f.send('перенеси встречу с Иваном навсегда', {intent: 'reschedule_event'}); pending(f, 'template');
  await f.send('2', {});
  assert.equal(f.ctx.pending.type, 'reschedule_time');
  await f.send('завтра в 15:00', move);
  assert.equal(first.time, '10:00'); assert.equal(second.time, '15:00');
});

test('new command discards a pending deletion even when model fails', async () => {
  const f = fixture(); event(f, 'Встреча'); event(f, 'Встреча', '2099-11-24T10:00:00.000Z');
  await f.send('удали встречу', {intent: 'delete_event'}); pending(f);
  f.parseFailure = true;
  await f.send('создай задачу', {intent: 'create_event'});
  assert.equal(f.ctx.pending, null); assert.equal(f.events.length, 2);
  f.parseFailure = false;
  await f.send('1', {intent: 'unknown'});
  assert.equal(f.events.length, 2);
});

test('source weekday and simple hour distinguish two identically named series', async () => {
  const f = fixture(); const first = template(f, 101, 1, '10:00'); const second = template(f, 102, 3, '18:00');
  await f.send('удали все повторы встречи с Иваном по средам в 18', {intent: 'delete_recurring_event', title: 'встреча', refers_to_last: true});
  assert.ok(f.templates.includes(first)); assert.ok(!f.templates.includes(second));
});

test('source date chooses a series by its occurrence, not by unrelated context', async () => {
  const f = fixture(); const first = template(f, 101, 1); const second = template(f, 102, 4);
  event(f, first.title, '2099-11-23T10:00:00.000Z').recurring_id = first.id;
  event(f, second.title, '2099-11-24T10:00:00.000Z').recurring_id = second.id;
  await f.send('удали все повторы встречи с Иваном 23 ноября 2099', {intent: 'delete_recurring_event', title: 'встреча', refers_to_last: true});
  assert.ok(!f.templates.includes(first)); assert.ok(f.templates.includes(second));
});

test('no matching series does not delete or rename a partially matching series', async () => {
  for (const action of ['delete_recurring_event', 'reschedule_recurring_event', 'rename_event']) {
    const f = fixture(); const peter = template(f, 101, 1, '10:00', 'Встреча с Петром');
    const before = {...peter};
    const commands = {delete_recurring_event: 'удали все повторы встречи с Иваном', reschedule_recurring_event: 'перенеси встречу с Иваном на завтра навсегда', rename_event: 'переименуй встречу с Иваном в Обсуждение'};
    await f.send(commands[action], {...move, intent: action});
    assert.deepEqual(peter, before); assert.equal(f.templates.length, 1); assert.match(f.replies.at(-1), /Не нашёл/);
  }
});

test('conflicting source times never silently select the last mentioned time', async () => {
  const f = fixture(); event(f, 'Встреча', '2099-11-23T10:00:00.000Z'); event(f, 'Встреча', '2099-11-23T11:00:00.000Z');
  await f.send('удали встречу в 10:00 в 11:00', {intent: 'delete_event'});
  assert.equal(f.events.length, 2); assert.match(f.replies.at(-1), /Не нашёл/);
});


test('quoted source title containing a destination-like phrase is not truncated', async () => {
  const f = fixture(); const selected = event(f, 'Встреча на 5 этаже'); const context = event(f, 'Встреча с Петром');
  await f.send('перенеси «Встреча на 5 этаже» на завтра', move);
  assert.equal(selected.event_at, '2099-12-01T15:00:00.000Z');
  assert.equal(context.event_at, '2099-11-23T10:00:00.000Z');
});

test('quoted old title keeps words such as forever, and the new title is preserved', async () => {
  const f = fixture(); const selected = event(f, 'Друзья навсегда'); const other = event(f, 'Друзья');
  await f.send('переименуй «Друзья навсегда» в «Встреча в офисе»', {intent: 'rename_event'});
  assert.equal(selected.title, 'Встреча в офисе'); assert.equal(other.title, 'Друзья');
});

test('selection uses chat-local date and time across UTC day boundary', async () => {
  const f = fixture(); f.tz = '+05:00';
  const selected = event(f, 'Встреча', '2099-11-23T20:30:00.000Z');
  const other = event(f, 'Встреча', '2099-11-24T20:30:00.000Z');
  await f.send('удали встречу 24 ноября 2099 в 01:30', {intent: 'delete_event'});
  assert.ok(!f.events.includes(selected)); assert.ok(f.events.includes(other));
});

test('rename offers both a standalone event and series and resumes the chosen kind', async () => {
  const f = fixture(); const series = template(f, 101); const single = event(f, series.title);
  await f.send('переименуй встречу с Иваном в Совещание', {intent: 'rename_event'});
  assert.equal(f.ctx.pending.type, 'choose_event');
  assert.deepEqual(Array.from(f.ctx.pending.choices, c => c.kind), ['template', 'event']);
  await f.send('2', {});
  assert.equal(single.title, 'Совещание'); assert.equal(series.title, 'Встреча с Иваном');
});

test('case matching supports names in instrumental and genitive forms', () => {
  assert.ok(titleMatches('Звонок с Сергеем', 'звонок Сергей'));
  assert.ok(titleMatches('Встреча с Марией', 'встреча Мария'));
  assert.ok(titleMatches('Встреча с Николаем', 'встреча Николая'));
});

test('after deleting a named event, a pronoun cannot silently fall back to earlier context', async () => {
  const f = fixture(); event(f, 'Встреча с Иваном'); const peter = event(f, 'Встреча с Петром');
  await f.send('удали встречу с Иваном', {intent: 'delete_event', refers_to_last: true});
  assert.equal(f.ctx.last_event_id, null);
  await f.send('перенеси его на завтра', move);
  assert.equal(peter.event_at, '2099-11-23T10:00:00.000Z');
  assert.match(f.replies.at(-1), /Не помню/);
});

test('rename still preserves quoted forever words and office names across quote styles', () => {
  for (const suffix of ['', ' навсегда', ' насовсем']) {
    for (const [open, close] of [['«', '»'], ['"', '"'], ['“', '”'], ['„', '”'], ["'", "'"]]) {
      for (const separator of ['в', 'на']) {
        assert.deepEqual(parseRename(`переименуй ${open}встреча в офисе${close} ${separator} ${open}Друзья навсегда${close}${suffix}.`), {
          title: 'встреча в офисе', new_title: 'Друзья навсегда', refers_to_last: false,
        });
      }
    }
  }
});

test('fallback from a series move to ordinary events still executes the selected ordinary event', async () => {
  const f = fixture(); const first = event(f, 'Встреча'); const second = event(f, 'Встреча', '2099-11-24T10:00:00.000Z');
  await f.send('перенеси встречу на завтра навсегда', move); pending(f);
  await f.send('2', {});
  assert.equal(first.event_at, '2099-11-23T10:00:00.000Z');
  assert.equal(second.event_at, '2099-12-01T15:00:00.000Z');
});

for (const action of ['rename_event', 'cancel_reminder', 'set_reminder']) {
  test(`${action}: duplicate events remain unchanged until a choice, then only chosen event changes`, async () => {
    const f = fixture(); const first = event(f, 'Встреча с Иваном'); const second = event(f, 'Встреча с Иваном', '2099-11-24T10:00:00.000Z');
    const before = {...first};
    const commands = {rename_event: 'переименуй встречу с Иваном в Обсуждение', cancel_reminder: 'не напоминай про встречу с Иваном', set_reminder: 'измени напоминание про встречу с Иваном за 30 минут'};
    await f.send(commands[action], {intent: action, refers_to_last: true}); pending(f);
    assert.deepEqual(first, before);
    assert.equal(second.title, 'Встреча с Иваном'); assert.equal(eventOffset(second), 60);
    await f.send('2', {});
    assert.deepEqual(first, before);
    if (action === 'rename_event') assert.equal(second.title, 'Обсуждение');
    if (action === 'cancel_reminder') assert.equal(second.remind_at, null);
    if (action === 'set_reminder') assert.equal(eventOffset(second), 30);
  });
}
