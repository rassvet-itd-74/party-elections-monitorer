import type { ParsedSnapshot } from "./snapshots";

export type SubjectType = "party" | "single" | "invalid" | "cancelled" | "turnout";

export interface SeriesPoint {
  sourceId: string;
  at: string;
  value: number;
}

export interface SeriesDelta {
  fromSourceId: string;
  toSourceId: string;
  from: string;
  to: string;
  delta: number;
}

export interface SubjectSeries {
  subjectType: SubjectType;
  subject: string;
  points: SeriesPoint[];
  deltas: SeriesDelta[];
  stats: { medianDelta: number | null; mad: number | null; maxDelta: number | null };
}

export interface Signal {
  id: string; // SIG-n
  type: "rate_outlier";
  from: string;
  to: string;
  fromSourceId: string;
  toSourceId: string;
  subjectType: SubjectType;
  subject: string;
  delta: number;
  medianDelta: number;
  mad: number;
  robustZ: number;
}

const SCALAR_LABELS: Record<"invalid" | "cancelled" | "turnout", string> = {
  invalid: "Недействительные бюллетени",
  cancelled: "Погашенные бюллетени",
  turnout: "Явка",
};

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mad(values: number[], med: number = median(values)): number {
  const deviations = values.map((v) => Math.abs(v - med));
  return median(deviations);
}

// robust z-score; MAD = 0 handled separately to avoid division by zero
export function robustZ(x: number, med: number, madValue: number): number {
  if (madValue === 0) {
    if (x === med) return 0;
    return x > med ? Infinity : -Infinity;
  }
  return (0.6745 * (x - med)) / madValue;
}

const SIGNAL_THRESHOLD = 3.5;

function pointsForSubject(
  snapshots: ParsedSnapshot[],
  extractValue: (data: ParsedSnapshot["data"]) => number | undefined
): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (const snapshot of snapshots) {
    const value = extractValue(snapshot.data);
    if (value === undefined) continue;
    points.push({ sourceId: `S-${snapshot.id}`, at: snapshot.created_at, value });
  }
  return points;
}

function buildDeltas(points: SeriesPoint[]): SeriesDelta[] {
  const deltas: SeriesDelta[] = [];
  for (let i = 1; i < points.length; i++) {
    deltas.push({
      fromSourceId: points[i - 1].sourceId,
      toSourceId: points[i].sourceId,
      from: points[i - 1].at,
      to: points[i].at,
      delta: points[i].value - points[i - 1].value,
    });
  }
  return deltas;
}

function buildSeries(
  subjectType: SubjectType,
  subject: string,
  points: SeriesPoint[]
): SubjectSeries {
  const deltas = buildDeltas(points);
  if (deltas.length === 0) {
    return { subjectType, subject, points, deltas, stats: { medianDelta: null, mad: null, maxDelta: null } };
  }
  const deltaValues = deltas.map((d) => d.delta);
  const medianDelta = median(deltaValues);
  const madValue = mad(deltaValues, medianDelta);
  const maxDelta = Math.max(...deltaValues);
  return {
    subjectType,
    subject,
    points,
    deltas,
    stats: { medianDelta, mad: madValue, maxDelta },
  };
}

function collectSignals(series: SubjectSeries, startId: number): { signals: Signal[]; nextId: number } {
  const signals: Signal[] = [];
  let nextId = startId;
  if (series.stats.medianDelta === null || series.stats.mad === null) {
    return { signals, nextId };
  }
  const { medianDelta, mad: madValue } = series.stats;
  for (const d of series.deltas) {
    const z = robustZ(d.delta, medianDelta, madValue);
    if (Math.abs(z) > SIGNAL_THRESHOLD) {
      signals.push({
        id: `SIG-${nextId}`,
        type: "rate_outlier",
        from: d.from,
        to: d.to,
        fromSourceId: d.fromSourceId,
        toSourceId: d.toSourceId,
        subjectType: series.subjectType,
        subject: series.subject,
        delta: d.delta,
        medianDelta,
        mad: madValue,
        robustZ: z,
      });
      nextId++;
    }
  }
  return { signals, nextId };
}

export interface UikAnalysis {
  series: SubjectSeries[];
  signals: Signal[];
  nextSignalId: number;
}

// builds all per-subject time series + robust-z signals for one УИК's snapshots (already sorted by created_at)
export function analyzeUik(snapshots: ParsedSnapshot[], signalIdStart = 1): UikAnalysis {
  const subjectKeys = new Set<string>();
  const singleKeys = new Set<string>();
  for (const snapshot of snapshots) {
    for (const key of Object.keys(snapshot.data.party ?? {})) subjectKeys.add(key);
    for (const key of Object.keys(snapshot.data.single ?? {})) singleKeys.add(key);
  }

  const series: SubjectSeries[] = [];

  for (const party of subjectKeys) {
    const points = pointsForSubject(snapshots, (d) => d.party?.[party]);
    series.push(buildSeries("party", party, points));
  }
  for (const candidate of singleKeys) {
    const points = pointsForSubject(snapshots, (d) => d.single?.[candidate]);
    series.push(buildSeries("single", candidate, points));
  }
  series.push(buildSeries("invalid", SCALAR_LABELS.invalid, pointsForSubject(snapshots, (d) => d.invalid)));
  series.push(buildSeries("cancelled", SCALAR_LABELS.cancelled, pointsForSubject(snapshots, (d) => d.cancelled)));
  series.push(buildSeries("turnout", SCALAR_LABELS.turnout, pointsForSubject(snapshots, (d) => d.turnout)));

  const signals: Signal[] = [];
  let nextId = signalIdStart;
  for (const s of series) {
    const result = collectSignals(s, nextId);
    signals.push(...result.signals);
    nextId = result.nextId;
  }

  return { series, signals, nextSignalId: nextId };
}
