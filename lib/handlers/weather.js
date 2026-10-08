// Обработчик погоды (intent weather).
const { sendMessage } = require("../telegram");
const { getWeatherText } = require("../weather");

async function handleWeather(chatId, parsed, ctx, patch) {
  const region = parsed.region || ctx.last_region || null;
  const offsetDays = Number.isFinite(parsed.weather_offset_days) ? parsed.weather_offset_days : 0;

  if (!region) {
    await sendMessage(chatId, "Для какого города показать погоду? Напиши название — например, «Пермь».");
    patch.pending = { type: "weather_region", weather_offset_days: offsetDays };
    return;
  }

  const reply = await getWeatherText(region, offsetDays, parsed.weather_part_of_day, parsed.weather_hour);
  await sendMessage(chatId, reply);
  if (reply.startsWith("📍")) {
    patch.last_region = region;
    patch.last_weather_offset_days = offsetDays;
  }
}

module.exports = { handleWeather };
