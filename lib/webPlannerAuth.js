const SESSION = "__Host-delishki-session";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function config() {
  const origin = process.env.WEB_PLANNER_ORIGIN;
  const supabase = process.env.WEB_SUPABASE_URL;
  const key = process.env.WEB_SUPABASE_PUBLISHABLE_KEY;
  if (!/^https:\/\/[a-z0-9][a-z0-9.-]+$/i.test(origin || "") ||
      !/^https:\/\/[a-z0-9][a-z0-9.-]+$/i.test(supabase || "") || !key) return null;
  const testEmail = process.env.WEB_PLANNER_TEST_EMAIL?.trim().toLowerCase();
  const production = process.env.VERCEL_ENV === "production";
  const testDb = process.env.WEB_PLANNER_TEST_DATABASE_URL;
  const liveDb = process.env.WEB_PLANNER_DATABASE_URL;
  if (production
    ? process.env.WEB_PLANNER_PUBLIC_READY !== "1" || !liveDb
    : !testEmail || !testDb || testDb === liveDb || testDb === process.env.DATABASE_URL) return null;
  return { origin, supabase, key, testEmail: production ? null : testEmail };
}

async function auth(settings, endpoint, { token, body } = {}) {
  return fetch(`${settings.supabase}/auth/v1/${endpoint}`, {
    method: body ? "POST" : "GET",
    headers: {
      apikey: settings.key,
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body && { "Content-Type": "application/json" }),
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
    redirect: "error",
  });
}

async function user(req, settings) {
  const token = req.cookies[SESSION];
  if (typeof token !== "string" || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return null;
  const response = await auth(settings, "user", { token });
  if ([401, 403].includes(response.status)) return null;
  if (!response.ok) throw new Error("Auth service unavailable");
  const data = await response.json();
  return data.email_confirmed_at && UUID.test(data.id) && typeof data.email === "string" &&
    (!settings.testEmail || data.email.toLowerCase() === settings.testEmail)
    ? { id: data.id, email: data.email } : null;
}

function sessionCookie(res, token = "", maxAge = 0) {
  res.setHeader("Set-Cookie", `${SESSION}=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`);
}

function guard(req, res, settings, methods) {
  res.setHeader("Cache-Control", "no-store");
  if (!settings) { res.status(503).json({ error: "Веб-кабинет пока недоступен." }); return false; }
  if (!methods.includes(req.method)) { res.status(405).end(); return false; }
  if (req.method !== "GET" && (req.headers.origin !== settings.origin ||
      req.headers["content-type"]?.split(";")[0] !== "application/json")) {
    res.status(403).end();
    return false;
  }
  return true;
}

module.exports = { UUID, config, auth, user, sessionCookie, guard };
