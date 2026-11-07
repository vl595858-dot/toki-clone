// Чтение картинки (скриншот билета, талона, счёта и т.п.) моделью с распознаванием изображений.
const { getFileUrl, downloadFile } = require("./telegram");

const MAX_BYTES = 8 * 1024 * 1024;

function mimeFromUrl(url) {
  if (/\.png($|\?)/i.test(url)) return "image/png";
  if (/\.webp($|\?)/i.test(url)) return "image/webp";
  return "image/jpeg";
}

function buildPrompt(today) {
  return (
    `Сегодня ${today}. Перед тобой изображение (скриншот или фото билета, талона, счёта, брони, посылки, документа и т.п.). ` +
    `Найди на нём события и сроки, о которых стоит напомнить. Верни ТОЛЬКО JSON вида ` +
    `{"documents":[{"kind":"transport|event|appointment|expiry|invoice|parcel|lodging","vehicle":"plane|train|bus|ship"|null,"title":string,"date":"YYYY-MM-DD"|null,"time":"HH:MM"|null,"city":string|null,"emoji":string|null}]}\n\n` +
    `Правила:\n` +
    `- kind: transport — билет на самолёт, поезд, автобус, паром (vehicle обязателен); event — кино, концерт, театр, выставка, спорт; appointment — запись к врачу, мастеру, в сервис; ` +
    `expiry — срок действия документа или абонемента; invoice — счёт, квитанция, срок оплаты; parcel — посылка, доставка, срок хранения на почте; lodging — бронь жилья.\n` +
    `- Если на изображении нет ничего из этого или оно нечитаемо — верни {"documents":[]}.\n` +
    `- НИЧЕГО не выдумывай и не угадывай: чего не видно на изображении — null. Время вылета, отправления, начала бери точно как написано (24-часовой формат).\n` +
    `- Если год не указан, возьми ближайшую будущую дату относительно сегодняшней.\n` +
    `- title: коротко (до 80 символов), главное для напоминания. Самолёт: «Рейс SU 1234, Пермь → Москва» (номер рейса, если виден). Поезд: «Поезд 016А, Москва → Санкт-Петербург». ` +
    `Мероприятие: название. Запись: к кому или куда («Приём у терапевта», «Стрижка, салон …»). Срок: «Срок действия: загранпаспорт» (что именно). ` +
    `Счёт: «Оплатить: кому или за что, сумма». Посылка: «Забрать посылку: пункт выдачи или служба». Жильё: «Заезд: название» и «Выезд: название» — два отдельных документа.\n` +
    `- В title НЕ пиши личные данные: ФИО, номера паспортов и документов, номера карт, штрихкоды.\n` +
    `- date/time: для билета туда-обратно — отдельный документ на каждый перелёт или поездку (время отправления). Для срока действия, счёта и посылки время обычно null; date — дата окончания срока, оплаты или хранения.\n` +
    `- city: город отправления (для билетов), город мероприятия или жилья. Если не виден — null.\n` +
    `- emoji: один подходящий эмодзи (для записи к врачу 🩺, к парикмахеру 💈, в автосервис 🔧). Если не уверен — null.`
  );
}

async function recognizeImage(fileId, tzOffset) {
  const url = await getFileUrl(fileId);
  const buf = await downloadFile(url);
  if (buf.length > MAX_BYTES) throw new Error("image too large");

  const sign = tzOffset[0] === "-" ? -1 : 1;
  const [h, m] = tzOffset.slice(1).split(":").map(Number);
  const today = new Date(Date.now() + sign * (h * 60 + m) * 60000).toISOString().slice(0, 10);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildPrompt(today) },
            { type: "image_url", image_url: { url: `data:${mimeFromUrl(url)};base64,${buf.toString("base64")}`, detail: "high" } },
          ],
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI vision error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || "";
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("vision: no JSON");
  return JSON.parse(raw.slice(start, end + 1));
}

module.exports = { recognizeImage };
