import http from "node:http";
import { config } from "./config";
import { handleUpdate } from "./router";

export function startServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/telegram-webhook") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers["x-telegram-bot-api-secret-token"] !== config.WEBHOOK_SECRET) {
      res.writeHead(401).end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const update = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    // отвечаем Telegram сразу же, дальше обрабатываем асинхронно
    res.writeHead(200).end();
    handleUpdate(update).catch((err) => console.error("Failed to handle update:", err));
  });

  server.listen(config.PORT, () => {
    console.log(`Listening on port ${config.PORT}`);
  });

  return server;
}
