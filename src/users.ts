import { db } from "./db";

export interface User {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_seen_at: string;
}

const selectByTelegramId = db.prepare<[number], User>(
  "SELECT * FROM users WHERE telegram_id = ?"
);
const selectByUsername = db.prepare<[string], User>(
  "SELECT * FROM users WHERE username = ? COLLATE NOCASE"
);
const insertOrUpdate = db.prepare(`
  INSERT INTO users (telegram_id, username, first_name, last_seen_at)
  VALUES (@telegramId, @username, @firstName, @lastSeenAt)
  ON CONFLICT(telegram_id) DO UPDATE SET
    username = excluded.username,
    first_name = excluded.first_name,
    last_seen_at = excluded.last_seen_at
`);
const clearUsernameStmt = db.prepare(
  "UPDATE users SET username = NULL WHERE username = ? COLLATE NOCASE AND telegram_id != ?"
);

function isUniqueConstraintError(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/.test(e.message);
}

export function upsertUser(
  telegramId: number,
  username: string | null,
  firstName: string | null,
  lastSeenAt: string
): void {
  const params = { telegramId, username, firstName, lastSeenAt };
  try {
    insertOrUpdate.run(params);
  } catch (e) {
    if (isUniqueConstraintError(e) && username) {
      // username switched hands: strip it from the stale owner, then retry
      clearUsernameStmt.run(username, telegramId);
      insertOrUpdate.run(params);
    } else {
      throw e;
    }
  }
}

export function getUserByUsername(username: string): User | undefined {
  const normalized = username.startsWith("@") ? username.slice(1) : username;
  return selectByUsername.get(normalized);
}

export function getUserByTelegramId(telegramId: number): User | undefined {
  return selectByTelegramId.get(telegramId);
}
