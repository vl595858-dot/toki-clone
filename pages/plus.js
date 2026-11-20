import Head from 'next/head';
import { useEffect, useState } from 'react';
import { price as launchPrice, durationDays } from '../lib/plusPricing';

const publicBotUrl = 'https://t.me/moideladelishki_bot';

export async function getServerSideProps() {
  const { config } = require('../lib/plusPayments');
  const settings = config();
  const { PLUS_SELLER_NAME, PLUS_SELLER_INN, PLUS_SELLER_OGRNIP, PLUS_SUPPORT_EMAIL, PLUS_SUPPORT_PHONE } = process.env;
  const seller = PLUS_SELLER_NAME && PLUS_SELLER_INN && PLUS_SELLER_OGRNIP && PLUS_SUPPORT_EMAIL
    ? { name: PLUS_SELLER_NAME, inn: PLUS_SELLER_INN, ogrnip: PLUS_SELLER_OGRNIP,
        email: PLUS_SUPPORT_EMAIL, phone: PLUS_SUPPORT_PHONE || null }
    : null;
  return { props: {
    seller,
    testCheckout: Boolean(settings),
    botUrl: settings ? `https://t.me/${settings.bot}` : publicBotUrl,
  } };
}

export default function PlusPage({ testCheckout, botUrl, seller }) {
  return (
    <>
      <Head>
        <title>Мои делишки — планировщик в Telegram</title>
        <meta name="description" content="Записывайте дела голосом и получайте напоминания в Telegram. Тариф «Плюс» — 290 ₽ за 30 дней." />
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <main className="page" lang="ru">
        <header className="header wrap">
          <a href="#top" className="brand"><span aria-hidden="true">✓</span>Мои делишки</a>
          <nav aria-label="Навигация"><a href="#plans">Тарифы</a>{seller && <a href="#contacts">Контакты</a>}</nav>
        </header>
        <section className="hero wrap" id="top" aria-labelledby="intro">
          <div>
            <h1 id="intro">Скажи дело.<br />Бот напомнит.</h1>
            <p>Записывайте дела голосом или текстом. Бот разберёт дату, добавит дело в календарь и напомнит прямо в Telegram.</p>
            <a className="button" href={botUrl}>Попробовать в Telegram</a>
          </div>
          <figure className="example">
            <figcaption>Пример записи</figcaption>
            <blockquote>Напомни завтра в 18:00 позвонить в студию.</blockquote>
            <div className="event">
              <span className="tick" aria-hidden="true">✓</span>
              <div><strong>Позвонить в студию</strong><span>Завтра, 18:00</span></div>
            </div>
          </figure>
        </section>
        <section className="plans wrap" id="plans" aria-labelledby="plan-title">
          <h2 id="plan-title">Тарифы при запуске оплаты</h2>
          <div className="cards">
            <article className="card">
              <h3>Бесплатный</h3>
              <p className="price">0 ₽</p>
              <ul>
                <li>До 30 новых дел и 30 голосовых за 30 дней</li>
                <li>Календарь, поиск и перенос дел</li>
                <li>Одно напоминание на дело</li>
              </ul>
              <a className="secondary" href={botUrl}>Открыть бота</a>
            </article>
            <article className="card premium">
              <h3>Плюс</h3>
              <p className="price">{launchPrice} ₽ <span>за {durationDays} дней</span></p>
              <ul>
                <li>Создание дел без месячного лимита</li>
                <li>До 120 голосовых за 30 дней</li>
                <li>Разбор до 30 скриншотов билетов, записей и счетов</li>
              </ul>
              {testCheckout
                ? <TestCheckout />
                : <p className="status">Оплата пока недоступна. Подключаем ЮKassa.</p>}
            </article>
          </div>
        </section>
        <section className="details wrap" id="access" aria-labelledby="access-title">
          <h2 id="access-title">Как получить Плюс</h2>
          <p>После запуска оплаты войдите на сайте через Telegram и оплатите 290 ₽ картой или через СБП. Когда ЮKassa подтвердит платёж, Плюс включится в боте на том же аккаунте на 30 дней. Оплата разовая.</p>
        </section>
        {seller && (
          <>
            <section className="details wrap" aria-labelledby="terms-title">
              <h2 id="terms-title">Публичная оферта</h2>
              <p className="status">Проект условий. Оплата пока недоступна.</p>
              <details className="offer">
                <summary>Условия платного доступа</summary>
                <div>
                  <h3>Услуга</h3>
                  <p>{seller.name} предоставляет доступ к расширенным возможностям онлайн-планировщика «Мои делишки» по тарифу «Плюс». Состав тарифа указан на этой странице.</p>
                  <h3>Оплата и активация</h3>
                  <p>Стоимость доступа — {launchPrice} ₽ за {durationDays} дней. Договор заключается после подтверждения платежа. Оплата разовая, автоматического продления нет. После подтверждения платежа доступ включается в Telegram-боте для аккаунта, указанного при оформлении покупки. Срок доступа отсчитывается с момента его активации. По окончании срока действует бесплатный тариф.</p>
                  <h3>Поддержка и возврат</h3>
                  <p>Если доступ не включился или вы хотите отказаться от услуги, напишите на <a href={`mailto:${seller.email}`}>{seller.email}</a>. Укажите дату платежа и номер заказа, если он у вас есть. Потребитель вправе отказаться от договора в любое время с учётом фактически понесённых исполнителем расходов, связанных с исполнением договора. Обращения и возвраты рассматриваются в соответствии с законодательством Российской Федерации.</p>
                  <h3>Исполнитель</h3>
                  <p>Реквизиты и способы связи указаны в разделе <a href="#contacts">«Контакты»</a> ниже.</p>
                </div>
              </details>
            </section>
            <footer className="footer wrap" id="contacts">
              <h2>Контакты</h2>
              <p>{seller.name} · ИНН {seller.inn} · ОГРНИП {seller.ogrnip}</p>

              <p><a href={`mailto:${seller.email}`}>{seller.email}</a>{seller.phone && <> · <a href={`tel:${seller.phone.replace(/[^+0-9]/g, '')}`}>{seller.phone}</a></>}</p>
            </footer>
          </>
        )}
      </main>
      <style jsx>{`
        .page { min-height: 100vh; color: #172235; background: #eff3fa; font: 1rem/1.6 system-ui, sans-serif; }
        .wrap { width: min(68rem, calc(100% - 3rem)); margin-inline: auto; }
        .header { display: flex; justify-content: space-between; align-items: center; padding-block: 1.4rem; gap: 1rem; }
        .brand { display: inline-flex; gap: .6rem; align-items: center; font-weight: 750; }
        .brand span, .tick { display: grid; place-items: center; width: 1.9rem; height: 1.9rem; border-radius: .65rem; background: #dce6ff; color: #183eaf; }
        nav { display: flex; flex-wrap: wrap; gap: 1rem; }
        a { color: inherit; text-decoration: none; }
        nav a:hover, .footer a:hover { text-decoration: underline; }
        a:focus-visible { outline: 3px solid #173ab2; outline-offset: 4px; }
        .hero { display: grid; grid-template-columns: 1.2fr 1fr; align-items: center; gap: 3rem; padding-block: clamp(3rem, 9vw, 7rem); }
        h1, h2, h3, p, figure, blockquote { margin: 0; }
        h1 { font-size: clamp(3rem, 6vw, 5.25rem); line-height: .99; letter-spacing: -.065em; }
        .hero p { max-width: 32rem; font-size: 1.15rem; margin-block: 1.4rem; }
        .button, .secondary { display: inline-block; border-radius: .85rem; padding: .72rem 1.05rem; font-weight: 700; }
        .button { background: #244dcc; color: #fff; }
        .button:hover { background: #193bac; }
        .example { padding: clamp(1.2rem, 4vw, 2.4rem); background: #172235; color: #fff; border-radius: 1.6rem; }
        figcaption { font-weight: 650; color: #b9cafd; margin-bottom: .9rem; }
        blockquote { background: #2b3a56; padding: .85rem 1rem; border-radius: .8rem .8rem .8rem .15rem; }
        .event { display: flex; align-items: center; gap: .75rem; color: #172235; background: #fff; border-radius: .8rem; margin-top: 1.2rem; padding: .85rem 1rem; }
        .event span { display: block; font-size: .95rem; }
        .event .tick { display: grid; flex-shrink: 0; }
        h2 { font-size: clamp(1.7rem, 3.5vw, 2.5rem); line-height: 1.12; letter-spacing: -.03em; margin-bottom: 1rem; }
        h3 { font-size: 1.2rem; }
        .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
        .card { padding: clamp(1.25rem, 3vw, 2rem); border-radius: 1.2rem; border: 1px solid #d3ddef; background: #fff; }
        .premium { border-color: #809bea; }
        .price { font-size: 2.6rem; line-height: 1.15; font-weight: 750; margin-top: .65rem; }
        .price span { font-size: 1rem; font-weight: 500; }
        ul { padding-left: 1.2em; margin-block: 1.1rem; }
        li + li { margin-top: .35rem; }
        .secondary { color: #183eaf; background: #e3ebff; }
        .secondary:hover { background: #d4e0ff; }
        .status { color: #4b556c; }
        .details { padding-top: 2.5rem; }
        .details p { max-width: 46rem; }
        .details p + p { margin-top: .55rem; }
        .offer { margin-top: 1rem; padding: 1rem 1.2rem; border: 1px solid #d3ddef; border-radius: .85rem; background: #fff; }
        summary { cursor: pointer; font-weight: 700; }
        .offer h3 { margin-top: 1rem; }
        .offer a { color: #183eaf; text-decoration: underline; }
        .footer { margin-top: 2.75rem; border-top: 1px solid #cdd7ec; padding-block: 1.8rem 2.5rem; }
        .footer h2 { font-size: 1.4rem; }
        .footer a { color: #183eaf; }
        @media (max-width: 45rem) {
          .wrap { width: min(68rem, calc(100% - 2rem)); }
          .hero, .cards { grid-template-columns: 1fr; }
          .hero { gap: 1.75rem; }
        }
        @media (max-width: 22rem) { .header { align-items: flex-start; flex-direction: column; } }
      `}</style>
      <style jsx global>{`body { margin: 0; } * { box-sizing: border-box; }`}</style>
    </>
  );
}

async function orderRequest(action) {
  const response = await fetch('/api/plus/order', action ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  } : { cache: 'no-store' });
  if (!response.ok) throw new Error('Заказ недоступен');
  return response.json();
}

function TestCheckout() {
  const [order, setOrder] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const status = order?.status;

  useEffect(() => {
    let mounted = true;
    let timer;
    async function refresh() {
      try {
        const result = await orderRequest();
        if (!mounted) return;
        setOrder(result);
        if (['unlinked', 'payment_pending'].includes(result.status)) timer = setTimeout(refresh, 2500);
      } catch {
        if (mounted) setError('Не удалось проверить заказ. Обновите страницу.');
      }
    }
    refresh();
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [status]);

  async function submit(action) {
    setBusy(true);
    setError('');
    try {
      const result = await orderRequest(action);
      if (result.paymentUrl) {
        window.location.assign(result.paymentUrl);
        return;
      }
      setOrder(await orderRequest());
    } catch {
      setError('Не удалось обработать заказ. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p>Тестовый режим. Используйте тестовую карту ЮKassa.</p>
      {['new', 'expired', 'canceled', 'succeeded'].includes(status) && (
        <>
          {status === 'expired' && <p>Время подтверждения истекло.</p>}
          {status === 'canceled' && <p>ЮKassa отменила платёж.</p>}
          {status === 'succeeded' && <p role="status">Тестовый Плюс активен до {new Date(order.accessUntil).toLocaleDateString('ru-RU', { timeZone: 'Asia/Yekaterinburg' })} по времени Перми.</p>}
          <button type="button" disabled={busy} onClick={() => submit('start')}>Создать тестовый заказ</button>
        </>
      )}
      {status === 'unlinked' && (
        <p><a href={order.telegramUrl} target="_blank" rel="noreferrer">Подтвердить аккаунт в Telegram</a>. Затем вернитесь на эту страницу.</p>
      )}
      {status === 'linked' && (
        <button type="button" disabled={busy} onClick={() => submit('checkout')}>Тестовая оплата · {launchPrice} ₽</button>
      )}
      {status === 'payment_pending' && (
        <>
          <p role="status">Ждём подтверждения платежа от ЮKassa.</p>
          <button type="button" disabled={busy} onClick={() => submit('checkout')}>Проверить платёж или вернуться к оплате</button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <style jsx>{`
        p { margin-block: .45rem; }
        a { color: #183eaf; }
        button { font: inherit; font-weight: 700; color: #fff; background: #244dcc; border: 0; border-radius: .8rem; padding: .65rem .9rem; cursor: pointer; }
        button:disabled { opacity: .65; cursor: wait; }
      `}</style>
    </div>
  );
}
