import type { SubjectSeries } from "./analytics";

const PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// timestamps are stored as ISO UTC; HH:MM slice is a good-enough label for a same-day report
function formatTime(iso: string): string {
  return iso.slice(11, 16);
}

interface ChartSeriesInput {
  label: string;
  points: { to: string; delta: number }[];
}

const WIDTH = 720;
const HEIGHT = 320;
const MARGIN = { top: 36, right: 16, bottom: 56, left: 48 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;

// generic manually-drawn grouped bar chart: no external chart libraries used
export function renderBarChart(title: string, series: ChartSeriesInput[]): string {
  const nonEmpty = series.filter((s) => s.points.length > 0);
  if (nonEmpty.length === 0) {
    return `<svg width="${WIDTH}" height="120" xmlns="http://www.w3.org/2000/svg">
      <text x="10" y="30" font-size="14" fill="#333">${escapeXml(title)}</text>
      <text x="10" y="60" font-size="12" fill="#888">Недостаточно данных для графика</text>
    </svg>`;
  }

  const categorySet = new Set<string>();
  for (const s of nonEmpty) for (const p of s.points) categorySet.add(p.to);
  const categories = [...categorySet].sort();

  const allValues = nonEmpty.flatMap((s) => s.points.map((p) => p.delta));
  const maxValue = Math.max(1, ...allValues.map((v) => Math.abs(v)));

  const categoryWidth = PLOT_WIDTH / categories.length;
  const barWidth = Math.max(2, (categoryWidth * 0.8) / nonEmpty.length);
  const baselineY = MARGIN.top + PLOT_HEIGHT;

  const bars: string[] = [];
  const axisLabels: string[] = [];

  categories.forEach((category, ci) => {
    const groupX = MARGIN.left + ci * categoryWidth + categoryWidth * 0.1;
    nonEmpty.forEach((s, si) => {
      const point = s.points.find((p) => p.to === category);
      if (!point) return;
      const barHeight = (Math.abs(point.delta) / maxValue) * PLOT_HEIGHT;
      const x = groupX + si * barWidth;
      const y = baselineY - barHeight;
      const color = PALETTE[si % PALETTE.length];
      bars.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" fill="${color}" />`
      );
      bars.push(
        `<text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}" font-size="9" text-anchor="middle" fill="#333">${point.delta}</text>`
      );
    });
    const labelX = MARGIN.left + ci * categoryWidth + categoryWidth / 2;
    axisLabels.push(
      `<text x="${labelX.toFixed(1)}" y="${(baselineY + 16).toFixed(1)}" font-size="10" text-anchor="middle" fill="#333" transform="rotate(-40 ${labelX.toFixed(1)} ${(baselineY + 16).toFixed(1)})">${formatTime(category)}</text>`
    );
  });

  const legend = nonEmpty
    .map((s, i) => {
      const x = MARGIN.left + i * 140;
      const color = PALETTE[i % PALETTE.length];
      return `<rect x="${x}" y="${MARGIN.top - 20}" width="10" height="10" fill="${color}" />
        <text x="${x + 14}" y="${MARGIN.top - 11}" font-size="10" fill="#333">${escapeXml(s.label)}</text>`;
    })
    .join("\n");

  return `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif">
    <text x="${MARGIN.left}" y="18" font-size="14" fill="#111">${escapeXml(title)}</text>
    ${legend}
    <line x1="${MARGIN.left}" y1="${baselineY}" x2="${WIDTH - MARGIN.right}" y2="${baselineY}" stroke="#999" />
    <line x1="${MARGIN.left}" y1="${MARGIN.top}" x2="${MARGIN.left}" y2="${baselineY}" stroke="#999" />
    ${bars.join("\n")}
    ${axisLabels.join("\n")}
  </svg>`;
}

export interface UikCharts {
  partyChart: string;
  singleChart: string;
  invalidCancelledChart: string;
  turnoutChart: string;
}

function toChartSeries(s: SubjectSeries): ChartSeriesInput {
  return { label: s.subject, points: s.deltas.map((d) => ({ to: d.to, delta: d.delta })) };
}

export function buildUikCharts(series: SubjectSeries[]): UikCharts {
  const partySeries = series.filter((s) => s.subjectType === "party").map(toChartSeries);
  const singleSeries = series.filter((s) => s.subjectType === "single").map(toChartSeries);
  const invalidSeries = series.filter((s) => s.subjectType === "invalid").map(toChartSeries);
  const cancelledSeries = series.filter((s) => s.subjectType === "cancelled").map(toChartSeries);
  const turnoutSeries = series.filter((s) => s.subjectType === "turnout").map(toChartSeries);

  return {
    partyChart: renderBarChart("Приращения по партиям", partySeries),
    singleChart: renderBarChart("Приращения по одномандатным кандидатам", singleSeries),
    invalidCancelledChart: renderBarChart("Недействительные и погашенные бюллетени", [
      ...invalidSeries,
      ...cancelledSeries,
    ]),
    turnoutChart: renderBarChart("Приращения явки", turnoutSeries),
  };
}
