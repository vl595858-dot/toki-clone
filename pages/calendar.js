import React, { useState, useEffect, useCallback, useRef } from "react";
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
  const r = await fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
      ...(opts.headers || {}),
    },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Ошибка ${r.status}`);
  return data;
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

    const offset = detectTzOffset();
    setTzOffset(offset);
    // сообщаем боту тот же часовой пояс, которым пользуется приложение —
    // голосовые команды в чате начнут считать время так же, как здесь на экране
    api(tg.initData, "/api/webapp/timezone", {
      method: "POST",
      body: JSON.stringify({ offset }),
    }).catch(() => {});

    setReady(true);
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
  const today = sod(new Date());
  const [events, setEvents] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [err, setErr] = useState("");
  const [view, setView] = useState("list");
  const [fwd, setFwd] = useState(13);
  const [month, setMonth] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [addFor, setAddFor] = useState(null);
  const [menuFor, setMenuFor] = useState(null);
  const refs = useRef({});

  const load = useCallback(async () => {
    setSyncing(true);
    setErr("");
    try {
      const from = addD(today, -3).toISOString();
      const to = addD(today, fwd + 1).toISOString();
      const { events } = await api(initData, `/api/webapp/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      setEvents(events);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSyncing(false);
    }
  }, [today, fwd, initData]);

  useEffect(() => { load(); }, [load]);

  const patchEvent = async (id, body, optimistic) => {
    if (optimistic) setEvents((list) => optimistic(list));
    setSyncing(true);
    setErr("");
    try {
      await api(initData, `/api/webapp/events/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      load();
    } catch (e) {
      setErr(e.message);
      load();
    } finally {
      setSyncing(false);
    }
  };

  const add = async (dk, title, time) => {
    if (!title.trim()) return;
    setSyncing(true);
    setErr("");
    try {
      await api(initData, "/api/webapp/events", {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), date: dk, time: time || null }),
      });
      load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSyncing(false);
    }
  };

  const editEvent = (ev, title, time) => {
    patchEvent(ev.id, { title, date: ev.date, time },
      (list) => list.map((e) => (e.id === ev.id ? { ...e, title } : e)));
  };

  const remove = async (ev) => {
    setEvents((list) => list.filter((e) => e.id !== ev.id));
    setSyncing(true);
    try {
      await api(initData, `/api/webapp/events/${ev.id}`, { method: "DELETE" });
    } catch (e) {
      setErr(e.message);
      load();
    } finally {
      setSyncing(false);
    }
  };

  const move = (ev, dk) => {
    setMenuFor(null);
    patchEvent(ev.id, { date: dk, time: ev.time },
      (list) => list.map((e) => (e.id === ev.id ? { ...e } : e)));
  };

  const jump = (d) => {
    const f = Math.round((sod(d) - today) / 864e5);
    if (f > fwd) setFwd(f);
    setView("list");
    setTimeout(() => { const el = refs.current[key(d)]; if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }, 100);
  };

  const byDay = {};
  for (const ev of events) {
    const local = utcIsoToLocalParts(ev.eventAt, tzOffset);
    (byDay[local.dateStr] = byDay[local.dateStr] || []).push({ ...ev, date: local.dateStr, time: local.timeStr });
  }
  Object.values(byDay).forEach((l) => l.sort((a, b) => a.time.localeCompare(b.time)));

  const days = [];
  for (let i = 0; i <= fwd; i++) days.push(addD(today, i));

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
            <button key={k} onClick={() => setView(k)} style={{
              border: "none", cursor: "pointer", fontSize: 14, padding: "7px 14px",
              borderRadius: 20, fontWeight: 500,
              background: view === k ? C.ink : "transparent", color: view === k ? C.paper : C.soft,
            }}>{l}</button>
          ))}
          {syncing && <span style={{ fontSize: 11, color: C.accent, marginLeft: "auto" }}>Синхронизирую…</span>}
        </div>

        {err && (
          <div style={{ margin: "10px 18px 0", fontSize: 12, color: C.warn, background: C.warnSoft, padding: "8px 10px", borderRadius: 8 }}>
            {err}
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
                  onDelete={remove} onEdit={editEvent} onMove={move}
                  menuFor={menuFor} setMenuFor={setMenuFor}
                  adding={addFor === k} onAdd={() => setAddFor(k)} onCancel={() => setAddFor(null)}
                  onSubmit={(t, tm) => { add(k, t, tm); setAddFor(null); }} />
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
        <button onClick={() => setAddFor(key(today))} aria-label="Добавить дело" style={{
          position: "fixed", bottom: 26, right: 22, width: 54, height: 54, borderRadius: "50%",
          border: "none", background: C.accent, color: "#fff", fontSize: 28, lineHeight: "54px",
          cursor: "pointer", boxShadow: "0 6px 16px rgba(47,93,80,.35)",
        }}>+</button>
      )}
    </div>
  );
}

function Day({ date, today, items, onDelete, onEdit, onMove, menuFor, setMenuFor, adding, onAdd, onCancel, onSubmit }) {
  const isToday = same(date, today);
  const isPast = date < today && !isToday;

  const row = (ev) => (
    <Row key={ev.id} ev={ev} isPast={isPast}
      onDelete={() => onDelete(ev)}
      onEdit={(t, tm) => onEdit(ev, t, tm)} onMove={(dk) => onMove(ev, dk)}
      menuOpen={menuFor === ev.id} onMenu={() => setMenuFor(menuFor === ev.id ? null : ev.id)}
      base={date} />
  );

  return (
    <div style={{ background: C.card, borderRadius: 16, border: `1px solid ${isToday ? C.accent : C.line}`, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 16px", background: isToday ? C.accentSoft : "transparent", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
          <span style={{ fontFamily: "'Source Serif 4', serif", fontWeight: 600, fontSize: 17, color: isToday ? C.accent : C.ink }}>{heading(date, today)}</span>
          <span style={{ fontSize: 13, color: C.soft }}>{date.getDate()} {MG[date.getMonth()]}</span>
        </div>
        <button onClick={onAdd} style={{ border: "none", background: "transparent", color: C.soft, fontSize: 20, cursor: "pointer", padding: 4 }} aria-label="Добавить">+</button>
      </div>
      <div style={{ padding: items.length || adding ? "4px 16px 12px" : "0 16px" }}>
        {items.length === 0 && !adding && <div style={{ fontSize: 13, color: C.soft, padding: "8px 0 12px" }}>Ничего не запланировано</div>}
        {items.map(row)}
        {adding && <Form mode="add" onSubmit={onSubmit} onCancel={onCancel} />}
      </div>
    </div>
  );
}

function Row({ ev, isPast, onDelete, onEdit, onMove, menuOpen, onMenu, base }) {
  const [editing, setEditing] = useState(false);

  if (editing) return (
    <Form mode="edit" title0={ev.title} time0={ev.time || ""}
      onSubmit={(t, tm) => { onEdit(t, tm); setEditing(false); }} onCancel={() => setEditing(false)} />
  );

  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0" }}>
        <span style={{ marginTop: 5 }}>{ev.emoji || "📌"}</span>
        <div style={{ flex: 1, minWidth: 0, cursor: "text" }} onClick={() => setEditing(true)}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            {ev.time && <span style={{ fontSize: 12, color: isPast ? C.warn : C.soft, fontVariantNumeric: "tabular-nums" }}>{ev.time}</span>}
            <span style={{ fontSize: 15, color: C.ink, wordBreak: "break-word" }}>{ev.title}</span>
            {ev.recurring && <span style={{ fontSize: 11, color: C.soft, border: `1px solid ${C.line}`, borderRadius: 10, padding: "1px 7px", whiteSpace: "nowrap" }}>↻ повтор</span>}
          </div>
          {isPast && (
            <button onClick={(e) => { e.stopPropagation(); onMenu(); }} style={{
              border: "none", background: "transparent", color: C.warn, fontSize: 12, cursor: "pointer",
              padding: "3px 0 0", textDecoration: "underline", textUnderlineOffset: 2,
            }}>Перенести на другой день</button>
          )}
        </div>
        {!isPast && <button onClick={onMenu} style={{ border: "none", background: "transparent", color: C.soft, fontSize: 14, cursor: "pointer", padding: "2px 4px" }} aria-label="Перенести">⋯</button>}
        <button onClick={onDelete} style={{ border: "none", background: "transparent", color: C.line, fontSize: 17, cursor: "pointer", padding: "0 2px" }} aria-label="Удалить">×</button>
      </div>
      {menuOpen && <Move base={base} onPick={onMove} onClose={onMenu} />}
    </div>
  );
}

function Form({ mode, title0 = "", time0 = "", onSubmit, onCancel }) {
  const [title, setTitle] = useState(title0);
  const [time, setTime] = useState(time0);
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.focus(); }, []);
  const go = () => { if (!title.trim()) return onCancel(); onSubmit(title, time); };

  return (
    <div style={{ margin: "8px 0", padding: 10, background: C.paper, borderRadius: 10, border: `1px solid ${C.line}` }}>
      <input ref={ref} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Что нужно сделать"
        onKeyDown={(e) => { if (e.key === "Enter") go(); if (e.key === "Escape") onCancel(); }}
        style={{ width: "100%", boxSizing: "border-box", border: `1px solid ${C.line}`, borderRadius: 8,
          background: "#fff", fontSize: 15, padding: "8px 10px", outline: "none", marginBottom: 8, color: C.ink }} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)}
          style={{ fontSize: 13, border: `1px solid ${C.line}`, borderRadius: 6, padding: "6px 7px", background: "#fff" }} />
        {time && <button onClick={() => setTime("")} style={{ border: "none", background: "transparent", color: C.soft, fontSize: 12, cursor: "pointer" }}>без времени</button>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button onClick={onCancel} style={{ border: "none", background: "transparent", color: C.soft, fontSize: 13, cursor: "pointer", padding: "7px 4px" }}>Отмена</button>
          <button onClick={go} style={{ border: "none", background: C.accent, color: "#fff", fontSize: 13, borderRadius: 20, padding: "7px 16px", cursor: "pointer" }}>
            {mode === "add" ? "Добавить" : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Move({ base, onPick, onClose }) {
  const [custom, setCustom] = useState("");
  const opts = [["Завтра",1],["+2 дня",2],["+3 дня",3],["Через неделю",7]];
  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 10, padding: 10, marginBottom: 8, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      {opts.map(([l, n]) => <button key={l} onClick={() => onPick(key(addD(base, n)))} style={chip}>{l}</button>)}
      <input type="date" value={custom} onChange={(e) => setCustom(e.target.value)}
        style={{ fontSize: 12, border: `1px solid ${C.line}`, borderRadius: 6, padding: "5px 6px", background: "#fff" }} />
      <button onClick={() => custom && onPick(custom)} style={{ ...chip, background: C.accent, color: "#fff", border: "none" }}>Перенести</button>
      <button onClick={onClose} style={{ border: "none", background: "transparent", color: C.soft, fontSize: 12, cursor: "pointer", marginLeft: "auto" }}>отмена</button>
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
