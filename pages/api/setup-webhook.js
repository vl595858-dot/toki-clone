const { setWebhook } = require("../../lib/telegram");

const { timingSafeEqual } = require("crypto");

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const key = process.env.SETUP_KEY;
  if (!key) return res.status(503).json({ error: "setup_disabled" });
  const supplied = req.headers.authorization;
  const expected = `Bearer ${key}`;
  if (typeof supplied !== "string" || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return res.status(403).json({ error: "forbidden" });
  }

  // Only operator configuration or Vercel's system production domain is trusted.
  // Request headers must never determine where Telegram sends messages.
  const configured = process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
  let url;
  try {
    const origin = new URL(configured);
    if (origin.protocol !== "https:" || origin.username || origin.password ||
        origin.pathname !== "/" || origin.search || origin.hash || !process.env.TELEGRAM_WEBHOOK_SECRET) throw new Error();
    url = `${origin.origin}/api/telegram/${encodeURIComponent(process.env.TELEGRAM_WEBHOOK_SECRET)}`;
  } catch {
    return res.status(503).json({ error: "invalid_setup_configuration" });
  }
  try {
    if (!await setWebhook(url)) return res.status(502).json({ error: "telegram_setup_failed" });
    return res.status(200).json({ ok: true });
  } catch {
    // Network errors and Telegram replies can contain URLs with credentials.
    console.error("Telegram webhook registration failed");
    return res.status(502).json({ error: "telegram_setup_failed" });
  }
}
