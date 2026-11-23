const { config, guard, user } = require("../../../lib/webPlannerAuth");
const { TERMS_VERSION, paymentConfig, checkoutAvailable, checkout } = require("../../../lib/webPlannerPayments");

export default async function handler(req, res) {
  const web = config();
  if (!guard(req, res, web, ["POST"])) return;
  const settings = paymentConfig(web);
  if (!settings) return res.status(503).json({ error: "Оплата пока недоступна." });
  try {
    const account = await user(req, web);
    if (!account) return res.status(401).json({ error: "Войди в веб-кабинет." });
    const { action, terms } = req.body || {};
    if (action !== "check" && (action !== "buy" || terms !== TERMS_VERSION)) {
      return res.status(400).json({ error: "Перед оплатой прими условия оферты." });
    }
    if (action === "buy" && !checkoutAvailable(settings)) return res.status(503).json({ error: "Новые оплаты пока недоступны." });
    return res.json(await checkout(account, settings, action === "buy"));
  } catch {
    console.error("Web payments: unable to reconcile checkout");
    return res.status(502).json({ error: "Не удалось проверить платёж. Попробуй позже." });
  }
}
