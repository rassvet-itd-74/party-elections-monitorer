import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, "data.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_seen_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users(username) WHERE username IS NOT NULL;

  CREATE TABLE IF NOT EXISTS bindings (
      telegram_id INTEGER PRIMARY KEY,
      uik INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_message_id INTEGER,
      telegram_id INTEGER NOT NULL,
      username TEXT,
      uik INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      text TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_message_id INTEGER,
      telegram_id INTEGER NOT NULL,
      username TEXT,
      uik INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL,
      raw_text TEXT
  );
`);

// wipes all rows but keeps the schema in place; used only by the admin-only /flush confirm
export const flushDatabase = db.transaction(() => {
  db.exec(`
    DELETE FROM observations;
    DELETE FROM snapshots;
    DELETE FROM bindings;
    DELETE FROM users;
  `);
});
