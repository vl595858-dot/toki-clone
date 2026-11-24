const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/ё/g, 'е')
  .replace(/[\p{Pd}_.]/gu, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const compact = value => normalize(value).replace(/ /g, '');

const aliases = {
  'спб': 'санкт-петербург', 'питер': 'санкт-петербург', 'питере': 'санкт-петербург',
  'петербург': 'санкт-петербург', 'петербурге': 'санкт-петербург', 'ленинград': 'санкт-петербург',
  'мск': 'москва', 'екб': 'екатеринбург', 'нск': 'новосибирск',
  'нижний': 'нижний новгород', 'новасибирск': 'новосибирск',
  'new york': 'нью-йорк', 'dubai': 'дубай', 'delhi': 'дели', 'cape town': 'кейптаун',
  'bangkok': 'бангкок', 'new delhi': 'нью-дели', 'st petersburg': 'saint petersburg',
};
const alternateName = key => Object.hasOwn(aliases, key) ? aliases[key] : undefined;
const countries = {
  россия: 'RU', рф: 'RU', russia: 'RU', сша: 'US', usa: 'US', 'united states': 'US',
  'соединенные штаты': 'US', 'соединенные штаты америки': 'US', великобритания: 'GB',
  англия: 'GB', uk: 'GB', 'united kingdom': 'GB', оаэ: 'AE', uae: 'AE',
  'объединенные арабские эмираты': 'AE', канада: 'CA', франция: 'FR', германия: 'DE',
  'новая зеландия': 'NZ', грузия: 'GE',
};

function stripCity(value) {
  return String(value || '').trim().replace(/^(?:а\s+)?(?:(?:я\s+(?:живу\s+)?в|я\s+из|в|во|из)\s+)?(?:(?:город(?:е|а)?\s+|г(?:\.\s*|\s+)))/iu, '')
    .replace(/^(?:а\s+)?(?:я\s+(?:живу\s+)?в|я\s+из|в|во|из)\s+/iu, '').replace(/^[«" ]+|[»"?!;. ]+$/gu, '');
}

function wordForms(word) {
  if (/^(?:на|де|ла|ле|сан|нью|дон)$/u.test(word)) return [word];
  const forms = [word];
  const endings = [
    [/(?:нем|нему)$/u, ['ний', 'ный']], [/(?:ном|ному)$/u, ['ный']],
    [/(?:ском|ского|скому)$/u, ['ский']], [/(?:цком|цкого)$/u, ['цкий']],
    [/(?:ых|их)$/u, ['ые', 'ие']], [/(?:ах|ях)$/u, ['ы', 'и']],
    [/це$/u, ['ец']], [/е$/u, ['', 'а', 'ь', 'я', 'й']], [/и$/u, ['ь', 'а', 'я']],
    [/а$/u, ['', 'о']], [/у$/u, ['', 'а']], [/я$/u, ['ь', 'я']],
    [/ом$/u, ['', 'ый', 'ий']], [/ою$/u, ['а']], [/ью$/u, ['ь']],
  ];
  for (const [ending, replacements] of endings) {
    const base = word.replace(ending, '');
    if (word !== base && base.length >= 2) forms.push(...replacements.map(suffix => base + suffix));
  }
  return [...new Set(forms)];
}

function nameForms(city) {
  const words = normalize(city).split(' ');
  // Only the last word varies in «на Дону» and «на Амуре» after the preposition.
  const forms = words.map((word, index) => words[index - 1] === 'на' && word === 'дону'
    ? ['дону'] : wordForms(word));
  let variants = [{words: [], cost: 0}];
  for (const part of forms) {
    variants = variants.flatMap(v => part.map((word, i) => ({
      words: [...v.words, word], cost: v.cost + (i ? 1 + i / 10 : 0),
    }))).sort((a,b) => a.cost - b.cost).slice(0, 36);
  }
  return variants.map(v => ({name:v.words.join(' '), cost:v.cost}));
}

const latin = 'a b v g d e zh z i y k l m n o p r s t u f kh ts ch sh shch _ y _ e yu ya'.split(' ');
const transliterate = value => compact(value).replace(/[а-я]/g, letter => latin[letter.charCodeAt(0) - 1072]).replace(/[_y]/g, c => c === 'y' ? 'i' : '');
const foldedLatin = value => transliterate(value).normalize('NFD').replace(/\p{M}/gu, '');
function nearSpelling(a, b) {
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length !== b.length) {
    if (b.length > a.length) [a,b] = [b,a];
    return a.slice(i+1) === b.slice(i);
  }
  return a.slice(i+1) === b.slice(i+1) ||
    (a[i] === b[i+1] && a[i+1] === b[i] && a.slice(i+2) === b.slice(i+2));
}

function adminKey(value) {
  return normalize(value).split(' ').map(word => word
    .replace(/^(?:обл|область|области|край|крае|края|штат|state|province|республика|республике)$/u, '')
    .replace(/(?:ская|ской|ский|ского|скую)$/u, 'ск')
    .replace(/(?<=.{3})[еиуы]$/u, '')).filter(Boolean).join(' ');
}
function matchesAdmin(place, query) {
  const normal = normalize(query).replace(/^(?:в|во|из)\s+/u, '');
  if (!normal) return false;
  if (Object.hasOwn(countries, normal)) return place.countryCode === countries[normal];
  if (normal === normalize(place.countryCode)) return true;
  const key = adminKey(normal);
  return [place.country, ...place.areas].some(value => normalize(value) === normal ||
    (key && (key === adminKey(value) || foldedLatin(key) === foldedLatin(adminKey(value)))));
}
const placeLabel = place => [...new Set([place.name, place.region, place.country].filter(Boolean))].join(', ');
const TOOK_TOO_LONG = 6500;
function asPlace(row) {
  return {
    id: row.id, lat: row.latitude, lon: row.longitude, name: row.name, country: row.country,
    countryCode: row.country_code, region: row.admin1,
    areas: [row.admin1, row.admin2, row.admin3, row.admin4].filter(Boolean),
    timezone: row.timezone, population: row.population || 0, feature: row.feature_code || '',
  };
}
const isCenter = place => /^PPLA[234]?$|^PPLC$/u.test(place.feature);
const rank = place => place.population + (isCenter(place) ? 1000 : 0);
function nearby(a, b) {
  return a.countryCode === b.countryCode && a.region === b.region && a.areas[1] === b.areas[1] && a.timezone === b.timezone &&
    compact(a.name) === compact(b.name) &&
    Math.hypot(a.lat - b.lat, (a.lon - b.lon) * Math.cos(a.lat * Math.PI / 180)) < 0.03;
}

function select(rows, city, qualifiers, forms, fuzzy) {
  const scored = rows.filter(r => Number.isFinite(r.latitude) && Number.isFinite(r.longitude) && r.name &&
    (!r.feature_code || /^PPL/u.test(r.feature_code) && !/^PPL[QXH]$/u.test(r.feature_code))).map(asPlace)
    .filter(p => qualifiers.every(q => matchesAdmin(p, q))).map(place => {
      const name = compact(alternateName(normalize(place.name)) || place.name);
      const exact = forms.find(form => compact(form.name) === name || foldedLatin(form.name) === foldedLatin(place.name));
      const stemmed = !exact && nameForms(place.name).find(form => compact(form.name) === compact(city));
      const typo = fuzzy && nearSpelling(compact(city), name);
      return {place, score: exact ? (exact.cost ? 1 : 0) : stemmed ? 1 : typo ? 2 : Infinity};
    }).filter(r => Number.isFinite(r.score)).sort((a,b) => a.score - b.score || rank(b.place) - rank(a.place));
  if (!scored.length) return null;
  const choices = [];
  for (const {place, score} of scored) {
    if (score !== scored[0].score || choices.some(p => (p.id !== undefined && p.id === place.id) || nearby(p, place))) continue;
    choices.push(place);
  }
  const [first, second] = choices;
  const decisive = !second || (first.population >= 100000 && second.population > 0 &&
    first.population >= second.population * 15) || (second.population === 0 &&
    (first.population >= 500000 || (first.population >= 10000 && isCenter(first) && !isCenter(second))));
  if (decisive && (!fuzzy || scored[0].score < 2 || first.population >= 10000)) return {place:first};
  return {choices:choices.slice(0,5)};
}

async function resolvePlace(input) {
  const raw = stripCity(input);
  if (!raw || raw.length > 150 || !/\p{L}/u.test(raw)) return {};
  const [cityInput, ...explicit] = raw.split(/[,;]+/u).map(s => s.trim()).filter(Boolean);
  if (!cityInput) return {};
  const parts = cityInput.split(/\s+/u);
  let splits = [{city:cityInput, qualifiers:explicit}];
  if (!explicit.length) {
    const qualified = [];
    for (let i = parts.length - 1; i > 0 && i >= parts.length - 5; i--) {
      const suffix = parts.slice(i).join(' ');
      const prefix = parts.slice(0,i).join(' ').replace(/\s+(?:в|во|in)$/iu, '');
      const split = {city:prefix, qualifiers:[suffix]};
      if (Object.hasOwn(countries, normalize(suffix)) || /(?:област[ьи]|кра[йея]|республи[кц][аеуы]|штат)(?!\p{L})/iu.test(suffix)) {
        // Take the suffix after a preposition, or the usual «adjective + область».
        if (prefix !== parts.slice(0,i).join(' ') || parts.length - i === 2 || Object.hasOwn(countries, normalize(suffix))) qualified.push(split);
      } else if (parts.length - i <= 2) splits.push(split);
    }
    if (qualified.length) splits = qualified;
  }
  const signal = AbortSignal.timeout(TOOK_TOO_LONG);
  const searches = new Map();
  async function search(name, language) {
    const key = language + ":" + name;
    if (!searches.has(key)) searches.set(key, (async () => {
      const res = await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' +
        encodeURIComponent(name) + '&count=30&language=' + language + '&format=json', {signal});
      if (!res.ok) throw new Error('Geocoder unavailable');
      return (await res.json()).results || [];
    })());
    return searches.get(key);
  }
  try {
    for (const {city:cityRaw, qualifiers} of splits) {
      const key = normalize(stripCity(cityRaw));
      const florida = qualifiers.some(q => /^(?:флорида|florida)$/iu.test(q));
      const foreignPetersburg = florida && /^(?:санкт петербург|st petersburg|saint petersburg)$/u.test(key);
      const city = foreignPetersburg ? 'saint petersburg' : alternateName(key) || key;
      const language = /^[a-z]/u.test(city) ? 'en' : 'ru';
      const filters = foreignPetersburg ? qualifiers.map(q => normalize(q) === 'флорида' ? 'Florida' : q) : qualifiers;
      const forms = nameForms(city);
      // Hyphens in a name can change what GeoNames returns.
      const query = foreignPetersburg ? city : alternateName(key) || stripCity(cityRaw).toLowerCase().replace(/ё/g, 'е');
      const initial = await search(query, language);
      const terms = [...new Set([normalize(city), normalize(city).replace(/ /g, '-'),
        ...(foreignPetersburg ? ['st. petersburg', 'petersburg'] : []),
        ...forms.slice(1, 19).map(f => query.includes('-') ? f.name.replace(/ /g, '-') : f.name)])]
        .filter(name => name !== query);
      const rows = [...initial];
      const matched = select(rows, city, filters, forms, false);
      // Exact matches already present for a direct or qualified lookup.
      if (matched && rows.some(r => compact(r.name) === compact(city) && filters.every(q => matchesAdmin(asPlace(r), q)))) return matched;
      for (let i=0; i<terms.length; i+=5) {
        rows.push(...(await Promise.all(terms.slice(i,i+5).map(name => search(name, language)))).flat());
        const result = select(rows, city, filters, forms, false);
        if (result && (result.place || i + 5 >= terms.length)) return result;
      }
      if (splits.length === 1) {
        const match = select(rows, city, filters, forms, true);
        if (match) return match;
        // Recover a few common transcription confusions when search itself returns no close name.
        const alternatives = {а:'о', о:'а', е:'и', и:'е'};
        const guesses = [...city].flatMap((letter, i) => i > 0 && alternatives[letter]
          ? [city.slice(0,i) + alternatives[letter] + city.slice(i+1)] : []).slice(0,5);
        if (city.length >= 7) {
          const extra = (await Promise.all(guesses.map(name => search(name, language)))).flat();
          return select(extra, city, filters, forms, true) || {};
        }
        return {};
      }
      if (splits[0].city === cityRaw && !qualifiers.length) {
        const typo = select(rows, city, [], forms, true);
        if (typo) return typo;
      }
    }
    return {};
  } catch {
    return {unavailable:true};
  }
}

function offsetForZone(zone, instant = new Date()) {
  if (!zone) return null;
  try {
    const value = new Intl.DateTimeFormat('en', { timeZone:zone, timeZoneName:'longOffset' })
      .formatToParts(instant).find(part => part.type === 'timeZoneName').value;
    if (value === 'GMT') return '+00:00';
    return /^GMT[+-]\d\d:\d\d$/u.test(value) ? value.slice(3) : null;
  } catch { return null; }
}

// A document's wall time may differ from the offset on the day it was uploaded.
function offsetAtLocalTime(zone, date, time = '12:00') {
  const wall = Date.parse(date + 'T' + time + ':00Z');
  if (!Number.isFinite(wall)) return null;
  const minutes = offset => (offset[0] === '-' ? -1 : 1) * (+offset.slice(1,3)*60 + +offset.slice(4));
  const offsets = new Set([-1,0,1].map(day => offsetForZone(zone, new Date(wall + day*86400000))).filter(Boolean));
  const valid = [...offsets].filter(offset => offsetForZone(zone, new Date(wall - minutes(offset)*60000)) === offset);
  return valid.length === 1 ? valid[0] : null;
}

module.exports = { resolvePlace, placeLabel, matchesAdmin, normalize, stripCity, offsetForZone, offsetAtLocalTime };
