import { config } from "./config";
import { sendMessage, sendDocument } from "./telegramApi";
import { bindUser, getBindingForUser, listAllBindings } from "./bindings";
import { getUserByUsername } from "./users";
import { insertObservation } from "./observations";
import { insertSnapshot } from "./snapshots";
import { parseDataMessage } from "./parser";
import { getOrBuildReport } from "./report";
import { flushDatabase } from "./db";
import type { TelegramMessage } from "./telegramTypes";

const HELP_TEXT = `1. Один раз: привязка к своему УИК

Сначала напишите в topic любое сообщение (чтобы бот вас увидел), затем:
/bind @ваш_ник НОМЕР_УИК
Например: /bind @ivanov 1245. Бот подтвердит привязку. Привязать может любой участник — как себя, так и коллегу (если тот уже писал в topic).

Если бот не знает ваш username:
«Я ещё не видел @username. Пусть пользователь сначала напишет сообщение в этом топике.»
Просто напишите любое сообщение в topic и повторите /bind.

Проверить, кто на какой УИК привязан:
/bindings

Привязка меняется новым /bind — старая просто перезаписывается.

2. Обычные наблюдения

Любое текстовое сообщение в topic (кроме команд) — это наблюдение, оно автоматически сохраняется за вашим УИК. Бот не отвечает на каждое сообщение — это нормально, отсутствие ответа не значит, что сообщение потерялось.

Если вы ещё не привязаны, бот попросит сначала выполнить /bind.

3. Числовые срезы

Когда нужно зафиксировать текущие цифры, отправьте /data. Секции: П — партии, О — одномандатные кандидаты, Н — недействительные бюллетени, Г — погашенные бюллетени, Я — явка. Можно прислать всё сразу:
/data
П: ЕР=312, КПРФ=148, ЛДПР=72
О: Иванов=284, Петров=193, Сидоров=48
Н: 12
Г: 5
Я: 620/1850
(в Я первое число — сколько человек уже проголосовало, второе, через /, — сколько всего избирателей в списке; второе число достаточно указать один раз за день, дальше можно писать просто Я: 650).

А можно любую секцию отдельным сообщением, когда узнали именно эту цифру — например, только недействительные:
/data
Н: 12
Можно писать компактно через ; или ,, лишние пробелы не страшны. Присылайте /data каждый раз, когда узнали новые цифры (например, раз в час) — не обязательно ждать, пока будут известны все показатели сразу.

4. Получить отчёт

/report — PDF по всем УИК сразу.
/report 1245 — PDF только по УИК №1245.

Отчёт может запросить любой участник в любой момент, ждать ничего не нужно — бот пришлёт PDF файлом в этот же topic (обычно занимает до минуты). Если отчёт уже строится по чьему-то запросу, ваш запрос дождётся того же результата, а не запустит расчёт заново.

В отчёте по каждому УИК будет два раздела: формальная статистика (графики, цифры) и раздел с гипотезами от ИИ — гипотезы всегда сопровождаются ссылками на конкретные сообщения/срезы, по которым их можно проверить, и никогда не формулируются как утверждение о нарушении.`;

function reply(message: TelegramMessage, text: string): Promise<void> {
  return sendMessage(message.chat.id, message.message_thread_id, text);
}

export async function handleBind(message: TelegramMessage, args: string[]): Promise<void> {
  const [usernameArg, uikArg] = args;
  if (!usernameArg || !uikArg) {
    await reply(message, "Использование: /bind @username НОМЕР_УИК");
    return;
  }
  const uik = Number(uikArg);
  if (!Number.isInteger(uik) || uik <= 0) {
    await reply(message, "Номер УИК должен быть положительным целым числом.");
    return;
  }
  const user = getUserByUsername(usernameArg);
  if (!user) {
    await reply(
      message,
      `Я ещё не видел ${usernameArg.startsWith("@") ? usernameArg : "@" + usernameArg}. Пусть пользователь сначала напишет сообщение в этом топике.`
    );
    return;
  }
  bindUser(user.telegram_id, uik);
  await reply(message, `Готово: ${usernameArg.startsWith("@") ? usernameArg : "@" + usernameArg} → УИК №${uik}`);
}

export async function handleBindings(message: TelegramMessage): Promise<void> {
  const bindings = listAllBindings();
  if (bindings.length === 0) {
    await reply(message, "Пока нет ни одной привязки.");
    return;
  }
  const byUik = new Map<number, string[]>();
  for (const b of bindings) {
    const label = b.username ? `@${b.username}` : `id${b.telegram_id}`;
    if (!byUik.has(b.uik)) byUik.set(b.uik, []);
    byUik.get(b.uik)!.push(label);
  }
  const lines = [...byUik.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([uik, users]) => `УИК №${uik}: ${users.join(", ")}`);
  await reply(message, lines.join("\n"));
}

const NOT_BOUND_MESSAGE = "Вы пока не привязаны к УИК. Используйте /bind @ваш_ник НОМЕР.";

export async function handleData(message: TelegramMessage, text: string): Promise<void> {
  if (!message.from) return;
  const result = parseDataMessage(text);
  if (!result.ok) {
    await reply(message, `Ошибка в /data: ${result.error}`);
    return;
  }
  const binding = getBindingForUser(message.from.id);
  if (!binding) {
    await reply(message, NOT_BOUND_MESSAGE);
    return;
  }
  insertSnapshot({
    telegramMessageId: message.message_id,
    telegramId: message.from.id,
    username: message.from.username ?? null,
    uik: binding.uik,
    createdAt: new Date(message.date * 1000).toISOString(),
    data: result.data,
    rawText: text,
  });
  const sections = Object.keys(result.data).join(", ");
  await reply(message, `Срез сохранён для УИК №${binding.uik} (${sections}).`);
}

export async function handleReport(message: TelegramMessage, args: string[]): Promise<void> {
  let uikFilter: number | undefined;
  if (args[0]) {
    const uik = Number(args[0]);
    if (!Number.isInteger(uik) || uik <= 0) {
      await reply(message, "Номер УИК должен быть положительным целым числом.");
      return;
    }
    uikFilter = uik;
  }
  try {
    const { buffer, filename } = await getOrBuildReport(uikFilter);
    await sendDocument(message.chat.id, message.message_thread_id, buffer, filename);
  } catch (e) {
    console.error("Report generation failed:", e);
    await reply(message, "Не удалось сформировать отчёт. Попробуйте ещё раз позже.");
  }
}

export async function handleHelp(message: TelegramMessage): Promise<void> {
  await reply(message, HELP_TEXT);
}

export async function handleFlush(message: TelegramMessage, args: string[]): Promise<void> {
  if (!message.from || message.from.id !== config.ADMIN_ID) return; // silent for non-admins
  if (args[0] !== "confirm") {
    await reply(
      message,
      "⚠️ Это удалит ВСЕ данные без возможности восстановления: наблюдения, срезы, привязки, пользователей. Для подтверждения отправьте /flush confirm."
    );
    return;
  }
  flushDatabase();
  await reply(message, "База данных очищена.");
}

export async function handleObservation(message: TelegramMessage, text: string): Promise<void> {
  if (!message.from || !text) return;
  const binding = getBindingForUser(message.from.id);
  if (!binding) {
    await reply(message, NOT_BOUND_MESSAGE);
    return;
  }
  insertObservation({
    telegramMessageId: message.message_id,
    telegramId: message.from.id,
    username: message.from.username ?? null,
    uik: binding.uik,
    createdAt: new Date(message.date * 1000).toISOString(),
    text,
  });
}
