// Обработчик погоды (intent weather).
const { sendMessage } = require("../telegram");
const { getWeatherText, resolveWeatherPlace } = require("../weather");

// Берём место из самого сообщения, а не из region, куда модель может перенести старый город.
function weatherRequest(text) {
  const raw = String(text || "").trim();
  let rest = raw
    .replace(/(?:на|в)\s+\d{1,2}[:.\-]\d{2}/giu, " ")
    .replace(/(?<!\p{L})(?:а|и|какая|какой|какую|что|как|там|погода|погоду|погодой|прогноз|прогноза|погоды|будет|будут|с|сейчас|сегодня|завтра|послезавтра|утром|днём|днем|вечером|ночью|покажи|скажи|расскажи|пожалуйста|мне|нас|ждёт|ждет|ожидается|ожидать)(?!\p{L})/giu, " ")
    .replace(/(?<!\p{L})(?:в|на)\s+(?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)(?!\p{L})/giu, " ")
    .replace(/[?!:;«»".]/g, " ")
    .replace(/\s+/g, " ").trim()
    .replace(/(?:^|\s)(?:в|во|на|для|по)$/iu, "").trim()
    .replace(/^(?:в|во|для|по|городе|город|г\.)\s+/iu, "")
    .replace(/^городе\s+/iu, "").trim();
  const location = rest.match(/(?:^|\s)(?:в|во|для)\s+(?:городе\s+)?(.+)$/iu);
  if (location) rest = location[1].trim();
  return { region: rest || null, continuation: !rest && /^а\s/iu.test(raw) };
}

async function handleWeather(chatId, parsed, ctx, patch, text) {
  const request = weatherRequest(text);
  const continuation = request.continuation && ctx.pending?.type !== "weather_region";
  const region = request.region || (continuation ? ctx.last_region : null);
  let offsetDays = Number.isFinite(parsed.weather_offset_days) ? parsed.weather_offset_days :
    (continuation ? ctx.last_weather_offset_days || 0 : ctx.pending?.weather_offset_days || 0);
  if (/послезавтра/iu.test(text)) offsetDays = 2;
  else if (/завтра/iu.test(text)) offsetDays = 1;
  else if (/сегодня/iu.test(text)) offsetDays = 0;
  else if (continuation && /утром|вечером|дн[её]м|ночью/iu.test(text)) offsetDays = ctx.last_weather_offset_days || 0;

  if (!region) {
    await sendMessage(chatId, "Для какого города показать погоду? Напиши название — например, «Пермь».");
    patch.pending = { type: "weather_region", weather_offset_days: offsetDays };
    return;
  }

  const resolved = continuation && ctx.last_weather_place
    ? { place: ctx.last_weather_place }
    : await resolveWeatherPlace(region);
  if (!resolved.place) {
    await sendMessage(chatId, resolved.ambiguous
      ? "Какой именно город? Уточни страну или область."
      : `Не нашёл город «${region}». Какой город ты имеешь в виду?`);
    patch.pending = { type: "weather_region", weather_offset_days: offsetDays };
    return;
  }
  const reply = await getWeatherText(resolved.place, offsetDays, parsed.weather_part_of_day, parsed.weather_hour);
  await sendMessage(chatId, reply);
  if (reply.startsWith("📍")) {
    patch.last_region = resolved.place.name;
    patch.last_weather_place = resolved.place;
    patch.last_weather_offset_days = offsetDays;
  }
}

module.exports = { handleWeather };
