const { setWebhook } = require("../../lib/telegram");

export default async function handler(req, res) {
  if (req.query.key !== process.env.SETUP_KEY) {
    res.status(403).send("forbidden");
    return;
  }

  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const url = `https://${host}/api/telegram/${process.env.TELEGRAM_WEBHOOK_SECRET}`;

  const result = await setWebhook(url);
  res.status(200).json({ webhookUrl: url, telegramResponse: result });
}
