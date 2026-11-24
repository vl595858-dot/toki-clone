const { sendMessage } = require('../telegram');
const { getWeatherForecast } = require('../weather');
const { weatherRequest, weatherSchedule } = require('../weatherRequest');
const { isNewCommand } = require("../targetQuery");
const { cityAnswer } = require('../placeDialog');

function isWeatherCommand(text) {
  if (isNewCommand(text) && !/^(?:а\s+)?(?:какая|какой|какую|погода|покажи|скажи|расскажи|прогноз)(?!\p{L})/iu.test(text.trim())) return false;
  return weatherRequest(text).explicit;
}

function shouldHandleWeather(text, ctx) {
  return isWeatherCommand(text) || Boolean(weatherRequest(text).continuation &&
    (ctx.last_weather_place || ctx.pending?.type === 'weather_region'));
}

async function handleWeather(chatId, ctx, patch, text) {
  const request = weatherRequest(text);
  const waiting = ctx.pending?.type === 'weather_region' && !request.explicit ? ctx.pending : null;
  const continuation = !waiting && request.continuation && ctx.last_weather_place;
  const schedule = weatherSchedule(request, waiting?.schedule || (continuation ? ctx.last_weather_schedule : null));
  const say = reply => sendMessage(chatId, reply);
  if (schedule.invalid) {
    if (waiting) patch.pending = waiting;
    return say('Укажи одну корректную дату и время прогноза.');
  }
  const placeText = /^(?:отмена|отмени|стоп)[.!?]*$/iu.test(text.trim()) ? text.trim() : request.region;
  let place = continuation;
  if (placeText) {
    const result = await cityAnswer(placeText, waiting?.city);
    if (!result.place) {
      if (!result.closed) patch.pending = {type:'weather_region', schedule, city:result.state};
      return say(result.reply);
    }
    place = result.place;
  }
  if (!place) {
    patch.pending = {type:'weather_region', schedule, city:waiting?.city};
    return say(waiting?.city?.choices?.length
      ? 'Сохранил дату и время. Напиши номер города из списка или название с областью.'
      : 'Для какого города показать погоду? Напиши название и, если нужно, область.');
  }
  const {reply, dates} = await getWeatherForecast(place, schedule);
  await say(reply);
  patch.last_region = place.name;
  patch.last_weather_place = place;
  patch.last_weather_schedule = dates ? {...schedule, day:{dates}} : schedule;
}

module.exports = { handleWeather, shouldHandleWeather, isWeatherCommand };
