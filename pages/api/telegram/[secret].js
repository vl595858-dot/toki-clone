const { sendMessage } = require("../../../lib/telegram");
const { transcribeVoice, parseMessage } = require("../../../lib/ai");
const { getWeatherText } = require("../../../lib/weather");
const { todayInOffset, toUtcIso, offsetMinutesToPhrase, formatDateHuman } = require("../../../lib/time");
const db = require("../../../lib/db");

const TZ_OFFSET = process.env.DEFAULT_TZ_OFFSET || "+03:00";

export const config = {
  api: { bodyParser: true },
};
export const maxDuration = 10; // потолок бесплатного тарифа Vercel

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(200).send("ok");
    return;
  }
  if (req.query.secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    res.status(403).end();
    return;
  }

try {
  await handleUpdate(req.body);
} catch (e) {
  console.error("handleUpdate error", e);
}
  res.status(200).json({ ok: true });
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message) return;
  const chatId = message.chat.id;

let text = message.text;

if (!text && message.voice) {
  try {
    text = await transcribeVoice(message.voice.file_id);
    if (!text) {
      await sendMessage(chatId, "Не расслышал голосовое — попробуй ещё раз, покороче и чётче.");
      return;
    }
  } catch (e) {
    console.error("transcribe error", e);
    await sendMessage(chatId, "Не получилось распознать голосовое. Попробуй текстом.");
    return;
  }
}

if (!text) return;

if (text.trim() === "/start") {
  await sendMessage(
    chatId,
    "Привет! 👋 Я запомню твои дела и напомню о них.\n\n" +
    "Пиши или говори голосом, например:\n" +
    "«Встреча с юристом в четверг в 15:00, напомни за час»\n\n" +
    "Про погоду тоже можно спросить: «погода в Перми»"
    );
  return;
}

let parsed;
  try {
    parsed = await parseMessage(text, TZ_OFFSET);
  } catch (e) {
    console.error("parse error", e);
    await sendMessage(chatId, "Не разобрал сообщение. Попробуй сформулировать иначе.");
    return;
  }

if (parsed.intent === "weather") {
  const reply = await getWeatherText(parsed.region);
  await sendMessage(chatId, reply);
  return;
}

if (parsed.intent === "create_event" && parsed.title) {
  const eventDate = parsed.event_date || todayInOffset(TZ_OFFSET);
  const eventTime = parsed.event_time || "09:00";
  const eventAtIso = toUtcIso(eventDate, eventTime, TZ_OFFSET);
  const offsetMin = Number.isFinite(parsed.remind_offset_minutes) ? parsed.remind_offset_minutes : 0;
  const remindAtIso = new Date(new Date(eventAtIso).getTime() - offsetMin * 60000).toISOString();
  const emoji = parsed.emoji || "📌";

  await db.query(
    `INSERT INTO events (chat_id, title, emoji, event_at, remind_at) VALUES ($1,$2,$3,$4,$5)`,
    [chatId, parsed.title, emoji, eventAtIso, remindAtIso]
    );

  const timeNote = parsed.event_time ? "" : " (время не назвал — поставил на 09:00, поправь, если не то)";
  await sendMessage(
    chatId,
    `✅ Записал: ${emoji} ${parsed.title}\n` +
    `📅 ${formatDateHuman(eventDate, eventTime)}${timeNote}\n` +
    `⏰ Напомню ${offsetMinutesToPhrase(offsetMin)}`
    );
  return;
}

await sendMessage(
  chatId,
  "Не понял, о чём речь 🤔 Можешь переформулировать? Например: «Позвонить маме завтра в 12:00, напомни за 30 минут»."
  );
}
