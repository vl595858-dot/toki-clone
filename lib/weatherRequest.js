const { MONTHS_GEN } = require('./constants');
const { isValidDate } = require('./time');

const WEATHER = /(?<!\p{L})(?:погод[ауыеой]|прогноз(?:а)?)(?!\p{L})/iu;
const PARTS = { утром:'morning', днем:'day', вечером:'evening', ночью:'night' };
const DAYS = ['воскресенье','понедельник','вторник','среду','четверг','пятницу','субботу'];
const NUMBERS = { один:1, одну:1, два:2, две:2, три:3, четыре:4, пять:5, шесть:6, семь:7, восемь:8,
  девять:9, десять:10, одиннадцать:11, двенадцать:12, тринадцать:13, четырнадцать:14, пятнадцать:15, сутки:1 };

function weatherRequest(text) {
  const raw = String(text || '').trim();
  const request = { explicit: WEATHER.test(raw) };
  const word = (expression, flags = 'giu') => new RegExp('(?<![\\p{L}\\d])(?:' + expression + ')(?![\\p{L}\\d])', flags);
  let rest = raw.toLowerCase().replace(/ё/g, 'е').replace(/[?!]+$/gu, '');
  const setDay = day => {
    if (request.day && JSON.stringify(request.day) !== JSON.stringify(day)) request.invalid = true;
    request.day = day;
  };
  const setHour = (hour, minute = '00') => {
    if (hour > 23 || +minute > 59) request.invalid = true;
    request.hour = hour;
    request.minute = +minute;
  };
  rest = rest
    .replace(word('в\\s+(\\d{1,2})[:.\\-](\\d{2})(?![.\\-]\\d)'), (_, h, m) => {setHour(+h,m);return ' ';})
    .replace(word('(\\d{1,2}):(\\d{2})'), (_, h, m) => {setHour(+h,m);return ' ';})
    .replace(word('(?:на\\s+)?(\\d{4}-\\d\\d-\\d\\d)'), (_, date) => {setDay({date});return ' ';})
    .replace(word('(?:на\\s+)?(\\d{1,2})\\s+(' + MONTHS_GEN.join('|') + ')(?:\\s+(\\d{4})(?:\\s+года)?)?'),
      (_, d,m,y) => {setDay({month:MONTHS_GEN.indexOf(m)+1, day:+d, year:y});return ' ';})
    .replace(word('(?:на\\s+)?(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{4}))?'),
      (_, d,m,y) => {setDay({month:+m,day:+d,year:y});return ' ';})
    .replace(word('через\\s+(сутки|(?:\\d+|' + Object.keys(NUMBERS).filter(n => n !== 'сутки').join('|') + ')(?=\\s+(?:день|дня|дней|суток|сутки)))(?:\\s+(?:день|дня|дней|суток|сутки))?'),
      (_, n) => {setDay({offset:NUMBERS[n] ?? +n});return ' ';})
    .replace(word('(?:на\\s+)?(послезавтра|завтра|сегодня|вчера)'), (_, d) => {
      setDay({offset:{вчера:-1,сегодня:0,завтра:1,послезавтра:2}[d]});return ' ';
    })
    .replace(word('(?:на\\s+выходных|в\\s+выходные|на\\s+выходные)'), () => {setDay({weekend:true});return ' ';})
    .replace(word('(?:в|во|на)\\s+(' + DAYS.join('|') + ')'), (_, day) => {setDay({weekday:DAYS.indexOf(day)});return ' ';})
    .replace(word('в\\s+(\\d{1,2})(?:\\s+(утра|дня|вечера|ночи))?'), (_, h,p) => {
      setHour(+h < 12 && /^(?:дня|вечера)$/u.test(p) ? +h+12 : +h);return ' ';
    })
    .replace(word('(утром|днем|вечером|ночью|за\\s+сутки|весь\\s+день|в\\s+течение\\s+суток)'), (_, p) => {
      request.part = PARTS[p] || 'all';return ' ';
    })
    .replace(word('сейчас'), () => {request.now = true;return ' ';});
  rest = rest.replace(word('а|и|какая|какой|какую|что|как|там|погода|погоду|погодой|погоды|прогноз|прогноза|будет|будут|покажи|скажи|расскажи|пожалуйста|мне|нас|ждет|ожидается|ожидать'), ' ')
    .replace(/[«»"]/gu,' ').replace(/\s+/g,' ').replace(/^[ ,]+|[ ,.!?]+$/g,'')
    .replace(/(?:^|\s)(?:в|во|на|для|по)$/iu,'').trim().replace(/^(?:в|во|для|по)\s+/iu,'').trim();
  request.region = rest || null;
  request.continuation = !request.explicit && ((!rest && (request.day || request.part || request.hour !== undefined || request.now)) || /^а\s+(?:в|во)\s+/iu.test(raw) && Boolean(rest));
  return request;
}

const dateAt = (today, days) => {
  if (!Number.isInteger(days) || Math.abs(days) > 36600) return null;
  return new Date(Date.parse(today + 'T12:00:00Z') + days * 86400000).toISOString().slice(0,10);
};
function forecastDates(day, today) {
  if (!day) return [today];
  if (day.dates) return day.dates;
  if (day.date) return [day.date];
  if (day.month !== undefined) {
    const year = day.year || today.slice(0,4);
    const suffix = '-' + String(day.month).padStart(2,'0') + '-' + String(day.day).padStart(2,'0');
    const date = year + suffix;
    if (!day.year && date < today) return [String(+year+1) + suffix];
    return [date];
  }
  const weekday = new Date(today + 'T12:00:00Z').getUTCDay();
  if (day.weekend) {
    if (weekday === 0) return [today];
    const saturday = dateAt(today, 6-weekday);
    return [saturday,dateAt(today,7-weekday)];
  }
  if (day.weekday !== undefined) return [dateAt(today, (day.weekday-weekday+7)%7)];
  return [dateAt(today,day.offset)];
}

function localDate(instant, zone) {
  try {
    const parts = new Intl.DateTimeFormat('en', {timeZone:zone || 'UTC', year:'numeric', month:'2-digit', day:'2-digit'})
      .formatToParts(instant);
    return ['year','month','day'].map(type => parts.find(p => p.type === type).value).join('-');
  } catch { return new Date(instant).toISOString().slice(0,10); }
}

function weatherSchedule(request, previous, now = Date.now()) {
  const date = request.now ? null : request.day || previous?.day;
  const time = request.now ? {} : request.hour !== undefined ? {hour:request.hour, minute:request.minute}
    : request.part ? {part:request.part} : previous ? {hour:previous.hour, minute:previous.minute, part:previous.part} : {};
  return { day:date, ...time, at:request.day ? now : previous?.at ?? now, invalid:request.invalid };
}

module.exports = { weatherRequest, weatherSchedule, forecastDates, localDate, isValidDate };
