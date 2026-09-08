export interface SnapshotData {
  party?: Record<string, number>;
  single?: Record<string, number>;
  invalid?: number;
  cancelled?: number;
  turnout?: number;
  registeredVoters?: number;
}

export type ParseResult =
  | { ok: true; data: SnapshotData }
  | { ok: false; error: string };

const SECTION_LABELS = ["П", "О", "Н", "Г", "Я"] as const;
type SectionLabel = (typeof SECTION_LABELS)[number];

// drops the leading "/data" (and optional "@botname") token
function stripCommand(text: string): string {
  return text.replace(/^\s*\/data(@\w+)?/i, "").trim();
}

function parseKeyValueList(
  raw: string
): { ok: true; values: Record<string, number> } | { ok: false; error: string } {
  const parts = raw
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return { ok: false, error: "пустой список значений" };

  const values: Record<string, number> = {};
  for (const part of parts) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) return { ok: false, error: `не удалось разобрать "${part}"` };
    const key = part.slice(0, eqIndex).trim();
    const valueRaw = part.slice(eqIndex + 1).trim();
    if (!key) return { ok: false, error: `пустой ключ в "${part}"` };
    if (!/^\d+$/.test(valueRaw)) return { ok: false, error: `нечисловое значение в "${part}"` };
    if (key in values) return { ok: false, error: `повторяющийся ключ "${key}"` };
    values[key] = parseInt(valueRaw, 10);
  }
  return { ok: true, values };
}

function parseNonNegInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return parseInt(trimmed, 10);
}

export function parseDataMessage(text: string): ParseResult {
  const payload = stripCommand(text);
  if (!payload) return { ok: false, error: "не удалось распознать ни одной секции" };

  const labelRe = /([ПОНГЯ])\s*:\s*/g;
  const matches = [...payload.matchAll(labelRe)];
  if (matches.length === 0) return { ok: false, error: "не удалось распознать ни одной секции" };

  const sections = new Map<SectionLabel, string>();
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const label = match[1] as SectionLabel;
    if (sections.has(label)) return { ok: false, error: `секция "${label}" указана дважды` };
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index as number) : payload.length;
    const content = payload
      .slice(start, end)
      .replace(/[,;\s]+$/, "")
      .trim();
    if (!content) return { ok: false, error: `секция "${label}" пуста` };
    sections.set(label, content);
  }

  const data: SnapshotData = {};

  const partyRaw = sections.get("П");
  if (partyRaw !== undefined) {
    const parsed = parseKeyValueList(partyRaw);
    if (!parsed.ok) return { ok: false, error: `секция "П": ${parsed.error}` };
    data.party = parsed.values;
  }

  const singleRaw = sections.get("О");
  if (singleRaw !== undefined) {
    const parsed = parseKeyValueList(singleRaw);
    if (!parsed.ok) return { ok: false, error: `секция "О": ${parsed.error}` };
    data.single = parsed.values;
  }

  const invalidRaw = sections.get("Н");
  if (invalidRaw !== undefined) {
    const value = parseNonNegInt(invalidRaw);
    if (value === null) return { ok: false, error: `секция "Н": ожидалось целое число` };
    data.invalid = value;
  }

  const cancelledRaw = sections.get("Г");
  if (cancelledRaw !== undefined) {
    const value = parseNonNegInt(cancelledRaw);
    if (value === null) return { ok: false, error: `секция "Г": ожидалось целое число` };
    data.cancelled = value;
  }

  const turnoutRaw = sections.get("Я");
  if (turnoutRaw !== undefined) {
    const [turnoutPart, registeredPart] = turnoutRaw.split("/").map((p) => p.trim());
    const turnout = parseNonNegInt(turnoutPart);
    if (turnout === null) return { ok: false, error: `секция "Я": ожидалось целое число` };
    data.turnout = turnout;
    if (registeredPart !== undefined) {
      const registered = parseNonNegInt(registeredPart);
      if (registered === null)
        return { ok: false, error: `секция "Я": списочное число избирателей должно быть целым` };
      data.registeredVoters = registered;
    }
  }

  if (Object.keys(data).length === 0) {
    return { ok: false, error: "не удалось распознать ни одной секции" };
  }

  return { ok: true, data };
}
