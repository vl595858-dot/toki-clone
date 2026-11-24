const assert = require('node:assert/strict');
const {fixture} = require('./mockServices');
const saved = require('../fixtures/open-meteo.json');

function weatherServices(voice = false, useSaved = true) {
  const geocodes = [], forecasts = [], missing = [];
  const flags = {noWeather:false, noGeocoder:false};
  const places = useSaved ? {} : {
    'пермь': [{id:1, name:'Пермь', latitude:58, longitude:56, country:'Россия', timezone:'Asia/Yekaterinburg'}],
    'москва': [{id:2, name:'Москва', latitude:55, longitude:37, country:'Россия', timezone:'Europe/Moscow'}],
    'киров': [
      {id:3, name:'Киров', latitude:58, longitude:49, country:'Россия', admin1:'Кировская область', timezone:'Europe/Kirov'},
      {id:4, name:'Киров', latitude:54, longitude:34, country:'Россия', admin1:'Калужская область', timezone:'Europe/Moscow'},
    ],
  };
  const f = fixture({now:'2026-11-24T11:00:00Z', fetch:async raw => {
    const url = new URL(raw);
    if (url.hostname === 'geocoding-api.open-meteo.com') {
      if (flags.noGeocoder) return {ok:false};
      const city = url.searchParams.get('name');
      geocodes.push(city);
      const key = [city,url.searchParams.get('count'),url.searchParams.get('language')].join('|');
      if (useSaved && !(key in saved) && !(city in places)) missing.push(key);
      return {ok:true,json:async () => ({results:places[city] || (useSaved && saved[key]) || []})};
    }
    assert.equal(url.hostname, 'api.open-meteo.com');
    forecasts.push(url.searchParams.get('latitude'));
    if (flags.noWeather) throw new Error('network unavailable');
    const time = [];
    for (let day = 24; day <= 29; day++) {
      for (let hour = 0; hour < 24; hour++) time.push('2026-11-' + day + 'T' + String(hour).padStart(2,'0') + ':00');
    }
    return {ok:true,json:async () => ({
      current:{time:time[12],temperature_2m:5,wind_speed_10m:2,precipitation:0},
      hourly:{time,temperature_2m:time.map(() => 5),wind_speed_10m:time.map(() => 2),
        precipitation_probability:time.map(() => 0)},
    })};
  }});
  return Object.assign(f, {geocodes,forecasts,places,flags,missing,context:() => f.ctx,
    async say(text, model = {intent:'weather',region:'Пермь',weather_offset_days:0}) {
      await f.send(text, model, voice);
      return f.replies.at(-1);
    },
  });
}

module.exports = {weatherServices};
