const DAY_LABELS = ["сегодня", "завтра", "послезавтра"];
const MONTHS_GEN = [
  "января","февраля","марта","апреля","мая","июня",
  "июля","августа","сентября","октября","ноября","декабря",
];

function dayLabel(offsetDays, dateStr) {
  if (offsetDays >= 0 && offsetDays <= 2) return DAY_LABELS[offsetDays];
  const [, m, d] = dateStr.split("-").map(Number);
  return `${d} ${MONTHS_GEN[m - 1]}`;
}

async function geocode(region) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    region
  )}&count=1&language=ru&format=json`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.results || !data.results.length) return null;
  const r = data.results[0];
  return { lat: r.latitude, lon: r.longitude, name: r.name, country: r.country };
}

function precipVerdict(currentPrecip, hourlyProb) {
  if (currentPrecip && currentPrecip > 0) return "идут прямо сейчас";
  const maxProb = hourlyProb && hourlyProb.length ? Math.max(...hourlyProb) : 0;
  if (maxProb >= 50) return `возможны в ближайшие часы (~${Math.round(maxProb)}%)`;
  if (maxProb >= 20) return `маловероятны (~${Math.round(maxProb)}%)`;
  return "не ожидаются";
}

function precipVerdictDaily(prob) {
  const p = Math.round(prob || 0);
  if (p >= 50) return `вероятны (~${p}%)`;
  if (p >= 20) return `возможны (~${p}%)`;
  return "не ожидаются";
}

async function getWeatherText(region, offsetDaysRaw) {
  if (!region) return "Уточни город или регион, для которого нужна погода.";
  const offsetDays = Number.isFinite(offsetDaysRaw) ? Math.max(0, Math.min(7, offsetDaysRaw)) : 0;

  const place = await geocode(region);
  if (!place) return `Не нашёл такое место: «${region}». Попробуй написать иначе.`;

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
    `&current=temperature_2m,precipitation,wind_speed_10m` +
    `&hourly=precipitation_probability` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max` +
    `&forecast_days=8&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) return "Не удалось получить погоду, попробуй позже.";
  const data = await res.json();

  const place2 = place.country ? `${place.name}, ${place.country}` : place.name;

  if (offsetDays === 0) {
    const temp = Math.round(data.current.temperature_2m);
    const wind = Math.round(data.current.wind_speed_10m);
    const nowHourIndex = new Date().getHours();
    const hourlyProb = (data.hourly.precipitation_probability || []).slice(
      nowHourIndex,
      nowHourIndex + 6
    );
    const verdict = precipVerdict(data.current.precipitation, hourlyProb);
    return (
      `📍 ${place2}\n` +
      `🌡 Сейчас: ${temp}°C\n` +
      `💨 Ветер: ${wind} м/с\n` +
      `🌧 Осадки: ${verdict}`
    );
  }

  const idx = Math.min(offsetDays, (data.daily.time || []).length - 1);
  if (idx < 0) return "Не удалось получить прогноз на этот день, попробуй позже.";

  const dateStr = data.daily.time[idx];
  const tMax = Math.round(data.daily.temperature_2m_max[idx]);
  const tMin = Math.round(data.daily.temperature_2m_min[idx]);
  const wind = Math.round(data.daily.wind_speed_10m_max[idx]);
  const precipProb = data.daily.precipitation_probability_max[idx];

  return (
    `📍 ${place2}\n` +
    `📅 ${dayLabel(offsetDays, dateStr)}\n` +
    `🌡 ${tMin}…${tMax}°C\n` +
    `💨 Ветер до ${wind} м/с\n` +
    `🌧 Осадки: ${precipVerdictDaily(precipProb)}`
  );
}

module.exports = { getWeatherText };
