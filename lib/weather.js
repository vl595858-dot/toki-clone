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

const { placeLabel } = require("./places");
const { forecastDates, localDate, isValidDate } = require("./weatherRequest");
const UNAVAILABLE = "Не удалось получить погоду. Попробуй позже.";

async function getWeatherForecast(place, schedule) {
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=" + place.lat + "&longitude=" + place.lon +
    "&current=temperature_2m,precipitation,wind_speed_10m" +
    "&hourly=temperature_2m,precipitation_probability,wind_speed_10m" +
    "&wind_speed_unit=ms&forecast_days=16&timezone=auto";
  let data;
  try {
    const res = await fetch(url, {signal:AbortSignal.timeout(6000)});
    if (!res.ok) return {reply:UNAVAILABLE};
    data = await res.json();
  } catch { return {reply:UNAVAILABLE}; }

  const today = data.current?.time?.slice(0,10) || localDate(Date.now(), data.timezone || place.timezone);
  const base = localDate(schedule.at, data.timezone || place.timezone);
  const dates = forecastDates(schedule.day, base);
  if (!dates.every(date => typeof date === "string" && isValidDate(date))) return {reply:"Укажи корректную дату прогноза."};
  const title = "📍 " + placeLabel(place);
  const hourly = data.hourly || {};
  const times = hourly.time || [];
  if (!schedule.day && !schedule.part && schedule.hour === undefined && Number.isFinite(data.current?.temperature_2m)) {
    const c = data.current;
    const nowIdx = Math.max(0,times.indexOf(String(c.time || "").slice(0,13) + ":00"));
    const verdict = precipVerdictNow(c.precipitation, (hourly.precipitation_probability || []).slice(nowIdx,nowIdx+6));
    return {reply:[title,"🌡 Сейчас: " + Math.round(c.temperature_2m) + "°C",
      "💨 Ветер: " + Math.round(c.wind_speed_10m) + " м/с", "🌧 Осадки: " + verdict].join("\n"), dates};
  }
  const lines = dates.map(date => {
    const delta = (Date.parse(date) - Date.parse(today)) / 86400000;
    const label = dayLabel(delta,date);
    const part = PARTS[schedule.part] || PARTS.day;
    // Open-Meteo supplies hourly values. Use the containing hour and label it accurately.
    const hour = schedule.hour;
    const indices = times.flatMap((t,i) => {
      const h = +t.slice(11,13);
      return t.slice(0,10) === date && (hour === undefined ? h >= part.from && h < part.to : h === hour) ? [i] : [];
    });
    const nums = arr => indices.map(i => arr?.[i]).filter(Number.isFinite);
    const temps = nums(hourly.temperature_2m);
    if (!temps.length) return "📅 " + label + ": прогноз недоступен" + (hour === undefined ? "." : " на этот час.");
    const atHour = hour !== undefined ? String(hour).padStart(2,"0") + ":00" : null;
    const atMinute = schedule.minute ? atHour.slice(0,3) + String(schedule.minute).padStart(2,"0") : atHour;
    const heading = "📅 " + label + (atHour ? " в " + atMinute + (schedule.minute ? " (данные на " + atHour + ")" : "") : " " + part.label);
    const min = Math.round(Math.min(...temps));
    const max = Math.round(Math.max(...temps));
    const winds = nums(hourly.wind_speed_10m);
    const probs = nums(hourly.precipitation_probability);
    return [heading, "🌡 " + (min === max ? min : min + "…" + max) + "°C",
      winds.length ? "💨 Ветер до " + Math.round(Math.max(...winds)) + " м/с" : null,
      probs.length ? "🌧 Осадки: " + precipVerdictPeriod(Math.max(...probs)) : null].filter(Boolean).join("\n");
  });
  return {reply:[title,...lines].join("\n"), dates};
}

module.exports = { getWeatherForecast };
