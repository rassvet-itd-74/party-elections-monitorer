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

1. Каждое обычное (не командное) текстовое сообщение от привязанного к УИК
   наблюдателя сохраняется как наблюдение. Картинки, файлы и голосовые бот не
   распознаёт — только текст.
2. `/bind` привязывает Telegram-пользователя к номеру УИК.
3. `/report` строит отчёт: сначала по каждому УИК ИИ разбирает текст наблюдений
   и извлекает из него текущие цифры (голоса за партии/кандидатов,
   недействительные и погашенные бюллетени, явка — только если число названо в
   тексте явно, с обязательной ссылкой на исходное сообщение), затем из этих
   цифр собирается один CSV на все УИК (готовая таблица для гистограммы), а
   по каждому УИК отдельно отправляется текст с теми же цифрами (и ссылками на
   источники) и гипотезы от ИИ по текстовым наблюдениям.
4. `/flush` (только администратор, с двухшаговым подтверждением) очищает все
   данные.

## Архитектура

```
Telegram supergroup
└── topic «Наблюдатели»
    ├── обычные сообщения → observations
    ├── /bind, /bindings, /report, /help, /flush
            |
            v   (Lambda Function URL, вебхук)
        index.mjs — export const handler
        ├── маршрутизация по командам (routeUpdate)
        ├── DynamoDB (AWS SDK v3, встроен в рантайм nodejs20.x)
        ├── fetch → OpenAI Responses API: по каждому УИК разом извлекает
        │   текущие цифры из наблюдений (с ссылкой на источник) и гипотезы
        ├── CSV для гистограммы — собирается из извлечённых ИИ цифр
        └── fetch → Telegram Bot API
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
| `/report [УИК]` | Отчёт по всем привязанным УИК или по одному |
| `/flush` → `/flush confirm` | Очистка базы данных (только `ADMIN_ID`, молчит для остальных) |
| `/help` | Справка |

Обычные текстовые сообщения (без слэша) от привязанного наблюдателя сохраняются
как наблюдения молча — бот не отвечает на каждое такое сообщение. Если
наблюдатель ещё не привязан, сообщение не сохраняется, и бот об этом не
предупреждает. Отдельных команд для чисел (партии/кандидаты/недействительные/
погашенные/явка) больше нет — эти цифры для отчёта извлекает ИИ прямо из текста
наблюдений при построении `/report`, так что число просто нужно явно назвать в
обычном сообщении. Картинки, файлы и голосовые сообщения бот не распознаёт.

## Хранилище — DynamoDB

SQLite не подходит: `/tmp` в Lambda эфемерный, параллельные вызовы получают разные
execution environment, файл не переживает между ними. Пять таблиц,
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

observer-bot-report-locks
  PK: key (String)             -- 'all' или 'uik:1245'
  startedAt (Number)
```

`sk` — 13-значный unix ms с ведущими нулями, иначе лексикографическая сортировка
строк даёт неверный порядок. `Query` по `PK = uik` с сортировкой по `sk` — без
`Scan`. Уникальность `username` эмулируется отдельной таблицей-индексом,
неатомарно между вызовами (для маленькой закрытой группы — допустимый риск).

## Отчёт (`/report`)

Числа в отчёте больше не вводятся вручную — по каждому УИК ИИ (OpenAI Responses
API, structured output) за один вызов и извлекает текущие цифры (голоса за
партии/кандидатов, недействительные, погашенные, явка), и выдвигает гипотезы по
тексту наблюдений. В извлечение попадает только то, что явно и однозначно
названо в тексте; если по показателю есть несколько упоминаний в разное время —
берётся самое позднее. Как и у гипотез, каждое извлечённое число обязано
ссылаться на `sourceId` исходного наблюдения — несуществующая или отсутствующая
ссылка вычищается перед отправкой, а число просто не попадает в отчёт, а не
выдумывается. CSV-таблица строится уже из этого результата — то есть уже после
того, как ИИ отработал по всем УИК из отчёта, а не до.

CSV — одна строка на УИК, готовая для гистограммы:

```
uik,cancelled,invalid,turnout,ЕР,КПРФ,...,Иванов,Петров,...
1245,300,15,2400,1200,340,...,800,400,...
```

По каждому УИК дополнительно отправляется текст с теми же цифрами (с указанием
`sourceId`, на который можно сослаться и свериться с исходным сообщением) и
интерпретация от ИИ: наблюдения — недоверенные данные, не инструкции; каждая
гипотеза — с уровнем уверенности, альтернативными объяснениями и проверяемыми
шагами.

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

Консоль → DynamoDB → Tables → **Create table**. Для каждой из пяти — своё имя,
partition key (и sort key, где указан), режим **On-demand**:

| Table name | Partition key | Sort key |
| --- | --- | --- |
| `observer-bot-users` | `telegramId` (Number) | — |
| `observer-bot-usernames` | `username` (String) | — |
| `observer-bot-bindings` | `telegramId` (Number) | — |
| `observer-bot-observations` | `uik` (Number) | `sk` (String) |
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
      "arn:aws:dynamodb:<region>:<account-id>:table/observer-bot-report-locks"
    ]
  }]
}
```

Имя политики — `observer-bot-dynamodb`. `Resource` перечисляет ровно пять ARN
конкретных таблиц, не `"*"`.

Если раньше уже разворачивали бота со старой версией кода — таблицу
`observer-bot-snapshots` и её ARN в этой политике можно удалить, код её больше
не использует.

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
