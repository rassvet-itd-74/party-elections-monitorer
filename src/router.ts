import { config } from "./config";
import { upsertUser } from "./users";
import {
  handleBind,
  handleBindings,
  handleData,
  handleReport,
  handleHelp,
  handleFlush,
  handleObservation,
} from "./handlers";
import type { TelegramUpdate } from "./telegramTypes";

export async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message) return; // прочие типы апдейтов не обрабатываем

  if (message.chat.id !== config.TARGET_CHAT_ID || message.message_thread_id !== config.TARGET_THREAD_ID) return;

  if (message.from) {
    upsertUser(
      message.from.id,
      message.from.username ?? null,
      message.from.first_name ?? null,
      new Date(message.date * 1000).toISOString()
    );
  }

  const text = message.text ?? "";
  const [rawCommand, ...args] = text.split(/\s+/);
  // в группах Telegram может добавлять "@ИмяБота" к команде — отрезаем
  const command = rawCommand.startsWith("/") ? rawCommand.split("@")[0] : null;

  switch (command) {
    case "/bind":
      return handleBind(message, args);
    case "/bindings":
      return handleBindings(message);
    case "/data":
      return handleData(message, text);
    case "/report":
      return handleReport(message, args);
    case "/help":
      return handleHelp(message);
    case "/flush":
      return handleFlush(message, args);
    default:
      return handleObservation(message, text);
  }
}
