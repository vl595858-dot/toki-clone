const { config, receiveNotification } = require("../../../lib/plusPayments");

export default async function handler(req, res) {
  const settings = config();
  if (!settings) return res.status(404).end();
  if (req.method !== "POST") return res.status(405).end();
  try {
    await receiveNotification(req.body, settings);
    return res.status(200).end();
  } catch (error) {
    console.error("Plus test payment notification failed:", error.code || error.message);
    return res.status(503).end();
  }
}
