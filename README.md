# Telegram-бот-планировщик — инструкция по запуску

Код полностью готов. Ниже — шаги, которые нужно сделать руками, каждый занимает
несколько минут. Ни один из них не требует OAuth или Google Cloud Console —
именно этим бот проще предыдущего проекта.

## Шаг 1. Создать бота у @BotFather

1. В Telegram найди **@BotFather**, напиши ему `/newbot`
2. Придумай имя и username (должен заканчиваться на `bot`, например `moi_dela_bot`)
3. Получишь **токен** — длинную строку вида `123456:ABC-DEF...`. Сохрани его.

## Шаг 2. Создать базу данных на Neon

1. Зайди на https://neon.tech, зарегистрируйся (можно через GitHub)
2. Создай новый проект, любое имя
3. В разделе **SQL Editor** вставь содержимое файла `schema.sql` из этой папки, выполни (кнопка Run) — создастся таблица `events`
4. В разделе **Connection Details** выбери режим **Pooled connection**, скопируй строку вида `postgresql://...` — это `DATABASE_URL`

## Шаг 3. Получить ключ OpenAI (для распознавания голоса)

1. Зайди на https://platform.openai.com, зарегистрируйся
2. Создай API-ключ (API keys → Create new secret key)
3. Пополни баланс на пару долларов — распознавание голоса стоит копейки за сообщение

## Шаг 4. Отправить код на GitHub и Vercel

Точно так же, как в прошлый раз:

```
git init
git add .
git commit -m "init"
```

Создай новый пустой репозиторий на github.com (например `toki-clone`), затем:

```
git remote add origin https://github.com/ТВОЙ-ЛОГИН/toki-clone.git
git branch -M main
git push -u origin main
```

На vercel.com → Add New → Project → импортируй `toki-clone` → Deploy
(сборка упадёт без переменных окружения — это ожидаемо, идём дальше)

## Шаг 5. Переменные окружения на Vercel

Settings → Environment Variables, добавь семь штук:

| Имя | Значение |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен из шага 1 |
| `TELEGRAM_WEBHOOK_SECRET` | любая случайная строка, придумай сама |
| `SETUP_KEY` | ещё одна случайная строка |
| `DATABASE_URL` | строка из шага 2 |
| `OPENAI_API_KEY` | ключ из шага 3 |
| `CRON_SECRET` | ещё одна случайная строка |
| `DEFAULT_TZ_OFFSET` | `+03:00` для Москвы (или другое смещение) |

После сохранения — Deployments → верхний деплой → три точки → Redeploy.

## Шаг 6. Зарегистрировать вебхук у Telegram

Узнай адрес сайта (Settings → Domains), затем один раз открой в браузере:

```
https://твой-адрес.vercel.app/api/setup-webhook?key=ТВОЙ_SETUP_KEY
```

(`ТВОЙ_SETUP_KEY` — то, что ты вписала в переменную `SETUP_KEY`)

Должен прийти ответ вида `{"telegramResponse":{"ok":true,...}}` — значит Telegram
теперь знает, куда слать сообщения.

## Шаг 7. Подключить GitHub Actions для напоминаний

В репозитории на GitHub: Settings → Secrets and variables → Actions → New repository secret,
добавь два секрета:

| Имя | Значение |
|---|---|
| `REMINDERS_URL` | `https://твой-адрес.vercel.app/api/cron/reminders` |
| `CRON_SECRET` | то же значение, что вписала на Vercel в шаге 6 |

Workflow уже лежит в `.github/workflows/reminders.yml` и начнёт запускаться сам,
каждые 5 минут, как только эти секреты появятся.

## Шаг 8. Проверка

Открой бота в Telegram по его username, напиши или скажи голосом:

> Встреча с юристом завтра в 15:00, напомни за час

Бот должен ответить подтверждением с эмодзи и датой. За час до события придёт
отдельное сообщение-напоминание (с точностью до 5 минут — так работает бесплатный
GitHub Actions).

Спроси и про погоду: «погода в Перми».

## Если что-то не работает

Логи смотри на Vercel: проект → Deployments → последний деплой → Runtime Logs.
Пришли мне текст ошибки — по нему я скажу точную причину.
