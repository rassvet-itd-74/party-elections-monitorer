import { db } from "./db";

export interface Observation {
  id: number;
  telegram_message_id: number | null;
  telegram_id: number;
  username: string | null;
  uik: number;
  created_at: string;
  text: string;
}

const insertStmt = db.prepare(`
  INSERT INTO observations (telegram_message_id, telegram_id, username, uik, created_at, text)
  VALUES (@telegramMessageId, @telegramId, @username, @uik, @createdAt, @text)
`);
const selectByUik = db.prepare<[number], Observation>(
  "SELECT * FROM observations WHERE uik = ? ORDER BY created_at ASC"
);
const selectAll = db.prepare<[], Observation>(
  "SELECT * FROM observations ORDER BY created_at ASC"
);

export function insertObservation(params: {
  telegramMessageId: number | null;
  telegramId: number;
  username: string | null;
  uik: number;
  createdAt: string;
  text: string;
}): void {
  insertStmt.run(params);
}

export function getObservationsByUik(uik: number): Observation[] {
  return selectByUik.all(uik);
}

export function getAllObservations(): Observation[] {
  return selectAll.all();
}

export function getDistinctObservedUiks(): number[] {
  const rows = db
    .prepare<[], { uik: number }>("SELECT DISTINCT uik FROM observations")
    .all();
  return rows.map((r) => r.uik);
}
