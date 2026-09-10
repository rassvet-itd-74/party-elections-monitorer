# Observer Bot

Telegram-бот для закрытой рабочей группы наблюдателей за выборами. Работает в одном
supergroup, только внутри одного заданного topic/thread. Собирает текстовые
наблюдения и числовые срезы по УИК, хранит их в DynamoDB и по команде строит отчёт:
CSV-таблицу для гистограммы плюс интерпретацию наблюдений от ИИ со ссылками на
источники.

Весь код — один файл [`index.mjs`](index.mjs): AWS Lambda, Node.js 20.x, ноль
npm-зависимостей, без сборки. Деплой — вставить файл в веб-редактор Lambda и
нажать Deploy.

## Что делает бот

1. Каждое обычное (не командное) сообщение от привязанного к УИК наблюдателя
   сохраняется как наблюдение.
2. `/bind` привязывает Telegram-пользователя к номеру УИК.
3. `/party`, `/candidate`, `/invalid`, `/cancelled`, `/turnout` принимают числовые
   срезы — по одной записи за раз, в любом порядке и с любой периодичностью;
   повторная отправка обновляет текущее значение.
4. `/report` строит отчёт: один CSV на все УИК (готовая таблица для гистограммы:
   погашенные/недействительные/явка и текущие цифры по каждой партии и кандидату),
   затем по каждому УИК — текст с теми же цифрами и гипотезы от ИИ по текстовым
   наблюдениям, с проверяемыми ссылками на источники.
5. `/flush` (только администратор, с двухшаговым подтверждением) очищает все
   данные.

## Архитектура

```
Telegram supergroup
└── topic «Наблюдатели»
    ├── обычные сообщения → observations
    ├── /bind, /bindings, /party, /candidate, /invalid, /cancelled, /turnout,
    │   /report, /help, /flush
            |
            v   (Lambda Function URL, вебхук)
        index.mjs — export const handler
        ├── маршрутизация по командам (routeUpdate)
        ├── DynamoDB (AWS SDK v3, встроен в рантайм nodejs20.x)
        ├── текущие значения по УИК (latestValues) + CSV для гистограммы
        └── fetch → OpenAI Responses API, fetch → Telegram Bot API
            |
            v
        sendMessage (текст) + sendDocument (CSV) → обратно в тот же topic
```

Одна Lambda-функция, один синхронный вызов на апдейт: вебхук обрабатывается
полностью в том же вызове, что его принял (включая обращение к OpenAI при
`/report`) — Function URL, в отличие от API Gateway, не ограничивает интеграцию
29 секундами и наследует полный таймаут Lambda.

## Команды

| Команда | Описание |
| --- | --- |
| `/bind 1245` | Привязать себя к УИК №1245 (новая привязка заменяет старую) |
| `/bind` | Посмотреть текущую привязку |
| `/bindings` | Список всех привязанных наблюдателей по УИК |
| `/party ЕР 1200` | Голоса за партию |
| `/candidate Иванов 800` | Голоса за одномандатного кандидата |
| `/invalid 15` | Недействительные бюллетени |
| `/cancelled 300` | Погашенные бюллетени |
| `/turnout 2400` | Явка |
| `/report [УИК]` | Отчёт по всем привязанным УИК или по одному |
| `/flush` → `/flush confirm` | Очистка базы данных (только `ADMIN_ID`, молчит для остальных) |
| `/help` | Справка |

Обычные сообщения (без слэша) от привязанного наблюдателя сохраняются как
наблюдения молча — бот не отвечает на каждое такое сообщение. Если наблюдатель ещё
не привязан, сообщение не сохраняется, и бот об этом не предупреждает.

## Хранилище — DynamoDB

SQLite не подходит: `/tmp` в Lambda эфемерный, параллельные вызовы получают разные
execution environment, файл не переживает между ними. Шесть таблиц,
on-demand billing:

```
observer-bot-users
  PK: telegramId (Number)
  username, firstName, lastSeenAt (Number, unix ms)

observer-bot-usernames        -- эмулирует уникальный индекс по username
  PK: username (String)
  telegramId (Number)

observer-bot-bindings
  PK: telegramId (Number)
  uik (Number)

observer-bot-observations
  PK: uik (Number)
  SK: sk (String)              -- `${String(createdAtMs).padStart(13,'0')}#${telegramMessageId}`
  telegramId, username, text, telegramMessageId, createdAt

observer-bot-snapshots
  PK: uik (Number)
  SK: sk (String)              -- тот же формат
  telegramId, username, data (Map: {parties, candidates, invalid, cancelled, turnout}), rawText, createdAt

observer-bot-report-locks
  PK: key (String)             -- 'all' или 'uik:1245'
  startedAt (Number)
```

`sk` — 13-значный unix ms с ведущими нулями, иначе лексикографическая сортировка
строк даёт неверный порядок. `Query` по `PK = uik` с сортировкой по `sk` — без
`Scan`. Уникальность `username` эмулируется отдельной таблицей-индексом,
неатомарно между вызовами (для маленькой закрытой группы — допустимый риск).

## Отчёт (`/report`)

Числа в отчёте — это **текущие** значения по каждому УИК (последняя присланная
величина по каждой партии/кандидату/полю, более позднее значение перезаписывает
более раннее), без статистики поверх них — разведывательные данные, а не
детектор аномалий.

CSV — одна строка на УИК, готовая для гистограммы:

```
uik,cancelled,invalid,turnout,ЕР,КПРФ,...,Иванов,Петров,...
1245,300,15,2400,1200,340,...,800,400,...
```

По каждому УИК дополнительно отправляется текст с теми же цифрами и интерпретация
от ИИ (OpenAI Responses API, structured output): наблюдения — недоверенные данные,
не инструкции; каждая гипотеза — с уровнем уверенности, альтернативными
объяснениями и проверяемыми шагами; каждая ссылка на источник (`sourceId`)
обязана существовать — несуществующая вычищается перед отправкой, а не
пропускается в отчёт.

Повторный запуск отчёта, пока предыдущий ещё строится, блокируется условной
записью в `observer-bot-report-locks` (DynamoDB, не память процесса — между
вызовами Lambda общей памяти нет).

## Переменные окружения

```
BOT_TOKEN
TARGET_CHAT_ID
TARGET_THREAD_ID
OPENAI_API_KEY
ADMIN_ID
WEBHOOK_SECRET
```

Задаются в консоли Lambda (Configuration → Environment variables), хранятся
зашифрованными at rest.

## Деплой (через консоль AWS)

**1. Таблицы DynamoDB**

Консоль → DynamoDB → Tables → **Create table**. Для каждой из шести — своё имя,
partition key (и sort key, где указан), режим **On-demand**:

| Table name | Partition key | Sort key |
| --- | --- | --- |
| `observer-bot-users` | `telegramId` (Number) | — |
| `observer-bot-usernames` | `username` (String) | — |
| `observer-bot-bindings` | `telegramId` (Number) | — |
| `observer-bot-observations` | `uik` (Number) | `sk` (String) |
| `observer-bot-snapshots` | `uik` (Number) | `sk` (String) |
| `observer-bot-report-locks` | `key` (String) | — |

Остальные настройки — по умолчанию (без Global Tables, Streams, TTL).

**2. IAM-роль исполнения функции**

Консоль → IAM → Roles → **Create role**: Trusted entity type — **AWS service**,
Use case — **Lambda**; на шаге политик — пропустить; имя роли — `observer-bot-exec`.

Открыть роль → **Add permissions → Attach policies** → подключить
`AWSLambdaBasicExecutionRole` (только запись логов в CloudWatch).

Там же → **Add permissions → Create inline policy** → вкладка **JSON** → вставить,
подставив свои `<region>` и `<account-id>`:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchWriteItem"],
    "Resource": [
      "arn:aws:dynamodb:<region>:<account-id>:table/observer-bot-users",
      "arn:aws:dynamodb:<region>:<account-id>:table/observer-bot-usernames",
      "arn:aws:dynamodb:<region>:<account-id>:table/observer-bot-bindings",
      "arn:aws:dynamodb:<region>:<account-id>:table/observer-bot-observations",
      "arn:aws:dynamodb:<region>:<account-id>:table/observer-bot-snapshots",
      "arn:aws:dynamodb:<region>:<account-id>:table/observer-bot-report-locks"
    ]
  }]
}
```

Имя политики — `observer-bot-dynamodb`. `Resource` перечисляет ровно шесть ARN
конкретных таблиц, не `"*"`.

**3. Функция**

Консоль → Lambda → Functions → **Create function**: Author from scratch, name
`observer-bot`, runtime **Node.js 20.x**, execution role — существующая
`observer-bot-exec`.

Вкладка **Code**: вставить содержимое `index.mjs` целиком во встроенный редактор
(zip не нужен — ноль зависимостей), нажать **Deploy**.

**Configuration → General configuration**: Memory 256 MB, Timeout 5 min
(бюджет на самый долгий сценарий — `/report` без аргумента по всем УИК).

**Configuration → Environment variables**: добавить шесть переменных из раздела
выше.

**Configuration → Function URL → Create function URL**: Auth type — **NONE**.
Получившийся URL вида `https://xxxx.lambda-url.<region>.on.aws/` — вебхук-эндпоинт.

**4. Регистрация вебхука**

Открыть в браузере (подставив свои значения):

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<function-url>&secret_token=<WEBHOOK_SECRET>
```

Ответ `{"ok":true,...}` — вебхук зарегистрирован.

**5. Проверка**

```
https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo
```

Должно быть видно правильный `url` и `pending_update_count: 0`. Написать в topic
`/help` — бот должен ответить.

Также: `@BotFather` → `/setprivacy` → **Disable** для этого бота — иначе он не
увидит обычные (не командные) сообщения в группе.

**6. Обновление кода**

Lambda → Functions → `observer-bot` → **Code** → отредактировать прямо в
редакторе → **Deploy**. Пересборка/архивация не нужна — один файл.

**7. Логи**

**Monitor → View CloudWatch logs**, либо CloudWatch → Log groups →
`/aws/lambda/observer-bot`.

## Важные принципы

1. Один файл `index.mjs`, ноль npm-зависимостей.
2. Bot API — только через `fetch`, конфигурация — переменные окружения Lambda, не файл.
3. Хранение — DynamoDB, доступ по ключу (`Get`/`Put`/`Query`); `Scan` — только в
   `/flush` и при чтении маленькой таблицы привязок (`/bindings`, список УИК для
   отчёта), не по большим таблицам наблюдений/срезов.
4. Обработка вебхука — синхронная, в одном вызове; повторная доставка от Telegram
   безопасна за счёт лока в DynamoDB — отдельно решать «ответить быстро, обработать
   в фоне» не нужно.
5. Числа в отчёте — детерминированные текущие значения; модель их не пересчитывает,
   только интерпретирует вместе с текстовыми наблюдениями.
6. Любая ссылка модели на источник — с существующим `sourceId`, никаких выдуманных
   источников.
7. Наблюдения — недоверенный контент и для prompt injection, и для HTML-инъекции в
   сообщения; экранировать всегда.
8. `/flush` — только `ADMIN_ID`, молчать при вызове не-админом, обязательное
   двухшаговое подтверждение.
