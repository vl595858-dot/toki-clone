// Публичные курсы валют для экрана «Конвертация» (это не личные данные, поэтому без авторизации).
const { getRates } = require("../../lib/rates");

export default async function handler(req, res) {
  try {
    const data = await getRates();
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    res.status(200).json(data);
  } catch (e) {
    console.error("rates error", e);
    res.status(502).json({ error: "Курсы сейчас недоступны" });
  }
}
