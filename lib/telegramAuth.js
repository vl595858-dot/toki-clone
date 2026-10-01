const crypto = require("crypto");

/*
 * Проверка initData — встроенного механизма Telegram Mini Apps, который
 * подтверждает, что страницу действительно открыл конкретный пользователь
 * Telegram, не выдавая себя за другого. Без OAuth, без паролей — Telegram
 * сам подписывает эти данные секретом, известным только ему и нашему боту.
 * Алгоритм — официальный, задокументированный Telegram:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
function verifyInitData(initDataRaw, botToken, maxAgeSeconds = 86400) {
  if (!initDataRaw || typeof initDataRaw !== "string") {
    return { ok: false, error: "initData отсутствует" };
  }

  const params = new URLSearchParams(initDataRaw);
  const hash = params.get("hash");
  if (!hash) return { ok: false, error: "нет hash в initData" };
  params.delete("hash");

  const pairs = [];
  for (const [key, value] of params.entries()) pairs.push(`${key}=${value}`);
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) {
    return { ok: false, error: "подпись не совпадает" };
  }

  const authDate = Number(params.get("auth_date"));
  if (Number.isFinite(authDate) && maxAgeSeconds > 0) {
    const ageSeconds = Date.now() / 1000 - authDate;
    if (ageSeconds > maxAgeSeconds) return { ok: false, error: "initData устарела" };
  }

  let user = null;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch (e) {
    // игнорируем — user не обязателен для всех сценариев
  }

  return { ok: true, user };
}

module.exports = { verifyInitData };
