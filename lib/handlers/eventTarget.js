// Общий выбор события/серии для действий. Контекст используется только без конкретных признаков.
const db = require('../db');
const { sendMessage } = require('../telegram');
const { utcIsoToLocalParts, formatDateHuman } = require('../time');
const { WEEKDAY_RU, MONTHS_GEN } = require('../constants');
const { titleWordGroups, titleMatches, titleScore } = require('../targetQuery');

function criteria(parsed) {
  return { ...(parsed.target || {}), title: parsed.target?.title ?? parsed.title ?? null };
}
function isSpecific(parsed) {
  const q = criteria(parsed);
  return !!(q.title || q.date || q.monthDay || q.time || q.weekday !== undefined);
}
function candidateMatches(row, query, tz) {
  if (query.conflict) return false;
  if (query.title && !titleMatches(row.title, query.title)) return false;
  if (row._kind === 'template') {
    if (query.time && row.time !== query.time) return false;
    let weekday = query.weekday;
    if (query.date) weekday = new Date(`${query.date}T12:00:00Z`).getUTCDay();
    if (query.weekday !== undefined && query.date && weekday !== query.weekday) return false;
    if (weekday !== undefined && row.frequency === 'weekly' && row.weekday !== weekday) return false;
    const monthDay = query.monthDay || query.date?.slice(5);
    if (monthDay) {
      const [month, day] = monthDay.split('-').map(Number);
      if (['monthly', 'yearly'].includes(row.frequency) && row.month_day !== day) return false;
      if (row.frequency === 'yearly' && row.month !== month) return false;
    }
    return true;
  }
  const local = utcIsoToLocalParts(row.event_at, tz);
  if (query.date && local.dateStr !== query.date) return false;
  if (query.monthDay && local.dateStr.slice(5) !== query.monthDay) return false;
  if (query.time && local.timeStr !== query.time) return false;
  if (query.weekday !== undefined && new Date(`${local.dateStr}T12:00:00Z`).getUTCDay() !== query.weekday) return false;
  return true;
}

async function findCandidates(chatId, parsed, tz, kind = 'event') {
  const query = criteria(parsed);
  const params = [chatId];
  // AND между словами не позволяет общему «встреча» скрыть несовпавшее имя.
  const conditions = titleWordGroups(query.title || '').map(group => {
    const variants = group.map(word => { params.push(`%${word}%`); return `title ILIKE $${params.length}`; });
    return `(${variants.join(' OR ')})`;
  });
  const table = kind === 'template' ? 'recurring_events' : 'events';
  const window = kind === 'event' && !query.date && !query.monthDay
    ? ` AND event_at >= now() - interval '24 hours'` : '';
  const { rows } = await db.query(
    `SELECT * FROM ${table} WHERE chat_id=$1${conditions.length ? ` AND ${conditions.join(' AND ')}` : ''}${window} ORDER BY ${kind === 'event' ? 'event_at ASC' : 'id ASC'}`,
    params
  );
  if (kind === 'template' && (query.date || query.monthDay)) {
    // Конкретная дата относится к экземпляру серии, в том числе перенесённому отдельно.
    const occurrences = await findCandidates(chatId, parsed, tz);
    const ids = new Set(occurrences.map(ev => ev.recurring_id).filter(Boolean));
    return rows.map(row => ({ ...row, _kind: kind })).filter(row => ids.has(row.id) &&
      (!query.title || titleMatches(row.title, query.title)));
  }
  return rows.map(row => ({ ...row, _kind: kind })).filter(row => candidateMatches(row, query, tz));
}
function result(matches) {
  return matches.length === 1 ? { target: matches[0], matches }
    : { target: null, matches, ambiguous: matches.length > 1, candidates: matches };
}
async function selectedTarget(chatId, selection) {
  const table = selection.kind === 'template' ? 'recurring_events' : 'events';
  const { rows } = await db.query(`SELECT * FROM ${table} WHERE id=$1 AND chat_id=$2`, [selection.id, chatId]);
  return result(rows.map(row => ({ ...row, _kind: selection.kind })));
}

async function resolveTarget(chatId, parsed, ctx, tz = '+05:00') {
  if (parsed._selection) {
    if (parsed._selection.kind !== 'event') return result([]);
    return selectedTarget(chatId, parsed._selection);
  }
  if (isSpecific(parsed)) return result(await findCandidates(chatId, parsed, tz));
  if (parsed.refers_to_last && ctx.last_event_id) return selectedTarget(chatId, {kind: 'event', id: ctx.last_event_id});
  return result([]);
}

async function resolveTemplateTarget(chatId, parsed, ctx, tz = '+05:00') {
  if (parsed._selection) {
    if (parsed._selection.kind !== 'template') return result([]);
    return selectedTarget(chatId, parsed._selection);
  }
  if (isSpecific(parsed)) return result(await findCandidates(chatId, parsed, tz, 'template'));
  if (parsed.refers_to_last && ctx.last_event_id) {
    const { rows } = await db.query(
      `SELECT t.* FROM recurring_events t JOIN events e ON e.recurring_id = t.id WHERE e.id=$1 AND e.chat_id=$2 AND t.chat_id=$2`,
      [ctx.last_event_id, chatId]
    );
    return result(rows.map(row => ({ ...row, _kind: 'template' })));
  }
  return result([]);
}

function candidateLine(ev, tz) {
  if (ev._kind === 'template') {
    const schedule = ev.frequency === 'daily' ? 'каждый день'
      : ev.frequency === 'monthly' ? `каждый месяц ${ev.month_day}-го`
      : ev.frequency === 'yearly' ? `каждый год ${ev.month_day} ${MONTHS_GEN[ev.month - 1]}`
      : `каждую неделю в ${WEEKDAY_RU[ev.weekday]}`;
    return `${ev.emoji || '📌'} ${ev.title} — ${schedule}, ${ev.time}`;
  }
  const local = utcIsoToLocalParts(ev.event_at, tz);
  return `${ev.emoji || '📌'} ${ev.title} — ${formatDateHuman(local.dateStr, local.timeStr)}`;
}
async function askWhich(chatId, parsed, candidates, patch, tz) {
  const lines = candidates.slice(0, 5).map((ev, i) => `${i + 1}. ${candidateLine(ev, tz)}`);
  await sendMessage(chatId, `❓ Какое дело выбрать?\n\n${lines.join('\n')}\n\nНапиши номер или уточни название/дату${candidates.length > 5 ? ' (показал первые пять)' : ''}. «Отмена» — ничего не менять.`);
  patch.pending = {
    type: 'choose_event', parsed: { ...parsed },
    choices: candidates.map(ev => ({kind: ev._kind || 'event', id: ev.id})),
  };
}
async function replyNotFound(chatId, parsed) {
  await sendMessage(chatId, parsed.refers_to_last && !isSpecific(parsed)
    ? 'Не помню, о каком деле речь — назови его, пожалуйста.'
    : `Не нашёл подходящее дело${parsed.title ? ` «${parsed.title}»` : ''} с указанными датой, временем или названием.`);
}

module.exports = { resolveTarget, resolveTemplateTarget, findCandidates, selectedTarget, isSpecific,
  candidateMatches, replyNotFound, askWhich, titleWordGroups, titleScore };
