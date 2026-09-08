import { db } from "./db";

export interface Binding {
  telegram_id: number;
  uik: number;
}

const upsertStmt = db.prepare(`
  INSERT INTO bindings (telegram_id, uik) VALUES (@telegramId, @uik)
  ON CONFLICT(telegram_id) DO UPDATE SET uik = excluded.uik
`);
const selectByTelegramId = db.prepare<[number], Binding>(
  "SELECT * FROM bindings WHERE telegram_id = ?"
);
const selectAll = db.prepare<[], Binding & { username: string | null }>(`
  SELECT b.telegram_id, b.uik, u.username
  FROM bindings b
  LEFT JOIN users u ON u.telegram_id = b.telegram_id
  ORDER BY b.uik ASC, u.username ASC
`);

export function bindUser(telegramId: number, uik: number): void {
  upsertStmt.run({ telegramId, uik });
}

export function getBindingForUser(telegramId: number): Binding | undefined {
  return selectByTelegramId.get(telegramId);
}

export function listAllBindings(): Array<Binding & { username: string | null }> {
  return selectAll.all();
}
