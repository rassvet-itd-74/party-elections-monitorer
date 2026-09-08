import { config } from "./config";

const API_BASE = `https://api.telegram.org/bot${config.BOT_TOKEN}`;

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

export async function callApi(method: string, params: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = (await res.json()) as TelegramApiResponse<unknown>;
  if (!data.ok) throw new Error(`Telegram API ${method}: ${data.description}`);
  return data.result;
}

export async function sendMessage(chatId: number, threadId: number | undefined, text: string): Promise<void> {
  await callApi("sendMessage", {
    chat_id: chatId,
    message_thread_id: threadId,
    text,
  });
}

export async function sendDocument(
  chatId: number,
  threadId: number | undefined,
  file: Buffer,
  filename: string
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (threadId !== undefined) form.append("message_thread_id", String(threadId));
  form.append("document", new Blob([new Uint8Array(file)], { type: "application/pdf" }), filename);
  const res = await fetch(`${API_BASE}/sendDocument`, { method: "POST", body: form });
  const data = (await res.json()) as TelegramApiResponse<unknown>;
  if (!data.ok) throw new Error(`Telegram API sendDocument: ${data.description}`);
}

export async function setWebhook(url: string, secretToken: string): Promise<void> {
  await callApi("setWebhook", { url, secret_token: secretToken });
}
