import Handlebars from "handlebars";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { getObservationsByUik, getDistinctObservedUiks, type Observation } from "./observations";
import {
  getSnapshotsByUik,
  getDistinctSnapshotUiks,
  getLatestRegisteredVoters,
  type ParsedSnapshot,
} from "./snapshots";
import { listAllBindings } from "./bindings";
import { analyzeUik } from "./analytics";
import { buildUikCharts } from "./charts";
import { toSourceObservations, toSourceSnapshots, collectKnownSourceIds } from "./sources";
import { analyzeUikWithAi } from "./ai";

export interface GeneratedReport {
  buffer: Buffer;
  filename: string;
}

// single global mutex: concurrent /report calls all await the same in-flight generation
let runningReport: Promise<GeneratedReport> | null = null;

export function getOrBuildReport(uikFilter?: number): Promise<GeneratedReport> {
  if (runningReport) return runningReport;
  const promise = buildReport(uikFilter).finally(() => {
    runningReport = null;
  });
  runningReport = promise;
  return promise;
}

function timestampForFilename(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function resolveUiks(uikFilter?: number): number[] {
  if (uikFilter !== undefined) return [uikFilter];
  const set = new Set<number>();
  for (const uik of getDistinctObservedUiks()) set.add(uik);
  for (const uik of getDistinctSnapshotUiks()) set.add(uik);
  for (const b of listAllBindings()) set.add(b.uik);
  return [...set].sort((a, b) => a - b);
}

function periodOf(observations: Observation[], snapshots: ParsedSnapshot[]): { from: string | null; to: string | null } {
  const timestamps = [...observations.map((o) => o.created_at), ...snapshots.map((s) => s.created_at)].sort();
  return { from: timestamps[0] ?? null, to: timestamps[timestamps.length - 1] ?? null };
}

interface UsedSource {
  sourceId: string;
  kind: "Наблюдение" | "Срез" | "Сигнал";
  at: string;
  username: string | null;
  label: string;
}

async function buildUikPage(uik: number) {
  const observations = getObservationsByUik(uik);
  const snapshots = getSnapshotsByUik(uik);

  const { series, signals } = analyzeUik(snapshots);
  const charts = buildUikCharts(series);

  const sourceObservations = toSourceObservations(observations);
  const sourceSnapshots = toSourceSnapshots(snapshots);
  const knownSourceIds = collectKnownSourceIds(sourceObservations, sourceSnapshots, signals);
  const period = periodOf(observations, snapshots);

  let aiAnalysis;
  try {
    aiAnalysis = await analyzeUikWithAi(
      { uik, period, signals, observations: sourceObservations, snapshots: sourceSnapshots },
      knownSourceIds
    );
  } catch (e) {
    console.error(`AI analysis failed for УИК ${uik}:`, e);
    aiAnalysis = { summary: "Анализ ИИ временно недоступен.", hypotheses: [] as Analysis["hypotheses"], unresolvedQuestions: [] as string[] };
  }

  const turnoutSeries = series.find((s) => s.subjectType === "turnout");
  const latestTurnout = turnoutSeries?.points.at(-1)?.value;
  const registeredVoters = getLatestRegisteredVoters(uik);
  const turnoutPercent =
    latestTurnout !== undefined && registeredVoters ? ((latestTurnout / registeredVoters) * 100).toFixed(1) : null;

  const sourceLookup = new Map<string, UsedSource>();
  for (const o of sourceObservations) {
    sourceLookup.set(o.sourceId, { sourceId: o.sourceId, kind: "Наблюдение", at: o.at, username: o.username, label: o.text });
  }
  for (const s of sourceSnapshots) {
    sourceLookup.set(s.sourceId, {
      sourceId: s.sourceId,
      kind: "Срез",
      at: s.at,
      username: s.username,
      label: JSON.stringify(s.data),
    });
  }
  for (const sig of signals) {
    sourceLookup.set(sig.id, {
      sourceId: sig.id,
      kind: "Сигнал",
      at: sig.to,
      username: null,
      label: `${sig.subject}: delta=${sig.delta} (медиана=${sig.medianDelta}, MAD=${sig.mad}, z=${sig.robustZ.toFixed(2)})`,
    });
  }

  const usedSourceIds = new Set<string>();
  for (const h of aiAnalysis.hypotheses) for (const e of h.evidence) usedSourceIds.add(e.sourceId);
  const usedSources = [...usedSourceIds]
    .sort()
    .map((id) => sourceLookup.get(id))
    .filter((s): s is UsedSource => s !== undefined);

  const observerCount = new Set([...observations.map((o) => o.telegram_id), ...snapshots.map((s) => s.telegram_id)]).size;

  return {
    uik,
    period,
    observerCount,
    observationCount: observations.length,
    snapshotCount: snapshots.length,
    turnout: latestTurnout ?? null,
    registeredVoters: registeredVoters ?? null,
    turnoutPercent,
    charts,
    signals,
    summary: aiAnalysis.summary,
    hypotheses: aiAnalysis.hypotheses,
    unresolvedQuestions: aiAnalysis.unresolvedQuestions,
    usedSources,
  };
}

type Analysis = Awaited<ReturnType<typeof analyzeUikWithAi>>;

async function buildReport(uikFilter?: number): Promise<GeneratedReport> {
  const uiks = resolveUiks(uikFilter);
  const pages = [];
  let totalObservations = 0;
  let totalSnapshots = 0;

  for (const uik of uiks) {
    const page = await buildUikPage(uik);
    totalObservations += page.observationCount;
    totalSnapshots += page.snapshotCount;
    pages.push(page);
  }

  const allPeriods = pages.map((p) => p.period).flatMap((p) => [p.from, p.to]).filter((x): x is string => x !== null).sort();

  const html = renderHtml({
    generatedAt: new Date().toISOString(),
    period: { from: allPeriods[0] ?? null, to: allPeriods[allPeriods.length - 1] ?? null },
    uikCount: uiks.length,
    totalObservations,
    totalSnapshots,
    pages,
  });

  const buffer = await renderPdf(html);
  const filename =
    uikFilter !== undefined
      ? `uik-${uikFilter}-${timestampForFilename()}.pdf`
      : `report-${timestampForFilename()}.pdf`;

  return { buffer, filename };
}

const templatePath = path.join(process.cwd(), "templates", "report.hbs");
const templateSource = fs.readFileSync(templatePath, "utf8");
Handlebars.registerHelper("formatNumber", (n: unknown) => (n === null || n === undefined ? "—" : String(n)));
Handlebars.registerHelper("percent", (n: unknown) => (n === null || n === undefined ? "" : `(${n}%)`));
Handlebars.registerHelper("dt", (iso: unknown) =>
  typeof iso === "string" && iso ? iso.replace("T", " ").slice(0, 16) : "—"
);
const template = Handlebars.compile(templateSource);

function renderHtml(data: unknown): string {
  return template(data);
}

async function renderPdf(html: string): Promise<Buffer> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const buffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "15mm", right: "15mm", bottom: "18mm", left: "15mm" },
    });
    return buffer;
  } finally {
    await browser.close();
  }
}
