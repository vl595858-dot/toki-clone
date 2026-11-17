import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Head from "next/head";
import Script from "next/script";
import {
  todayInOffset,
  toUtcIso,
  formatDateHuman,
  utcIsoToLocalParts,
} from "../lib/time";

const C = {
  paper: "#F2F3EF", card: "#FFFFFF", ink: "#22262A", soft: "#6B7370",
  line: "#DDE0DB", accent: "#2F5D50", accentSoft: "#E4EEE9",
  warn: "#B5502F", warnSoft: "#F5E4DC",
};

const WD = ["воскресенье","понедельник","вторник","среда","четверг","пятница","суббота"];
const MN = ["январь","февраль","март","апрель","май","июнь","июль","август","сентябрь","октябрь","ноябрь","декабрь"];
const MG = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];

const pad = (n) => String(n).padStart(2, "0");
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const addD = (d, n) => { const r = new Date(d); r.setDate(r.getDate()+n); return r; };
const sod = (d) => { const r = new Date(d); r.setHours(0,0,0,0); return r; };
const same = (a,b) => key(a) === key(b);

function heading(d, today) {
  const w = WD[d.getDay()];
  if (same(d, today)) return `Сегодня, ${w}`;
  if (same(d, addD(today,1))) return `Завтра, ${w}`;
  if (same(d, addD(today,-1))) return `Вчера, ${w}`;
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/* Часовой пояс этого браузера/телефона, как видит его сам устройство —
   без спроса геолокации, без разрешений, просто системная настройка. */
function detectTzOffset() {
  const totalMin = -new Date().getTimezoneOffset();
  const sign = totalMin < 0 ? "-" : "+";
  const abs = Math.abs(totalMin);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

let initDataCache = null;

async function api(initData, url, opts = {}) {
  let r;
  try {
    r = await fetch(url, {
      cache: "no-store",
      ...opts,
      headers: {
        "Content-Type": "application/json",
        Authorization: `tma ${initData}`,
        ...(opts.headers || {}),
      },
    });
  } catch (error) {
    throw new Error("Не удалось связаться с сервером. Проверь соединение и повтори попытку.");
  }
  const data = await r.json().catch(() => { throw new Error("Не удалось прочитать ответ сервера. Повтори попытку."); });
  if (!r.ok) throw new Error(typeof data.error === "string" ? data.error : `Ошибка сервера (${r.status}). Повтори попытку.`);
  return data;
}

// Отдельные состояния загрузки и записи: фоновый GET не стирает ошибку формы.
function useCalendarEvents(initData, today, fwd, tzOffset) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [savingCount, setSavingCount] = useState(0);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const mounted = useRef(true);
  const locks = useRef(new Set());
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current++; };
  }, []);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    try {
      const from = toUtcIso(key(addD(today, -3)), "00:00", tzOffset);
      const to = toUtcIso(key(addD(today, fwd + 1)), "00:00", tzOffset);
      const data = await api(initData, `/api/webapp/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      if (!Array.isArray(data.events)) throw new Error("Сервер вернул некорректный список событий.");
      if (!mounted.current || request !== sequence.current) return false;
      setEvents(data.events);
      setError("");
      return true;
    } catch (e) {
      if (mounted.current && request === sequence.current) setError(e.message);
      return false;
    } finally {
      if (mounted.current && request === sequence.current) setLoading(false);
    }
  }, [today, fwd, initData, tzOffset]);
  const latestLoad = useRef(load);
  latestLoad.current = load;
  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (key, url, options, apply) => {
    if (locks.current.has(key)) return false;
    locks.current.add(key);
    sequence.current++; // ответ на GET, начатый до записи, уже не актуален
    setLoading(false);
    setSavingCount(count => count + 1);
    try {
      const result = await api(initData, url, options);
      if (mounted.current) {
        sequence.current++;
        if (apply) setEvents(list => apply(list, result));
        // Запись уже подтверждена. Ошибка этого GET предлагает повторить загрузку, не POST/PATCH.
        latestLoad.current();
      }
      return true;
    } finally {
      locks.current.delete(key);
      if (mounted.current) setSavingCount(count => count - 1);
    }
  }, [initData]);
  return { events, syncing: loading || savingCount > 0, mutating: savingCount > 0, error, load, save };
}

// Ref блокирует второй клик синхронно, до следующей отрисовки React.
function useAction(action) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const run = async (...args) => {
    if (pending.current) return false;
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      const result = await action(...args);
      return mounted.current ? result : false;
    }
    catch (e) {
      if (mounted.current) setError(e.message || "Не удалось сохранить. Повтори попытку.");
      return false;
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  return { saving, error, run, pending };
}

export default function CalendarPage() {
  const [ready, setReady] = useState(false);
  const [initData, setInitData] = useState(null);
  const [tzOffset, setTzOffset] = useState("+03:00");

  useEffect(() => {
    const tg = typeof window !== "undefined" ? window.Telegram?.WebApp : null;
    if (!tg || !tg.initData) {
      setReady(true); // покажем сообщение «открой через бота»
      return;
    }
    tg.ready();
    tg.expand();
    initDataCache = tg.initData;
    setInitData(tg.initData);

    // если у человека уже задан пояс (по городу через бот) — календарь живёт по нему и ничего не перезаписывает.
    // Если пояс ещё ни разу не задавали — берём пояс телефона и запоминаем его для бота.
    (async () => {
      let offset = detectTzOffset();
      try {
        const saved = await api(tg.initData, "/api/webapp/timezone");
        if (saved.custom && saved.offset) {
          offset = saved.offset;
        } else {
          api(tg.initData, "/api/webapp/timezone", {
            method: "POST",
            body: JSON.stringify({ offset }),
          }).catch(() => {});
        }
      } catch (e) {
        // не получилось узнать сохранённый пояс — остаёмся на поясе телефона, ничего не записываем
      }
      setTzOffset(offset);
      setReady(true);
    })();
  }, []);

  return (
    <div style={{ background: C.paper, minHeight: "100vh" }}>
      <Head>
        <title>Мои дела</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </Head>
      <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />

      {!ready && (
        <div style={{ padding: 40, textAlign: "center", color: C.soft }}>Загрузка…</div>
      )}

      {ready && !initData && (
        <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 24, textAlign: "center" }}>
          <div style={{ fontFamily: "'Source Serif 4', serif", fontSize: 24, fontWeight: 600 }}>Мои дела</div>
          <div style={{ color: C.soft, fontSize: 14, maxWidth: 280 }}>
            Это приложение открывается кнопкой «Календарь» прямо в чате с ботом в Telegram — просто по ссылке в браузере оно не работает.
          </div>
        </div>
      )}

      {ready && initData && <Planner initData={initData} tzOffset={tzOffset} />}
    </div>
  );
}

function Planner({ initData, tzOffset }) {
  // «сегодня» не должно пересоздаваться при каждой отрисовке — иначе load() срабатывает бесконечно
  const todayKey = todayInOffset(tzOffset);
  const today = useMemo(() => new Date(`${todayKey}T00:00:00`), [todayKey]);
  const [view, setView] = useState("list");
  const [fwd, setFwd] = useState(13);
  const [month, setMonth] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [addFor, setAddFor] = useState(null);
  const [menuFor, setMenuFor] = useState(null);
  const [moveSnapshot, setMoveSnapshot] = useState(null);
  const refs = useRef({});
  const [editingEvents, setEditingEvents] = useState({});
  const changeEditor = useCallback((id, snapshot) => {
    setEditingEvents(current => {
      if (snapshot) return { ...current, [id]: snapshot };
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);
  const closeMenu = useCallback(id => {
    setMenuFor(current => current === id ? null : current);
    setMoveSnapshot(current => current?.id === id ? null : current);
  }, []);
  const toggleMenu = ev => {
    if (menuFor === ev.id) closeMenu(ev.id);
    else { setMenuFor(ev.id); setMoveSnapshot(ev); }
  };
  const [, refreshClock] = useState(0);
  const { events, syncing, mutating, error: err, load, save } = useCalendarEvents(initData, today, fwd, tzOffset);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      refreshClock(value => value + 1);
      load();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    const tg = window.Telegram?.WebApp;
    tg?.onEvent?.("activated", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
      tg?.offEvent?.("activated", refresh);
    };
  }, [load]);

  useEffect(() => {
    const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    const neededFwd = Math.round((sod(lastDay) - today) / 864e5);
    if (neededFwd > fwd) setFwd(neededFwd);
  }, [month]);

  const patchEvent = (id, body) => save(`event:${id}`, `/api/webapp/events/${id}`, {
    method: "PATCH", body: JSON.stringify(body),
  }, (list, result) => list.map(ev => ev.id !== id ? ev : {
    ...ev, title: body.title || ev.title, eventAt: result.eventAt || ev.eventAt,
    ...(body.remindOffsetMinutes !== undefined ? {
      remindOffsetMinutes: body.remindOffsetMinutes ?? -1,
      hasReminder: body.remindOffsetMinutes !== null && body.remindOffsetMinutes !== -1,
    } : {}),
  }));

  const add = (dk, title, time, remindOffsetMinutes) => save(`create:${dk}`, "/api/webapp/events", {
    method: "POST", body: JSON.stringify({ title: title.trim(), date: dk, time: time || null, remindOffsetMinutes }),
  });

  const editEvent = (ev, title, time, remindOffsetMinutes) => {
    const body = { title };
    if (time !== ev.time) body.time = time;
    if (remindOffsetMinutes !== ev.remindOffsetMinutes) body.remindOffsetMinutes = remindOffsetMinutes;
    return patchEvent(ev.id, body);
  };

  const remove = async ev => {
    const saved = await save(`event:${ev.id}`, `/api/webapp/events/${ev.id}`, { method: "DELETE" },
      list => list.filter(item => item.id !== ev.id));
    if (saved) closeMenu(ev.id);
    return saved;
  };

  const move = async (ev, dk) => {
    const saved = await patchEvent(ev.id, { date: dk, time: ev.time });
    if (saved) closeMenu(ev.id);
    return saved;
  };

  const jump = (d) => {
    const f = Math.round((sod(d) - today) / 864e5);
    if (f > fwd) setFwd(f);
    setView("list");
    setTimeout(() => { const el = refs.current[key(d)]; if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }, 100);
  };

  // Пока редактор открыт, обновление из бота не перемещает и не удаляет его черновик.
  const pinned = { ...(moveSnapshot ? { [moveSnapshot.id]: moveSnapshot } : {}), ...editingEvents };
  const displayed = events.map(ev => pinned[ev.id] || ev);
  for (const snapshot of Object.values(pinned)) {
    if (!events.some(ev => ev.id === snapshot.id)) displayed.push(snapshot);
  }
  const byDay = {};
  for (const ev of displayed) {
    const local = utcIsoToLocalParts(ev.eventAt, tzOffset);
    (byDay[local.dateStr] = byDay[local.dateStr] || []).push({ ...ev, date: local.dateStr, time: local.timeStr });
  }
  Object.values(byDay).forEach((l) => l.sort((a, b) => a.time.localeCompare(b.time)));

  const days = [];
  for (let i = 0; i <= fwd; i++) days.push(addD(today, i));
  for (const date of [addFor, ...Object.values(pinned).map(ev => ev.date)].filter(Boolean)) {
    if (!days.some(day => key(day) === date)) days.push(new Date(`${date}T00:00:00`));
  }
  days.sort((a, b) => a - b);

  return (
    <div style={{ paddingBottom: 100 }}>
      <div style={{ position: "sticky", top: 0, zIndex: 20, background: C.paper, paddingTop: 18, paddingBottom: 10, borderBottom: `1px solid ${C.line}` }}>
        <div style={{ padding: "0 18px", display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
          <h1 style={{ fontFamily: "'Source Serif 4', serif", fontWeight: 600, fontSize: 25, margin: 0 }}>Мои дела</h1>
          <span style={{ fontSize: 12, color: C.soft, textAlign: "right" }}>
            {today.getDate()} {MG[today.getMonth()]}, {WD[today.getDay()]}
          </span>
        </div>

        <div style={{ display: "flex", gap: 6, padding: "12px 18px 0", alignItems: "center" }}>
          {[["list","Лента"],["calendar","Календарь"]].map(([k,l]) => (
            <button disabled={mutating} key={k} onClick={() => setView(k)} style={{
              border: "none", cursor: "pointer", fontSize: 14, padding: "7px 14px",
              borderRadius: 20, fontWeight: 500,
              background: view === k ? C.ink : "transparent", color: view === k ? C.paper : C.soft,
            }}>{l}</button>
          ))}
          {syncing && <span role="status" style={{ fontSize: 11, color: C.accent, marginLeft: "auto" }}>Синхронизирую…</span>}
        </div>

        {err && (
          <div role="alert" style={{ margin: "10px 18px 0", fontSize: 12, color: C.warn, background: C.warnSoft, padding: "8px 10px", borderRadius: 8 }}>
            Не удалось обновить календарь. {err}
            <button onClick={load} style={chip}>Повторить загрузку</button>
          </div>
        )}
      </div>

      {view === "list" ? (
        <div style={{ padding: "14px 14px 0" }}>
          {days.map((d) => {
            const k = key(d);
            return (
              <div key={k} ref={(el) => (refs.current[k] = el)} style={{ marginBottom: 18 }}>
                <Day date={d} today={today} items={byDay[k] || []}
                  onDelete={remove} onEdit={editEvent} onMove={move} onEditingChange={changeEditor} busy={mutating}
                  menuFor={menuFor} onMenu={toggleMenu} onCloseMenu={closeMenu}
                  adding={addFor === k} onAdd={() => { if (!mutating) setAddFor(k); }} onCancel={() => setAddFor(current => current === k ? null : current)}
                  onSubmit={(t, tm, r) => add(k, t, tm, r)} />
              </div>
            );
          })}
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            <button onClick={() => setFwd((f) => f + 14)} style={{
              border: "none", background: "transparent", color: C.soft, fontSize: 13,
              cursor: "pointer", padding: "8px 10px", textDecoration: "underline", textUnderlineOffset: 3,
            }}>Показать больше дней вперёд</button>
          </div>
        </div>
      ) : (
        <Cal month={month} setMonth={setMonth} today={today}
          has={(d) => (byDay[key(d)] || []).length > 0} onPick={jump} />
      )}

      {view === "list" && (
        <button disabled={mutating} onClick={() => setAddFor(key(today))} aria-label="Добавить дело" style={{
          position: "fixed", bottom: 26, right: 22, width: 54, height: 54, borderRadius: "50%",
          border: "none", background: C.accent, color: "#fff", fontSize: 28, lineHeight: "54px",
          cursor: "pointer", boxShadow: "0 6px 16px rgba(47,93,80,.35)",
        }}>+</button>
      )}
    </div>
  );
}

function Day({ date, today, items, onDelete, onEdit, onMove, onEditingChange, busy, menuFor, onMenu, onCloseMenu, adding, onAdd, onCancel, onSubmit }) {
  const isToday = same(date, today);
  const isPast = date < today && !isToday;

  const row = (ev) => (
    <Row key={ev.id} ev={ev} isPast={isPast}
      onDelete={() => onDelete(ev)}
      onEdit={(t, tm, r) => onEdit(ev, t, tm, r)} onMove={(dk) => onMove(ev, dk)}
      menuOpen={menuFor === ev.id} onMenu={() => onMenu(ev)} onCloseMenu={() => onCloseMenu(ev.id)}
      base={isPast ? today : date} onEditingChange={onEditingChange} busy={busy} />
  );

  return (
    <div style={{ background: C.card, borderRadius: 16, border: `1px solid ${isToday ? C.accent : C.line}`, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 16px", background: isToday ? C.accentSoft : "transparent", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
          <span style={{ fontFamily: "'Source Serif 4', serif", fontWeight: 600, fontSize: 17, color: isToday ? C.accent : C.ink }}>{heading(date, today)}</span>
          <span style={{ fontSize: 13, color: C.soft }}>{date.getDate()} {MG[date.getMonth()]}</span>
        </div>
        <button disabled={busy} onClick={onAdd} style={{ border: "none", background: "transparent", color: C.soft, fontSize: 20, cursor: "pointer", padding: 4 }} aria-label="Добавить">+</button>
      </div>
      <div style={{ padding: items.length || adding ? "4px 16px 12px" : "0 16px" }}>
        {items.length === 0 && !adding && <div style={{ fontSize: 13, color: C.soft, padding: "8px 0 12px" }}>Ничего не запланировано</div>}
        {items.map(row)}
        {adding && <Form mode="add" onSubmit={onSubmit} onCancel={onCancel} />}
      </div>
    </div>
  );
}

function Row({ ev, isPast, onDelete, onEdit, onMove, menuOpen, onMenu, onCloseMenu, base, onEditingChange, busy }) {
  const [editing, setEditing] = useState(false);
  const deletion = useAction(onDelete);
  useEffect(() => () => onEditingChange(ev.id, null), [ev.id, onEditingChange]);
  const startEditing = () => { if (busy) return; onCloseMenu(); onEditingChange(ev.id, ev); setEditing(true); };
  const closeEditing = () => { setEditing(false); onEditingChange(ev.id, null); };

  if (editing) return (
    <Form mode="edit" title0={ev.title} time0={ev.time || ""} remind0={ev.remindOffsetMinutes}
      onSubmit={onEdit} onCancel={closeEditing} />
  );

  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0" }}>
        <span style={{ marginTop: 5 }}>{ev.emoji || "📌"}</span>
        <div style={{ flex: 1, minWidth: 0, cursor: "text" }} onClick={startEditing}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            {ev.time && <span style={{ fontSize: 12, color: isPast && !ev.done ? C.warn : C.soft, fontVariantNumeric: "tabular-nums" }}>{ev.time}</span>}
            <span style={{ fontSize: 15, color: ev.done ? C.soft : C.ink, textDecoration: ev.done ? "line-through" : "none", wordBreak: "break-word" }}>{ev.title}</span>
            {ev.done && <span style={{ fontSize: 12, color: C.accent }}>✓ Сделано</span>}
            {ev.recurring && <span style={{ fontSize: 11, color: C.soft, border: `1px solid ${C.line}`, borderRadius: 10, padding: "1px 7px", whiteSpace: "nowrap" }}>↻ повтор</span>}
          </div>
          {isPast && (
            <button disabled={busy} onClick={(e) => { e.stopPropagation(); onMenu(); }} style={{
              border: "none", background: "transparent", color: C.warn, fontSize: 12, cursor: "pointer",
              padding: "3px 0 0", textDecoration: "underline", textUnderlineOffset: 2,
            }}>Перенести на другой день</button>
          )}
        </div>
        {!isPast && <button disabled={busy} onClick={onMenu} style={{ border: "none", background: "transparent", color: C.soft, fontSize: 14, cursor: "pointer", padding: "2px 4px" }} aria-label="Перенести">⋯</button>}
        <button disabled={deletion.saving} onClick={() => deletion.run()} style={{ border: "none", background: "transparent", color: C.line, fontSize: 17, cursor: "pointer", padding: "0 2px" }} aria-label="Удалить">×</button>
      </div>
      {deletion.error && <div role="alert" style={{ color: C.warn, fontSize: 13 }}>
        Не удалось удалить. {deletion.error} <button disabled={deletion.saving} onClick={() => deletion.run()} style={chip}>Повторить удаление</button>
      </div>}
      {menuOpen && <Move base={base} past={isPast} onPick={onMove} onClose={onCloseMenu} />}
    </div>
  );
}

function Form({ mode, title0 = "", time0 = "", remind0 = 60, onSubmit, onCancel }) {
  const [title, setTitle] = useState(title0);
  const [time, setTime] = useState(time0);
  const [reminder, setReminder] = useState(remind0);
  const reminderOptions = [-1, 0, 15, 30, 60, 1440, 10080];
  if (!reminderOptions.includes(remind0)) reminderOptions.push(remind0);
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.focus(); }, []);
  const { saving, error, run, pending } = useAction(async () => {
    if (!title.trim()) throw new Error("Укажи название дела.");
    return onSubmit(title, time, reminder);
  });
  const cancel = () => { if (!pending.current) onCancel(); };
  const go = async () => { if (await run()) onCancel(); };

  return (
    <div style={{ margin: "8px 0", padding: 10, background: C.paper, borderRadius: 10, border: `1px solid ${C.line}` }}>
      <input disabled={saving} aria-label="Название дела" ref={ref} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Что нужно сделать"
        onKeyDown={(e) => { if (e.key === "Enter") go(); if (e.key === "Escape") cancel(); }}
        style={{ width: "100%", boxSizing: "border-box", border: `1px solid ${C.line}`, borderRadius: 8,
          background: "#fff", fontSize: 15, padding: "8px 10px", outline: "none", marginBottom: 8, color: C.ink }} />
      {error && <div role="alert" style={{ color: C.warn, fontSize: 13, marginBottom: 8 }}>Не удалось сохранить. {error}</div>}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input disabled={saving} aria-label="Время события" type="time" value={time} onChange={(e) => setTime(e.target.value)}
          style={{ fontSize: 13, border: `1px solid ${C.line}`, borderRadius: 6, padding: "6px 7px", background: "#fff" }} />
        {time && <button disabled={saving} onClick={() => setTime("")} style={{ border: "none", background: "transparent", color: C.soft, fontSize: 12, cursor: "pointer" }}>без времени</button>}
        <select disabled={saving} aria-label="Напоминание" value={reminder} onChange={(e) => setReminder(Number(e.target.value))}
          style={{ fontSize: 13, border: `1px solid ${C.line}`, borderRadius: 6, padding: "6px 7px", background: "#fff" }}>
          {reminderOptions.map((n) => <option key={n} value={n}>
            {n === -1 ? "Не напоминать" : n === 0 ? "В момент события" : `За ${n} мин.`}
          </option>)}
        </select>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button disabled={saving} onClick={cancel} style={{ border: "none", background: "transparent", color: C.soft, fontSize: 13, cursor: "pointer", padding: "7px 4px" }}>Отмена</button>
          <button disabled={saving} onClick={go} style={{ border: "none", background: C.accent, color: "#fff", fontSize: 13, borderRadius: 20, padding: "7px 16px", cursor: "pointer" }}>
            {saving ? "Сохраняю…" : error ? "Повторить сохранение" : mode === "add" ? "Добавить" : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Move({ base, past, onPick, onClose }) {
  const [custom, setCustom] = useState("");
  const [lastAttempt, setLastAttempt] = useState("");
  const { saving, error, run, pending } = useAction(onPick);
  const go = async date => {
    if (!date || pending.current) return;
    setLastAttempt(date);
    if (await run(date)) onClose();
  };
  const opts = [[past ? "Завтра" : "+1 день",1],["+2 дня",2],["+3 дня",3],["Через неделю",7]];
  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 10, padding: 10, marginBottom: 8, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      {opts.map(([l, n]) => <button disabled={saving} key={l} onClick={() => go(key(addD(base, n)))} style={chip}>{l}</button>)}
      <input disabled={saving} aria-label="Новая дата" type="date" value={custom} onChange={(e) => setCustom(e.target.value)}
        style={{ fontSize: 12, border: `1px solid ${C.line}`, borderRadius: 6, padding: "5px 6px", background: "#fff" }} />
      <button disabled={saving || !custom} onClick={() => go(custom)} style={{ ...chip, background: C.accent, color: "#fff", border: "none" }}>{saving ? "Сохраняю…" : "Перенести"}</button>
      <button disabled={saving} onClick={() => { if (!pending.current) onClose(); }} style={{ border: "none", background: "transparent", color: C.soft, fontSize: 12, cursor: "pointer", marginLeft: "auto" }}>отмена</button>
      {error && <div role="alert" style={{ color: C.warn, fontSize: 13, width: "100%" }}>
        Не удалось перенести. {error} <button disabled={saving} onClick={() => go(lastAttempt)} style={chip}>Повторить перенос</button>
      </div>}
    </div>
  );
}

const chip = { fontSize: 12, border: `1px solid ${C.line}`, background: "#fff", borderRadius: 20, padding: "6px 11px", cursor: "pointer", color: C.ink };

function Cal({ month, setMonth, today, has, onPick }) {
  const y = month.getFullYear(), m = month.getMonth();
  const start = (new Date(y, m, 1).getDay() + 6) % 7;
  const total = new Date(y, m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < start; i++) cells.push(null);
  for (let d = 1; d <= total; d++) cells.push(new Date(y, m, d));

  return (
    <div style={{ padding: "16px 18px 40px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <button onClick={() => setMonth(new Date(y, m - 1, 1))} style={nav} aria-label="Назад">‹</button>
        <span style={{ fontFamily: "'Source Serif 4', serif", fontSize: 18, fontWeight: 600 }}>{MN[m]} {y}</span>
        <button onClick={() => setMonth(new Date(y, m + 1, 1))} style={nav} aria-label="Вперёд">›</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4, marginBottom: 6 }}>
        {["пн","вт","ср","чт","пт","сб","вс"].map((w) => <div key={w} style={{ textAlign: "center", fontSize: 11, color: C.soft }}>{w}</div>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4 }}>
        {cells.map((d, i) => d ? (
          <button key={key(d)} onClick={() => onPick(d)} style={{
            aspectRatio: "1", borderRadius: 10, cursor: "pointer", display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", gap: 3,
            border: `1px solid ${same(d, today) ? C.accent : C.line}`,
            background: same(d, today) ? C.accentSoft : C.card,
          }}>
            <span style={{ fontSize: 13, color: same(d, today) ? C.accent : C.ink, fontWeight: same(d, today) ? 600 : 400 }}>{d.getDate()}</span>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: has(d) ? C.accent : "transparent" }} />
          </button>
        ) : <div key={`e${i}`} />)}
      </div>
      <div style={{ marginTop: 20, textAlign: "center" }}>
        <button onClick={() => onPick(today)} style={chip}>Вернуться к сегодня</button>
      </div>
    </div>
  );
}
const nav = { border: `1px solid ${C.line}`, background: C.card, width: 34, height: 34, borderRadius: "50%", fontSize: 18, cursor: "pointer", color: C.ink };
