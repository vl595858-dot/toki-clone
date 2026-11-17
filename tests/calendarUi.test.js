const {test} = require('node:test');
const assert = require('node:assert/strict');
const {calendarUi, calendarEvent, text, flush} = require('./helpers/calendarUi');
const {fixture} = require('./helpers/mockServices');

test('calendar API returns existing completion state and forbids cached lists', async () => {
  const f = fixture(); const done = f.seed(-1); done.done_at = '2099-05-05T13:00:00.000Z';
  f.seed(0);
  const {response, headers} = await f.api('GET');
  assert.equal(response.events[0].done, true); assert.equal(response.events[0].doneAt, done.done_at);
  assert.equal(response.events[1].done, false); assert.equal(response.events[1].doneAt, null);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.match(f.queries[0].sql, /done_at/);
});

test('focus refresh and other return signals show bot changes and completion, with listener cleanup', async () => {
  const f = await calendarUi({initial: [calendarEvent()]});
  assert.match(f.content(), /Исходное дело/);
  const signals = [[f.window, 'focus'], [f.document, 'visibilitychange'], [f.window, 'pageshow'], [f.telegram, 'activated']];
  for (let i = 0; i < signals.length; i++) {
    const [target, signal] = signals[i];
    await f.emit(target, signal);
    const req = f.pending('GET').at(-1); assert.ok(req, signal); assert.equal(req.options.cache, 'no-store');
    await f.reply(req, {events: [calendarEvent({title: `Из бота ${i}`, done: true, doneAt: '2026-11-17T12:00:00Z'})]});
    assert.match(f.content(), new RegExp(`Из бота ${i}`)); assert.match(f.content(), /✓ Сделано/);
  }
  f.document.visibilityState = 'hidden'; const count = f.requests.length;
  await f.emit(f.document, 'visibilitychange'); assert.equal(f.requests.length, count);
  await f.unmount();
  for (const target of [f.window, f.document, f.telegram]) assert.ok([...target.listeners.values()].every(set => !set.size));
});

test('older GET responses and errors cannot overwrite newer data or error state', async () => {
  const f = await calendarUi(); const old = f.pending('GET').at(-1);
  await f.emit(f.window, 'focus'); const latest = f.pending('GET').at(-1);
  await f.reply(latest, {events: [calendarEvent({title: 'Актуальные данные'})]});
  await f.reply(old, {events: [calendarEvent({title: 'Устаревшие данные'})]});
  assert.match(f.content(), /Актуальные данные/); assert.doesNotMatch(f.content(), /Устаревшие данные/);
  await f.emit(f.window, 'focus'); const failure = f.pending('GET').at(-1);
  await f.emit(f.window, 'focus'); const success = f.pending('GET').at(-1);
  await f.reply(success, {events: [calendarEvent({title: 'Ещё новее'})]});
  await f.reply(failure, {error: 'Старая ошибка'}, 500);
  assert.match(f.content(), /Ещё новее/); assert.doesNotMatch(f.content(), /Старая ошибка/);
  await f.unmount();
});

test('add form stays open on failure, retains all fields during refresh, and retries without double posting', async () => {
  const f = await calendarUi({initial: []}); await f.openAdd();
  await f.change(f.input('Что нужно сделать'), 'Введённый черновик');
  await f.change(f.root().findByProps({type: 'time'}), '16:45');
  await f.change(f.root().findByType('select'), '30');
  const button = f.button('Добавить');
  await flush(() => {button.props.onClick(); button.props.onClick(); f.input('Что нужно сделать').props.onKeyDown({key: 'Enter'});});
  assert.equal(f.pending('POST').length, 1); assert.equal(f.forms().length, 1);
  assert.equal(f.button('Сохраняю…').props.disabled, true);
  assert.equal(f.button('Календарь').props.disabled, true);
  assert.equal(f.buttons().find(b => b.props['aria-label'] === 'Добавить дело').props.disabled, true);
  const first = f.pending('POST')[0]; const body = first.options.body;
  await f.reply(first, {error: 'Временно недоступно'}, 503);
  assert.equal(f.forms().length, 1); assert.equal(f.input('Что нужно сделать').props.value, 'Введённый черновик');
  assert.equal(f.root().findByProps({type: 'time'}).props.value, '16:45');
  assert.equal(f.root().findByType('select').props.value, 30);
  assert.match(f.content(), /Временно недоступно/);
  await f.emit(f.window, 'focus'); await f.reply(f.pending('GET').at(-1), {events: []});
  assert.match(f.content(), /Временно недоступно/); assert.equal(f.input('Что нужно сделать').props.value, 'Введённый черновик');
  await f.click(f.button('Повторить сохранение')); const retry = f.pending('POST').at(-1);
  assert.equal(retry.options.body, body);
  await f.reply(retry, {id: 2, eventAt: '2026-11-17T16:45:00Z'});
  assert.equal(f.forms().length, 0);
  await f.reply(f.pending('GET').at(-1), {events: [calendarEvent({id: 2, title: 'Введённый черновик'})]});
  assert.match(f.content(), /Введённый черновик/); assert.equal(f.requests.filter(r => r.method === 'POST').length, 2);
  await f.unmount();
});

test('edit error survives background loading and successful PATCH closes the form even if the following GET fails', async () => {
  const f = await calendarUi({initial: [calendarEvent({remindOffsetMinutes: 95})]}); await f.openEdit();
  await f.change(f.input('Что нужно сделать'), 'Новый текст'); await f.change(f.root().findByProps({type: 'time'}), '17:20');
  await f.change(f.root().findByType('select'), '-1');
  await f.click(f.button('Сохранить')); const first = f.pending('PATCH').at(-1);
  assert.equal(f.forms().length, 1);
  await f.reply(first, {error: 'Не получилось записать'}, 400);
  assert.match(f.content(), /Не получилось записать/); assert.equal(f.forms().length, 1);
  await f.emit(f.document, 'visibilitychange');
  await f.reply(f.pending('GET').at(-1), {events: [calendarEvent({title: 'Изменено ботом', done: true})]});
  assert.equal(f.input('Что нужно сделать').props.value, 'Новый текст'); assert.match(f.content(), /Не получилось записать/);
  await f.click(f.button('Повторить сохранение')); const retry = f.pending('PATCH').at(-1);
  assert.equal(retry.options.body, first.options.body);
  await f.reply(retry, {ok: true, eventAt: '2026-11-17T17:20:00Z'});
  assert.equal(f.forms().length, 0); assert.match(f.content(), /Новый текст/); assert.match(f.content(), /Сделано/);
  await f.reply(f.pending('GET').at(-1), {error: 'Загрузка недоступна'}, 500);
  assert.match(f.content(), /Не удалось обновить календарь/);
  await f.click(f.button('Повторить загрузку'));
  assert.equal(f.requests.filter(r => r.method === 'PATCH').length, 2);
  await f.reply(f.pending('GET').at(-1), {events: [calendarEvent({title: 'Новый текст', done: true})]});
  assert.doesNotMatch(f.content(), /Загрузка недоступна/);
  await f.unmount();
});

test('GET started before or during a mutation cannot undo the confirmed edit', async () => {
  const f = await calendarUi({initial: [calendarEvent()]}); await f.openEdit();
  await f.change(f.input('Что нужно сделать'), 'Подтверждено');
  await f.emit(f.window, 'focus'); const before = f.pending('GET').at(-1);
  await f.click(f.button('Сохранить')); const patch = f.pending('PATCH').at(-1);
  await f.emit(f.window, 'focus'); const during = f.pending('GET').at(-1);
  await f.reply(patch, {ok: true, eventAt: calendarEvent().eventAt}); const after = f.pending('GET').at(-1);
  await f.reply(during, {events: [calendarEvent({title: 'Старое из параллельного GET'})]});
  await f.reply(before, {events: [calendarEvent()]});
  assert.match(f.content(), /Подтверждено/); assert.doesNotMatch(f.content(), /Старое из параллельного GET/);
  await f.reply(after, {events: [calendarEvent({title: 'Подтверждено'})]});
  await f.unmount();
});

test('move failure keeps date input and retry moves only after acknowledgement', async () => {
  const f = await calendarUi({initial: [calendarEvent()]});
  await f.click(f.buttons().find(b => b.props['aria-label'] === 'Перенести'));
  await f.change(f.root().findByProps({type: 'date'}), '2026-11-20');
  const button = f.button('Перенести'); await flush(() => {button.props.onClick(); button.props.onClick();});
  assert.equal(f.pending('PATCH').length, 1);
  const first = f.pending('PATCH')[0]; await f.reply(first, {error: 'Перенос отклонён'}, 500);
  assert.equal(f.root().findByProps({type: 'date'}).props.value, '2026-11-20'); assert.match(f.content(), /Перенос отклонён/);
  await f.emit(f.window, 'focus'); await f.reply(f.pending('GET').at(-1), {events: [calendarEvent()]});
  assert.match(f.content(), /Перенос отклонён/);
  await f.click(f.button('Повторить перенос')); const retry = f.pending('PATCH').at(-1);
  assert.equal(retry.options.body, first.options.body);
  await f.reply(retry, {ok: true, eventAt: '2026-11-20T14:00:00Z'});
  assert.equal(f.root().findAllByType(f.Move).length, 0);
  await f.unmount();
});

test('delete failure preserves row and error through reload and retry does not double-delete', async () => {
  const f = await calendarUi({initial: [calendarEvent()]}); const button = f.buttons().find(b => b.props['aria-label'] === 'Удалить');
  await flush(() => {button.props.onClick(); button.props.onClick();});
  assert.equal(f.pending('DELETE').length, 1); assert.match(f.content(), /Исходное дело/);
  await f.reply(f.pending('DELETE')[0], {error: 'Удаление недоступно'}, 500);
  await f.emit(f.window, 'focus'); await f.reply(f.pending('GET').at(-1), {events: [calendarEvent()]});
  assert.match(f.content(), /Удаление недоступно/);
  await f.click(f.button('Повторить удаление')); await f.reply(f.pending('DELETE').at(-1), {ok: true});
  assert.doesNotMatch(f.content(), /Исходное дело/); await f.unmount();
});

test('network save failure is understandable and keeps the draft', async () => {
  const f = await calendarUi({initial: []}); await f.openAdd(); await f.change(f.input('Что нужно сделать'), 'Черновик без сети');
  await f.click(f.button('Добавить')); await f.reject(f.pending('POST')[0]);
  assert.match(f.content(), /Проверь соединение/); assert.equal(f.input('Что нужно сделать').props.value, 'Черновик без сети');
  await f.unmount();
});

test('expanded date range ignores a late response for the previous narrower range', async () => {
  const f = await calendarUi(); const narrow = f.pending('GET').at(-1);
  await f.click(f.button('Показать больше дней вперёд')); const wide = f.pending('GET').at(-1);
  assert.notEqual(wide.url, narrow.url);
  await f.reply(wide, {events: [calendarEvent({title: 'Далёкое дело', eventAt: '2026-12-07T14:00:00Z'})]});
  await f.reply(narrow, {events: []}); assert.match(f.content(), /Далёкое дело/);
  await f.unmount();
});

test('returning after midnight refreshes today and the date range', async () => {
  const f = await calendarUi({initial: []}); const oldUrl = f.requests.at(-1).url;
  f.clock.value = Date.parse('2026-11-18T12:00:00Z'); await f.emit(f.window, 'focus');
  const latest = f.pending('GET').at(-1); assert.notEqual(latest.url, oldUrl);
  assert.match(latest.url, /from=2026-11-15/);
  await f.reply(latest, {events: [calendarEvent({title: 'Новое сегодня', eventAt: '2026-11-18T14:00:00Z'})]});
  assert.match(f.content(), /Новое сегодня/); await f.unmount();
});

test('failed editor retains draft and error if a bot moves or deletes its event during refresh', async () => {
  const f = await calendarUi({initial: [calendarEvent()]}); await f.openEdit();
  await f.change(f.input('Что нужно сделать'), 'Сохранённый в форме черновик');
  await f.change(f.root().findByProps({type: 'time'}), '17:30');
  await f.click(f.button('Сохранить')); await f.reply(f.pending('PATCH')[0], {error: 'Запись отклонена'}, 503);
  await f.emit(f.window, 'focus');
  await f.reply(f.pending('GET').at(-1), {events: [calendarEvent({eventAt: '2026-11-20T14:00:00Z', title: 'Перенесено ботом'})]});
  assert.equal(f.forms().length, 1); assert.equal(f.input('Что нужно сделать').props.value, 'Сохранённый в форме черновик');
  assert.match(f.content(), /Запись отклонена/);
  await f.emit(f.window, 'focus'); await f.reply(f.pending('GET').at(-1), {events: []});
  assert.equal(f.forms().length, 1); assert.equal(f.root().findByProps({type: 'time'}).props.value, '17:30');
  assert.match(f.content(), /Запись отклонена/);
  await f.click(f.button('Отмена')); assert.equal(f.forms().length, 0);
  assert.doesNotMatch(f.content(), /Исходное дело/); await f.unmount();
});

test('returning after midnight does not discard an open add draft', async () => {
  const f = await calendarUi({initial: []}); await f.openAdd();
  await f.change(f.input('Что нужно сделать'), 'Черновик на исходный день');
  f.clock.value = Date.parse('2026-11-18T12:00:00Z'); await f.emit(f.window, 'focus');
  await f.reply(f.pending('GET').at(-1), {events: []});
  assert.equal(f.forms().length, 1); assert.equal(f.input('Что нужно сделать').props.value, 'Черновик на исходный день');
  await f.unmount();
});

test('move draft and its error survive a bot moving or deleting the event', async () => {
  const f = await calendarUi({initial: [calendarEvent()]});
  await f.click(f.buttons().find(b => b.props['aria-label'] === 'Перенести'));
  await f.change(f.root().findByProps({type: 'date'}), '2026-11-22');
  await f.click(f.button('Перенести')); await f.reply(f.pending('PATCH')[0], {error: 'Сбой переноса'}, 503);
  await f.emit(f.window, 'focus'); await f.reply(f.pending('GET').at(-1), {events: [calendarEvent({eventAt: '2026-11-21T14:00:00Z'})]});
  assert.equal(f.root().findByProps({type: 'date'}).props.value, '2026-11-22'); assert.match(f.content(), /Сбой переноса/);
  await f.emit(f.window, 'focus'); await f.reply(f.pending('GET').at(-1), {events: []});
  assert.equal(f.root().findByProps({type: 'date'}).props.value, '2026-11-22'); assert.match(f.content(), /Сбой переноса/);
  await f.click(f.button('отмена')); assert.equal(f.root().findAllByType(f.Move).length, 0);
  assert.doesNotMatch(f.content(), /Исходное дело/); await f.unmount();
});
