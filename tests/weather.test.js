const {test} = require('node:test');
const assert = require('node:assert/strict');
const {weatherServices} = require('./helpers/weatherServices');
const fixture = voice => weatherServices(voice, false);

for (const voice of [false, true]) {
  const mode = voice ? 'voice transcript' : 'text';
  test(`${mode}: Пермь → в Москве → А завтра? → А вечером?`, async () => {
    const f = fixture(voice);
    assert.match(await f.say('Какая погода в Перми?'), /📍 Пермь/);
    assert.match(await f.say('Какая погода в Москве на сегодня?'), /📍 Москва/);
    assert.equal(f.context().last_region, 'Москва');
    assert.match(await f.say('А завтра?'), /📍 Москва[\s\S]*завтра/);
    assert.match(await f.say('А вечером?'), /📍 Москва[\s\S]*завтра вечером/);
    assert.deepEqual(f.forecasts, ['58', '55', '55', '55']);
    assert.ok(f.geocodes.includes('пермь') && f.geocodes.includes('москва'));
    assert.equal(f.geocodes.filter(query => query === 'москве').length, 1);
  });

  test(`${mode}: unknown city asks without falling back to Moscow or trusting a fuzzy match`, async () => {
    const f = fixture(voice);
    await f.say('Погода в Москве');
    f.places['неизвестноград'] = [{id: 10, name: 'Другой город', latitude: 1, longitude: 2}];
    assert.match(await f.say('Погода в Неизвестноград'), /Не нашёл город[\s\S]*Какой город/);
    assert.equal(f.context().last_region, 'Москва');
    assert.equal(f.context().pending.type, 'weather_region');
    assert.equal(f.forecasts.length, 1);
    assert.match(await f.say('Погода в Ненайденске'), /Не нашёл город[\s\S]*Какой город/);
    assert.equal(f.context().last_region, 'Москва');
    assert.equal(f.forecasts.length, 1);
    assert.match(await f.say('Пермь'), /📍 Пермь/);
    assert.equal(f.context().last_region, 'Пермь');
  });

  test(`${mode}: equally suitable cities require clarification and accept an oblast`, async () => {
    const f = fixture(voice);
    await f.say('Погода в Москве');
    assert.match(await f.say('Какая погода в Кирове?'), /Какой именно город/);
    assert.equal(f.context().last_region, 'Москва');
    assert.equal(f.context().pending.type, 'weather_region');
    assert.equal(f.forecasts.length, 1);
    assert.match(await f.say('Киров, Калужская область'), /📍 Киров/);
    assert.equal(f.forecasts.at(-1), '54');
  });

  test(`${mode}: new request without city does not use previous city`, async () => {
    const f = fixture(voice);
    await f.say('Погода в Москве');
    assert.match(await f.say('Какая погода?'), /Для какого города/);
    assert.equal(f.forecasts.length, 1);
  });
}
