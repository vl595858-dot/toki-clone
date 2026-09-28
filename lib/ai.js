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

async function parseMessage(text, tzOffset, contextText = "") {
  const nowIso = nowInTz(tzOffset);
  const contextBlock = contextText
    ? `Контекст диалога (используй, только если сообщение к нему относится):\n${contextText}\n\n`
    : "";
  const prompt =
    `Текущая дата и время: ${nowIso} (это уже с учётом часового пояса пользователя).\n` +
    `Разбери сообщение пользователя Telegram-бота-органайзера на русском языке.\n` +
    `Ответь ТОЛЬКО одним JSON-объектом, без пояснений и без markdown-ограждений, ровно такой формы:\n` +
    `{"intent":"create_event|create_recurring_event|delete_event|delete_recurring_event|list_events|reschedule_event|cancel_reminder|set_reminder|weather|unknown",` +
    `"title":string|null,"emoji":string|null,"event_date":"YYYY-MM-DD"|null,"event_time":"HH:MM"|null,` +
    `"event_relative_minutes":number|null,"remind_offset_minutes":number|null,` +
    `"weekday":"monday|tuesday|wednesday|thursday|friday|saturday|sunday"|null,` +
    `"region":string|null,"weather_offset_days":number|null,"list_scope":"today|tomorrow|all"|null,"refers_to_last":true|false}\n\n` +
    `Правила по intent:\n` +
    `- create_event — просит запомнить/зафиксировать/поставить встречу, задачу, событие ОДИН раз, на конкретную дату.\n` +
    `- create_recurring_event — просит поставить событие, которое повторяется КАЖДУЮ НЕДЕЛЮ в один и тот же день недели ("каждый понедельник...", "по средам...", "еженедельно по пятницам...").\n` +
    `- delete_recurring_event — просит отменить/остановить именно повторяющееся/еженедельное дело целиком (все будущие повторения), а не один случай.\n` +
    `- list_events — спрашивает, что запланировано / какие дела / что на сегодня-завтра и т.п.\n` +
    `- delete_event — просит удалить/убрать/отменить какое-то одно конкретное дело (не напоминание, а само событие целиком, и это не про повторяющееся дело целиком).\n` +
    `- reschedule_event — просит перенести/передвинуть существующее дело на другое время.\n` +
    `- cancel_reminder — просит убрать именно напоминание, оставив само событие (например "не напоминай про встречу").\n` +
    `- set_reminder — просит поставить или изменить напоминание для УЖЕ СУЩЕСТВУЮЩЕГО дела, не создавая нового ("напомни за час", "напомни за день до", "напоминай за 15 минут"). Если в сообщении описано новое событие вместе с напоминанием — это create_event, а не set_reminder.\n` +
    `- weather — спрашивает про погоду.\n` +
    `- unknown — во всех остальных случаях.\n\n` +
    `Правила по полям:\n` +
    `- title — для create_event/create_recurring_event: ПОЛНОЕ название события так, как его произнёс пользователь, сохраняя все значимые слова (например "совещание с партнёрами" остаётся "совещание с партнёрами", а не сокращается до "совещание"; "собрание с педагогами" остаётся "собрание с педагогами"). Убери из него только саму дату/день недели/время и фразу про напоминание — остальной смысл не трогай и не сокращай. Для delete_event/reschedule_event/cancel_reminder/delete_recurring_event: ОДНО самое отличительное существительное из этого дела, дословно то слово, которое пользователь, скорее всего, использовал в оригинальном названии — НЕ придумывай новых слов и не превращай глагол в существительное (например для дела "Купить молоко" используй "молоко", а не "покупка молока").\n` +
    `- emoji — ровно один эмодзи, подходящий по смыслу события (встреча — 🤝, тренировка — 🏋️, врач — 🩺, самолёт — ✈️, день рождения — 🎂, звонок — 📞, работа — 💼 и т.п.). Если не уверен — 📌. Нужен только для create_event/create_recurring_event.\n` +
    `- weekday — только для create_recurring_event/delete_recurring_event: день недели, который назвал пользователь, английским словом в нижнем регистре (monday..sunday).\n` +
    `- event_time — для create_recurring_event: время события каждую неделю, формат "HH:MM". Если не назвал — null.\n` +
    `- Если время события (для create_event или новое время для reschedule_event) названо АБСОЛЮТНО ("завтра в 15:00", "в четверг", "12 октября") — заполни event_date и/или event_time, а event_relative_minutes оставь null.\n` +
    `- Если время названо ОТНОСИТЕЛЬНО ОТ ТЕКУЩЕГО МОМЕНТА В МИНУТАХ ИЛИ ЧАСАХ ("через 3 минуты", "через полчаса", "через 2 часа") — НЕ считай дату и время сам, просто переведи в целое число минут в event_relative_minutes (час=60, полчаса=30), а event_date/event_time оставь null.\n` +
    `- remind_offset_minutes — для create_event/create_recurring_event/set_reminder: если сказано "напомни за час/сутки/неделю/30 минут" — переведи в минуты (час=60, сутки=1440, неделю=10080). Если не сказано — null.\n` +
    `- region — только для weather: название города/региона как в тексте.\n` +
    `- weather_offset_days — только для weather: 0 если "сегодня" или не уточнено, 1 если "завтра", 2 если "послезавтра", иначе число дней от текущей даты выше (например "в четверг" — посчитай разницу в днях).\n` +
    `- list_scope — только для list_events: "today" если про сегодня, "tomorrow" если про завтра, иначе "all".\n` +
    `- refers_to_last — для delete_event/reschedule_event/cancel_reminder/set_reminder: true, если пользователь не называет дело по названию, а имеет в виду последнее, о котором шла речь ("его", "это", "перенеси на пятницу", "поставь на 18:00", "напомни за час"); иначе false. Если названо конкретное дело — false, а название запиши в title. Для остальных intent — false.\n\n` +
    `Правила использования контекста диалога (если он приведён ниже):\n` +
    `- Если бот ждёт название города для погоды, а сообщение — просто название места (даже одно слово), верни intent="weather", region=это название, weather_offset_days=значение из контекста.\n` +
    `- Если бот ждёт новое время для переноса, а сообщение содержит время и/или дату, верни intent="reschedule_event", refers_to_last=true и заполни event_date/event_time (или event_relative_minutes).\n` +
    `- Если бот ждёт, за сколько напомнить, а сообщение — интервал, верни intent="set_reminder", refers_to_last=true и remind_offset_minutes.\n` +
    `- Если сообщение вроде "а завтра?", "а послезавтра?", "а в четверг?" и в контексте есть последний запрос погоды — верни intent="weather", region=город из контекста, weather_offset_days=новое значение.\n` +
    `- Если сообщение явно является новой самостоятельной командой, игнорируй ожидание бота и контекст.\n\n` +
    contextBlock +
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
