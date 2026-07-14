// SPDX-License-Identifier: Apache-2.0
/**
 * PROVE2 — the costed cross-judge per-capability QA-lift + competitor
 * head-to-head harness. The "measure-first" keystone: it produces the
 * cross-judged numbers that decide whether a measured capability may be
 * activated by default.
 *
 * WHAT IT DOES (one bounded, sampled, COSTED run):
 *   1. Ingest a bounded sample (COMIS_BENCH_LIMIT LongMemEval items + the first
 *      COMIS_BENCH_LOCOMO_LIMIT LoCoMo samples), each into its OWN store — the
 *      standard per-item protocol (mirrors qa-judge-harness.bench.test.ts).
 *   2. For each SYSTEM under test, build its per-question CONTEXT (LLM-free, in
 *      beforeAll):
 *        - comis-baseline   : recall AS SHIPPED (the defaults).
 *        - comis-<capability>: recall with ONE capability overlaid ON
 *          (graphSpread / intent-reweight / forget) — the per-capability QA-lift.
 *        - letta-fs-control : the full-haystack dump (the honesty control; never
 *          Comis's headline).
 *        - <competitor>     : an OPTIONAL external system's per-question context
 *          loaded from COMIS_BENCH_CONTEXTS_FILE (mem0 etc., produced by an
 *          out-of-repo runner — competitors are NEVER imported here; supply-chain).
 *   3. Grade EVERY system's per-question context through the SAME answer LLM + the
 *      SAME ≥2 judges (cross-judge), at temperature 0. A per-(questionId, context)
 *      verdict cache means a capability whose recall is byte-identical to baseline
 *      reuses the baseline verdict at $0 — a provably-0 lift, the byte-identity
 *      discipline made load-bearing.
 *   4. Aggregate per system (overall + per-category), the Wilson CI, the
 *      two-proportion significance vs baseline, and the cross-judge spread; write a
 *      committed-shape manifest via the confined writer.
 *
 * THE CREDIBILITY PROTOCOL: ≥2 judges,
 * competitors re-run by us under ONE protocol/judge/machine, N + significance,
 * cost + latency, COI disclosed, raw verdicts attributable to fixed harness code.
 * A number stands only if it survives BOTH judges (the cross-judge spread).
 *
 * COI: the answer model and judge-2 are BOTH Anthropic in the operator's wiring
 * (answer=claude-sonnet, judge1=gpt-4o, judge2=claude-sonnet). Using claude as a
 * judge of claude-authored answers is a self-preference COI — recorded in the
 * manifest; the headline relies on judge-1 (gpt-4o, the LongMemEval reference
 * judge) and the cross-judge spread, never judge-2 alone.
 *
 * ARCHITECTURE CUT: this *.bench.test.ts is the single agent->memory cut escape
 * (source-rules.test.ts excludeFileSuffixes [".test.ts"]) — it MAY import
 * @comis/memory. It imports NO competitor package (mem0/zep/hindsight/mnemosyne):
 * competitor numbers arrive ONLY as pre-rendered contexts in COMIS_BENCH_CONTEXTS_FILE,
 * so an absent competitor simply contributes no rows (it can never fabricate one).
 *
 * SECURITY: fresh mkdtempSync stores (never ~/.comis); operator dataset paths are
 * confinement-checked before read; gold answers ride the question channel only
 * (never ingested); the manifest records ONLY {provider, modelId} per role and is
 * asserted to carry no credential substring; written via the confined writeRegularFile.
 *
 * @module
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  SqliteMemoryAdapter,
  createEmbeddingProvider,
  createLocalRerankerProvider,
} from "@comis/memory";
import { createMemoryRecall, type MemoryRecallDeps, type MemoryRecallConfig } from "@comis/agent";
import { completeSimple, getModel } from "@earendil-works/pi-ai/compat";
import { writeRegularFile } from "@comis/observability";
import { loadLongMemEvalDataset } from "./longmemeval-loader.js";
import { loadLocomoDataset } from "./locomo-loader.js";
import { ANSWER_SYSTEM_PROMPT, formatAnswerContext, buildAnswerPrompt } from "./qa-answer-prompt.js";
import { buildJudgePrompt } from "./qa-judge-prompt.js";
import { formatFilesystemContext } from "./filesystem-baseline.js";
import { parseJudgeVerdict } from "./qa-judge-parse.js";
import { aggregateAccuracy, type CategorizedVerdict, type AccuracyResult } from "./qa-accuracy.js";
import { computeSpreadFromResults } from "./cross-judge-spread.js";
import { wilsonInterval, twoProportionTest } from "./significance.js";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
import type { MemoryConfig, MemorySearchResult, SessionKey } from "@comis/core";
import { MemoryConfigSchema } from "@comis/core";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve, sep, dirname } from "node:path";

// ── ENV GATES (read ONLY at the .test.ts boundary; globals rule scopes to src/**) ──
const COMIS_BENCH = process.env.COMIS_BENCH;
const LLAMA_MODEL_PATH = process.env.LLAMA_MODEL_PATH;
const LLAMA_RERANKER_MODEL_PATH = process.env.LLAMA_RERANKER_MODEL_PATH;
const COMIS_BENCH_DATA = process.env.COMIS_BENCH_DATA;
const ANSWER_PROVIDER = process.env.COMIS_BENCH_ANSWER_PROVIDER;
const ANSWER_MODEL = process.env.COMIS_BENCH_ANSWER_MODEL;
const ANSWER_API_KEY = process.env.COMIS_BENCH_ANSWER_API_KEY;
const JUDGE_PROVIDER = process.env.COMIS_BENCH_JUDGE_PROVIDER;
const JUDGE_MODEL = process.env.COMIS_BENCH_JUDGE_MODEL;
const JUDGE_API_KEY = process.env.COMIS_BENCH_JUDGE_API_KEY;
// Second judge lane for cross-judge (≥2 judges). Falls back to the answer lane's
// provider/key when only the model differs is NOT done — both must be explicit so a
// missing judge-2 honestly degrades to single-judge (spread not computed) rather than
// silently reusing judge-1.
const JUDGE2_PROVIDER = process.env.COMIS_BENCH_JUDGE2_PROVIDER;
const JUDGE2_MODEL = process.env.COMIS_BENCH_JUDGE2_MODEL;
const JUDGE2_API_KEY = process.env.COMIS_BENCH_JUDGE2_API_KEY;
// Cost-bounding sample knobs. LIMIT caps LongMemEval items; LOCOMO_LIMIT caps LoCoMo
// samples (each carries ~150 qa). QUESTION_CAP is the GLOBAL ceiling on graded
// questions (LME processed first, so the cap weights toward the harder, more
// discriminating LongMemEval set). Defaults keep an accidental run cheap.
const COMIS_BENCH_LIMIT = process.env.COMIS_BENCH_LIMIT;
const COMIS_BENCH_LOCOMO_LIMIT = process.env.COMIS_BENCH_LOCOMO_LIMIT;
const COMIS_BENCH_QUESTION_CAP = process.env.COMIS_BENCH_QUESTION_CAP;
// Skip the letta-fs full-haystack control (its per-question full-dump answer is the
// dominant cost — ~$0.40/q on a LongMemEval haystack). Off for the Comis-only
// capability-lift pass; ON for the competitor head-to-head where it is the anchor.
const COMIS_PROVE2_SKIP_CONTROL = process.env.COMIS_PROVE2_SKIP_CONTROL;
// Optional external competitor contexts: JSON `{ systemLabel: { questionId: context } }`.
// Produced by an out-of-repo runner (mem0 etc.); absent -> no competitor rows.
const COMIS_BENCH_CONTEXTS_FILE = process.env.COMIS_BENCH_CONTEXTS_FILE;
// Output manifest path (defaults under the data dir / a tmp dir).
const COMIS_PROVE2_REPORT_DIR = process.env.COMIS_PROVE2_REPORT_DIR;
// When set, write the EXACT sampled items (docs + questions) to this path so an
// out-of-repo competitor runner (mem0 etc.) ingests/queries byte-identical inputs and
// emits contexts keyed by the SAME questionId — the apples-to-apples contract.
const COMIS_PROVE2_EXPORT_SAMPLE = process.env.COMIS_PROVE2_EXPORT_SAMPLE;

const BENCH_NOW = 1_700_000_000_000;
const LLM_TIMEOUT_MS = 120_000;
const HARNESS_VERSION = "phase-114-prove2-v1";
const CONTROL_LABEL = "filesystem-baseline-full-context-control";
const BASELINE_LABEL = "comis-baseline";

const BENCH_SESSION_KEY: SessionKey = { tenantId: "default", userId: "user_a", channelId: "default" };

/**
 * The as-shipped recall defaults. usefulnessAlpha/forgetAlpha are set to their
 * NEUTRAL values (usefulness is centered on a 0.5 used-rate -> factor 1.0 with no
 * feedback signal; forgetAlpha 0 -> no decay), so this baseline is behaviourally
 * equivalent to the shipped 4-alpha config (qa-judge-harness.bench.test.ts) while staying
 * TOTAL when a capability overlay turns one of them on — no undefined alpha -> NaN.
 */
function baselineConfig(rerankEnabled: boolean): MemoryRecallConfig {
  return {
    maxResults: 5,
    minScore: 0.1,
    includeTrustLevels: ["system", "learned"],
    rerank: { enabled: rerankEnabled, maxCandidates: 40, minResults: 1, timeoutMs: 800 },
    scoring: {
      recencyAlpha: 0.2,
      temporalAlpha: 0.2,
      proofAlpha: 0.1,
      trustAlpha: 0.1,
      usefulnessAlpha: 0.1,
      forgetAlpha: 0.0,
    },
  };
}

/**
 * The Comis systems under test: the baseline + one overlay per capability that
 * has a RECALL-TIME knob. User-representation, social-modeling, memory-reasoning,
 * and dialectic are write-path / tool features with no recall-config toggle on
 * verbatim-ingested docs — their costed lift needs an enrichment-aware harness
 * (documented in the gap report; their keyless mechanical proofs stand). The
 * learn-rank online-tuning capability needs a learned tuned-alpha store the bench
 * never builds -> measuring it needs simulated episodes (deferred).
 */
interface ComisSystem {
  label: string;
  overlay: (base: MemoryRecallConfig) => MemoryRecallConfig;
}
const COMIS_SYSTEMS: ComisSystem[] = [
  { label: BASELINE_LABEL, overlay: (b) => b },
  {
    label: "comis-graphspread",
    overlay: (b) => ({
      ...b,
      lanes: { graphSpread: { enabled: true, weight: 2.0, maxDepth: 2, fanOut: 8 } },
    }),
  },
  {
    label: "comis-intent-reweight",
    overlay: (b) => ({
      ...b,
      feedback: { enabled: true },
      queryUnderstanding: { intentReweight: true, synonyms: false, temporalParse: false },
    }),
  },
  {
    label: "comis-forget",
    overlay: (b) => ({
      ...b,
      forget: { enabled: true },
      scoring: { ...b.scoring, forgetAlpha: 1.0 },
    }),
  },
];

function makeBenchConfig(dbPath: string, dims: number): MemoryConfig {
  return MemoryConfigSchema.parse({
    dbPath,
    walMode: false,
    recall: { embeddingModel: "local", embeddingDimensions: dims },
    compaction: { enabled: false, threshold: 1000, targetSize: 500 },
    retention: { maxAgeDays: 0 },
  });
}

function extractResponseText(response: { content?: unknown[] }): string {
  let text = "";
  if (response.content && Array.isArray(response.content)) {
    for (const part of response.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as Record<string, unknown>).type === "text" &&
        "text" in part
      ) {
        text += (part as Record<string, unknown>).text;
      }
    }
  }
  return text;
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
function mean(samples: number[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((s, x) => s + x, 0) / samples.length;
}

function readDataset(vendoredRelPath: string, operatorFileName: string): { parsed: unknown; raw: string } {
  if (COMIS_BENCH_DATA !== undefined && COMIS_BENCH_DATA.length > 0) {
    const base = resolve(COMIS_BENCH_DATA);
    const p = resolve(base, operatorFileName);
    if (!p.startsWith(base + sep) && p !== base) throw new Error("dataset path escapes COMIS_BENCH_DATA base");
    const raw = readFileSync(p, "utf-8");
    return { parsed: JSON.parse(raw), raw };
  }
  const raw = readFileSync(fileURLToPath(new URL(vendoredRelPath, import.meta.url)), "utf-8");
  return { parsed: JSON.parse(raw), raw };
}

/** One question's per-system context bundle (recall is LLM-free, run in beforeAll). */
interface QAItem {
  questionId: string;
  query: string;
  category: string;
  goldAnswer: string;
  /** systemLabel -> the rendered context for this question. */
  contexts: Map<string, string>;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Total coercion of the optional competitor contexts file into a typed map. */
function loadCompetitorContexts(): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  if (COMIS_BENCH_CONTEXTS_FILE === undefined || COMIS_BENCH_CONTEXTS_FILE.length === 0) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(COMIS_BENCH_CONTEXTS_FILE), "utf-8"));
  } catch {
    return out; // a missing/malformed file -> no competitor rows (never a crash).
  }
  if (parsed === null || typeof parsed !== "object") return out;
  for (const sys of Object.keys(parsed as Record<string, unknown>)) {
    const byQ = (parsed as Record<string, unknown>)[sys];
    if (byQ === null || typeof byQ !== "object") continue;
    const m = new Map<string, string>();
    for (const qid of Object.keys(byQ as Record<string, unknown>)) {
      const ctx = (byQ as Record<string, unknown>)[qid];
      if (typeof ctx === "string") m.set(qid, ctx);
    }
    out.set(sys, m);
  }
  return out;
}

describe.skipIf(!COMIS_BENCH)("PROVE2 — costed per-capability QA-lift + head-to-head (gated)", () => {
  const items: QAItem[] = [];
  /** Per-Comis-system recall-error count (recall returned err) — a config that can't
   *  wire cleanly on this bench (e.g. needs unbuilt graph/feedback state) is flagged
   *  honestly in the manifest rather than reported as a false regression. */
  const recallErrors = new Map<string, number>();
  /** First recall-error message per Comis system (for the deferred-unrunnable note). */
  const recallErrorMsg = new Map<string, string>();
  /** Comis systems excluded from grading because recall was unrunnable on this bench. */
  const deferredUnrunnable: Array<{ label: string; reason: string }> = [];
  /** All system labels in stable order (comis configs, control, then competitors). */
  const systemLabels: string[] = [];
  const competitorLabels: string[] = [];
  let reportDir = "";
  let datasetSha = "";
  let embeddingEnabled = false;
  let rerankEnabled = false;

  const haveAnswer = !!ANSWER_PROVIDER && !!ANSWER_MODEL && !!ANSWER_API_KEY;
  const haveJudge = !!JUDGE_PROVIDER && !!JUDGE_MODEL && !!JUDGE_API_KEY;
  const haveJudge2 = !!JUDGE2_PROVIDER && !!JUDGE2_MODEL && !!JUDGE2_API_KEY;

  beforeAll(async () => {
    const lmeRead = readDataset("./__fixtures__/longmemeval-sample.json", "longmemeval.json");
    const locomoRead = readDataset("./__fixtures__/locomo-sample.json", "locomo.json");
    const lmeResult = loadLongMemEvalDataset(lmeRead.parsed);
    const locomoResult = loadLocomoDataset(locomoRead.parsed);
    expect(lmeResult.ok && locomoResult.ok, "datasets parse").toBe(true);
    if (!lmeResult.ok || !locomoResult.ok) return;

    datasetSha = createHash("sha256").update(lmeRead.raw).update(locomoRead.raw).digest("hex");

    const lmeLimit = parseLimit(COMIS_BENCH_LIMIT, 20);
    const locomoLimit = parseLimit(COMIS_BENCH_LOCOMO_LIMIT, 1);
    const questionCap = parseLimit(COMIS_BENCH_QUESTION_CAP, 60);
    const skipControl = COMIS_PROVE2_SKIP_CONTROL !== undefined && COMIS_PROVE2_SKIP_CONTROL.length > 0;
    const lmeItems = lmeResult.value.slice(0, lmeLimit);
    const locomoItems = locomoResult.value.slice(0, locomoLimit);

    // Embedding + reranker (built ONCE; absent -> honest FTS-only).
    let embed: Awaited<ReturnType<typeof createEmbeddingProvider>> | undefined;
    let dims = 4;
    if (LLAMA_MODEL_PATH !== undefined && LLAMA_MODEL_PATH.length > 0) {
      embed = await createEmbeddingProvider({
        provider: "local",
        local: { modelUri: LLAMA_MODEL_PATH, modelsDir: "/tmp/comis-test-models" },
      });
      if (embed.ok) dims = embed.value.dimensions;
    }
    embeddingEnabled = !!embed?.ok;

    const dir = mkdtempSync(join(tmpdir(), "comis-prove2-"));
    reportDir = COMIS_PROVE2_REPORT_DIR ? resolve(COMIS_PROVE2_REPORT_DIR) : resolve(COMIS_BENCH_DATA && COMIS_BENCH_DATA.length > 0 ? COMIS_BENCH_DATA : dir);
    const reranker =
      LLAMA_RERANKER_MODEL_PATH !== undefined && LLAMA_RERANKER_MODEL_PATH.length > 0
        ? await createLocalRerankerProvider({ modelUri: LLAMA_RERANKER_MODEL_PATH, modelsDir: "/tmp/comis-test-models", threads: 8 })
        : undefined;
    const rerankerPort = reranker?.ok ? reranker.value : undefined;
    rerankEnabled = !!rerankerPort;

    const baseCfg = baselineConfig(rerankEnabled);
    const makeRecall = (port: SqliteMemoryAdapter, cfg: MemoryRecallConfig) =>
      createMemoryRecall(
        {
          memoryPort: port,
          clock: createFakeClock(BENCH_NOW),
          timers: createFakeTimers(BENCH_NOW),
          logger: createMockLogger(),
          ...(rerankerPort ? { reranker: rerankerPort } : {}),
        } as MemoryRecallDeps,
        cfg,
      );

    // Per-item ingest + per-system recall (all LLM-free, in beforeAll).
    const ingestDocs = async (docs: Array<{ content: string; createdAt: number }>, idx: number): Promise<SqliteMemoryAdapter> => {
      const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, `p2-${idx}.db`), dims), embed?.ok ? embed.value : undefined);
      for (const doc of docs) {
        const stored = await adapter.store({
          id: randomUUID(),
          tenantId: "default",
          agentId: "bench",
          userId: "user_a",
          content: doc.content,
          trustLevel: "learned",
          source: { who: "bench" },
          tags: ["bench"],
          createdAt: doc.createdAt,
        });
        expect(stored.ok, "doc stored").toBe(true);
      }
      return adapter;
    };

    const buildQuestion = async (
      adapter: SqliteMemoryAdapter,
      docs: Array<{ content: string; createdAt: number }>,
      q: { questionId: string; query: string; category: string; goldAnswer: string },
    ): Promise<void> => {
      if (items.length >= questionCap) return; // global cost ceiling on graded questions
      const contexts = new Map<string, string>();
      for (const sys of COMIS_SYSTEMS) {
        // A capability overlay may be incompatible with the bench's plain adapter
        // (e.g. a lane that needs a tripleStore / feedback store the verbatim-ingest
        // bench never builds). Catch the throw, record it, and degrade to an empty
        // context — the post-ingest prune then EXCLUDES a fully-unrunnable system from
        // grading (honest deferral, never a graded false-0%).
        let ranked: MemorySearchResult[] = [];
        try {
          const recall = makeRecall(adapter, sys.overlay(baseCfg));
          const r = await recall.recall(q.query, BENCH_SESSION_KEY);
          if (!r.ok) {
            recallErrors.set(sys.label, (recallErrors.get(sys.label) ?? 0) + 1);
            if (!recallErrorMsg.has(sys.label)) recallErrorMsg.set(sys.label, r.error.message);
          } else {
            ranked = r.value;
          }
        } catch (e) {
          recallErrors.set(sys.label, (recallErrors.get(sys.label) ?? 0) + 1);
          if (!recallErrorMsg.has(sys.label)) recallErrorMsg.set(sys.label, e instanceof Error ? e.message : String(e));
        }
        contexts.set(sys.label, formatAnswerContext(ranked));
      }
      // The letta-fs full-haystack control (no recall ranking) — gated by cost knob.
      if (!skipControl) contexts.set(CONTROL_LABEL, formatFilesystemContext(docs));
      items.push({ questionId: q.questionId, query: q.query, category: q.category, goldAnswer: q.goldAnswer, contexts });
    };

    let idx = 0;
    for (const lme of lmeItems) {
      const adapter = await ingestDocs(lme.docs, idx++);
      for (const q of lme.questions) {
        await buildQuestion(adapter, lme.docs, { questionId: q.questionId, query: q.query, category: q.category, goldAnswer: q.answer });
      }
      adapter.close();
    }
    for (const locomo of locomoItems) {
      const adapter = await ingestDocs(locomo.docs, idx++);
      for (const qa of locomo.qa) {
        await buildQuestion(adapter, locomo.docs, { questionId: qa.questionId, query: qa.query, category: "locomo", goldAnswer: qa.answer });
      }
      adapter.close();
    }
    await rerankerPort?.dispose?.();

    // EXPORT the exact sampled items (docs + the questions that passed the cap) so an
    // out-of-repo competitor runner ingests/queries byte-identical inputs (apples-to-apples).
    if (COMIS_PROVE2_EXPORT_SAMPLE !== undefined && COMIS_PROVE2_EXPORT_SAMPLE.length > 0) {
      const includedQ = new Set(items.map((i) => i.questionId));
      const exportItems: Array<{
        docs: Array<{ content: string; createdAt: number }>;
        questions: Array<{ questionId: string; query: string; goldAnswer: string; category: string }>;
      }> = [];
      for (const lme of lmeItems) {
        const qs = lme.questions
          .filter((q) => includedQ.has(q.questionId))
          .map((q) => ({ questionId: q.questionId, query: q.query, goldAnswer: q.answer, category: q.category }));
        if (qs.length > 0) exportItems.push({ docs: lme.docs, questions: qs });
      }
      for (const locomo of locomoItems) {
        const qs = locomo.qa
          .filter((qa) => includedQ.has(qa.questionId))
          .map((qa) => ({ questionId: qa.questionId, query: qa.query, goldAnswer: qa.answer, category: "locomo" }));
        if (qs.length > 0) exportItems.push({ docs: locomo.docs, questions: qs });
      }
      const exportPath = resolve(COMIS_PROVE2_EXPORT_SAMPLE);
      writeRegularFile({ path: exportPath, content: JSON.stringify(exportItems), confinedBaseDir: dirname(exportPath) });
    }

    // Merge optional competitor contexts onto the items (keyed by questionId).
    const competitors = loadCompetitorContexts();
    for (const [sys, byQ] of competitors) {
      competitorLabels.push(sys);
      for (const item of items) {
        const ctx = byQ.get(item.questionId);
        if (ctx !== undefined) item.contexts.set(sys, ctx);
      }
    }

    // PRUNE: exclude any Comis system whose recall errored on EVERY question — it is
    // fully unrunnable on this verbatim-ingest bench (its enabling derived state is not
    // built here). The baseline is always kept. A partially-erroring system is kept
    // (its valid questions still count). Excluded systems are reported under
    // capabilitiesDeferred with the recall error — honest deferral, never a graded 0%.
    const questionCount = items.length;
    const runnableComis = COMIS_SYSTEMS.map((s) => s.label).filter((label) => {
      if (label === BASELINE_LABEL) return true;
      const errs = recallErrors.get(label) ?? 0;
      if (questionCount > 0 && errs >= questionCount) {
        deferredUnrunnable.push({ label, reason: recallErrorMsg.get(label) ?? "recall unrunnable on this bench" });
        return false;
      }
      return true;
    });
    systemLabels.push(...runnableComis, ...(skipControl ? [] : [CONTROL_LABEL]), ...competitorLabels);
  }, 7_200_000);

  it.skipIf(!haveAnswer || !haveJudge)(
    "grades every system through the same answer + ≥2 judges and writes the cross-judged manifest",
    async () => {
      let answerModel: ReturnType<typeof getModel> | undefined;
      let judgeModel: ReturnType<typeof getModel> | undefined;
      let judge2Model: ReturnType<typeof getModel> | undefined;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic provider/model strings
        answerModel = getModel(ANSWER_PROVIDER as any, ANSWER_MODEL as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic provider/model strings
        judgeModel = getModel(JUDGE_PROVIDER as any, JUDGE_MODEL as any);
        if (haveJudge2) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic provider/model strings
          judge2Model = getModel(JUDGE2_PROVIDER as any, JUDGE2_MODEL as any);
        }
      } catch {
        /* unresolved -> the per-question guard marks every cell invalid (non-fatal). */
      }

      // ── one answer+judge round-trip with a per-(questionId, context) cache. The
      // cache key folds the context hash so a system whose recall is byte-identical
      // to another reuses the verdict at $0 (provably-0 lift). ──
      const answerCache = new Map<string, string>();
      const judgeCache = new Map<string, ReturnType<typeof parseJudgeVerdict>>();
      const judge2Cache = new Map<string, ReturnType<typeof parseJudgeVerdict>>();
      const answerTokens: number[] = [];
      const judgeTokens: number[] = [];
      let answerCostUsd = 0;
      let judgeCostUsd = 0;
      const answerLatencies: number[] = [];
      const judgeLatencies: number[] = [];

      const ctxKey = (item: QAItem, ctx: string): string =>
        `${item.questionId}:${createHash("sha256").update(ctx).digest("hex").slice(0, 16)}`;

      const getAnswer = async (item: QAItem, ctx: string): Promise<string> => {
        if (!answerModel) return "";
        const key = ctxKey(item, ctx);
        const cached = answerCache.get(key);
        if (cached !== undefined) return cached;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
        let text = "";
        const start = performance.now();
        try {
          const resp = await completeSimple(
            answerModel,
            { systemPrompt: ANSWER_SYSTEM_PROMPT, messages: [{ role: "user" as const, content: buildAnswerPrompt(item.query, ctx), timestamp: Date.now() }] },
            { apiKey: ANSWER_API_KEY, temperature: 0.0, maxTokens: 4096, signal: controller.signal },
          );
          text = extractResponseText(resp);
          answerTokens.push(resp.usage.totalTokens);
          answerCostUsd += resp.usage.cost.total;
        } finally {
          clearTimeout(timer);
        }
        answerLatencies.push(performance.now() - start);
        answerCache.set(key, text);
        return text;
      };

      const getVerdict = async (
        model: ReturnType<typeof getModel>,
        apiKey: string,
        cache: Map<string, ReturnType<typeof parseJudgeVerdict>>,
        item: QAItem,
        ctx: string,
        answer: string,
      ): Promise<ReturnType<typeof parseJudgeVerdict>> => {
        const key = ctxKey(item, ctx);
        if (cache.has(key)) return cache.get(key);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
        let text = "";
        const start = performance.now();
        try {
          const resp = await completeSimple(
            model,
            { messages: [{ role: "user" as const, content: buildJudgePrompt(item.category, item.query, item.goldAnswer, answer), timestamp: Date.now() }] },
            { apiKey, temperature: 0, maxTokens: 1024, signal: controller.signal },
          );
          text = extractResponseText(resp);
          judgeTokens.push(resp.usage.totalTokens);
          judgeCostUsd += resp.usage.cost.total;
        } finally {
          clearTimeout(timer);
        }
        judgeLatencies.push(performance.now() - start);
        const verdict = parseJudgeVerdict(text);
        cache.set(key, verdict);
        return verdict;
      };

      // Per-system verdict accumulators for each judge.
      const judge1Verdicts = new Map<string, CategorizedVerdict[]>();
      const judge2Verdicts = new Map<string, CategorizedVerdict[]>();
      for (const sys of systemLabels) {
        judge1Verdicts.set(sys, []);
        judge2Verdicts.set(sys, []);
      }

      for (const item of items) {
        for (const sys of systemLabels) {
          const ctx = item.contexts.get(sys);
          if (ctx === undefined) continue; // competitor with no context for this q
          if (!answerModel || !judgeModel) {
            judge1Verdicts.get(sys)!.push({ category: item.category, correct: false, invalid: true });
            continue;
          }
          const answer = await getAnswer(item, ctx);
          const v1 = await getVerdict(judgeModel, JUDGE_API_KEY as string, judgeCache, item, ctx, answer);
          judge1Verdicts.get(sys)!.push(
            v1 === undefined ? { category: item.category, correct: false, invalid: true } : { category: item.category, correct: v1.correct, invalid: false },
          );
          if (judge2Model) {
            const v2 = await getVerdict(judge2Model, JUDGE2_API_KEY as string, judge2Cache, item, ctx, answer);
            judge2Verdicts.get(sys)!.push(
              v2 === undefined ? { category: item.category, correct: false, invalid: true } : { category: item.category, correct: v2.correct, invalid: false },
            );
          }
        }
      }

      // Aggregate per system + significance vs baseline + cross-judge spread.
      const judge1Results = new Map<string, AccuracyResult>();
      const judge2Results = new Map<string, AccuracyResult>();
      for (const sys of systemLabels) {
        judge1Results.set(sys, aggregateAccuracy(judge1Verdicts.get(sys)!));
        if (judge2Model) judge2Results.set(sys, aggregateAccuracy(judge2Verdicts.get(sys)!));
      }
      const baseline = judge1Results.get(BASELINE_LABEL)!;

      // How many questions a system's recall context is BYTE-IDENTICAL to baseline's
      // (a Comis capability that is a no-op on this verbatim-ingest bench => count ==
      // questionCount => provably-0 lift, computed for free from the captured contexts).
      const identicalToBaseline = new Map<string, number>();
      for (const label of systemLabels) {
        let n = 0;
        for (const item of items) {
          const base = item.contexts.get(BASELINE_LABEL);
          const ctx = item.contexts.get(label);
          if (ctx !== undefined && base !== undefined && ctx === base) n++;
        }
        identicalToBaseline.set(label, n);
      }

      const systems = systemLabels.map((label) => {
        const j1 = judge1Results.get(label)!;
        const j2 = judge2Results.get(label);
        const ci = wilsonInterval(j1.correct, j1.validTotal);
        const vsBaseline = twoProportionTest({ correct: j1.correct, total: j1.validTotal }, { correct: baseline.correct, total: baseline.validTotal });
        const deltaPts = j1.overall - baseline.overall;
        const overallSpread = j2 ? Math.abs(j1.overall - j2.overall) : undefined;
        return {
          label,
          isControl: label === CONTROL_LABEL,
          isCompetitor: competitorLabels.includes(label),
          identicalToBaselineCount: identicalToBaseline.get(label) ?? 0,
          recallErrorCount: recallErrors.get(label) ?? 0,
          judge1: { overall: j1.overall, correct: j1.correct, validTotal: j1.validTotal, invalid: j1.invalid, perCategory: j1.perCategory },
          judge2: j2 ? { overall: j2.overall, correct: j2.correct, validTotal: j2.validTotal, invalid: j2.invalid } : undefined,
          ci,
          vsBaseline: { deltaPts, ...vsBaseline },
          crossJudge: j2 ? { overallSpread, surviving: overallSpread !== undefined && overallSpread <= 5.0, perCategory: computeSpreadFromResults(j1, judge2Results.get(label)!) } : undefined,
        };
      });

      const manifest = {
        harness: "prove2-qa-lift",
        harnessVersion: HARNESS_VERSION,
        generatedAt: Date.now(),
        keyless: false,
        dataset: { name: COMIS_BENCH_DATA ? "operator-haystack" : "vendored-fixture", questionCount: items.length, sha256: datasetSha },
        models: {
          answer: { provider: ANSWER_PROVIDER ?? "", modelId: ANSWER_MODEL ?? "" },
          judge1: { provider: JUDGE_PROVIDER ?? "", modelId: JUDGE_MODEL ?? "" },
          judge2: haveJudge2 ? { provider: JUDGE2_PROVIDER ?? "", modelId: JUDGE2_MODEL ?? "" } : null,
          embedding: embeddingEnabled ? { provider: "local", modelUri: LLAMA_MODEL_PATH } : { provider: "none" },
          reranker: rerankEnabled ? { provider: "local", modelUri: LLAMA_RERANKER_MODEL_PATH } : { provider: "none" },
        },
        defaults: { maxResults: 5, includeTrustLevels: ["system", "learned"], rerankEnabled, scoringAlphas: { recency: 0.2, temporal: 0.2, proof: 0.1, trust: 0.1 } },
        capabilitiesMeasured: COMIS_SYSTEMS.map((s) => s.label).filter((l) => l !== BASELINE_LABEL),
        capabilitiesDeferred: {
          note: "USER/SOCIAL/REASON/DIALECTIC are write-path/tool features with no recall-config toggle on verbatim-ingested docs; online rank-tuning needs a learned tuned-alpha store the standard protocol never builds; KG graphSpread needs a built tripleStore. Their costed QA-lift needs an enrichment-aware harness; their keyless mechanical proofs stand.",
          list: ["user-representation", "social-modeling", "memory-reasoning", "dialectic", "learn-rank-online-tuning"],
          unrunnableOnThisBench: deferredUnrunnable,
        },
        systems,
        cost: {
          answerTokensPerQuery: mean(answerTokens),
          judgeTokensPerQuery: mean(judgeTokens),
          answerCostUsd,
          judgeCostUsd,
          totalCostUsd: answerCostUsd + judgeCostUsd,
          uniqueAnswerCalls: answerCache.size,
          note: "context-hash verdict cache: a capability whose recall is byte-identical to another system reuses its verdict at $0.",
        },
        latency: {
          answerP50Ms: percentile(answerLatencies, 50),
          answerP95Ms: percentile(answerLatencies, 95),
          judgeP50Ms: percentile(judgeLatencies, 50),
          judgeP95Ms: percentile(judgeLatencies, 95),
        },
        coi: "answer=" + (ANSWER_PROVIDER ?? "") + "; judge1=" + (JUDGE_PROVIDER ?? "") + "; judge2=" + (JUDGE2_PROVIDER ?? "none") + ". Judge-2 shares the answer provider in the operator wiring (self-preference COI) — headline relies on judge-1 (LongMemEval reference) + the cross-judge spread, never judge-2 alone.",
        honestyProtocol: "≥2 judges; competitors re-run by us as pre-rendered contexts (never imported); N + Wilson CI + two-proportion significance; cost + latency; raw verdicts from fixed harness code. No 'beats X' headline before the spread survives.",
      };
      const manifestJson = JSON.stringify(manifest, null, 2);
      const writeResult = writeRegularFile({ path: join(reportDir, "prove2-report.json"), content: manifestJson, confinedBaseDir: reportDir });
      expect(writeResult.ok, "manifest written to the confined dir").toBe(true);

      // eslint-disable-next-line no-console -- gated bench harness reports its numbers
      console.log("BENCH PROVE2 systems:\n" + systems.map((s) => `  ${s.label}: j1=${s.judge1.overall.toFixed(1)}% (n=${s.judge1.validTotal})` + (s.judge2 ? ` j2=${s.judge2.overall.toFixed(1)}% spread=${s.crossJudge?.overallSpread?.toFixed(1)}` : "") + ` Δvsbase=${s.vsBaseline.deltaPts.toFixed(1)}pt p=${s.vsBaseline.pValue.toFixed(3)}`).join("\n"));
      // eslint-disable-next-line no-console -- cost line
      console.log("BENCH PROVE2 cost:", JSON.stringify(manifest.cost), "report:", join(reportDir, "prove2-report.json"));

      // STRUCTURAL invariants only (never a hard accuracy floor — machine/model dependent).
      for (const s of systems) {
        expect(s.judge1.overall).toBeGreaterThanOrEqual(0);
        expect(s.judge1.overall).toBeLessThanOrEqual(100);
      }
      // No credential substring may reach the committed-shape manifest.
      expect(manifestJson).not.toMatch(/apiKey|sk-|Bearer/);
    },
    7_200_000,
  );

  it("ingests a bounded sample (>=1 question, baseline context present)", () => {
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const item of items) expect(item.contexts.has(BASELINE_LABEL)).toBe(true);
    // eslint-disable-next-line no-console -- diagnostic: per-system recall health (keyless-visible)
    console.log(
      "PROVE2 recall health — errors/" + items.length + ":",
      JSON.stringify(Object.fromEntries(recallErrors)),
      "| deferred:",
      JSON.stringify(deferredUnrunnable),
      "| graded:",
      JSON.stringify(systemLabels),
    );
  });
});
