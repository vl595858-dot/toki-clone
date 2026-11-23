const assert = require("node:assert/strict");
const test = require("node:test");
const { expiryFor, paymentConfig, checkoutAvailable, hookMatches } = require("../lib/webPlannerPayments");
const { config, guard } = require("../lib/webPlannerAuth");

const web = { origin: "https://preview.example.com" };

test("test keys cannot enable production checkout and live settings require approval and fiscal configuration", (t) => {
  const env = {
    WEB_YOOKASSA_MODE: "test",
    WEB_YOOKASSA_SHOP_ID: "1",
    WEB_YOOKASSA_SECRET_KEY: "test_example",
    WEB_YOOKASSA_HOOK_KEY: "x".repeat(32),
    WEB_YOOKASSA_VAT_CODE: "1",
    WEB_YOOKASSA_PAYMENT_SUBJECT: "service",
    WEB_YOOKASSA_PAYMENT_MODE: "full_payment",
    WEB_YOOKASSA_CHECKOUT_PAUSED: "0",
    VERCEL_ENV: "preview",
  };
  const original = process.env;
  process.env = env;
  t.after(() => { process.env = original; });
  assert.equal(paymentConfig(web).test, true);
  env.WEB_YOOKASSA_CHECKOUT_PAUSED = "1";
  assert.equal(checkoutAvailable(paymentConfig(web)), false);
  assert.equal(paymentConfig(web).test, true); // Refund and payment reconciliation stay available.
  env.VERCEL_ENV = "production";
  assert.equal(paymentConfig(web), null);
  Object.assign(env, { WEB_YOOKASSA_MODE: "live", WEB_YOOKASSA_SECRET_KEY: "live_example" });
  assert.equal(paymentConfig(web), null);
  Object.assign(env, {
    WEB_YOOKASSA_LIVE_APPROVED: "1",
    PLUS_SELLER_NAME: "Example",
    PLUS_SELLER_INN: "Example",
    PLUS_SELLER_OGRNIP: "Example",
    PLUS_SUPPORT_EMAIL: "support@example.com",
  });
  assert.equal(paymentConfig(web).test, false);
  env.WEB_YOOKASSA_PAYMENT_MODE = "full_prepayment";
  assert.equal(paymentConfig(web), null);
});

test("payment periods extend active access and restart after a gap", () => {
  const periods = [
    { paid_at: "2030-01-01T10:00:00Z", days: 30 },
    { paid_at: "2030-01-15T10:00:00Z", days: 30 },
  ];
  assert.equal(expiryFor(periods).toISOString(), "2030-03-02T10:00:00.000Z");
  assert.equal(expiryFor(periods.slice(1)).toISOString(), "2030-02-14T10:00:00.000Z");
  assert.equal(expiryFor([]), null);
  assert.equal(expiryFor([...periods, { paid_at: "2030-03-06T10:00:00Z", days: 30 }]).toISOString(), "2030-04-05T10:00:00.000Z");
});

test("wrong webhook keys and cross-origin state changes are rejected", () => {
  assert.equal(hookMatches("x".repeat(32), "x".repeat(32)), true);
  assert.equal(hookMatches("a".repeat(32), "x".repeat(32)), false);
  assert.equal(hookMatches(["x".repeat(32)], "x".repeat(32)), false);
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, end() {} };
  assert.equal(guard({ method: "POST", headers: { origin: "https://other.example.com", "content-type": "application/json" } }, res, web, ["POST"]), false);
  assert.equal(res.code, 403);
  assert.equal(guard({ method: "POST", headers: { origin: web.origin, "content-type": "application/json" } }, res, web, ["POST"]), true);
});

test("preview web planner needs a separate database and one test email", (t) => {
  const env = {
    VERCEL_ENV: "preview",
    WEB_PLANNER_ORIGIN: web.origin,
    WEB_SUPABASE_URL: "https://example-project.supabase.co",
    WEB_SUPABASE_PUBLISHABLE_KEY: "example",
    DATABASE_URL: "postgres://prod",
    WEB_PLANNER_TEST_DATABASE_URL: "postgres://prod",
    WEB_PLANNER_TEST_EMAIL: "TEST@example.com",
  };
  const original = process.env;
  process.env = env;
  t.after(() => { process.env = original; });
  assert.equal(config(), null);
  env.WEB_PLANNER_TEST_DATABASE_URL = "postgres://preview";
  assert.equal(config().testEmail, "test@example.com");
  env.VERCEL_ENV = "production";
  assert.equal(config(), null);
  env.WEB_PLANNER_PUBLIC_READY = "1";
  env.WEB_PLANNER_DATABASE_URL = "postgres://live-web-db";
  assert.equal(config().testEmail, null);
});
