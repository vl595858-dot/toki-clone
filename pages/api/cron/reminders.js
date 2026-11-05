const { sendMessage } = require("../../../lib/telegram");
const { formatDateHuman, utcIsoToLocalParts, nextNOccurrencesUtcIso } = require("../../../lib/time");
const db = require("../../../lib/db");
const { getTzOffset } = require("../../../lib/settings");
const { loadContext, saveContext } = require("../../../lib/context");
const { reminderKeyboard } = require("../../../lib/handlers/reminderButtons");

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
        const remindIso = new Date(
          new Date(occIso).getTime() - tpl.remind_offset_minutes * 60000
        ).toISOString();
        await db.query(
          `INSERT INTO events (chat_id, title, emoji, event_at, remind_at, recurring_id) VALUES ($1,$2,$3,$4,$5,$6)`,
          [tpl.chat_id, tpl.title, tpl.emoji, occIso, remindIso, tpl.id]
        );
        regenerated += 1;
      }
    }

    // «занимаем» пачку напоминаний одним запросом: так два одновременных запуска не отправят одно и то же дважды
    const { rows: claimed } = await db.query(
      `UPDATE events SET reminded = TRUE
       WHERE id IN (
         SELECT id FROM events
         WHERE reminded = FALSE AND done_at IS NULL AND remind_at <= now()
         ORDER BY remind_at LIMIT 50
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`
    );
    const rows = claimed.sort((x, y) => new Date(x.remind_at) - new Date(y.remind_at));

    let skipped = 0;
    for (const ev of rows) {
      // событие давно прошло (например, был простой) — не шлём устаревшее, оно уже помечено отправленным
      if (new Date(ev.event_at).getTime() < Date.now() - STALE_AFTER_MS) {
        skipped += 1;
        continue;
      }
      const tz = await tzFor(ev.chat_id);
      const { dateStr, timeStr } = utcIsoToLocalParts(ev.event_at, tz);
      const text =
        `⏰ Напоминание: ${ev.emoji || "📌"} ${ev.title}\n` +
        `🗓 Событие: ${formatDateHuman(dateStr, timeStr)}`;
      try {
        const sent = await sendMessage(ev.chat_id, text, { replyMarkup: reminderKeyboard(ev.id) });
        if (sent) {
          // запоминаем дело: ответ на напоминание («перенеси на завтра», «удали») должен понимать, о чём речь;
          // если человек как раз отвечает на вопрос бота (pending) — его не трогаем
          const ctx = await loadContext(ev.chat_id);
          if (!ctx.pending) await saveContext(ev.chat_id, { ...ctx, last_event_id: ev.id });
        }
      } catch (e) {
        console.error("reminder send failed for", ev.id, e);
        // не отправилось — снимаем отметку, следующая минута повторит попытку
        await db.query(`UPDATE events SET reminded = FALSE WHERE id = $1`, [ev.id]);
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

    res.status(200).json({ processed: rows.length - skipped, skipped, regenerated, cleaned });
  } catch (e) {
    console.error("cron reminders error", e);
    res.status(500).json({ error: String(e) });
  }
}
