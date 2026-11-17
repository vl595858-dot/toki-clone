const { sendMessage } = require("../../../lib/telegram");
const { formatDateHuman, utcIsoToLocalParts, nextNOccurrencesUtcIso } = require("../../../lib/time");
const db = require("../../../lib/db");
const { getTzOffset } = require("../../../lib/settings");
const { loadContext, saveContext } = require("../../../lib/context");
const { reminderKeyboard } = require("../../../lib/handlers/reminderButtons");
const { sendDayBeforeReminders } = require("../../../lib/dayBefore");

const { deliverReminder } = require("../../../lib/reminderDelivery");

const { reminderAt, templateOffset } = require("../../../lib/reminderSettings");

const RECURRING_BUFFER_SIZE = 8;
const STALE_AFTER_MS = 2 * 60 * 60 * 1000; // напоминания о делах, прошедших больше 2 часов назад, не отправляем

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const tzCache = new Map();
  const tzFor = async (chatId) => {
    if (!tzCache.has(chatId)) tzCache.set(chatId, await getTzOffset(chatId));
    return tzCache.get(chatId);
  };

  try {
    let regenerated = 0;

    const { rows: templates } = await db.query(`SELECT * FROM recurring_events`);
    for (const tpl of templates) {
      const { rows: future } = await db.query(
        `SELECT event_at FROM events WHERE recurring_id=$1 AND event_at >= now() ORDER BY event_at DESC`,
        [tpl.id]
      );
      const missing = RECURRING_BUFFER_SIZE - future.length;
      if (missing <= 0) continue;

      const tz = await tzFor(tpl.chat_id);
      const afterIso = future.length > 0 ? future[0].event_at : undefined;
      const newOccurrences = nextNOccurrencesUtcIso(tpl, tz, missing, afterIso);

      for (const occIso of newOccurrences) {
        const remindIso = reminderAt(occIso, templateOffset(tpl));
        await db.query(
          `INSERT INTO events (chat_id, title, emoji, event_at, remind_at, recurring_id) VALUES ($1,$2,$3,$4,$5,$6)`,
          [tpl.chat_id, tpl.title, tpl.emoji, occIso, remindIso, tpl.id]
        );
        regenerated += 1;
      }
    }

    // второе напоминание «накануне в 12:00» (дни рождения)
    const dayBefore = await sendDayBeforeReminders(tzFor);

    // Кандидатов проверяем повторно под блокировкой непосредственно перед отправкой.
    const { rows: candidates } = await db.query(
      `SELECT * FROM events
       WHERE reminded = FALSE AND done_at IS NULL AND remind_at <= now()
         AND event_at >= now() - interval '2 hours'
       ORDER BY remind_at LIMIT 50`
    );
    const rows = candidates;

    // у дней рождения (серии с двумя напоминаниями) кнопок «Сделано» и «Перенос» нет — только текст
    const recIds = Array.from(new Set(rows.map((r) => r.recurring_id).filter(Boolean)));
    const noButtons = new Set();
    if (recIds.length) {
      const { rows: bd } = await db.query(`SELECT id FROM recurring_events WHERE day_before = TRUE AND id = ANY($1)`, [recIds]);
      bd.forEach((r) => noButtons.add(r.id));
    }

    let skipped = 0;
    for (const ev of rows) {
      try {
        const sent = await deliverReminder(ev.id, "reminded", async (current) => {
          // Время или состояние дела могли измениться после чтения кандидатов.
          if (new Date(current.remind_at).getTime() > Date.now() ||
              new Date(current.event_at).getTime() < Date.now() - STALE_AFTER_MS) {
            skipped += 1;
            return false;
          }
          const tz = await tzFor(current.chat_id);
          const { dateStr, timeStr } = utcIsoToLocalParts(current.event_at, tz);
          const text =
            `⏰ Напоминание: ${current.emoji || "📌"} ${current.title}\n` +
            `🗓 Событие: ${formatDateHuman(dateStr, timeStr)}`;
          return sendMessage(
            current.chat_id,
            text,
            noButtons.has(current.recurring_id) ? {} : { replyMarkup: reminderKeyboard(current.id, current.is_doc === true) }
          );
        });
        if (!sent) continue;
      } catch (e) {
        console.error("reminder send failed for", ev.id, e);
        continue;
      }
      // Ошибка контекста после доставки не должна приводить к повторной отправке.
      try {
        const ctx = await loadContext(ev.chat_id);
        if (!ctx.pending) await saveContext(ev.chat_id, { ...ctx, last_event_id: ev.id });
      } catch (e) {
        console.error("reminder context failed for", ev.id, e);
      }
    }

    // раз в неделю (воскресенье 22:00 UTC = понедельник 03:00 по Перми) удаляем дела старше 30 дней,
    // и выполненные, и нет, чтобы база не разрасталась; окно в 5 минут на случай пропущенного запуска
    let cleaned = 0;
    const now = new Date();
    if (now.getUTCDay() === 0 && now.getUTCHours() === 22 && now.getUTCMinutes() < 5) {
      try {
        const del = await db.query(`DELETE FROM events WHERE event_at < now() - interval '30 days'`);
        cleaned = del.rowCount || 0;
      } catch (e) {
        console.error("cleanup error", e);
      }
    }

    res.status(200).json({ processed: rows.length - skipped, skipped, regenerated, dayBefore, cleaned });
  } catch (e) {
    console.error("cron reminders error", e);
    res.status(500).json({ error: String(e) });
  }
}
