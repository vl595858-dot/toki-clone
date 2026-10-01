const { requireTelegramUser } = require("./_auth");
const { getTzOffset, setTzOffset } = require("../../../lib/settings");

export default async function handler(req, res) {
  const chatId = requireTelegramUser(req, res);
  if (!chatId) return;

  if (req.method === "GET") {
    const offset = await getTzOffset(chatId);
    res.status(200).json({ offset });
    return;
  }

  if (req.method === "POST") {
    const { offset } = req.body || {};
    if (!/^[+-]\d{2}:\d{2}$/.test(offset || "")) {
      res.status(400).json({ error: "Некорректный формат смещения" });
      return;
    }
    await setTzOffset(chatId, offset);
    res.status(200).json({ ok: true, offset });
    return;
  }

  res.status(405).end();
}
