const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file, mocks, globals = {}, suffix = '') {
  const filename = path.resolve(__dirname, '..', file);
  const module = {exports: {}};
  const source = fs.readFileSync(filename, 'utf8')
    .replace('export const config', 'const config')
    .replace('export const maxDuration', 'const maxDuration')
    .replace('export default async function handler', 'async function handler');
  const sandbox = {module, exports: module.exports, console, process,
    require: name => {
      if (!(name in mocks)) throw new Error(`Unexpected dependency ${name}`);
      return mocks[name];
    }, ...globals};
  vm.runInNewContext(source + suffix, sandbox, {filename});
  return module.exports;
}

function fixture(voice) {
  let ctx = {};
  let text;
  const replies = [];
  const geocodes = [];
  const forecasts = [];
  const places = {
    'пермь': [{id: 1, name: 'Пермь', country: 'Россия', latitude: 58, longitude: 56}],
    'москва': [{id: 2, name: 'Москва', country: 'Россия', latitude: 55, longitude: 37}],
    'киров': [
      {id: 3, name: 'Киров', country: 'Россия', admin1: 'Кировская область', latitude: 58, longitude: 49},
      {id: 4, name: 'Киров', country: 'Россия', admin1: 'Калужская область', latitude: 54, longitude: 34},
    ],
  };
  const weather = load('lib/weather.js', {}, {fetch: async raw => {
    const url = new URL(raw);
    if (url.hostname === 'geocoding-api.open-meteo.com') {
      assert.equal(url.searchParams.get('count'), '10');
      const city = url.searchParams.get('name');
      geocodes.push(city);
      return {ok: true, json: async () => ({results: places[city] || []})};
    }
    assert.equal(url.hostname, 'api.open-meteo.com');
    forecasts.push(url.searchParams.get('latitude'));
    const time = [];
    for (let day = 17; day <= 19; day++) {
      for (let hour = 0; hour < 24; hour++) time.push(`2026-11-${day}T${String(hour).padStart(2, '0')}:00`);
    }
    return {ok: true, json: async () => ({
      current: {time: time[12], temperature_2m: 5, wind_speed_10m: 2, precipitation: 0},
      hourly: {time, temperature_2m: time.map(() => 5), wind_speed_10m: time.map(() => 2), precipitation_probability: time.map(() => 0)},
    })};
  }});
  const telegram = {sendMessage: async (chatId, reply) => {replies.push(reply); return true;}};
  const weatherHandler = load('lib/handlers/weather.js', {'../telegram': telegram, '../weather': weather});
  const mocks = {
    '../../../lib/telegram': telegram,
    '../../../lib/ai': {
      transcribeVoice: async () => text,
      // Deliberately wrong city and day: production code must use explicit user words.
      parseMessage: async () => ({intent: 'weather', region: 'Пермь', weather_offset_days: 0,
        weather_part_of_day: /вечером/iu.test(text) ? 'evening' : null}),
    },
    '../../../lib/context': {loadContext: async () => ctx, saveContext: async (id, value) => {ctx = value;}},
    '../../../lib/settings': {getTzOffset: async () => '+05:00'},
    '../../../lib/text': require('../lib/text'),
    '../../../lib/contextText': {buildContextText: async () => 'Последний город: Пермь'},
    '../../../lib/handlers/weather': weatherHandler,
  };
  // Remaining handlers are not used by these weather requests.
  const route = fs.readFileSync(path.resolve(__dirname, '../pages/api/telegram/[secret].js'), 'utf8');
  for (const match of route.matchAll(/require\("([^"]+)"\)/g)) {
    if (!(match[1] in mocks)) mocks[match[1]] = {};
  }
  const runUpdate = load('pages/api/telegram/[secret].js', mocks, {}, '\nmodule.exports = handleUpdate;');
  return {
    geocodes, forecasts, replies, places,
    context: () => ctx,
    async send(value) {
      text = value;
      await runUpdate({message: {chat: {id: 1}, ...(voice ? {voice: {file_id: 'fake'}} : {text})}});
      return replies.at(-1);
    },
  };
}

for (const voice of [false, true]) {
  const mode = voice ? 'voice transcript' : 'text';
  test(`${mode}: Пермь → в Москве → А завтра? → А вечером?`, async () => {
    const f = fixture(voice);
    assert.match(await f.send('Какая погода в Перми?'), /📍 Пермь/);
    assert.match(await f.send('Какая погода в Москве на сегодня?'), /📍 Москва/);
    assert.equal(f.context().last_region, 'Москва');
    assert.match(await f.send('А завтра?'), /📍 Москва[\s\S]*завтра/);
    assert.match(await f.send('А вечером?'), /📍 Москва[\s\S]*завтра вечером/);
    assert.deepEqual(f.forecasts, ['58', '55', '55', '55']);
    assert.deepEqual(f.geocodes, ['пермь', 'москва']);
  });

  test(`${mode}: unknown city asks without falling back to Moscow or trusting a fuzzy match`, async () => {
    const f = fixture(voice);
    await f.send('Погода в Москве');
    f.places['неизвестноград'] = [{id: 10, name: 'Другой город', latitude: 1, longitude: 2}];
    assert.match(await f.send('Погода в Неизвестноград'), /Не нашёл город[\s\S]*Какой город/);
    assert.equal(f.context().last_region, 'Москва');
    assert.equal(f.context().pending.type, 'weather_region');
    assert.equal(f.forecasts.length, 1);
    assert.match(await f.send('Погода в Ненайденске'), /Не нашёл город[\s\S]*Какой город/);
    assert.equal(f.context().last_region, 'Москва');
    assert.equal(f.forecasts.length, 1);
    assert.match(await f.send('Пермь'), /📍 Пермь/);
    assert.equal(f.context().last_region, 'Пермь');
  });

  test(`${mode}: equally suitable cities require clarification and accept an oblast`, async () => {
    const f = fixture(voice);
    await f.send('Погода в Москве');
    assert.match(await f.send('Какая погода в Кирове?'), /Какой именно город/);
    assert.equal(f.context().last_region, 'Москва');
    assert.equal(f.context().pending.type, 'weather_region');
    assert.equal(f.forecasts.length, 1);
    assert.match(await f.send('Киров, Калужская область'), /📍 Киров/);
    assert.equal(f.forecasts.at(-1), '54');
  });

  test(`${mode}: new request without city does not use previous city`, async () => {
    const f = fixture(voice);
    await f.send('Погода в Москве');
    assert.match(await f.send('Какая погода?'), /Для какого города/);
    assert.equal(f.forecasts.length, 1);
  });
}
