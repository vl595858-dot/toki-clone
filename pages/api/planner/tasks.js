const db = require("../../../lib/webPlannerDb");
const { isValidDate } = require("../../../lib/time");
const { UUID, config, guard, user } = require("../../../lib/webPlannerAuth");
const { paymentConfig } = require("../../../lib/webPlannerPayments");
const { status, insertTask, linkEnabled } = require("../../../lib/webPlanner");

function csvCell(value) {
  const text = String(value);
  const safe = /^[\s]*[=+@-]|^[\t\r\n]/.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""') + '"';
}

export default async function handler(req, res) {
  const settings = config();
  if (!guard(req, res, settings, ["GET", "POST", "PATCH", "DELETE"])) return;
  try {
    const account = await user(req, settings);
    if (!account) return res.status(401).json({ error: "Войди в веб-кабинет." });
    const allowTest = paymentConfig(settings)?.test === true;
    if (req.method === "GET") {
      const plan = await status(db, account.id, allowTest);
      if (req.query.export === "csv") {
        if (!plan.accessUntil) return res.status(403).json({ error: "Экспорт доступен на тарифе Плюс." });
        const { rows } = await db.query(`SELECT title,due_on::text,done FROM web_planner_tasks
          WHERE user_id = $1 ORDER BY due_on,id`, [account.id]);
        const data = rows.map(({ title, due_on, done }) => [title, due_on, done ? "Да" : "Нет"].map(csvCell).join(","));
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", 'attachment; filename="moi-delishki.csv"');
        return res.send("\uFEFF" + ["Дело,Дата,Готово", ...data].join("\r\n"));
      }
      const page = /^\d{1,4}$/.test(String(req.query.page)) ? Number(req.query.page) : 0;
      const search = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase().slice(0, 240) : "";
      const { rows } = await db.query(`SELECT id,title,due_on::text,done FROM web_planner_tasks
        WHERE user_id = $1 AND ($2 = '' OR strpos(lower(title),$2) > 0)
        ORDER BY done,due_on,id LIMIT 51 OFFSET $3`, [account.id, search, page * 50]);
      return res.json({ tasks: rows.slice(0, 50), more: rows.length > 50, ...plan, linking: linkEnabled() });
    }

    const { title: rawTitle, date, done, id } = req.body || {};
    if (req.method === "DELETE" || req.method === "PATCH") {
      if (typeof id !== "string" || !UUID.test(id)) return res.status(400).end();
      if (req.method === "DELETE") {
        const result = await db.query("DELETE FROM web_planner_tasks WHERE id = $1 AND user_id = $2", [id, account.id]);
        return res.status(result.rowCount ? 204 : 404).end();
      }
      if (typeof done === "boolean") {
        const result = await db.query("UPDATE web_planner_tasks SET done = $3 WHERE id = $1 AND user_id = $2", [id, account.id, done]);
        return res.status(result.rowCount ? 204 : 404).end();
      }
    }
    const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
    if (!title || title.length > 240 || typeof date !== "string" || !isValidDate(date)) {
      return res.status(400).json({ error: "Укажи название до 240 символов и дату дела." });
    }
    if (req.method === "POST") {
      if (!await insertTask(account.id, title, date, allowTest)) {
        return res.status(409).json({ error: "Лимит бесплатного тарифа — 30 новых дел за последние 30 дней." });
      }
      return res.status(201).json({ ok: true });
    }
    const result = await db.query("UPDATE web_planner_tasks SET title = $3, due_on = $4 WHERE id = $1 AND user_id = $2",
      [id, account.id, title, date]);
    return res.status(result.rowCount ? 204 : 404).end();
  } catch {
    return res.status(502).json({ error: "Не удалось загрузить или сохранить дела. Попробуй ещё раз." });
  }
}
