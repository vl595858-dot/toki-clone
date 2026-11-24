// --live fetches missing public Open-Meteo samples. --refresh fetches every query again.
const fs = require('node:fs');
const path = require('node:path');
const cases = require('../tests/fixtures/place-cases.json');
const file = path.join(__dirname, '../tests/fixtures/open-meteo.json');
const baseline = process.env.GEOCODING_BASELINE;
const resolve = baseline
  ? require(baseline).resolveWeatherPlace
  : require('../lib/places').resolvePlace;
const refresh = process.argv.includes('--refresh');
const live = refresh || process.argv.includes('--live');
const samples = !refresh && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const active = new Map();
const fetchLive = fetch;
global.fetch = async (url, options) => {
  const query = new URL(url);
  const key = [query.searchParams.get('name'), query.searchParams.get('count'), query.searchParams.get('language')].join('|');
  if (!live && !Object.hasOwn(samples, key)) throw new Error(`Missing recorded search: ${key}`);
  if (!Object.hasOwn(samples, key)) {
    if (!active.has(key)) active.set(key, (async () => {
      const res = await fetchLive(url, {...options, signal: AbortSignal.timeout(15000)});
      if (!res.ok) throw new Error(`Geocoder HTTP ${res.status}`);
      samples[key] = (await res.json()).results || [];
    })().finally(() => active.delete(key)));
    await active.get(key);
  }
  return {ok: true, json: async () => ({ results: samples[key] })};
};
(async () => {
  let passed = 0;
  try {
    for (let i = 0; i < cases.length; i += 4) {
      const batch = await Promise.all(cases.slice(i, i + 4).map(async ([input, country, id]) => {
        try {
          const r = await resolve(input);
          const place = r.place;
          const source = place?.id !== undefined ? {id:place.id, name:place.name, country_code:place.countryCode}
            : Object.values(samples).flat().find(row => row.latitude === place?.lat && row.longitude === place?.lon);
          return {input, ok: source?.id === id && source?.country_code === country, actual: source?.id, expected: id,
            name: source?.name, options: r.choices?.map(x => [x.id, x.name, x.region, x.country])};
        } catch (error) { return {input, error: error.message}; }
      }));
      for (const result of batch) {
        if (result.ok) passed++;
        else console.log(JSON.stringify(result));
      }
    }
    console.log(passed + "/" + cases.length + " correct direct resolutions");
    if (!baseline && passed !== cases.length) process.exitCode = 1;
  } finally {
    if (live) fs.writeFileSync(file, '{\n' + Object.keys(samples).sort().map(key =>
      '  ' + JSON.stringify(key) + ': ' + JSON.stringify(samples[key])).join(',\n') + '\n}\n');
  }
})();
