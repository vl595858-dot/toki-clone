const { randomUUID, timingSafeEqual } = require("node:crypto");
const db = require("./webPlannerDb");
const { UUID } = require("./webPlannerAuth");
const { lock } = require("./webPlanner");
const { price, durationDays } = require("./plusPricing");

const TERMS_VERSION = "web-plus-1";
const DAY_MS = 86400000;

function paymentConfig(web) {
  const mode = process.env.WEB_YOOKASSA_MODE;
  const test = mode === "test";
  const production = process.env.VERCEL_ENV === "production";
  if (!web || (test ? production : mode !== "live" || !production)) return null;
  const shopId = process.env.WEB_YOOKASSA_SHOP_ID;
  const secret = process.env.WEB_YOOKASSA_SECRET_KEY;
  const hookKey = process.env.WEB_YOOKASSA_HOOK_KEY;
  const vat = process.env.WEB_YOOKASSA_VAT_CODE;
  const subject = process.env.WEB_YOOKASSA_PAYMENT_SUBJECT;
  const paymentMode = process.env.WEB_YOOKASSA_PAYMENT_MODE;
  if (!/^\d+$/.test(shopId || "") || !new RegExp(test ? "^test_[\\w-]+$" : "^live_[\\w-]+$").test(secret || "") ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(hookKey || "") || !/^(?:[1-9]|1[0-2])$/.test(vat || "") ||
      !["service", "intellectual_activity"].includes(subject) ||
      paymentMode !== "full_payment") return null;
  if (!test && (process.env.WEB_YOOKASSA_LIVE_APPROVED !== "1" || !process.env.PLUS_SELLER_NAME ||
      !process.env.PLUS_SELLER_INN || !process.env.PLUS_SELLER_OGRNIP || !process.env.PLUS_SUPPORT_EMAIL)) return null;
  return { origin: web.origin, test, shopId, secret, hookKey, vat: Number(vat), subject, paymentMode };
}

const checkoutAvailable = (settings) => Boolean(settings) && process.env.WEB_YOOKASSA_CHECKOUT_PAUSED !== "1";

function hookMatches(actual, expected) {
  return typeof actual === "string" && Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

async function api(settings, endpoint, body, id) {
  const response = await fetch(`https://api.yookassa.ru/v3/${endpoint}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`${settings.shopId}:${settings.secret}`).toString("base64")}`,
      ...(body && { "Content-Type": "application/json", "Idempotence-Key": id }),
    },
    body: body && JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const error = new Error("ЮKassa API request failed");
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function amountMinor(amount, currency = "RUB") {
  if (amount?.currency !== currency || typeof amount?.value !== "string" || !/^\d{1,8}\.\d{2}$/.test(amount.value)) return null;
  return Number(amount.value.replace(".", ""));
}

function redirect(payment) {
  try {
    const url = new URL(payment.confirmation?.confirmation_url);
    if (url.protocol === "https:" && !url.port &&
        ["yoomoney.ru", "yookassa.ru"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
      if (!url.username && !url.password) return url.href;
    }
  } catch {
    // Completed payments have no confirmation URL.
  }
  return null;
}

function expiryFor(orders) {
  let until = 0;
  for (const order of orders) {
    until = Math.max(until, new Date(order.paid_at).getTime()) + order.days * DAY_MS;
  }
  return until ? new Date(until) : null;
}

async function refreshAccess(client, order) {
  const { rows } = await client.query(
    `SELECT paid_at, days FROM web_plus_orders
     WHERE user_id = $1 AND is_test = $2 AND state = 'succeeded' AND refunded_minor < amount_minor
     ORDER BY paid_at, id`, [order.user_id, order.is_test]);
  const until = expiryFor(rows);
  if (!until) {
    await client.query("DELETE FROM web_plus_access WHERE user_id = $1 AND is_test = $2", [order.user_id, order.is_test]);
  } else {
    await client.query(`INSERT INTO web_plus_access(user_id,is_test,expires_at) VALUES ($1,$2,$3)
      ON CONFLICT(user_id,is_test) DO UPDATE SET expires_at = EXCLUDED.expires_at`, [order.user_id, order.is_test, until]);
  }
}

async function recordPayment(orderId, payment, settings, refund) {
  return db.withTransaction(async client => {
    const { rows: [candidate] } = await client.query("SELECT user_id FROM web_plus_orders WHERE id = $1", [orderId]);
    if (!candidate) return null;
    await lock(client, candidate.user_id);
    const { rows: [order] } = await client.query("SELECT * FROM web_plus_orders WHERE id = $1 FOR UPDATE", [orderId]);
    if (!order || order.is_test !== settings.test || payment.test !== settings.test ||
        !UUID.test(payment.id || "") || (order.payment_id && payment.id !== order.payment_id) ||
        payment.metadata?.web_order !== order.id ||
        amountMinor(payment.amount, order.currency) !== order.amount_minor) return null;
    const nextState = payment.status;
    if (!["pending", "succeeded", "canceled"].includes(nextState) ||
        (nextState === "succeeded" && payment.paid !== true) ||
        (order.state !== "pending" && ![order.state, "pending"].includes(nextState))) return null;
    if (refund && (nextState !== "succeeded" || refund.payment_id !== payment.id ||
        refund.status !== "succeeded" || !UUID.test(refund.id) ||
        !(amountMinor(refund.amount, order.currency) > 0))) return null;
    if (refund) {
      await client.query("INSERT INTO web_plus_refunds (id,order_id,amount_minor) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING",
        [refund.id, order.id, amountMinor(refund.amount, order.currency)]);
    }
    const { rows: [{ total }] } = await client.query(
      "SELECT coalesce(sum(amount_minor), 0)::int AS total FROM web_plus_refunds WHERE order_id = $1", [order.id]);
    const refunded = Math.max(order.refunded_minor, amountMinor(payment.refunded_amount, order.currency) || 0, total);
    if (refunded > order.amount_minor) throw new Error("Unexpected refund total");
    const state = order.state === "pending" ? nextState : order.state;
    const capturedAt = Number.isFinite(Date.parse(payment.captured_at)) ? payment.captured_at : null;
    await client.query(
      `UPDATE web_plus_orders SET payment_id = $2, state = $3,
       paid_at = CASE WHEN $3 = 'succeeded' THEN coalesce(paid_at, $4, statement_timestamp()) ELSE paid_at END, refunded_minor = $5,
       email = CASE WHEN $3 = 'pending' THEN email ELSE NULL END
       WHERE id = $1`,
      [order.id, payment.id, state, capturedAt, refunded]);
    if (state !== order.state || refunded !== order.refunded_minor) await refreshAccess(client, order);
    return state;
  });
}

async function pendingOrder(account, settings, create) {
  return db.withTransaction(async client => {
    await lock(client, account.id);
    const { rows: [current] } = await client.query(
      `SELECT *, created_at > statement_timestamp() - interval '30 minutes' AS retryable
       FROM web_plus_orders WHERE user_id = $1 AND is_test = $2 AND state = 'pending'`, [account.id, settings.test]);
    if (current || !create) return current || null;
    const { rows: [order] } = await client.query(
      `INSERT INTO web_plus_orders(id,user_id,email,terms_version,vat_code,payment_subject,payment_mode,amount_minor,days,is_test)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *, true AS retryable`,
      [randomUUID(), account.id, account.email, TERMS_VERSION, settings.vat, settings.subject,
        settings.paymentMode, price * 100, durationDays, settings.test]);
    return order;
  });
}

async function checkout(account, settings, create) {
  const order = await pendingOrder(account, settings, create);
  if (!order) return { state: null };
  if (!order.payment_id && (!create || !order.retryable)) return { state: "review" };
  const amount = { value: (order.amount_minor / 100).toFixed(2), currency: order.currency };
  const description = `Мои делишки — веб-планировщик Плюс, ${order.days} дней`;
  const payment = order.payment_id
    ? await api(settings, `payments/${order.payment_id}`)
    : await api(settings, "payments", {
      amount,
      capture: true,
      confirmation: { type: "redirect", return_url: `${settings.origin}/planner?returned=1` },
      description,
      metadata: { web_order: order.id },
      receipt: {
        customer: { email: order.email },
        items: [{
          description,
          quantity: "1.00",
          amount,
          vat_code: order.vat_code,
          payment_mode: order.payment_mode,
          payment_subject: order.payment_subject,
        }],
      },
    }, order.id);
  const state = await recordPayment(order.id, payment, settings);
  if (!state) throw new Error("Provider payment mismatch");
  const url = state === "pending" ? redirect(payment) : null;
  return { state: state === "pending" && create && !url ? "review" : state, url };
}

async function notification(settings, event) {
  if (event?.type !== "notification") return;
  const id = event.object?.id;
  if (typeof id !== "string" || !UUID.test(id)) return;
  let refund;
  let payment;
  try {
    if (event.event === "refund.succeeded") {
      refund = await api(settings, `refunds/${id}`);
      if (refund.id !== id || refund.status !== "succeeded" || !UUID.test(refund.payment_id || "")) return;
      payment = await api(settings, `payments/${refund.payment_id}`);
    } else if (["payment.succeeded", "payment.canceled"].includes(event.event)) {
      payment = await api(settings, `payments/${id}`);
      if (payment.id !== id) return;
      if (payment.status === "pending") throw new Error("Provider status not ready");
    } else {
      return;
    }
  } catch (error) {
    if (error.status === 404) return;
    throw error;
  }
  const orderId = payment.metadata?.web_order;
  if (UUID.test(orderId || "")) await recordPayment(orderId, payment, settings, refund);
}

module.exports = { TERMS_VERSION, paymentConfig, checkoutAvailable, hookMatches, checkout, notification, expiryFor, recordPayment };
