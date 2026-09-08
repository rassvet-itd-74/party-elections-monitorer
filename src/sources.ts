import type { Observation } from "./observations";
import type { ParsedSnapshot } from "./snapshots";
import type { Signal } from "./analytics";

export interface SourceObservation {
  sourceId: string;
  uik: number;
  at: string;
  username: string | null;
  text: string;
}

export interface SourceSnapshot {
  sourceId: string;
  uik: number;
  at: string;
  username: string | null;
  data: ParsedSnapshot["data"];
}

export function toSourceObservations(observations: Observation[]): SourceObservation[] {
  return observations.map((o) => ({
    sourceId: `O-${o.id}`,
    uik: o.uik,
    at: o.created_at,
    username: o.username,
    text: o.text,
  }));
}

export function toSourceSnapshots(snapshots: ParsedSnapshot[]): SourceSnapshot[] {
  return snapshots.map((s) => ({
    sourceId: `S-${s.id}`,
    uik: s.uik,
    at: s.created_at,
    username: s.username,
    data: s.data,
  }));
}

export function collectKnownSourceIds(
  observations: SourceObservation[],
  snapshots: SourceSnapshot[],
  signals: Signal[]
): Set<string> {
  const ids = new Set<string>();
  for (const o of observations) ids.add(o.sourceId);
  for (const s of snapshots) ids.add(s.sourceId);
  for (const sig of signals) ids.add(sig.id);
  return ids;
}
