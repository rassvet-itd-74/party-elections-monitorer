# GosDoomMonitorer (party-elections-monitorer)

Telegram-бот для закрытой рабочей группы наблюдателей: собирает наблюдения и числовые срезы по УИК прямо в одном topic Telegram-группы и по команде `/report` строит PDF-отчёт с детерминированной статистикой и интерпретацией от ИИ (с обязательными ссылками на источники).

Полное техническое задание — [observer_bot_spec.md](observer_bot_spec.md).

---

## 1. Технический запуск

### Требования

- Node.js 20+
- Docker + Docker Compose (для продакшена)
- Telegram-бот (создаётся через `@BotFather`)
- Ключ OpenAI API

### Локальная разработка

```bash
npm install
cp .env.example .env
# заполнить .env: BOT_TOKEN, TARGET_CHAT_ID, TARGET_THREAD_ID, OPENAI_API_KEY, ADMIN_ID, WEBHOOK_SECRET
npm run build
npm start
```

Бот слушает `POST /telegram-webhook` на порту из `PORT` (`.env`). Для локальной проверки понадобится туннель (например, `cloudflared tunnel` или `ngrok`) с HTTPS наружу — Telegram принимает только HTTPS webhook URL.

Зарегистрировать вебхук (один раз, после того как URL доступен извне):

```bash
npm run register-webhook
```

Использует `WEBHOOK_URL` и `WEBHOOK_SECRET` из `.env`.

### Структура проекта

```
src/
├── index.ts          # точка входа
├── server.ts         # http-сервер приёма вебхука
├── router.ts         # маршрутизация по командам
├── telegramApi.ts    # fetch-обёртка над Bot API
├── handlers.ts        # обработчики команд (/bind, /data, /report, /flush, ...)
├── config.ts          # чтение и валидация .env (zod)
├── db.ts               # better-sqlite3, схема, flushDatabase
├── users.ts, bindings.ts, observations.ts, snapshots.ts
├── parser.ts          # парсер /data
├── analytics.ts        # delta, median, MAD, robust z-score
├── charts.ts            # ручная генерация SVG-графиков
├── ai.ts                 # OpenAI Responses API + Structured Output
├── sources.ts            # сборка sourceId для observations/snapshots/signals
└── report.ts             # оркестрация /report: анализ → графики → AI → HTML → PDF
prompts/uik-analysis.txt   # системный промпт для анализа одного УИК
templates/report.hbs        # Handlebars-шаблон PDF-отчёта
```

---

## 2. Инструкция для наблюдателей

**1. Один раз: привязка к своему УИК**

Сначала напишите в topic любое сообщение (чтобы бот вас увидел), затем:

```
/bind @ваш_ник НОМЕР_УИК
```

Например: `/bind @ivanov 1245`. Бот подтвердит привязку. Привязать может любой участник — как себя, так и коллегу (если тот уже писал в topic).

Если бот не знает ваш username, он попросит сначала написать любое сообщение в topic и повторить `/bind`.

Проверить, кто на какой УИК привязан: `/bindings`. Привязка меняется новым `/bind` — старая просто перезаписывается.

**2. Обычные наблюдения**

Любое текстовое сообщение в topic (кроме команд) — это наблюдение, оно автоматически сохраняется за вашим УИК. Бот не отвечает на каждое сообщение — это нормально.

**3. Числовые срезы**

Отправьте `/data` с любым непустым набором секций:

```
/data
П: ЕР=312, КПРФ=148, ЛДПР=72
О: Иванов=284, Петров=193, Сидоров=48
Н: 12
Г: 5
Я: 620/1850
```

Секции: `П` — партии, `О` — одномандатные кандидаты, `Н` — недействительные бюллетени, `Г` — погашенные бюллетени, `Я` — явка (число проголосовавших `/` списочное число избирателей, второе число достаточно указать один раз за день). Можно присылать любую секцию отдельным сообщением и писать компактно через `,`/`;`.

**4. Получить отчёт**

```
/report        # PDF по всем УИК
/report 1245   # PDF только по УИК №1245
```

Обычно занимает до минуты. Если отчёт уже строится по чьему-то запросу — ваш запрос дождётся того же результата, а не запустит расчёт заново. В отчёте по каждому УИК — формальная статистика (графики, цифры) и раздел с гипотезами от ИИ, всегда со ссылками на источники и без утверждений о нарушениях.

---

## 3. Хостинг (Docker, домен за Cloudflare)

Домен проксируется через Cloudflare в режиме **Flexible**: HTTPS для внешних клиентов держит Cloudflare, до сервера доходит обычный HTTP. Свой TLS на сервере не нужен.

**1. Подготовка в Telegram**

- Создать бота через `@BotFather`, получить `BOT_TOKEN`.
- `/setprivacy` → **Disable** (иначе бот не увидит обычные сообщения в группе).
- Добавить бота в целевой supergroup с включёнными Topics.
- Узнать `TARGET_CHAT_ID`/`TARGET_THREAD_ID`: временно залогировать `message.chat.id`/`message.message_thread_id` из входящего апдейта, написать тестовое сообщение в нужном topic, посмотреть логи.
- Узнать `ADMIN_ID`: `@userinfobot` в личке покажет числовой `user_id`.

**2. Cloudflare**

- DNS-запись поддомена (например, `bot.example.com`) на IP сервера — статус **Proxied** (оранжевое облако).
- SSL/TLS → Overview → режим **Flexible**.

**3. Сервер**

- VPS: 1 vCPU, 2 GB RAM, Ubuntu/Debian, публичный IP, открыт порт 80.
- Установить Docker:
  ```bash
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker $USER   # перелогиниться после этого
  ```
- Ограничить порт 80 диапазонами IP Cloudflare:
  ```bash
  sudo ufw allow 22/tcp
  for ip in $(curl -s https://www.cloudflare.com/ips-v4); do sudo ufw allow from "$ip" to any port 80; done
  for ip in $(curl -s https://www.cloudflare.com/ips-v6); do sudo ufw allow from "$ip" to any port 80; done
  sudo ufw enable
  ```

**4. Конфигурация и запуск**

```bash
git clone <repo> && cd party-elections-monitorer
cp .env.example .env
nano .env   # BOT_TOKEN, TARGET_CHAT_ID, TARGET_THREAD_ID, OPENAI_API_KEY, ADMIN_ID, PORT=8080, WEBHOOK_SECRET, WEBHOOK_URL
mkdir -p data
docker compose up -d --build
```

`WEBHOOK_SECRET`: сгенерировать `openssl rand -hex 32`.

**5. Регистрация вебхука**

Один раз при первом деплое (и при каждой смене домена/секрета):

```bash
docker compose exec bot node dist/registerWebhook.js
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

Должно быть видно правильный `url` и `pending_update_count: 0` (или небольшое число).

**6. Проверка**

Написать в topic `/help`, `/bind`, `/data`, `/report`. Логи: `docker compose logs -f bot`.

**7. Бэкап данных**

`data/data.sqlite` — обычный файл на хосте, бэкапится напрямую:

```
0 3 * * * cp /home/observer-bot/party-elections-monitorer/data/data.sqlite /home/observer-bot/backups/data-$(date +\%Y\%m\%d).sqlite
```

**8. Обновление кода**

```bash
git pull
docker compose up -d --build
```

При смене домена или `WEBHOOK_SECRET` — заново выполнить регистрацию вебхука (шаг 5).

---

## 4. Админ: полная очистка базы

`/flush` — доступна только `ADMIN_ID` из `.env`. Требует подтверждения: `/flush` → предупреждение, `/flush confirm` → реальная очистка (наблюдения, срезы, привязки, пользователи; схема не удаляется). Для всех остальных пользователей команда не отвечает вообще.
