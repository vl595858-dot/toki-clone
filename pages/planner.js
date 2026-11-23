import Head from "next/head";
import { useEffect, useRef, useState } from "react";
import { price, durationDays } from "../lib/plusPricing";
import { limits } from "../lib/plusPlanLimits";

export async function getServerSideProps() {
  const { config } = require("../lib/webPlannerAuth");
  const { TERMS_VERSION } = require("../lib/webPlannerPayments");
  return { props: { available: Boolean(config()), termsVersion: TERMS_VERSION } };
}

async function api(path, method = "GET", body) {
  const response = await fetch(`/api/planner/${path}`, {
    method,
    cache: "no-store",
    ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || "Операция не выполнена. Попробуй ещё раз.");
  return data;
}

function localToday() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function TaskFields({ task, onCancel }) {
  return <>
    <label>Дело<input name="title" maxLength={240} defaultValue={task?.title} required /></label>
    <label>Дата<input name="date" type="date" defaultValue={task?.due_on || localToday()} required /></label>
    <button>{task ? "Сохранить" : "Добавить дело"}</button>
    {onCancel && <button type="button" className="secondary" onClick={onCancel}>Отмена</button>}
  </>;
}

export default function Planner({ available, termsVersion }) {
  const [session, setSession] = useState(null);
  const [data, setData] = useState(null);
  const [email, setEmail] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [edit, setEdit] = useState(null);
  const [filter, setFilter] = useState({ q: "", page: 0 });
  const returned = useRef(false);

  async function reload(options = filter) {
    const params = new URLSearchParams(options);
    setData(await api(`tasks?${params}`));
    setFilter(options);
  }

  async function refreshSession() {
    const next = await api("session");
    setSession(next);
    if (!next.email) {
      setData(null);
      return;
    }
    await reload({ q: "", page: 0 });
    if (next.paymentMode && !returned.current && new URLSearchParams(window.location.search).has("returned")) {
      returned.current = true;
      await payment("check");
    }
  }

  async function run(fn) {
    setWorking(true);
    setError("");
    setNotice("");
    try { await fn(); }
    catch (failure) { setError(failure.message); }
    finally { setWorking(false); }
  }

  useEffect(() => {
    if (available) run(refreshSession);
  }, [available]);

  function signIn(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    return run(async () => {
      if (!waiting) {
        const address = String(form.get("email"));
        await api("session", "POST", { action: "send", email: address });
        setEmail(address);
        setWaiting(true);
        setNotice("Код отправлен. Проверь почту.");
      } else {
        await api("session", "POST", { action: "verify", email, code: String(form.get("code")) });
        setWaiting(false);
        await refreshSession();
      }
    });
  }

  function save(event, task) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form));
    return run(async () => {
      await api("tasks", task ? "PATCH" : "POST", { ...fields, ...(task && { id: task.id }) });
      setEdit(null);
      if (!task) {
        form.elements.title.value = "";
        await reload({ q: "", page: 0 });
      } else {
        await reload();
      }
    });
  }

  function change(task, method, done) {
    return run(async () => {
      await api("tasks", method, { id: task.id, done });
      await reload();
    });
  }

  async function payment(action) {
    const result = await api("checkout", "POST", { action, ...(action === "buy" && { terms: termsVersion }) });
    if (action === "buy" && result.url) {
      window.location.assign(result.url);
      return;
    }
    await reload();
    const messages = {
      succeeded: "Платёж подтверждён. Плюс подключён.",
      pending: "ЮKassa ещё проверяет платёж. Проверь статус через несколько минут.",
      canceled: "Платёж отменён. Можно создать новый.",
      review: "Платёж требует проверки. Если ты уже оплатил, дождись подтверждения или обратись в поддержку через страницу тарифов.",
    };
    setNotice(messages[result.state] || "Актуальный статус тарифа показан в кабинете.");
  }

  return <>
    <Head>
      <title>Веб-планировщик · Мои делишки</title>
      <meta name="robots" content="noindex, nofollow" />
    </Head>
    <main className="planner" lang="ru">
      <header><a className="brand" href="/plus">Мои делишки</a><a href="/plus#plans">Тарифы</a></header>
      <h1>Мои дела</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!available && <p>Веб-кабинет пока недоступен.</p>}
      {available && !session && !error && <p role="status">Загружаем кабинет…</p>}
      {available && !session && error && <button onClick={() => run(refreshSession)}>Повторить</button>}
      {session && !session.email && (
        <section className="panel auth">
          <h2>Вход по email</h2>
          <form onSubmit={signIn}>
            {waiting
              ? <label>Код для {email}<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,10}" required /></label>
              : <label>Электронная почта<input name="email" type="email" autoComplete="email" maxLength={254} defaultValue={email} required /></label>}
            <button disabled={working}>{waiting ? "Войти" : "Получить код"}</button>
            {waiting && <button type="button" className="secondary" onClick={() => setWaiting(false)}>Изменить адрес</button>}
          </form>
        </section>
      )}
      {session?.email && <>
        <p className="account">{session.email} <button className="secondary" disabled={working} onClick={() => run(async () => {
          await api("session", "POST", { action: "logout" });
          returned.current = false;
          setEdit(null);
          await refreshSession();
        })}>Выйти</button></p>
        {data && <>
          <section className="panel">
            <h2>Добавить дело</h2>
            <form onSubmit={event => save(event)}><fieldset disabled={working}><TaskFields /></fieldset></form>
          </section>
          <section className="panel">
            <h2>Список дел</h2>
            <form onSubmit={event => {
              event.preventDefault();
              const q = String(new FormData(event.currentTarget).get("q"));
              run(() => reload({ q, page: 0 }));
            }}><label>Поиск<input name="q" type="search" maxLength={240} /></label><button disabled={working}>Найти</button></form>
            {data.tasks.length === 0 && <p>Дел пока нет.</p>}
            <ul>
              {data.tasks.map(task => <li key={task.id}>
                {edit === task.id
                  ? <form onSubmit={event => save(event, task)}><fieldset disabled={working}><TaskFields task={task} onCancel={() => setEdit(null)} /></fieldset></form>
                  : <div className="task">
                    <div><strong className={task.done ? "done" : ""}>{task.title}</strong><time dateTime={task.due_on}>{task.due_on.split("-").reverse().join(".")}</time></div>
                    <div className="actions">
                      <button className="secondary" disabled={working} onClick={() => change(task, "PATCH", !task.done)}>{task.done ? "Вернуть в дела" : "Выполнено"}</button>
                      <button className="secondary" disabled={working} onClick={() => setEdit(task.id)}>Изменить</button>
                      <button className="secondary" disabled={working} onClick={() => {
                        if (window.confirm("Удалить это дело?")) change(task, "DELETE");
                      }}>Удалить</button>
                    </div>
                  </div>}
              </li>)}
            </ul>
            <div className="actions">
              {filter.page > 0 && <button className="secondary" onClick={() => run(() => reload({ ...filter, page: filter.page - 1 }))}>Назад</button>}
              {data.more && <button className="secondary" onClick={() => run(() => reload({ ...filter, page: filter.page + 1 }))}>Дальше</button>}
              {data.accessUntil && <a href="/api/planner/tasks?export=csv">Скачать список в CSV</a>}
            </div>
          </section>
          <section className="panel" id="purchase">
            <h2>Мой тариф</h2>
            {data.accessUntil
              ? <p>Плюс до {new Date(data.accessUntil).toLocaleDateString("ru-RU")}. Новые дела без лимита.</p>
              : <p>Бесплатный. Осталось {Math.max(0, limits.free.event - data.used)} из {limits.free.event} новых дел за последние 30 дней.</p>}
            {session.canBuy && <form onSubmit={event => { event.preventDefault(); run(() => payment("buy")); }}>
              <label className="checkbox"><input type="checkbox" name="terms" required /> Принимаю условия <a href="/plus#terms" target="_blank" rel="noreferrer">оферты</a></label>
              <button disabled={working}>{session.paymentMode === "test" ? "Тестовая оплата" : "Оплатить"} {price} ₽ за {durationDays} дней</button>
            </form>}
            {!session.canBuy && <p>Оплата пока недоступна.</p>}
            {session.paymentMode && <button type="button" className="secondary" disabled={working} onClick={() => run(() => payment("check"))}>Проверить платёж</button>}
          </section>
          {data.linking && (data.linked || data.accessUntil) && <section className="panel">
            <h2>Привязка Telegram</h2>
            {data.linked ? <>
              <p>Telegram-аккаунт привязан. Действующий веб-тариф «Плюс» доступен и в боте.</p>
              <button className="secondary" disabled={working} onClick={() => run(async () => {
                await api("link", "POST", { action: "unlink" }); await reload();
              })}>Отвязать аккаунт</button>
            </> : <>
              <p>В личном чате с <a href="https://t.me/moideladelishki_bot" target="_blank" rel="noreferrer">ботом</a> отправь /webkey и введи полученный код здесь. Привязать можно один аккаунт.</p>
              <form onSubmit={event => {
                event.preventDefault();
                const code = String(new FormData(event.currentTarget).get("linkCode")).trim();
                run(async () => { await api("link", "POST", { code }); await reload(); });
              }}><label>Код привязки<input name="linkCode" maxLength={24} autoComplete="off" required /></label><button disabled={working}>Привязать</button></form>
            </>}
          </section>}
        </>}
        {!data && !working && <button onClick={() => run(refreshSession)}>Загрузить дела</button>}
      </>}
    </main>
    <style jsx global>{`
      * { box-sizing: border-box; }
      body { margin: 0; background: #eff3fa; color: #172235; font: 1rem/1.5 system-ui, sans-serif; }
      .planner { width: min(64rem, 100% - 2rem); margin: auto; padding-block: 1rem 3rem; }
      .planner header, .planner .task { display: flex; justify-content: space-between; gap: .85rem; align-items: center; flex-wrap: wrap; }
      .planner a { color: #183eaf; }
      .planner .brand { font-weight: 760; text-decoration: none; color: inherit; }
      .planner h1 { font-size: clamp(2.3rem, 7vw, 4.3rem); letter-spacing: -.055em; margin-block: .6rem; }
      .planner h2 { font-size: 1.3rem; margin: 0 0 .8rem; }
      .planner .panel { padding: 1.25rem; margin-block: 1rem; border-radius: 1rem; border: 1px solid #d4deef; background: #fff; }
      .planner .auth { max-width: 36rem; }
      .planner form, .planner fieldset, .planner .actions { display: flex; flex-wrap: wrap; gap: .65rem; align-items: end; }
      .planner fieldset { border: 0; padding: 0; margin: 0; width: 100%; min-width: 0; }
      .planner label:not(.checkbox) { display: grid; gap: .15rem; }
      .planner input:not([type=checkbox]) { padding: .52rem; min-width: 0; max-width: 100%; border: 1px solid #7888a4; border-radius: .45rem; font: inherit; color: inherit; }
      .planner .checkbox { display: inline-flex; gap: .35rem; align-items: center; flex-wrap: wrap; }
      .planner button { border: 0; padding: .58rem .72rem; border-radius: .55rem; background: #244dcc; color: #fff; font: inherit; cursor: pointer; }
      .planner button.secondary { background: #e3ebff; color: #17337f; }
      .planner button:disabled { opacity: .6; cursor: wait; }
      .planner ul { list-style: none; margin: .75rem 0; padding: 0; }
      .planner li { padding: .8rem 0; border-bottom: 1px solid #d4deef; }
      .planner time { font-size: .9rem; color: #4b556c; display: block; }
      .planner .done { text-decoration: line-through; }
      .planner .error { color: #96261d; }
      .planner .account { overflow-wrap: anywhere; }
      .planner :focus-visible { outline: 3px solid #173ab2; outline-offset: 3px; }
    `}</style>
  </>;
}
