const { getFileUrl, downloadFile } = require("./telegram");

/* ---- голос -> текст (OpenAI Whisper) ---- */
async function transcribeVoice(fileId) {
  const fileUrl = await getFileUrl(fileId);
  const audioBuffer = await downloadFile(fileUrl);

  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "voice.ogg");
  form.append("model", "whisper-1");
  form.append("language", "ru");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Whisper error ${res.status}: ${body}`);
  }
  const data = await res.json();
  return (data.text || "").trim();
}

/* ---- текст -> структура (OpenAI) ---- */
function nowInTz(offset) {
  return new Date().toISOString().replace("Z", offset);
}

async function parseMessage(text, tzOffset) {
  const nowIso = nowInTz(tzOffset);
  const prompt =
    `Текущая дата и время: ${nowIso} (это уже с учётом часового пояса пользователя).\n` +
    `Разбери сообщение пользователя Telegram-бота-органайзера на русском языке.\n` +
    `Ответь ТОЛЬКО одним JSON-объектом, без пояснений и без markdown-ограждений, ровно такой формы:\n` +
    `{"intent":"create_event|weather|unknown","title":string|null,"emoji":string|null,"event_date":"YYYY-MM-DD"|null,"event_time":"HH:MM"|null,"remind_offset_minutes":number|null,"region":string|null}\n\n` +
    `Правила:\n` +
    `- intent="create_event" — если просит запомнить/зафиксировать/поставить встречу, задачу, событие, напоминание.\n` +
    `- intent="weather" — если спрашивает про погоду.\n` +
    `- intent="unknown" — во всех остальных случаях.\n` +
    `- title — краткое описание события на русском, без даты/времени внутри текста.\n` +
    `- emoji — ровно один эмодзи, максимально подходящий по смыслу события (встреча — 🤝, тренировка — 🏋️, врач — 🩺, самолёт — ✈️, день рождения — 🎂, звонок — 📞, работа — 💼 и т.п.). Если не уверен — 📌.\n` +
    `- event_date/event_time — переведи относительные даты ("завтра", "в четверг", "через неделю") в конкретные значения относительно текущей даты выше. Если время не названо явно — event_time=null.\n` +
    `- remind_offset_minutes — если сказано "напомни за час/сутки/неделю/30 минут" и т.п. — переведи в минуты (час=60, сутки=1440, неделю=10080). Если не сказано — null.\n` +
    `- region — только для intent="weather": название города или региона как в тексте.\n\n` +
    `Сообщение пользователя: "${text}"`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI parse error ${res.status}: ${body}`);
  }
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || "";
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Модель не вернула JSON: " + raw.slice(0, 300));
  return JSON.parse(cleaned.slice(start, end + 1));
}

module.exports = { transcribeVoice, parseMessage };
