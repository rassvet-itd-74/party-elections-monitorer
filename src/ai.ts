import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import type { SourceObservation, SourceSnapshot } from "./sources";
import type { Signal } from "./analytics";

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
const OPENAI_MODEL = "gpt-4o-2024-08-06";

const EvidenceSchema = z.object({
  sourceId: z.string(),
  argument: z.string(),
});

const HypothesisSchema = z.object({
  title: z.string(),
  assessment: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  evidence: z.array(EvidenceSchema),
  alternativeExplanations: z.array(z.string()),
  verificationSteps: z.array(z.string()),
});

const AnalysisSchema = z.object({
  summary: z.string(),
  hypotheses: z.array(HypothesisSchema),
  unresolvedQuestions: z.array(z.string()),
});

export type Analysis = z.infer<typeof AnalysisSchema>;

const basePrompt = fs.readFileSync(path.join(process.cwd(), "prompts", "uik-analysis.txt"), "utf8");

export interface AnalysisInput {
  uik: number;
  period: { from: string | null; to: string | null };
  signals: Signal[];
  observations: SourceObservation[];
  snapshots: SourceSnapshot[];
}

export async function analyzeUikWithAi(
  input: AnalysisInput,
  knownSourceIds: Set<string>
): Promise<Analysis> {
  const response = await openai.responses.parse({
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: basePrompt },
      { role: "user", content: JSON.stringify(input) },
    ],
    text: { format: zodTextFormat(AnalysisSchema, "uik_analysis") },
  });

  const parsed = response.output_parsed;
  if (!parsed) throw new Error("OpenAI response did not contain structured output");

  return sanitizeAnalysis(parsed, knownSourceIds);
}

// drops any evidence pointing at a sourceId the model invented, and drops hypotheses left with no evidence
function sanitizeAnalysis(analysis: Analysis, knownSourceIds: Set<string>): Analysis {
  const hypotheses = analysis.hypotheses
    .map((h) => ({ ...h, evidence: h.evidence.filter((e) => knownSourceIds.has(e.sourceId)) }))
    .filter((h) => h.evidence.length > 0);

  return { ...analysis, hypotheses };
}
