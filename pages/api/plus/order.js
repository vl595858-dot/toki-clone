const { COOKIE, config, createOrder, browserOrder, checkout } = require("../../../lib/plusPayments");

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const settings = config();
  if (!settings) return res.status(404).end();
  if (!["GET", "POST"].includes(req.method)) return res.status(405).end();
  if (req.method === "POST" && req.headers.origin !== settings.origin) return res.status(403).end();

  try {
    const order = await browserOrder(req.cookies[COOKIE]);
    if (req.method === "POST" && req.body?.action === "start") {
      if (!order || order.status !== "pending" || (!order.payment_id && !order.can_start)) {
        const token = await createOrder();
        res.setHeader("Set-Cookie", `${COOKIE}=${token}; Max-Age=86400; Path=/api/plus/order; HttpOnly; Secure; SameSite=Lax`);
        return res.status(201).json({ started: true });
      }
    } else if (req.method === "POST" && req.body?.action === "checkout") {
      if (!order || !order.telegram_user_id) return res.status(409).end();
      return res.status(200).json({ paymentUrl: await checkout(order, settings) });
    } else if (req.method === "POST") {
      return res.status(400).end();
    }
    if (!order) return res.status(200).json({ status: "new" });
    let status = order.status;
    if (status === "pending") {
      if (order.payment_id) status = "payment_pending";
      else if (!order.can_start) status = "expired";
      else if (order.telegram_user_id) status = "linked";
      else status = "unlinked";
    }
    return res.status(200).json({
      status,
      telegramUrl: status === "unlinked" ? `https://t.me/${settings.bot}?start=plus_${order.id}` : null,
      accessUntil: order.access_until,
    });
  } catch (error) {
    console.error("Plus test order failed:", error.code || error.message);
    return res.status(502).end();
  }
}
