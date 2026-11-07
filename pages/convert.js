import React, { useState, useEffect, useMemo, useRef } from "react";
import Head from "next/head";
import Script from "next/script";

const C = {
  paper: "#F2F3EF", card: "#FFFFFF", ink: "#22262A", soft: "#6B7370",
  line: "#DDE0DB", accent: "#2F5D50", accentSoft: "#E4EEE9",
};

const CURRENCIES = [
  { code: "RUB", flag: "🇷🇺", name: "Российский рубль" },
  { code: "USD", flag: "🇺🇸", name: "Доллар США" },
  { code: "EUR", flag: "🇪🇺", name: "Евро" },
  { code: "GBP", flag: "🇬🇧", name: "Фунт стерлингов" },
  { code: "INR", flag: "🇮🇳", name: "Индийская рупия" },
  { code: "CNY", flag: "🇨🇳", name: "Китайский юань" },
  { code: "VND", flag: "🇻🇳", name: "Вьетнамский донг" },
  { code: "THB", flag: "🇹🇭", name: "Тайский бат" },
  { code: "AED", flag: "🇦🇪", name: "Дирхам ОАЭ" },
  { code: "TRY", flag: "🇹🇷", name: "Турецкая лира" },
  { code: "BTC", flag: "₿", name: "Биткоин" },
];

const byCode = (code) => CURRENCIES.find((c) => c.code === code) || CURRENCIES[0];

// два знака после запятой (у биткоина до 8, иначе малые суммы превратятся в 0,00)
function fmt(n, code) {
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: code === "BTC" ? 8 : 2 });
}

// оставляем цифры и один разделитель дробной части
function cleanInput(s) {
  const t = s.replace(/\./g, ",").replace(/[^0-9,]/g, "");
  const i = t.indexOf(",");
  return i === -1 ? t : t.slice(0, i + 1) + t.slice(i + 1).replace(/,/g, "");
}

const toNumber = (text) => Number(text.replace(",", "."));

function loadSaved() {
  try {
    const s = JSON.parse(window.localStorage.getItem("convert_codes") || "null");
    if (s && byCode(s.top).code === s.top && byCode(s.bottom).code === s.bottom) return s;
  } catch (e) {}
  return { top: "RUB", bottom: "USD" };
}

export default function ConvertPage() {
  const [rates, setRates] = useState(null); // { RUB: 1, USD: 91.5, ... }
  const [failed, setFailed] = useState(false);
  const [codes, setCodes] = useState({ top: "RUB", bottom: "USD" });
  const [src, setSrc] = useState("top"); // в какой строке человек вводит число
  const [text, setText] = useState("");
  const [picking, setPicking] = useState(null); // "top" | "bottom" | null
  const topRef = useRef(null);

  function loadRates() {
    setFailed(false);
    fetch("/api/rates")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("rates"))))
      .then((d) => setRates(d.rubPer))
      .catch(() => setFailed(true));
  }

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.ready();
      tg.expand();
    }
    setCodes(loadSaved());
    loadRates();
    if (topRef.current) topRef.current.focus();
  }, []);

  function saveCodes(next) {
    setCodes(next);
    try {
      window.localStorage.setItem("convert_codes", JSON.stringify(next));
    } catch (e) {}
  }

  const available = useMemo(() => (rates ? CURRENCIES.filter((c) => rates[c.code]) : []), [rates]);

  // значение «другой» строки считаем из той, где вводят
  const shown = useMemo(() => {
    const out = { top: "", bottom: "" };
    out[src] = text;
    const other = src === "top" ? "bottom" : "top";
    const n = toNumber(text);
    if (rates && text && Number.isFinite(n) && rates[codes[src]] && rates[codes[other]]) {
      out[other] = fmt((n * rates[codes[src]]) / rates[codes[other]], codes[other]);
    }
    return out;
  }, [rates, codes, src, text]);

  function swap() {
    saveCodes({ top: codes.bottom, bottom: codes.top });
    setSrc(src === "top" ? "bottom" : "top"); // число остаётся при своей валюте
  }

  function pick(code) {
    saveCodes({ ...codes, [picking]: code });
    setPicking(null);
  }

  const row = (pos) => (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12 }}>
      <input
        ref={pos === "top" ? topRef : null}
        inputMode="decimal"
        placeholder="0"
        value={shown[pos]}
        onFocus={() => {
          if (src !== pos) {
            // переходим на ввод в другой строке: берём её число как основу
            const v = shown[pos].replace(/\s/g, "").replace(/ /g, "");
            setSrc(pos);
            setText(cleanInput(v));
          }
        }}
        onChange={(e) => {
          setSrc(pos);
          setText(cleanInput(e.target.value));
        }}
        style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontSize: 30, fontWeight: 600, color: C.ink }}
      />
      <button
        onClick={() => setPicking(pos)}
        style={{ border: `1px solid ${C.line}`, background: C.accentSoft, color: C.accent, borderRadius: 12, padding: "10px 12px", fontSize: 17, fontWeight: 600, whiteSpace: "nowrap" }}
      >
        {byCode(codes[pos]).flag} {codes[pos]} ▾
      </button>
    </div>
  );

  return (
    <>
      <Head>
        <title>Конвертация</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
      </Head>
      <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
      <div style={{ minHeight: "100vh", background: C.paper, padding: 16, fontFamily: "-apple-system, system-ui, sans-serif" }}>
        <div style={{ maxWidth: 480, margin: "0 auto", position: "relative" }}>
          {row("top")}
          <div style={{ display: "flex", justifyContent: "center", margin: "-8px 0", position: "relative", zIndex: 1 }}>
            <button
              onClick={swap}
              aria-label="Поменять местами"
              style={{ width: 44, height: 44, borderRadius: 22, border: `1px solid ${C.line}`, background: C.card, color: C.accent, fontSize: 22 }}
            >
              ⇅
            </button>
          </div>
          {row("bottom")}
          {failed && (
            <div style={{ marginTop: 16, textAlign: "center", color: C.soft }}>
              Курсы сейчас недоступны.{" "}
              <button onClick={loadRates} style={{ border: "none", background: "none", color: C.accent, fontSize: 16, textDecoration: "underline" }}>
                Повторить
              </button>
            </div>
          )}
        </div>
      </div>

      {picking && (
        <div onClick={() => setPicking(null)} style={{ position: "fixed", inset: 0, zIndex: 10, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "flex-end" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, width: "100%", maxHeight: "75vh", overflowY: "auto", borderRadius: "18px 18px 0 0", padding: "8px 0 16px" }}>
            {(available.length ? available : CURRENCIES).map((c) => (
              <button
                key={c.code}
                onClick={() => pick(c.code)}
                style={{ display: "flex", width: "100%", alignItems: "center", gap: 12, border: "none", borderBottom: `1px solid ${C.line}`, background: codes[picking] === c.code ? C.accentSoft : "transparent", padding: "14px 20px", fontSize: 17, color: C.ink, textAlign: "left" }}
              >
                <span style={{ width: 28, textAlign: "center" }}>{c.flag}</span>
                <b style={{ width: 48 }}>{c.code}</b>
                <span style={{ color: C.soft }}>{c.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
