const {test} = require('node:test');
const assert = require('node:assert/strict');
const {weatherServices} = require('./helpers/weatherServices');
const cases = require('./fixtures/place-cases.json');
const recorded = require('./fixtures/open-meteo.json');

for (const [input, country, id] of cases) {
  test('recorded Open-Meteo: ' + input + ' → ' + id, async () => {
    const f = weatherServices();
    const result = await f.load('lib/places.js').resolvePlace(input);
    assert.equal(result.place?.id, id);
    assert.equal(result.place.countryCode, country);
    assert.deepEqual(f.missing, []);
  });
}

test('qualified names take precedence over the best-known city; duplicates do not crowd out true alternatives', async () => {
  const f = weatherServices();
  const resolve = f.load('lib/places.js').resolvePlace;
  assert.equal((await resolve('Киров в Калужской области')).place?.id,548410);
  const result = await resolve('Киров');
  assert.ok(result.choices.some(p => p.id === 548408));
  assert.ok(result.choices.some(p => p.id === 548410));
  f.places['березовка'] = [
    {id:100,name:'Берёзовка',country_code:'RU',admin1:'Омская область',latitude:51,longitude:71,timezone:'Asia/Omsk'},
    {id:101,name:'Березовка',country_code:'RU',admin1:'Омская область',latitude:51.01,longitude:71,timezone:'Asia/Omsk'},
    {id:102,name:'Березовка',country_code:'RU',admin1:'Томская область',latitude:55,longitude:80,timezone:'Asia/Tomsk'},
  ];
  const duplicate = await resolve('Берёзовка');
  assert.deepEqual(Array.from(duplicate.choices, p => p.id),[100,102]);
});

for (const voice of [false,true]) {
  test('weather requests and continuations preserve the relevant date and time, voice=' + voice, async () => {
    const f = weatherServices(voice);
    f.parseFailure = true; // all these commands work independently of the model
    assert.match(await f.say('Какая погода в Санкт-Петербурге?'), /📍 Санкт-Петербург[^\n]*\n🌡/);
    assert.match(await f.say('Погода в Питере'), /📍 Санкт-Петербург[^\n]*\n🌡/);
    assert.match(await f.say('Погода в Нижнем Новгороде'), /📍 Нижний Новгород/);
    assert.match(await f.say('Погода в Перми 25 ноября'), /📍 Пермь[\s\S]*завтра/);
    assert.match(await f.say('Погода в Москве через два дня'), /📍 Москва[\s\S]*послезавтра/);
    assert.match(await f.say('Погода в Москве на выходных'), /28 ноября[\s\S]*29 ноября/);
    assert.match(await f.say('Погода в Дубае завтра вечером'), /📍 Дубай[\s\S]*завтра вечером/);
    assert.match(await f.say('А завтра?'), /📍 Дубай[\s\S]*завтра вечером/);
    assert.match(await f.say('Завтра?'), /📍 Дубай[\s\S]*завтра вечером/);
    assert.match(await f.say('А вечером?'), /завтра вечером/);
    assert.match(await f.say('А в 20:00?'), /завтра в 20:00/);
    assert.match(await f.say('А через два дня?'), /послезавтра в 20:00/);
    assert.match(await f.say('А в Москве?'), /📍 Москва[\s\S]*послезавтра в 20:00/);
    assert.match(await f.say('Погода в г. Москве'), /📍 Москва[\s\S]*Сейчас/);
  });

  test('weather clarification by area retains date and hour and can switch cities, voice=' + voice, async () => {
    const f = weatherServices(voice);
    assert.match(await f.say('Погода в Кирове 25 ноября в 20:00'), /Кировская[\s\S]*Калужская/i);
    assert.match(await f.say('Калужская область'), /📍 Киров, Калужская[\s\S]*завтра в 20:00/i);
    assert.equal(f.ctx.last_weather_place.id,548410);
    await f.say('Погода в Кирове послезавтра вечером');
    assert.match(await f.say('Пермь'), /📍 Пермь[\s\S]*послезавтра вечером/);
    await f.say('Погода в Кирове');
    assert.match(await f.say('Киров'), /Какой именно город/);
    assert.match(await f.say('Киров'), /Начни новый запрос/);
    assert.equal(f.ctx.pending,null);
  });

  test('timezone through the Telegram route stores qualified choices, survives failure and cancels on commands, voice=' + voice, async () => {
    const f = weatherServices(voice);
    await f.say('/start');
    assert.equal(f.ctx.pending.type,'timezone_city');
    assert.match(await f.say('СПб'), /\+03:00/);
    assert.equal(f.tz,'+03:00');
    await f.say('/timezone');
    assert.match(await f.say('Киров'), /Какой именно город/);
    assert.equal(f.tz,'+03:00');
    const kaluga = f.ctx.pending.city.choices.findIndex(p => p.id === 548410) + 1;
    assert.ok(kaluga > 0);
    assert.match(await f.say(String(kaluga)), /Калужская[\s\S]*\+03:00/i);
    await f.say('/timezone');
    f.flags.noGeocoder = true;
    assert.match(await f.say('Пермь'), /временно недоступен/);
    assert.equal(f.tz,'+03:00');
    assert.equal(f.ctx.pending.type,'timezone_city');
    f.flags.noGeocoder = false;
    assert.match(await f.say('Пермь'), /\+05:00/);
    await f.say('/timezone');
    assert.match(await f.say('Скажи погоду в Москве'), /📍 Москва/);
    assert.equal(f.tz,'+05:00');
    assert.equal(f.ctx.pending,null);
    await f.say('/start');
    assert.equal(f.ctx.pending,null);
    assert.equal(f.tz,'+05:00');
  });
}

test('timezone city names and abbreviations produce expected offsets without a forecast call', async () => {
  const f = weatherServices();
  // A nominative query can use a previously recorded equivalent name from the fixture.
  const ids = {
    'санкт-петербург':498817, 'санкт петербург':498817, москва:524901, пермь:511196,
    екатеринбург:1486209, новосибирск:1496747, владивосток:2013348, дубай:292223, лондон:2643743, дели:1273294,
  };
  const rows = Object.entries(recorded).filter(([key]) => key.endsWith("|ru")).flatMap(([, rows]) => rows);
  for (const [name,id] of Object.entries(ids)) f.places[name] = rows.filter(r => r.id === id).slice(0,1);
  for (const [city,offset] of [
    ['Санкт-Петербург','+03:00'], ['Санкт Петербург','+03:00'], ['Питер','+03:00'], ['СПб','+03:00'],
    ['Москва','+03:00'], ['Пермь','+05:00'], ['Екатеринбург','+05:00'], ['Новосибирск','+07:00'],
    ['Владивосток','+10:00'], ['Дубай','+04:00'], ['Лондон','+00:00'], ['Дели','+05:30'],
  ]) {
    await f.say('/timezone ' + city);
    assert.equal(f.tz,offset,city);
  }
  assert.deepEqual(f.forecasts,[]);
});

test('a new command exits weather city clarification and runs unchanged', async () => {
  const f = weatherServices();
  await f.say('Погода в Кирове');
  await f.say('Запиши встречу на завтра в 15:00', {intent:'create_event',title:'Встреча',event_date:'2026-11-25',event_time:'15:00'});
  assert.equal(f.ctx.pending,null);
  assert.equal(f.events.length,1);
  assert.equal(f.events[0].title,'Встреча');
});

test('forecast API failure and absent dates are visible without falling back to an available day', async () => {
  const f = weatherServices();
  assert.match(await f.say('Погода в Москве 10 декабря'), /10 декабря: прогноз недоступен/);
  assert.doesNotMatch(f.replies.at(-1), /🌡/);
  assert.match(await f.say('Погода в Москве 30 февраля'), /корректную дату/);
  f.flags.noWeather = true;
  assert.match(await f.say('Погода в Москве завтра'), /Не удалось получить погоду/);
});

test('a synthetic ticket waits for an ambiguous city and saves time and reminder with selected city offset', async () => {
  const f = weatherServices(true);
  f.tz = '+05:00';
  await f.photo([{kind:'transport', title:'Билет', date:'2026-12-01', time:'14:30', city:'Киров'}], 'напомни за час');
  assert.equal(f.ctx.pending.step,'city');
  assert.equal(f.events.length,0);
  assert.match(f.replies.at(-1), /Калужская/i);
  assert.match(await f.say('Калужская область'), /14:30 \(местное время\)[\s\S]*16:30/);
  const ok = f.sent.at(-1).options.replyMarkup.inline_keyboard[0][0].callback_data;
  await f.callback(ok);
  assert.equal(f.events[0].event_at,'2026-12-01T11:30:00.000Z');
  assert.equal(f.events[0].remind_at,'2026-12-01T10:30:00.000Z');
});

test('document uses the offset at the event date, including after correction from winter to summer', async () => {
  const f = weatherServices();
  await f.photo([{kind:'transport', title:'Рейс', date:'2026-12-01', time:'14:30', city:'Лондоне'}], 'напомни за час');
  assert.equal(f.ctx.pending.docs[0].tz,'+00:00');
  const fix = f.sent.at(-1).options.replyMarkup.inline_keyboard[0][1].callback_data;
  await f.callback(fix);
  await f.say('дата 2027-07-01');
  assert.equal(f.ctx.pending.docs[0].tz,'+01:00');
  const ok = f.sent.at(-1).options.replyMarkup.inline_keyboard[0][0].callback_data;
  await f.callback(ok);
  assert.equal(f.events[0].event_at,'2027-07-01T13:30:00.000Z');
  assert.equal(f.events[0].remind_at,'2027-07-01T12:30:00.000Z');
});

test('an unavailable geocoder never substitutes the chat timezone for a ticket', async () => {
  const f = weatherServices();
  f.tz = '+05:00';
  f.flags.noGeocoder = true;
  await f.photo([{kind:'transport',title:'Билет',date:'2026-12-01',time:'14:30',city:'Питер'}], 'не напоминай');
  assert.equal(f.ctx.pending.step,'city');
  assert.match(f.replies.at(-1), /временно недоступен/);
  assert.equal(f.events.length,0);
  f.flags.noGeocoder = false;
  await f.say('Питер');
  assert.equal(f.ctx.pending.docs[0].tz,'+03:00');
  assert.equal(f.ctx.pending.step,'confirm');
});

test('a document whose city has no IANA zone asks for a confirmed offset before saving', async () => {
  const f = weatherServices(false,false);
  f.places['городок'] = [{id:11,name:'Городок',latitude:55,longitude:37,country:'Россия'}];
  await f.photo([{kind:'transport',title:'Билет',date:'2026-12-01',time:'14:30',city:'Городок'}], 'не напоминай');
  assert.equal(f.ctx.pending.step,'city');
  assert.equal(f.events.length,0);
  assert.match(f.replies.at(-1), /смещение/);
  await f.say('UTC+03:00');
  const ok = f.sent.at(-1).options.replyMarkup.inline_keyboard[0][0].callback_data;
  await f.callback(ok);
  assert.equal(f.events[0].event_at,'2026-12-01T11:30:00.000Z');
  assert.equal(f.events[0].remind_at,null);
});
