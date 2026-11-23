const { config, guard, user } = require("../../../lib/webPlannerAuth");
const db = require("../../../lib/webPlannerDb");
const { status, linkEnabled, link, unlink } = require("../../../lib/webPlanner");

export default async function handler(req, res) {
  const settings = config();
  if (!guard(req, res, settings, ["POST"])) return;
  if (!linkEnabled()) return res.status(404).end();
  try {
    const account = await user(req, settings);
    if (!account) return res.status(401).json({ error: "Войди в веб-кабинет." });
    if (req.body?.action === "unlink") {
      await unlink(account.id);
      return res.json({ ok: true });
    }
    if (!(await status(db, account.id)).accessUntil) {
      return res.status(403).json({ error: "Привязка доступна при действующем веб-тарифе «Плюс»." });
    }
    if (!await link(account.id, req.body?.code)) {
      return res.status(409).json({ error: "Код истёк или один из аккаунтов уже привязан." });
    }
    return res.json({ ok: true });
  } catch {
    return res.status(502).json({ error: "Не удалось привязать Telegram." });
  }
}
