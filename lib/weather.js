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

async function getWeatherText(region) {
  if (!region) return "Уточни город или регион, для которого нужна погода.";
  const place = await geocode(region);
  if (!place) return `Не нашёл такое место: «${region}». Попробуй написать иначе.`;

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
    `&current=temperature_2m,precipitation,wind_speed_10m` +
    `&hourly=precipitation_probability&forecast_days=1&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) return "Не удалось получить погоду, попробуй позже.";
  const data = await res.json();

  const temp = Math.round(data.current.temperature_2m);
  const wind = Math.round(data.current.wind_speed_10m);
  const nowHourIndex = new Date().getHours();
  const hourlyProb = (data.hourly.precipitation_probability || []).slice(
    nowHourIndex,
    nowHourIndex + 6
  );

  const verdict = precipVerdict(data.current.precipitation, hourlyProb);
  const place2 = place.country ? `${place.name}, ${place.country}` : place.name;

  return (
    `📍 ${place2}\n` +
    `🌡 Сейчас: ${temp}°C\n` +
    `💨 Ветер: ${wind} м/с\n` +
    `🌧 Осадки: ${verdict}`
  );
}

module.exports = { getWeatherText };
