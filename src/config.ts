import { z } from "zod";

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
  TARGET_CHAT_ID: z.coerce.number().int(),
  TARGET_THREAD_ID: z.coerce.number().int(),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  ADMIN_ID: z.coerce.number().int(),
  PORT: z.coerce.number().int().default(8080),
  WEBHOOK_SECRET: z.string().min(1, "WEBHOOK_SECRET is required"),
  WEBHOOK_URL: z.string().url().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
