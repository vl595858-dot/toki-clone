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

const normalizePlace = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").trim();

function cityForms(city) {
  const name = normalizePlace(city).replace(/^(?:в|во)\s+/u, "");
  // Частые формы, где одного изменения окончания недостаточно.
  const known = { "москве": "москва", "москву": "москва", "москвы": "москва", "перми": "пермь", "пермью": "пермь" };
  const forms = [known[name] || name];
  if (!known[name]) {
    if (name.endsWith("е")) forms.push(name.slice(0, -1), name.slice(0, -1) + "а", name.slice(0, -1) + "ь");
    if (name.endsWith("и")) forms.push(name.slice(0, -1) + "ь", name.slice(0, -1) + "а");
    if (name.endsWith("ом")) forms.push(name.slice(0, -2));
  }
  return [...new Set(forms)];
}

async function resolveWeatherPlace(region) {
  const [city, ...qualifiers] = String(region || "").split(",").map(s => s.trim());
  if (!city) return { place: null };
  const forms = cityForms(city);
  const matches = new Map();
  for (const form of forms) {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(form)}&count=10&language=ru&format=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`);
    const data = await res.json();
    for (const result of data.results || []) {
      // Не принимаем похожее, но другое название из нечёткого поиска геокодера.
      if (!forms.includes(normalizePlace(result.name))) continue;
      const location = [result.country, result.admin1, result.admin2].map(normalizePlace);
      if (!qualifiers.every(q => location.includes(normalizePlace(q)))) continue;
      const key = result.id ?? `${result.latitude},${result.longitude}`;
      matches.set(key, result);
    }
    // Точное название имеет приоритет над предположениями об окончании.
    if (matches.size) break;
  }
  if (matches.size !== 1) return { place: null, ambiguous: matches.size > 1 };
  const r = [...matches.values()][0];
  return { place: { lat: r.latitude, lon: r.longitude, name: r.name, country: r.country } };
}

async function geocode(region) {
  return (await resolveWeatherPlace(region)).place;
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

async function getWeatherText(region, offsetDaysRaw, partRaw, hourRaw) {
  if (!region) return "Уточни город или регион, для которого нужна погода.";
  const offsetDays = Number.isFinite(offsetDaysRaw) ? Math.max(0, Math.min(7, offsetDaysRaw)) : 0;
  const partKey = PARTS[partRaw] ? partRaw : null;
  let hour = Number.isInteger(hourRaw) && hourRaw >= 0 && hourRaw <= 23 ? hourRaw : null;
  // день назван, а время нет (и время суток тоже) — показываем погоду на полдень
  if (hour === null && !partKey && offsetDays > 0) hour = 12;

  const resolved = typeof region === "object" ? { place: region } : await resolveWeatherPlace(region);
  const place = resolved.place;
  if (!place) return resolved.ambiguous
    ? "Какой именно город? Уточни страну или область."
    : `Не нашёл город «${region}». Какой город ты имеешь в виду?`;

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
    `&current=temperature_2m,precipitation,wind_speed_10m` +
    `&hourly=temperature_2m,precipitation_probability,wind_speed_10m` +
    `&wind_speed_unit=ms&forecast_days=8&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) return "Не удалось получить погоду, попробуй позже.";
  const data = await res.json();

  const place2 = place.country ? `${place.name}, ${place.country}` : place.name;
  const times = (data.hourly && data.hourly.time) || [];

  // «сейчас» — только для сегодняшнего дня без уточнения времени суток и часа
  if (offsetDays === 0 && !partKey && hour === null) {
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

  // конкретный час: показываем значения именно на этот час
  if (hour !== null) {
    const hIdx = times.findIndex((t) => t.slice(0, 10) === dateStr && Number(t.slice(11, 13)) === hour);
    const hTemp = hIdx === -1 ? null : data.hourly.temperature_2m && data.hourly.temperature_2m[hIdx];
    if (!Number.isFinite(hTemp)) return "Не удалось получить прогноз на этот час, попробуй позже.";
    const hWind = data.hourly.wind_speed_10m && data.hourly.wind_speed_10m[hIdx];
    const hProb = data.hourly.precipitation_probability && data.hourly.precipitation_probability[hIdx];
    const hh = String(hour).padStart(2, "0");
    return (
      `📍 ${place2}\n` +
      `📅 ${dayLabel(offsetDays, dateStr)} в ${hh}:00\n` +
      `🌡 ${Math.round(hTemp)}°C\n` +
      `💨 Ветер ${Number.isFinite(hWind) ? Math.round(hWind) : 0} м/с\n` +
      `🌧 Осадки: ${precipVerdictPeriod(hProb)}`
    );
  }

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

/* Определяет настоящий часовой пояс по названию города — тот же бесплатный
   геокодер, что и для погоды, плюс поле utc_offset_seconds из прогноза.
   Возвращает { offset: "+05:00", placeName } или null, если город не нашёлся. */
async function getTimezoneOffsetForCity(region) {
  if (!region) return null;
  const place = await geocode(region);
  if (!place) return null;

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&timezone=auto&forecast_days=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const totalSec = data.utc_offset_seconds;
  if (!Number.isFinite(totalSec)) return null;

  const sign = totalSec < 0 ? "-" : "+";
  const abs = Math.abs(totalSec);
  const hh = String(Math.floor(abs / 3600)).padStart(2, "0");
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, "0");
  const offset = `${sign}${hh}:${mm}`;

  const placeName = place.country ? `${place.name}, ${place.country}` : place.name;
  return { offset, placeName };
}

module.exports = { getWeatherText, getTimezoneOffsetForCity, resolveWeatherPlace };
