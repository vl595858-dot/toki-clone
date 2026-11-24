const { resolvePlace, placeLabel, matchesAdmin, normalize, stripCity } = require('./places');

const CITY_UNAVAILABLE = 'Геокодер временно недоступен. Повтори название города чуть позже.';
const CANCEL = /^(?:отмена|отмени|стоп)[.!?]*$/iu;
function showChoices(choices) {
  const labels = choices.map(placeLabel);
  return 'Какой именно город? Напиши номер, область или страну.\n' +
    choices.map((place, i) => {
      const details = labels.filter(label => label === labels[i]).length > 1
        ? ' (' + (place.areas.slice(1).join(', ') || (place.lat.toFixed(2) + ', ' + place.lon.toFixed(2))) + ')' : '';
      return (i+1) + '. ' + labels[i] + details;
    }).join('\n');
}

async function cityAnswer(text, pending = {}) {
  if (CANCEL.test(text.trim())) return {closed:true, reply:'Уточнение города отменено.'};
  const choices = pending.choices || [];
  const raw = stripCity(text);
  const number = /^(?:номер\s*|№\s*)?(\d+)[.)]?$/iu.exec(raw);
  if (number && choices[+number[1]-1]) return {place:choices[+number[1]-1]};
  const parts = raw.split(/[,;]+/u).map(s => s.trim()).filter(Boolean);
  const matches = choices.filter(place => parts.length && parts.every(part =>
    matchesAdmin(place, part) || normalize(place.name) === normalize(part)));
  if (matches.length === 1) return {place:matches[0]};
  const retry = pending.attempts || 0;
  let outcome = {};
  if (!matches.length && !number && raw && normalize(raw) !== normalize(pending.query)) outcome = await resolvePlace(raw);
  else if (pending.retry && raw) outcome = await resolvePlace(raw);
  if (outcome.place) return outcome;
  if (outcome.unavailable) return {reply:CITY_UNAVAILABLE, state:{...pending, query:raw, retry:true}};
  if (outcome.choices) return {reply:showChoices(outcome.choices), state:{query:raw, choices:outcome.choices, attempts:0}};
  if (retry >= 1) return {closed:true, reply:'Не удалось определить город. Начни новый запрос с названием города и областью или страной.'};
  const candidates = matches.length ? matches : choices;
  return {
    state:{...pending, query:raw, choices:candidates, attempts:retry+1},
    reply:candidates.length ? showChoices(candidates)
      : 'Не нашёл город «' + raw + '». Какой город ты имеешь в виду? Укажи область или страну.',
  };
}

module.exports = { cityAnswer, CITY_UNAVAILABLE };
