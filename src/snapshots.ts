import { db } from "./db";
import type { SnapshotData } from "./parser";

export interface Snapshot {
  id: number;
  telegram_message_id: number | null;
  telegram_id: number;
  username: string | null;
  uik: number;
  created_at: string;
  data: string; // JSON
  raw_text: string | null;
}

export interface ParsedSnapshot extends Omit<Snapshot, "data"> {
  data: SnapshotData;
}

const insertStmt = db.prepare(`
  INSERT INTO snapshots (telegram_message_id, telegram_id, username, uik, created_at, data, raw_text)
  VALUES (@telegramMessageId, @telegramId, @username, @uik, @createdAt, @data, @rawText)
`);
const selectByUik = db.prepare<[number], Snapshot>(
  "SELECT * FROM snapshots WHERE uik = ? ORDER BY created_at ASC"
);

export function insertSnapshot(params: {
  telegramMessageId: number | null;
  telegramId: number;
  username: string | null;
  uik: number;
  createdAt: string;
  data: SnapshotData;
  rawText: string;
}): void {
  insertStmt.run({
    telegramMessageId: params.telegramMessageId,
    telegramId: params.telegramId,
    username: params.username,
    uik: params.uik,
    createdAt: params.createdAt,
    data: JSON.stringify(params.data),
    rawText: params.rawText,
  });
}

export function getSnapshotsByUik(uik: number): ParsedSnapshot[] {
  return selectByUik.all(uik).map((row) => ({
    ...row,
    data: JSON.parse(row.data) as SnapshotData,
  }));
}

// last known registeredVoters for a УИК, taken from the most recent snapshot that stated it
export function getLatestRegisteredVoters(uik: number): number | undefined {
  const snapshots = getSnapshotsByUik(uik);
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const value = snapshots[i].data.registeredVoters;
    if (value !== undefined) return value;
  }
  return undefined;
}

export function getDistinctSnapshotUiks(): number[] {
  const rows = db
    .prepare<[], { uik: number }>("SELECT DISTINCT uik FROM snapshots")
    .all();
  return rows.map((r) => r.uik);
}
