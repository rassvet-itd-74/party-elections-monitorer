import { config } from "./config";
import { setWebhook } from "./telegramApi";

async function main() {
  if (!config.WEBHOOK_URL) {
    console.error("WEBHOOK_URL is not set in .env — cannot register webhook.");
    process.exit(1);
  }
  await setWebhook(config.WEBHOOK_URL, config.WEBHOOK_SECRET);
  console.log(`Webhook registered: ${config.WEBHOOK_URL}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
