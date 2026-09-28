const DAY_LABELS = ["сегодня", "завтра", "послезавтра"];
const MONTHS_GEN = [
  "января","февраля","марта","апреля","мая","июня",
  "июля","августа","сентября","октября","ноября","декабря",
];

// окна времени суток (часы по местному времени города): [from, to)
const PARTS = {
  morning: { from: 6, to: 12, label: "утром" },
  day: { from: 9, to: 21, label: "днём" }, // по умолчанию для будущих дней
  evening: { from: 18, to: 24, label: "вечером" },
  night: { from: 0, to: 6, label: "ночью" },
  all: { from: 0, to: 24, label: "за сутки" },
};

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

function precipVerdictNow(currentPrecip, hourlyProb) {
  if (currentPrecip && currentPrecip > 0) return "идут прямо сейчас";
  const maxProb = hourlyProb && hourlyProb.length ? Math.max(...hourlyProb) : 0;
  if (maxProb >= 50) return `возможны в ближайшие часы (~${Math.round(maxProb)}%)`;
  if (maxProb >= 20) return `маловероятны (~${Math.round(maxProb)}%)`;
  return "не ожидаются";
}

function precipVerdictPeriod(prob) {
  const p = Math.round(prob || 0);
  if (p >= 50) return `вероятны (~${p}%)`;
  if (p >= 20) return `возможны (~${p}%)`;
  return "не ожидаются";
}

async function getWeatherText(region, offsetDaysRaw, partRaw) {
  if (!region) return "Уточни город или регион, для которого нужна погода.";
  const offsetDays = Number.isFinite(offsetDaysRaw) ? Math.max(0, Math.min(7, offsetDaysRaw)) : 0;
  const partKey = PARTS[partRaw] ? partRaw : null;

  const place = await geocode(region);
  if (!place) return `Не нашёл такое место: «${region}». Попробуй написать иначе.`;

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
    `&current=temperature_2m,precipitation,wind_speed_10m` +
    `&hourly=temperature_2m,precipitation_probability,wind_speed_10m` +
    `&forecast_days=8&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) return "Не удалось получить погоду, попробуй позже.";
  const data = await res.json();

  const place2 = place.country ? `${place.name}, ${place.country}` : place.name;
  const times = (data.hourly && data.hourly.time) || [];

  // «сейчас» — только для сегодняшнего дня без уточнения времени суток
  if (offsetDays === 0 && !partKey) {
    const temp = Math.round(data.current.temperature_2m);
    const wind = Math.round(data.current.wind_speed_10m);
    // текущий час считаем по времени самого города, а не сервера
    const nowKey = String(data.current.time || "").slice(0, 13) + ":00";
    const nowIdx = Math.max(0, times.indexOf(nowKey));
    const hourlyProb = (data.hourly.precipitation_probability || []).slice(nowIdx, nowIdx + 6);
    const verdict = precipVerdictNow(data.current.precipitation, hourlyProb);
    return (
      `📍 ${place2}\n` +
      `🌡 Сейчас: ${temp}°C\n` +
      `💨 Ветер: ${wind} м/с\n` +
      `🌧 Осадки: ${verdict}`
    );
  }

  const dates = Array.from(new Set(times.map((t) => t.slice(0, 10))));
  if (dates.length === 0) return "Не удалось получить прогноз на этот день, попробуй позже.";
  const dateStr = dates[Math.min(offsetDays, dates.length - 1)];

  const part = PARTS[partKey || "day"];
  const idxs = [];
  times.forEach((t, i) => {
    if (t.slice(0, 10) !== dateStr) return;
    const hour = Number(t.slice(11, 13));
    if (hour >= part.from && hour < part.to) idxs.push(i);
  });
  if (idxs.length === 0) return "Не удалось получить прогноз на этот день, попробуй позже.";

  const nums = (arr) => idxs.map((i) => arr && arr[i]).filter((v) => Number.isFinite(v));
  const temps = nums(data.hourly.temperature_2m);
  const winds = nums(data.hourly.wind_speed_10m);
  const probs = nums(data.hourly.precipitation_probability);
  if (temps.length === 0) return "Не удалось получить прогноз на этот день, попробуй позже.";

  const tMin = Math.round(Math.min(...temps));
  const tMax = Math.round(Math.max(...temps));
  const tempText = tMin === tMax ? `${tMin}` : `${tMin}…${tMax}`;
  const wind = winds.length ? Math.round(Math.max(...winds)) : 0;
  const prob = probs.length ? Math.max(...probs) : 0;

  return (
    `📍 ${place2}\n` +
    `📅 ${dayLabel(offsetDays, dateStr)} ${part.label}\n` +
    `🌡 ${tempText}°C\n` +
    `💨 Ветер до ${wind} м/с\n` +
    `🌧 Осадки: ${precipVerdictPeriod(prob)}`
  );
}

module.exports = { getWeatherText };
