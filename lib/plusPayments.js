const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { query, withTransaction } = require("./db");
const { amount, durationDays } = require("./plusPricing");

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const BROWSER_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const COOKIE = "plus_test_order";

function config() {
  const origin = process.env.PLUS_TEST_ORIGIN;
  const bot = process.env.PLUS_TEST_BOT;
  const userId = process.env.PLUS_TEST_TELEGRAM_ID;
  const shopId = process.env.YOOKASSA_TEST_SHOP_ID;
  const key = process.env.YOOKASSA_TEST_SECRET_KEY;
  if (process.env.PLUS_TEST_ENABLED !== "1" || process.env.VERCEL_ENV === "production") return null;
  if (!/^https:\/\/[a-z0-9][a-z0-9.-]+(?::\d+)?$/i.test(origin || "")) return null;
  if (!/^[A-Za-z0-9_]{5,32}$/.test(bot || "") || !/^[1-9]\d{0,15}$/.test(userId || "")) return null;
  if (!/^\d+$/.test(shopId || "") || !/^test_[A-Za-z0-9_-]+$/.test(key || "")) return null;
  return { origin, bot, userId, shopId, key };
}

function hash(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function createOrder() {
  const token = randomBytes(32).toString("base64url");
  await query("INSERT INTO plus_test_orders (id, browser_token_hash) VALUES ($1, $2)", [randomUUID(), hash(token)]);
  return token;
}

async function browserOrder(token) {
  if (typeof token !== "string" || !BROWSER_TOKEN.test(token)) return null;
  const { rows } = await query(
    "SELECT *, created_at > now() - interval '20 minutes' AS can_start FROM plus_test_orders WHERE browser_token_hash = $1",
    [hash(token)],
  );
  return rows[0] || null;
}

async function linkOrder(id, userId) {
  const result = await query(
    `UPDATE plus_test_orders SET telegram_user_id = $2
     WHERE id = $1 AND created_at > now() - interval '20 minutes'
       AND (telegram_user_id IS NULL OR telegram_user_id = $2)`,
    [id, userId],
  );
  return result.rowCount === 1;
}

async function accessUntil(userId) {
  const { rows } = await query(
    "SELECT max(access_until) AS access_until FROM plus_test_orders WHERE telegram_user_id = $1 AND access_until > now()",
    [userId],
  );
  return rows[0].access_until;
}

async function yooRequest(settings, path, options = {}) {
  const response = await fetch(`https://api.yookassa.ru/v3/payments${path}`, {
    method: options.body ? "POST" : "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`${settings.shopId}:${settings.key}`).toString("base64")}`,
      ...(options.body && { "Content-Type": "application/json", "Idempotence-Key": options.orderId }),
    },
    body: options.body && JSON.stringify(options.body),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const error = new Error(`ЮKassa API HTTP ${response.status}`);
    error.httpStatus = response.status;
    throw error;
  }
  return response.json();
}

function matches(payment, order, settings) {
  return UUID.test(payment?.id || "") && payment.test === true &&
    payment.amount?.value === amount.value && payment.amount?.currency === amount.currency &&
    payment.metadata?.order_id === order.id &&
    (!order.payment_id || payment.id === order.payment_id) &&
    String(order.telegram_user_id) === settings.userId;
}

async function savePayment(payment, orderId, settings) {
  return withTransaction(async (client) => {
    // Serializes redelivery and extensions from separate orders for the same test user.
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [settings.userId]);
    const { rows: [order] } = await client.query("SELECT * FROM plus_test_orders WHERE id = $1 FOR UPDATE", [orderId]);
    if (!order || !matches(payment, order, settings)) return false;
    if (order.status !== "pending") return true;

    if (payment.status === "succeeded" && payment.paid === true) {
      await client.query(
        `UPDATE plus_test_orders
         SET payment_id = $1, status = 'succeeded', access_until = (
           SELECT greatest(now(), max(access_until)) + $4::int * interval '24 hours'
           FROM plus_test_orders WHERE telegram_user_id = $3
         ) WHERE id = $2`,
        [payment.id, orderId, settings.userId, durationDays],
      );
    } else {
      await client.query(
        "UPDATE plus_test_orders SET payment_id = $1, status = $3 WHERE id = $2",
        [payment.id, orderId, payment.status === "canceled" ? "canceled" : "pending"],
      );
    }
    return true;
  });
}

function confirmationUrl(payment) {
  try {
    const url = new URL(payment.confirmation?.confirmation_url);
    if (url.protocol === "https:" && !url.username && !url.password &&
      ["yoomoney.ru", "yookassa.ru"].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return url.href;
  } catch {
    // The provider may omit confirmation for a finalized payment.
  }
  return null;
}

async function checkout(order, settings) {
  if (String(order.telegram_user_id) !== settings.userId || order.status !== "pending") return null;
  if (!order.payment_id && !order.can_start) return null;
  const payment = order.payment_id
    ? await yooRequest(settings, `/${order.payment_id}`)
    : await yooRequest(settings, "", { orderId: order.id, body: {
      amount,
      capture: true,
      payment_method_data: { type: "bank_card" },
      confirmation: { type: "redirect", return_url: `${settings.origin}/plus#plans` },
      description: `Мои делишки — Плюс на ${durationDays} дней (тест)`,
      metadata: { order_id: order.id },
    } });
  if (!matches(payment, order, settings) || !(await savePayment(payment, order.id, settings))) {
    throw new Error("ЮKassa: платёж не соответствует тестовому заказу");
  }
  return payment.status === "pending" ? confirmationUrl(payment) : null;
}

async function receiveNotification(notification, settings) {
  if (notification?.type !== "notification" || !["payment.succeeded", "payment.canceled"].includes(notification.event)) return;
  const { id: paymentId, metadata } = notification.object || {};
  if (!UUID.test(paymentId || "") || !UUID.test(metadata?.order_id || "")) return;
  const { rows: [order] } = await query("SELECT * FROM plus_test_orders WHERE id = $1", [metadata.order_id]);
  if (!order || order.status !== "pending" || !matches(notification.object, order, settings)) return;
  let payment;
  try {
    payment = await yooRequest(settings, `/${paymentId}`);
  } catch (error) {
    if (error.httpStatus === 404) return;
    throw error;
  }
  if (payment?.id !== paymentId || !matches(payment, order, settings)) return;
  if (`payment.${payment.status}` !== notification.event || (payment.status === "succeeded" && payment.paid !== true)) {
    throw new Error("ЮKassa: статус платежа ещё не подтверждён");
  }
  await savePayment(payment, order.id, settings);
}

module.exports = { UUID, COOKIE, config, createOrder, browserOrder, linkOrder, accessUntil, checkout, receiveNotification };
