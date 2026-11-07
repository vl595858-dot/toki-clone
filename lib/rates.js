// Курсы для конвертации: фиатные валюты — ЦБ РФ, биткоин — CoinGecko (запасной — Binance).
// Всё считаем через рубль: rubPer[КОД] = сколько рублей стоит 1 единица валюты. Кэш в памяти — 10 минут.
const CODES = ["USD", "EUR", "GBP", "INR", "CNY", "VND", "THB", "AED", "TRY"];
const TTL_MS = 10 * 60 * 1000;

let cache = null; // { at, data }

async function getJson(url, ms = 4000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { "User-Agent": "moidelishki-bot" } });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

// ЦБ РФ через зеркало с JSON; запасной путь — официальный XML (кодировка windows-1251)
async function fetchCbr() {
  try {
    const j = await getJson("https://www.cbr-xml-daily.ru/daily_json.js");
    const out = {};
    for (const c of CODES) {
      const v = j.Valute?.[c];
      if (v && v.Value && v.Nominal) out[c] = v.Value / v.Nominal;
    }
    if (Object.keys(out).length) return { rubPer: out, date: j.Date };
  } catch (e) {
    console.error("cbr json failed", e);
  }
  const r = await fetch("https://www.cbr.ru/scripts/XML_daily.asp", { signal: AbortSignal.timeout(4000) });
  const xml = new TextDecoder("windows-1251").decode(await r.arrayBuffer());
  const out = {};
  for (const m of xml.matchAll(/<Valute[\s\S]*?<\/Valute>/g)) {
    const code = (m[0].match(/<CharCode>(\w+)<\/CharCode>/) || [])[1];
    const nominal = Number((m[0].match(/<Nominal>(\d+)<\/Nominal>/) || [])[1]);
    const value = Number(((m[0].match(/<Value>([\d,]+)<\/Value>/) || [])[1] || "").replace(",", "."));
    if (CODES.includes(code) && nominal && value) out[code] = value / nominal;
  }
  return { rubPer: out, date: null };
}

async function fetchBtcUsd() {
  try {
    const j = await getJson("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
    if (j?.bitcoin?.usd) return j.bitcoin.usd;
  } catch (e) {
    console.error("coingecko failed", e);
  }
  const j = await getJson("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
  return Number(j.price);
}

async function getRates() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const [cbr, btc] = await Promise.allSettled([fetchCbr(), fetchBtcUsd()]);
  if (cbr.status !== "fulfilled" && cache) return cache.data; // источник недоступен — отдаём прошлые курсы
  if (cbr.status !== "fulfilled") throw cbr.reason;
  const rubPer = { RUB: 1, ...cbr.value.rubPer };
  if (btc.status === "fulfilled" && btc.value && rubPer.USD) rubPer.BTC = btc.value * rubPer.USD;
  const data = { rubPer, updated: new Date().toISOString() };
  cache = { at: Date.now(), data };
  return data;
}

module.exports = { getRates, CODES };
