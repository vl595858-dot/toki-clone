const { config } = require("../../../../lib/webPlannerAuth");
const { paymentConfig, hookMatches, notification } = require("../../../../lib/webPlannerPayments");

export default async function handler(req, res) {
  const settings = paymentConfig(config());
  if (!settings || !hookMatches(req.query.key, settings.hookKey)) return res.status(404).end();
  if (req.method !== "POST") return res.status(405).end();
  try {
    await notification(settings, req.body);
    return res.status(200).end();
  } catch {
    console.error("Web payments: provider notification will be retried");
    return res.status(503).end();
  }
}
