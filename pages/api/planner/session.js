const { config, auth, user, sessionCookie, guard } = require("../../../lib/webPlannerAuth");
const { paymentConfig, checkoutAvailable } = require("../../../lib/webPlannerPayments");

export default async function handler(req, res) {
  const settings = config();
  if (!guard(req, res, settings, ["GET", "POST"])) return;
  try {
    if (req.method === "GET") {
      const account = await user(req, settings);
      const payment = paymentConfig(settings);
      return res.json({ email: account?.email || null, paymentMode: payment?.test === true ? "test" : payment ? "live" : null, canBuy: checkoutAvailable(payment) });
    }
    const { action, code } = req.body || {};
    if (action === "logout") {
      sessionCookie(res);
      return res.json({ ok: true });
    }
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Введи адрес электронной почты." });
    }
    if (settings.testEmail && email !== settings.testEmail) {
      return res.status(403).json({ error: "Вход на тестовом сайте доступен только тестировщику." });
    }
    if (action === "send") {
      const response = await auth(settings, "otp", { body: { email, create_user: true } });
      if (response.status === 429) return res.status(429).json({ error: "Подожди минуту перед повторным запросом." });
      if (!response.ok) return res.status(502).json({ error: "Не удалось отправить код." });
      return res.json({ ok: true });
    }
    if (action === "verify" && typeof code === "string" && /^\d{6,10}$/.test(code)) {
      const response = await auth(settings, "verify", { body: { email, token: code, type: "email" } });
      if (!response.ok) return res.status(400).json({ error: "Код неверен или истёк." });
      const { access_token: token, expires_in: age } = await response.json();
      if (typeof token !== "string" || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token) || !Number.isInteger(age) || age < 1) {
        throw new Error("Invalid auth session");
      }
      sessionCookie(res, token, Math.min(age, 3600));
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: "Введи код из письма." });
  } catch {
    return res.status(502).json({ error: "Не удалось подключиться к сервису входа." });
  }
}
