// Справка для модели о текущем состоянии разговора (память диалога в виде текста).
const db = require("./db");
const { utcIsoToLocalParts, formatDateHuman } = require("./time");

async function buildContextText(chatId, ctx, tz) {
  try {
    const lines = [];
    const pending = ctx.pending;
    if (pending && pending.type === "weather_region") {
      lines.push(
        `Бот только что спросил у пользователя город для погоды и ждёт название места (weather_offset_days=${
          pending.weather_offset_days ?? 0
        }).`
      );
    }
    if (pending && pending.type === "reschedule_time") {
      lines.push("Бот только что спросил, на какое время перенести дело, и ждёт новую дату или время.");
    }
    if (pending && pending.type === "reminder_offset") {
      lines.push("Бот только что спросил, за сколько напомнить о деле, и ждёт интервал (например «за час»).");
    }
    if (ctx.last_event_id) {
      const { rows } = await db.query(`SELECT title, event_at FROM events WHERE id=$1 AND chat_id=$2`, [
        ctx.last_event_id,
        chatId,
      ]);
      if (rows.length) {
        const local = utcIsoToLocalParts(rows[0].event_at, tz);
        lines.push(
          `Последнее дело, о котором шла речь: «${rows[0].title}» — ${formatDateHuman(local.dateStr, local.timeStr)}.`
        );
      }
    }
    if (ctx.last_region) {
      lines.push(
        `Последний запрос погоды: город «${ctx.last_region}», weather_offset_days=${ctx.last_weather_offset_days ?? 0}.`
      );
    }
    return lines.join("\n");
  } catch (e) {
    console.error("buildContextText error", e);
    return "";
  }
}

module.exports = { buildContextText };
