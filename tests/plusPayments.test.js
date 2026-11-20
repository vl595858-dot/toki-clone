const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../lib/db");

const ORDER_ID = "cefbe0a5-25ab-46d2-8f5a-22e9fde9437d";
const PAYMENT_ID = "299e7a1b-000f-5000-8000-126628f15141";
const settings = { origin: "https://preview.example.com", userId: "11", shopId: "81", key: "test_example" };

function setup(t) {
  const order = {
    id: ORDER_ID, telegram_user_id: "11", can_start: true, status: "pending", payment_id: null,
  };
  const requests = [];
  const grants = [];
  const payment = {
    id: PAYMENT_ID, status: "pending", paid: false, test: true,
    amount: { value: "290.00", currency: "RUB" },
    metadata: { order_id: ORDER_ID },
    confirmation: { confirmation_url: "https://yoomoney.ru/confirm" },
  };
  const query = async (sql, args) => {
    if (sql.startsWith("SELECT pg_advisory")) return { rows: [] };
    if (sql.startsWith("SELECT *")) return { rows: [{ ...order }] };
    assert.equal(args[1], ORDER_ID);
    order.payment_id = args[0];
    if (sql.includes("SET payment_id = $1, status = 'succeeded'")) {
      grants.push(args.slice(2));
      order.status = "succeeded";
    } else {
      order.status = args[2];
    }
    return { rows: [] };
  };
  t.mock.method(db, "query", query);
  t.mock.method(db, "withTransaction", async (fn) => fn({ query }));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ ...payment }) };
  });
  const path = require.resolve("../lib/plusPayments");
  delete require.cache[path];
  return { ...require(path), order, requests, payment, grants };
}

function notify(payment) {
  return { type: "notification", event: `payment.${payment.status}`, object: { ...payment } };
}

test("test checkout fixes the price and reuses the order id and known payment", async (t) => {
  const { checkout, order, requests, payment } = setup(t);
  assert.equal(await checkout({ ...order, telegram_user_id: "22" }, settings), null);
  assert.equal(await checkout({ ...order, can_start: false }, settings), null);
  assert.equal(requests.length, 0);
  assert.equal(await checkout({ ...order }, settings), "https://yoomoney.ru/confirm");
  const [{ options }] = requests;
  assert.equal(options.method, "POST");
  assert.equal(options.headers["Idempotence-Key"], ORDER_ID);
  const body = JSON.parse(options.body);
  assert.deepEqual(body.amount, { value: "290.00", currency: "RUB" });
  assert.equal(body.confirmation.return_url, "https://preview.example.com/plus#plans");
  assert.equal(body.payment_method_data.type, "bank_card");
  assert.deepEqual(body.metadata, { order_id: ORDER_ID });
  assert.equal(order.payment_id, PAYMENT_ID);
  payment.confirmation = { confirmation_url: "https://yoomoney.ru.example.com/confirm" };
  assert.equal(await checkout({ ...order }, settings), null);
  assert.equal(requests[1].options.method, "GET");
  assert.match(requests[1].url, new RegExp(`/${PAYMENT_ID}$`));
});

test("only a verified successful test payment grants 30 days once", async (t) => {
  const { receiveNotification, order, payment, grants, requests } = setup(t);
  const success = { ...payment, status: "succeeded", paid: true };
  await assert.rejects(receiveNotification(notify(success), settings), /статус платежа/);
  assert.equal(order.status, "pending");
  assert.equal(requests.length, 1);

  Object.assign(payment, success, { test: false });
  await receiveNotification(notify(success), settings);
  assert.deepEqual(grants, []);

  Object.assign(payment, success, { amount: { value: "1.00", currency: "RUB" } });
  await receiveNotification(notify(success), settings);
  assert.deepEqual(grants, []);

  Object.assign(payment, success);
  for (let i = 0; i < 2; i++) await receiveNotification(notify(success), settings);
  assert.equal(order.status, "succeeded");
  assert.deepEqual(grants, [["11", 30]]);
});

test("canceled test payments never grant access", async (t) => {
  const { receiveNotification, order, payment, grants } = setup(t);
  payment.status = "canceled";
  await receiveNotification(notify(payment), settings);
  assert.equal(order.status, "canceled");
  assert.deepEqual(grants, []);
});
