import Head from 'next/head';
import { price as launchPrice, durationDays } from '../lib/plusPricing';
import { limits } from '../lib/plusPlanLimits';

export async function getServerSideProps() {
  const { config } = require('../lib/webPlannerAuth');
  const { paymentConfig, checkoutAvailable } = require('../lib/webPlannerPayments');
  const payment = paymentConfig(config());
  const { PLUS_SELLER_NAME, PLUS_SELLER_INN, PLUS_SELLER_OGRNIP, PLUS_SUPPORT_EMAIL, PLUS_SUPPORT_PHONE } = process.env;
  const seller = PLUS_SELLER_NAME && PLUS_SELLER_INN && PLUS_SELLER_OGRNIP && PLUS_SUPPORT_EMAIL
    ? { name: PLUS_SELLER_NAME, inn: PLUS_SELLER_INN, ogrnip: PLUS_SELLER_OGRNIP,
        email: PLUS_SUPPORT_EMAIL, phone: PLUS_SUPPORT_PHONE || null }
    : null;
  return { props: {
    seller,
    canBuy: checkoutAvailable(payment),
    paymentMode: payment?.test ? 'test' : payment ? 'live' : null,
  } };
}

export default function PlusPage({ paymentMode, canBuy, seller }) {
  return (
    <>
      <Head>
        <title>Мои делишки — веб-планировщик</title>
        <meta name="description" content="Создавайте дела с датами, отмечайте выполненное и находите задачи в веб-планировщике «Мои делишки»." />
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <main className="page" lang="ru">
        <header className="header wrap">
          <a href="#top" className="brand"><span aria-hidden="true">✓</span>Мои делишки</a>
          <nav aria-label="Навигация"><a href="#plans">Тарифы</a>{seller && <a href="#contacts">Контакты</a>}</nav>
        </header>
        <section className="hero wrap" id="top" aria-labelledby="intro">
          <div>
            <h1 id="intro">Все дела<br />под рукой</h1>
            <p>Записывайте дела, назначайте даты и отмечайте выполненное. Войдите по электронной почте и пользуйтесь планировщиком прямо в браузере.</p>
            <a className="button" href="/planner">Открыть планировщик</a>
          </div>
          <figure className="example">
            <figcaption>Пример записи</figcaption>
            <blockquote>Позвонить в студию</blockquote>
            <div className="event">
              <span className="tick" aria-hidden="true">✓</span>
              <div><strong>Позвонить в студию</strong><span>Запланировано на завтра</span></div>
            </div>
          </figure>
        </section>
        <section className="plans wrap" id="plans" aria-labelledby="plan-title">
          <h2 id="plan-title">Тарифы</h2>
          <div className="cards">
            <article className="card">
              <h3>Бесплатный</h3>
              <p className="price">0 ₽</p>
              <ul>
                <li>До {limits.free.event} новых дел за последние 30 дней</li>
                <li>Список дел с датами, поиск, редактирование и отметки выполнения</li>
              </ul>
              <a className="secondary" href="/planner">Начать бесплатно</a>
            </article>
            <article className="card premium">
              <h3>Плюс</h3>
              <p className="price">{launchPrice} ₽ <span>за {durationDays} дней</span></p>
              <ul>
                <li>Все возможности бесплатного тарифа</li>
                <li>Создание дел без месячного лимита</li>
                <li>Экспорт всего списка дел в CSV</li>
              </ul>
              {canBuy
                ? <a className="button" href="/planner#purchase">{paymentMode === 'test' ? 'Проверить тестовую оплату' : 'Подключить Плюс'}</a>
                : <p className="status">Оплата пока недоступна.</p>}
            </article>
          </div>
        </section>
        <section className="details wrap" id="access" aria-labelledby="access-title">
          <h2 id="access-title">Как получить Плюс</h2>
          <p>Войдите в веб-планировщик по электронной почте. После запуска оплаты «Плюс» подключается в веб-кабинете после подтверждения платежа ЮKassa. Разовая оплата открывает доступ на {durationDays} дней. При действующем «Плюсе» новая покупка продлевает веб-доступ.</p>
        </section>
        {!seller && paymentMode === 'test' && (
          <section id="terms" className="details wrap">
            <h2>Условия тестовой оплаты</h2>
            <p>Используйте тестовую карту ЮKassa. Платёж проверяет подключение веб-тарифа в тестовом кабинете, деньги не списываются.</p>
          </section>
        )}
        {seller && (
          <>
            <section id="terms" className="details wrap" aria-labelledby="terms-title">
              <h2 id="terms-title">Публичная оферта</h2>
              <p className="status">{paymentMode === 'live' ? 'Условия покупки в веб-планировщике' : 'Условия веб-тарифа. Боевые платежи пока выключены.'}</p>
              <details className="offer">
                <summary>Условия платного доступа</summary>
                <div>
                  <h3>Услуга</h3>
                  <p>{seller.name} предоставляет доступ к расширенным возможностям онлайн-планировщика «Мои делишки» по тарифу «Плюс». Состав тарифа указан на этой странице.</p>
                  <h3>Оплата и активация</h3>
                  <p>Стоимость доступа — {launchPrice} ₽ за {durationDays} дней. Договор заключается после подтверждения платежа. Оплата разовая, автоматического продления нет. После подтверждения платежа доступ включается в веб-аккаунте, из которого оформлена покупка. Срок отсчитывается от подтверждения платежа или от окончания действующего веб-доступа, если он уже есть. Электронный чек направляется на почту аккаунта. По окончании срока действует бесплатный тариф.</p>
                  <h3>Поддержка и возврат</h3>
                  <p>Если доступ не включился или вы хотите отказаться от услуги, напишите на <a href={`mailto:${seller.email}`}>{seller.email}</a>. Укажите дату платежа и номер заказа, если он у вас есть. Потребитель вправе отказаться от договора в любое время с учётом фактически понесённых исполнителем расходов, связанных с исполнением договора. Обращения и возвраты рассматриваются в соответствии с законодательством Российской Федерации.</p>
                  <h3>Исполнитель</h3>
                  <p>Реквизиты и способы связи указаны в разделе <a href="#contacts">«Контакты»</a> ниже.</p>
                </div>
              </details>
            </section>
            <section className="details wrap" id="privacy">
              <h2>Данные веб-аккаунта</h2>
              <p>Адрес почты используется для входа, поддержки и отправки чека. Названия, даты и отметки выполнения хранятся в веб-аккаунте. Данные карты вводятся на странице ЮKassa. Веб-планировщик их не получает. По вопросам доступа к данным или удаления аккаунта напишите в поддержку.</p>
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
