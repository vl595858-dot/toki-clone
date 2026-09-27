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
  const sign = offset[0] === "-" ? -1 : 1;
  const [h, m] = offset.slice(1).split(":").map(Number);
  const offsetMin = sign * (h * 60 + m);
  const localMs = Date.now() + offsetMin * 60000;
  return new Date(localMs).toISOString().replace("Z", offset);
}

async function parseMessage(text, tzOffset) {
  const nowIso = nowInTz(tzOffset);
  const prompt =
    `Текущая дата и время: ${nowIso} (это уже с учётом часового пояса пользователя).\n` +
    `Разбери сообщение пользователя Telegram-бота-органайзера на русском языке.\n` +
    `Ответь ТОЛЬКО одним JSON-объектом, без пояснений и без markdown-ограждений, ровно такой формы:\n` +
    `{"intent":"create_event|list_events|delete_event|reschedule_event|cancel_reminder|weather|unknown",` +
    `"title":string|null,"emoji":string|null,"event_date":"YYYY-MM-DD"|null,"event_time":"HH:MM"|null,` +
    `"event_relative_minutes":number|null,"remind_offset_minutes":number|null,` +
    `"region":string|null,"weather_offset_days":number|null,"list_scope":"today|tomorrow|all"|null}\n\n` +
    `Правила по intent:\n` +
    `- create_event — просит запомнить/зафиксировать/поставить встречу, задачу, событие.\n` +
    `- list_events — спрашивает, что запланировано / какие дела / что на сегодня-завтра и т.п.\n` +
    `- delete_event — просит удалить/убрать/отменить какое-то конкретное дело (не напоминание, а само событие целиком).\n` +
    `- reschedule_event — просит перенести/передвинуть существующее дело на другое время.\n` +
    `- cancel_reminder — просит убрать именно напоминание, оставив само событие (например "не напоминай про встречу").\n` +
    `- weather — спрашивает про погоду.\n` +
    `- unknown — во всех остальных случаях.\n\n` +
    `Правила по полям:\n` +
    `- title — для create_event: краткое описание события на русском, без даты/времени внутри текста. Для delete_event/reschedule_event/cancel_reminder: несколько ключевых слов из названия события, по которым его можно найти (например "юрист", "встреча с юристом").\n` +
    `- emoji — ровно один эмодзи, подходящий по смыслу события (встреча — 🤝, тренировка — 🏋️, врач — 🩺, самолёт — ✈️, день рождения — 🎂, звонок — 📞, работа — 💼 и т.п.). Если не уверен — 📌. Нужен только для create_event.\n` +
    `- Если время события (для create_event или новое время для reschedule_event) названо АБСОЛЮТНО ("завтра в 15:00", "в четверг", "12 октября") — заполни event_date и/или event_time, а event_relative_minutes оставь null.\n` +
    `- Если время названо ОТНОСИТЕЛЬНО ОТ ТЕКУЩЕГО МОМЕНТА В МИНУТАХ ИЛИ ЧАСАХ ("через 3 минуты", "через полчаса", "через 2 часа") — НЕ считай дату и время сам, просто переведи в целое число минут в event_relative_minutes (час=60, полчаса=30), а event_date/event_time оставь null.\n` +
    `- remind_offset_minutes — для create_event: если сказано "напомни за час/сутки/неделю/30 минут" — переведи в минуты (час=60, сутки=1440, неделю=10080). Если не сказано — null.\n` +
    `- region — только для weather: название города/региона как в тексте.\n` +
    `- weather_offset_days — только для weather: 0 если "сегодня" или не уточнено, 1 если "завтра", 2 если "послезавтра", иначе число дней от текущей даты выше (например "в четверг" — посчитай разницу в днях).\n` +
    `- list_scope — только для list_events: "today" если про сегодня, "tomorrow" если про завтра, иначе "all".\n\n` +
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
