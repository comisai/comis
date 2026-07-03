// SPDX-License-Identifier: Apache-2.0
/**
 * Env-gated end-to-end QA + LLM-judge harness -- the
 * apples-to-apples ACCURACY engine.
 *
 * It REUSES the retrieval harness's ingest + live-recall block verbatim (ingest the
 * LongMemEval + LoCoMo documents ONCE into a real `SqliteMemoryAdapter` in
 * `beforeAll`, then run the live `createMemoryRecall` pipeline per question), and
 * ADDS the QA path after recall: format the recalled context
 * (`formatAnswerContext`) -> drive it through an ANSWER LLM (`completeSimple`) ->
 * grade with a category-specific JUDGE LLM (`completeSimple`, temperature 0) ->
 * parse the verdict (`parseJudgeVerdict`) -> aggregate overall +
 * per-category accuracy (`aggregateAccuracy`) -> build the reproducible
 * report (`buildBenchmarkReport`) -> write it via the confined
 * `writeRegularFile`. The number this prints is the "better memory" claim
 * turned into an end-to-end QA-accuracy figure (NOT recall@k -- that is the
 * retrieval harness's job).
 *
 * ARCHITECTURE CUT (the single escape hatch): this *.test.ts MAY
 * import the memory package (a devDependency); the agent->memory architecture cut
 * excludes .test.ts via findForbiddenImports' suffix filter (source-rules.test.ts,
 * excludeFileSuffixes: [".test.ts"]). The five pure modules
 * (qa-answer-prompt.ts, qa-judge-prompt.ts, qa-judge-parse.ts, qa-accuracy.ts,
 * qa-report.ts) + the loaders import ONLY @comis/core types -- this harness is the
 * single cut escape. Mirrors the blessed precedent retrieval-harness.bench.test.ts
 * and recall-eval.test.ts.
 *
 * DUPLICATED INGEST (intentional): the ingest + recall
 * block is DUPLICATED VERBATIM from retrieval-harness.bench.test.ts rather than
 * factored into a shared `__support__` helper -- a non-`.test.ts` helper importing
 * @comis/memory WOULD trip the agent->memory cut (only the `.test.ts` suffix is the
 * escape). The two harnesses are independent gates; the block is small.
 *
 * TWO-TIER GATE (mirrors retrieval-harness.bench.test.ts):
 * - UNGATED (default CI, `pnpm test`/`pnpm validate`): the deterministic, structural
 *   correctness of the pure modules is unit-tested in the co-located
 *   *.test.ts over the tiny vendored fixtures + the fake-LLM stub. A default
 *   `pnpm test` run (no COMIS_BENCH) SKIPS this entire suite -- no provider call, no
 *   dataset / GGUF weight, no cost reaches CI.
 * - GATED (THIS file): `COMIS_BENCH=1` enables the suite; the provider-backed `it`
 *   additionally nests behind the answer/judge model env
 *   (`COMIS_BENCH_ANSWER_{PROVIDER,MODEL,API_KEY}` + `COMIS_BENCH_JUDGE_*`). The
 *   vector/rerank lanes nest behind `LLAMA_MODEL_PATH` / `LLAMA_RERANKER_MODEL_PATH`;
 *   absent both -> honest FTS-only retrieval. No auto-download of datasets OR models
 *   -- the operator places everything out-of-band.
 *
 * SECURITY:
 * - Bench store is a fresh `mkdtempSync` tmp DB (NEVER ~/.comis), `trustLevel:
 *   "learned"`, `tenantId:"default"` / `agentId:"bench"` -- isolated from any live
 *   agent. No live daemon.
 * - The operator-provided `COMIS_BENCH_DATA` base is resolved and each dataset file
 *   path is asserted to live under it before any read (rejects `..`-escape;
 *   ASVS V5).
 * - Content comes from the loaders, which strip `has_answer` (LongMemEval) and
 *   exclude the `qa` block (LoCoMo); gold (`answer`) lives only on the question-list
 *   channel, never ingested.
 * - The report records ONLY `{provider, modelId}` per role (the report builder
 *   structurally omits keys); the report is written via the confined `writeRegularFile`
 *   (O_NOFOLLOW + EXCL + confinement). The harness `console.log`s only the
 *   structured `metrics`, never an api key or a model answer.
 * - The judge is advisory MEASUREMENT only -- prompt injection from dataset content
 *   into answer->judge is a documented, non-eliminable caveat (accepted);
 *   the rubric is placed first (buildJudgePrompt) and content is never `eval`'d.
 *
 * @module
 */

import { describe, it, expect, beforeAll } from "vitest";
// GATED test-only imports (the agent->memory cut excludes *.test.ts). The
// local-embedding factory is reached via createEmbeddingProvider
// ({provider:"local",...}); plus createLocalRerankerProvider.
import {
  SqliteMemoryAdapter,
  createEmbeddingProvider,
  createLocalRerankerProvider,
} from "@comis/memory";
// BARE production orchestrator (the live recall pipeline reused from the retrieval harness).
import { createMemoryRecall, type MemoryRecallDeps } from "@comis/agent";
// VALUE completion entry point (fine in a .test.ts) -- the answer + judge LLM calls.
import { completeSimple, getModel } from "@earendil-works/pi-ai/compat";
// VALUE obs import (fine in a .test.ts) -- the confined report writer.
import { writeRegularFile } from "@comis/observability";
// RELATIVE loaders (consumed verbatim; the loaders own field shapes).
import { loadLongMemEvalDataset } from "./longmemeval-loader.js";
import { loadLocomoDataset } from "./locomo-loader.js";
// RELATIVE prompt builders (the system/user answer split + the per-category judge rubric).
import { ANSWER_SYSTEM_PROMPT, formatAnswerContext, buildAnswerPrompt } from "./qa-answer-prompt.js";
import { buildJudgePrompt } from "./qa-judge-prompt.js";
// RELATIVE control formatter — the Letta-style FULL-haystack dump (no
// recall ranking). Builds the parallel CONTROL answerables alongside the recall path.
import { formatFilesystemContext } from "./filesystem-baseline.js";
// RELATIVE pure logic (verdict parse -> accuracy -> reproducible report).
import { parseJudgeVerdict } from "./qa-judge-parse.js";
import { aggregateAccuracy, type CategorizedVerdict } from "./qa-accuracy.js";
import { buildBenchmarkReport } from "./qa-report.js";
// Determinism helpers (test/support -- 5 segments up from packages/agent/src/memory/benchmark/).
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
// Core types (type-only -- no @comis/core value import needed).
import type { MemoryConfig, MemorySearchResult, SessionKey } from "@comis/core";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

// ENV GATES -- read process.env ONLY at the test boundary (allowed in a .test.ts;
// the globals rule scopes to src/**). Names shared verbatim with the sibling harnesses.
const COMIS_BENCH = process.env.COMIS_BENCH; // the full ingest+recall+answer+judge run
const LLAMA_MODEL_PATH = process.env.LLAMA_MODEL_PATH; // vector lane (embeddings)
const LLAMA_RERANKER_MODEL_PATH = process.env.LLAMA_RERANKER_MODEL_PATH; // rerank lift
const COMIS_BENCH_DATA = process.env.COMIS_BENCH_DATA; // operator-placed full haystack dir (optional)
// Answer/judge model lanes (the provider-backed run nests on these; absent -> it.skip).
const ANSWER_PROVIDER = process.env.COMIS_BENCH_ANSWER_PROVIDER;
const ANSWER_MODEL = process.env.COMIS_BENCH_ANSWER_MODEL;
const ANSWER_API_KEY = process.env.COMIS_BENCH_ANSWER_API_KEY;
const JUDGE_PROVIDER = process.env.COMIS_BENCH_JUDGE_PROVIDER;
const JUDGE_MODEL = process.env.COMIS_BENCH_JUDGE_MODEL;
const JUDGE_API_KEY = process.env.COMIS_BENCH_JUDGE_API_KEY;
// PROVE2 cost-bounding knobs. COMIS_BENCH_LIMIT caps the per-dataset item
// count for a sampled, cost-bounded COSTED run (absent -> the full set, byte-identical
// to the prior behaviour). COMIS_BENCH_SKIP_CONTROL skips the expensive full-haystack
// letta-fs control answer+judge loop (the control roughly DOUBLES the LLM spend and
// dumps the entire haystack per call — not needed for a Comis-only sampling pass). Both
// are read ONLY at the .test.ts boundary (the globals rule scopes to src/**).
const COMIS_BENCH_LIMIT = process.env.COMIS_BENCH_LIMIT;
const COMIS_BENCH_SKIP_CONTROL = process.env.COMIS_BENCH_SKIP_CONTROL;

/** Fixed epoch (matches the retrieval-harness sibling's neutral clock). */
const BENCH_NOW = 1_700_000_000_000;
/** Per-LLM-call wall-clock deadline (standard timer is allowed in a .test.ts). */
const LLM_TIMEOUT_MS = 120_000;
/** Harness version stamp -- a number is always attributable to fixed harness code. */
const HARNESS_VERSION = "phase-89-v1";
/**
 * The control label — the explicit, immutable identifier under
 * which the Letta-style filesystem-baseline control row is recorded in the
 * manifest. Pinned as a constant so every run report cites it
 * verbatim and it can NEVER be confused with Comis's recall score.
 */
const CONTROL_LABEL = "filesystem-baseline-full-context-control";

/**
 * The bench store config (mirrors the retrieval-harness sibling). `as MemoryConfig`:
 * the adapter reads the fields it needs; `dims` = the probed embedding dimensions
 * (or 4 for the FTS-only honest fallback).
 */
function makeBenchConfig(dbPath: string, dims: number): MemoryConfig {
  return {
    dbPath,
    walMode: false,
    embeddingModel: "local",
    embeddingDimensions: dims,
    compaction: { enabled: false, threshold: 1000, targetSize: 500 },
    retention: { maxAgeDays: 0 },
  } as MemoryConfig;
}

/** The bench recall scope -- neutral placeholders, isolated from any live session. */
const BENCH_SESSION_KEY: SessionKey = {
  tenantId: "default",
  userId: "user_a",
  channelId: "default",
};

/**
 * The pi-ai content-block walk. DUPLICATED VERBATIM from memory-review-job.ts
 * (it is independently re-declared there AND in memory-consolidation-job.ts --
 * there is no shared export; copying it is consistent with that intentional
 * duplication). Sums the `{type:"text"}` blocks.
 */
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

/**
 * Inline percentile over a numeric sample (latency p50/p95). Sorts a COPY
 * ascending, index = ceil(p/100 * n) - 1 clamped to [0, n-1] (the nearest-rank
 * method). Empty sample -> 0. Kept LOCAL to this `.bench.test.ts` (NOT a new src
 * file) so it never becomes a 0%-coverage src module under the agent all:true
 * floor (the TDD hard rule). Inputs are real `performance.now()` deltas, never
 * the fake clock.
 */
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Mean of a numeric sample (tokens/query); empty -> 0. */
function mean(samples: number[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((sum, x) => sum + x, 0) / samples.length;
}

/**
 * Read a vendored fixture (default) or an operator-placed dataset file under
 * `COMIS_BENCH_DATA`. When the operator base is set, resolve it and assert the
 * resolved file path stays under it BEFORE `readFileSync` -- this rejects a
 * `..`-escape on the operator path (ASVS V5). DUPLICATED VERBATIM
 * from retrieval-harness.bench.test.ts. Returns BOTH the parsed value and the raw
 * bytes (the bytes feed the dataset sha256, computed here where the file is read;
 * qa-report.ts stays pure by accepting only the hash string).
 */
function readDataset(
  vendoredRelPath: string,
  operatorFileName: string,
): { parsed: unknown; raw: string } {
  if (COMIS_BENCH_DATA !== undefined && COMIS_BENCH_DATA.length > 0) {
    const base = resolve(COMIS_BENCH_DATA);
    const p = resolve(base, operatorFileName);
    if (!p.startsWith(base + sep) && p !== base) {
      throw new Error("dataset path escapes COMIS_BENCH_DATA base");
    }
    const raw = readFileSync(p, "utf-8");
    return { parsed: JSON.parse(raw), raw };
  }
  // ESM-correct fixture resolution (this package is "type": "module" so __dirname
  // is unavailable) -- mirror the sibling harness.
  const raw = readFileSync(fileURLToPath(new URL(vendoredRelPath, import.meta.url)), "utf-8");
  return { parsed: JSON.parse(raw), raw };
}

/**
 * Resolve the report output directory. When `COMIS_BENCH_DATA` is set, write
 * alongside the operator haystack (resolved, asserted to be the base itself --
 * no traversal); otherwise a fresh tmp dir. The actual write uses
 * `writeRegularFile({ confinedBaseDir })`, so the O_NOFOLLOW + EXCL + confinement
 * guard applies regardless.
 */
function resolveReportDir(fallbackTmpDir: string): string {
  if (COMIS_BENCH_DATA !== undefined && COMIS_BENCH_DATA.length > 0) {
    return resolve(COMIS_BENCH_DATA);
  }
  return fallbackTmpDir;
}

describe.skipIf(!COMIS_BENCH)("end-to-end QA + judge (gated)", () => {
  // The aggregated accuracy result + the report, computed once in beforeAll and
  // asserted structurally below (the it.skipIf body itself drives the LLM calls).
  let metrics: ReturnType<typeof aggregateAccuracy> | undefined;
  let reportJson = "";
  // The ingest-once structural witness: store-call count vs doc count.
  let storedCount = 0;
  let docCount = 0;
  // Per-question answerables, built ONCE in beforeAll: recall (LLM-free) runs THERE,
  // per item against its own store, and the formatted context is captured so the gated
  // it body only drives the answer + judge LLMs (never recall).
  let answerables: Array<{
    questionId: string;
    query: string;
    category: string;
    goldAnswer: string;
    context: string;
    /**
     * Per-question recall wall-clock latency (ms), measured around `recall.recall`
     * in `beforeAll` via real `performance.now()` (NOT the injected fake clock --
     * the fake clock is for recency determinism and reads constant). Carried on the
     * answerable so the gated it body can fold recall latency into the end-to-end
     * per-question total.
     */
    recallMs: number;
  }> = [];
  // The PARALLEL control answerables — the SAME questions, but
  // each `context` is the FULL-haystack filesystem dump (formatFilesystemContext over
  // ALL of the item's docs, no recall, no ranking) instead of the ranked top-5. Built
  // ONCE in beforeAll alongside `answerables`; the gated it body grades them with the
  // SAME answer+judge models and records the aggregate as a labelled CONTROL row —
  // NEVER as Comis's score. No `recallMs` (there is no recall step for the control).
  const controlAnswerables: Array<{
    questionId: string;
    query: string;
    category: string;
    goldAnswer: string;
    context: string;
  }> = [];
  let reportDir = "";
  let datasetSha = "";
  let datasetItemCount = 0;
  let embeddingEnabled = false;

  // Provider-backed run nests on the answer/judge model env (the two-tier gate above).
  const haveAnswer = !!ANSWER_PROVIDER && !!ANSWER_MODEL && !!ANSWER_API_KEY;
  const haveJudge = !!JUDGE_PROVIDER && !!JUDGE_MODEL && !!JUDGE_API_KEY;

  beforeAll(async () => {
    // 1. DATASETS -- FULL arrays (the public sets); a single-object vendored fixture is
    //    accepted as a one-element array. Capture raw bytes for the reproducibility
    //    sha256. Each item/sample is an INDEPENDENT (haystack, question) pair, ingested
    //    into ITS OWN store below (the standard protocol; merging haystacks across items
    //    would add cross-item distractor noise the benchmark never intended).
    const lmeRead = readDataset("./__fixtures__/longmemeval-sample.json", "longmemeval.json");
    const locomoRead = readDataset("./__fixtures__/locomo-sample.json", "locomo.json");
    const lmeResult = loadLongMemEvalDataset(lmeRead.parsed);
    expect(lmeResult.ok, "LongMemEval dataset parses").toBe(true);
    const locomoResult = loadLocomoDataset(locomoRead.parsed);
    expect(locomoResult.ok, "LoCoMo dataset parses").toBe(true);
    if (!lmeResult.ok || !locomoResult.ok) return;
    // PROVE2 cost-bounding: cap each dataset to the first N items when COMIS_BENCH_LIMIT
    // is set (deterministic prefix — the public sets ship in a fixed order, so the same
    // N is reproducible). Absent -> the full set (unchanged).
    const benchLimit =
      COMIS_BENCH_LIMIT !== undefined && COMIS_BENCH_LIMIT.length > 0
        ? Math.max(0, Number.parseInt(COMIS_BENCH_LIMIT, 10) || 0)
        : undefined;
    const lmeItems =
      benchLimit !== undefined ? lmeResult.value.slice(0, benchLimit) : lmeResult.value;
    const locomoItems =
      benchLimit !== undefined ? locomoResult.value.slice(0, benchLimit) : locomoResult.value;

    // Reproducibility hash over BOTH dataset byte streams (identity only; no secret).
    datasetSha = createHash("sha256").update(lmeRead.raw).update(locomoRead.raw).digest("hex");

    // 2. EMBEDDING PROVIDER -- built ONCE; only when LLAMA_MODEL_PATH is set, else honest
    //    FTS-only (dims=4, the vector lane does not contribute).
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

    // 3. SHARED reranker (built ONCE, reused across every per-item store); the report
    //    output dir is resolved once.
    const dir = mkdtempSync(join(tmpdir(), "comis-qa-bench-"));
    reportDir = resolveReportDir(dir);
    const reranker =
      LLAMA_RERANKER_MODEL_PATH !== undefined && LLAMA_RERANKER_MODEL_PATH.length > 0
        ? await createLocalRerankerProvider({
            modelUri: LLAMA_RERANKER_MODEL_PATH,
            modelsDir: "/tmp/comis-test-models",
            threads: 8,
          })
        : undefined;
    const rerankerPort = reranker?.ok ? reranker.value : undefined;

    // A fresh recall pipeline bound to ONE item's store, with PRODUCTION-REPRESENTATIVE
    // defaults (alphas AS SHIPPED -- QA accuracy must reflect the measured defaults;
    // recorded in the report's `defaults` block): maxResults 5 / minScore 0.1 /
    // includeTrustLevels ["system","learned"] / rerank on only when its GGUF is present.
    const makeRecall = (port: SqliteMemoryAdapter) =>
      createMemoryRecall(
        {
          memoryPort: port,
          clock: createFakeClock(BENCH_NOW),
          timers: createFakeTimers(BENCH_NOW),
          logger: createMockLogger(),
          ...(rerankerPort ? { reranker: rerankerPort } : {}),
        } as MemoryRecallDeps,
        {
          maxResults: 5,
          minScore: 0.1,
          includeTrustLevels: ["system", "learned"],
          rerank: { enabled: !!rerankerPort, maxCandidates: 40, minResults: 1, timeoutMs: 800 },
          scoring: { recencyAlpha: 0.2, temporalAlpha: 0.2, proofAlpha: 0.1, trustAlpha: 0.1 },
        },
      );

    // 4. INGEST + RECALL per item, each in its OWN store. A fresh randomUUID per doc
    //    (NEVER the dataset ref). The gold answer/category ride the answerable channel
    //    only -- NEVER ingested (anti-leak). Recall (LLM-free) runs HERE; the formatted
    //    context is captured so the gated it body only drives the answer + judge LLMs.
    let storeIdx = 0;
    const ingestItem = async (
      docs: Array<{ content: string; createdAt: number }>,
    ): Promise<SqliteMemoryAdapter> => {
      docCount += docs.length;
      const adapter = new SqliteMemoryAdapter(
        makeBenchConfig(join(dir, `qa-${storeIdx++}.db`), dims),
        embed?.ok ? embed.value : undefined,
      );
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
        if (stored.ok) storedCount++;
      }
      return adapter;
    };

    for (const lme of lmeItems) {
      const adapter = await ingestItem(lme.docs);
      const recall = makeRecall(adapter);
      // CONTROL context for THIS item: the full filesystem dump of ALL its docs,
      // built ONCE per item (the same dump answers every question of the item).
      const controlContext = formatFilesystemContext(lme.docs);
      for (const q of lme.questions) {
        // LATENCY (recall segment) -- real wall-clock around the LLM-free recall call
        // (performance.now(), NOT the fake clock).
        const recallStart = performance.now();
        const r = await recall.recall(q.query, BENCH_SESSION_KEY);
        const recallMs = performance.now() - recallStart;
        const ranked: MemorySearchResult[] = r.ok ? r.value : [];
        answerables.push({
          questionId: q.questionId,
          query: q.query,
          category: q.category, // LongMemEval question_type -> per-category judge rubric
          goldAnswer: q.answer,
          context: formatAnswerContext(ranked),
          recallMs,
        });
        // PARALLEL control answerable: SAME question, FULL-haystack dump context (no
        // recall ranking). Recorded as the labelled control row, never Comis's score.
        controlAnswerables.push({
          questionId: q.questionId,
          query: q.query,
          category: q.category,
          goldAnswer: q.answer,
          context: controlContext,
        });
      }
      adapter.close();
    }
    for (const locomo of locomoItems) {
      const adapter = await ingestItem(locomo.docs);
      const recall = makeRecall(adapter);
      const controlContext = formatFilesystemContext(locomo.docs);
      for (const qa of locomo.qa) {
        const recallStart = performance.now();
        const r = await recall.recall(qa.query, BENCH_SESSION_KEY);
        const recallMs = performance.now() - recallStart;
        const ranked: MemorySearchResult[] = r.ok ? r.value : [];
        answerables.push({
          questionId: qa.questionId,
          query: qa.query,
          category: "locomo", // LoCoMo qa carry NO category -> the DEFAULT (LoCoMo) rubric
          goldAnswer: qa.answer,
          context: formatAnswerContext(ranked),
          recallMs,
        });
        controlAnswerables.push({
          questionId: qa.questionId,
          query: qa.query,
          category: "locomo",
          goldAnswer: qa.answer,
          context: controlContext,
        });
      }
      adapter.close();
    }
    datasetItemCount = answerables.length;

    await rerankerPort?.dispose?.();
    // 2h hook timeout: full-set ingest + LLM-free recall for all items runs HERE in
    // beforeAll (the it body only grades). The 2-min default trips on the real 500-item
    // set before any grading begins — must match the raised it-body budget.
  }, 7_200_000);

  it.skipIf(!haveAnswer || !haveJudge)(
    "drives recall->answer->judge->aggregate->report",
    async () => {
      // Resolve BOTH model lanes up front (the getModel guard, memory-review-job.ts:331-341).
      // An unresolved model is a hard config error here (the env says it should resolve).
      let answerModel: ReturnType<typeof getModel> | undefined;
      let judgeModel: ReturnType<typeof getModel> | undefined;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic provider/modelId strings
        answerModel = getModel(ANSWER_PROVIDER as any, ANSWER_MODEL as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic provider/modelId strings
        judgeModel = getModel(JUDGE_PROVIDER as any, JUDGE_MODEL as any);
      } catch {
        // Unresolved at the lane level -> every question is invalid (non-fatal); the
        // aggregate then reports 0/validTotal. Leave the models undefined.
      }

      const verdicts: CategorizedVerdict[] = [];

      // Measurement accumulators (valid questions only -- a question whose
      // model lane failed to resolve is excluded from tokens + latency, exactly as it
      // is excluded from the accuracy denominator). Tokens via `usage.totalTokens`
      // (pi-ai returns it on every completeSimple); latency via real performance.now()
      // wall-clock deltas (NOT the fake clock).
      const answerTokens: number[] = [];
      const judgeTokens: number[] = [];
      const answerCosts: number[] = [];
      const judgeCosts: number[] = [];
      const recallLatencies: number[] = [];
      const answerLatencies: number[] = [];
      const judgeLatencies: number[] = [];
      const endToEndLatencies: number[] = [];

      for (const a of answerables) {
        // category + goldAnswer + the recalled `context` were all resolved per item in
        // beforeAll (recall is LLM-free and ran against each item's OWN store). Only the
        // answer + judge LLMs run in this gated body. `a.category` is the LongMemEval
        // question_type, or the literal "locomo" -> buildJudgePrompt's DEFAULT rubric.

        // If a model lane failed to resolve, this question is INVALID (excluded from
        // the denominator), NOT wrong. Continue (non-fatal).
        if (!answerModel || !judgeModel) {
          verdicts.push({ category: a.category, correct: false, invalid: true });
          continue;
        }

        // ANSWER LLM -- ANSWER_SYSTEM_PROMPT is the systemPrompt; buildAnswerPrompt is the
        // USER content only (the system/user split -- no preamble duplication). Low temperature.
        // The operator key is forwarded to pi-ai's typed option field (the only way to
        // authenticate the call -- exactly memory-review-job.ts:361) and is never stored,
        // logged, or placed in the report (the secret-omission assertion below
        // proves the report carries none of it).
        const answerController = new AbortController();
        const answerTimer = setTimeout(() => answerController.abort(), LLM_TIMEOUT_MS);
        let modelAnswer = "";
        // Per-question answer measurements (tokens via usage.totalTokens;
        // latency via real wall-clock around the completeSimple call).
        let answerTokensThis = 0;
        let answerCostThis = 0;
        const answerStart = performance.now();
        try {
          const answerResp = await completeSimple(
            answerModel,
            {
              systemPrompt: ANSWER_SYSTEM_PROMPT,
              messages: [
                { role: "user" as const, content: buildAnswerPrompt(a.query, a.context), timestamp: Date.now() },
              ],
            },
            { apiKey: ANSWER_API_KEY, temperature: 0.0, maxTokens: 4096, signal: answerController.signal },
          );
          modelAnswer = extractResponseText(answerResp);
          // usage is always present on a completeSimple AssistantMessage (pi-ai
          // types.d.ts) -- currently discarded by extractResponseText. Numbers only;
          // no secret reaches the report (the secret-omission assertion below proves it).
          answerTokensThis = answerResp.usage.totalTokens;
          answerCostThis = answerResp.usage.cost.total;
        } finally {
          clearTimeout(answerTimer);
        }
        const answerMs = performance.now() - answerStart;

        // JUDGE LLM -- a SEPARATE model lane, temperature 0 (for determinism). The
        // category-specific rubric is placed FIRST (prompt-injection ordering).
        const judgeController = new AbortController();
        const judgeTimer = setTimeout(() => judgeController.abort(), LLM_TIMEOUT_MS);
        let judgeText = "";
        let judgeTokensThis = 0;
        let judgeCostThis = 0;
        const judgeStart = performance.now();
        try {
          const judgeResp = await completeSimple(
            judgeModel,
            {
              messages: [
                {
                  role: "user" as const,
                  content: buildJudgePrompt(a.category, a.query, a.goldAnswer, modelAnswer),
                  timestamp: Date.now(),
                },
              ],
            },
            { apiKey: JUDGE_API_KEY, temperature: 0, maxTokens: 1024, signal: judgeController.signal },
          );
          judgeText = extractResponseText(judgeResp);
          judgeTokensThis = judgeResp.usage.totalTokens;
          judgeCostThis = judgeResp.usage.cost.total;
        } finally {
          clearTimeout(judgeTimer);
        }
        const judgeMs = performance.now() - judgeStart;

        // PARSE -- undefined => INVALID (excluded from the denominator), NEVER wrong.
        const verdict = parseJudgeVerdict(judgeText);
        const invalid = verdict === undefined;
        verdicts.push(
          invalid
            ? { category: a.category, correct: false, invalid: true }
            : { category: a.category, correct: verdict.correct, invalid: false },
        );

        // Record tokens + latency for VALID questions only (same exclusion
        // as the accuracy denominator). End-to-end = recall (from beforeAll) + answer +
        // judge for this question.
        if (!invalid) {
          answerTokens.push(answerTokensThis);
          judgeTokens.push(judgeTokensThis);
          answerCosts.push(answerCostThis);
          judgeCosts.push(judgeCostThis);
          recallLatencies.push(a.recallMs);
          answerLatencies.push(answerMs);
          judgeLatencies.push(judgeMs);
          endToEndLatencies.push(a.recallMs + answerMs + judgeMs);
        }
      }

      // AGGREGATE -- overall + per-category, invalid-excluded denominator.
      metrics = aggregateAccuracy(verdicts);

      // ─────────────────────────────────────────────────────────────────────
      // CONTROL: the Letta-style filesystem-baseline. Run the
      // SAME answer->judge->parse loop over `controlAnswerables` (full-haystack dump
      // context, NO recall), with the SAME models + temperature 0, and aggregate as a
      // SEPARATE `controlMetrics`. This roughly DOUBLES the answer+judge LLM calls for
      // the run (≈2040 -> ≈4080 each). It is recorded under an explicit CONTROL label,
      // NEVER as Comis's recall score (the headline `metrics`/`report.results` above is
      // unchanged). No tokens/latency capture here — the cost/latency blocks measure
      // Comis's recall path, not the control.
      const controlVerdicts: CategorizedVerdict[] = [];
      // PROVE2 cost-bounding: skip the expensive full-haystack control loop entirely when
      // COMIS_BENCH_SKIP_CONTROL is set (it ~doubles LLM spend AND dumps the whole haystack
      // per call). The control row then aggregates over zero verdicts (a clean no-op row).
      if (!COMIS_BENCH_SKIP_CONTROL)
        for (const a of controlAnswerables) {
        // A model lane that failed to resolve makes the question INVALID (excluded),
        // never wrong — same discipline as the recall loop above.
        if (!answerModel || !judgeModel) {
          controlVerdicts.push({ category: a.category, correct: false, invalid: true });
          continue;
        }

        // ANSWER LLM over the FULL-haystack control context (same call shape as the
        // recall path; the operator key is forwarded only to pi-ai's apiKey option,
        // never stored/logged/reported).
        const cAnswerController = new AbortController();
        const cAnswerTimer = setTimeout(() => cAnswerController.abort(), LLM_TIMEOUT_MS);
        let controlAnswer = "";
        try {
          const cAnswerResp = await completeSimple(
            answerModel,
            {
              systemPrompt: ANSWER_SYSTEM_PROMPT,
              messages: [
                { role: "user" as const, content: buildAnswerPrompt(a.query, a.context), timestamp: Date.now() },
              ],
            },
            { apiKey: ANSWER_API_KEY, temperature: 0.0, maxTokens: 4096, signal: cAnswerController.signal },
          );
          controlAnswer = extractResponseText(cAnswerResp);
        } finally {
          clearTimeout(cAnswerTimer);
        }

        // JUDGE LLM -- same separate judge model lane, temperature 0, rubric-first.
        const cJudgeController = new AbortController();
        const cJudgeTimer = setTimeout(() => cJudgeController.abort(), LLM_TIMEOUT_MS);
        let controlJudgeText = "";
        try {
          const cJudgeResp = await completeSimple(
            judgeModel,
            {
              messages: [
                {
                  role: "user" as const,
                  content: buildJudgePrompt(a.category, a.query, a.goldAnswer, controlAnswer),
                  timestamp: Date.now(),
                },
              ],
            },
            { apiKey: JUDGE_API_KEY, temperature: 0, maxTokens: 1024, signal: cJudgeController.signal },
          );
          controlJudgeText = extractResponseText(cJudgeResp);
        } finally {
          clearTimeout(cJudgeTimer);
        }

        const cVerdict = parseJudgeVerdict(controlJudgeText);
        controlVerdicts.push(
          cVerdict === undefined
            ? { category: a.category, correct: false, invalid: true }
            : { category: a.category, correct: cVerdict.correct, invalid: false },
        );
      }
      // The control's aggregate accuracy (the labelled control row's `results`).
      const controlMetrics = aggregateAccuracy(controlVerdicts);

      // COST + LATENCY blocks -- mean tokens/query (answer + judge, valid
      // questions only) and p50/p95 wall-clock latency (recall/answer/judge/end-to-end).
      // Pure numbers; threaded into the builder so qa-report.json carries them.
      const answerTokensPerQuery = mean(answerTokens);
      const judgeTokensPerQuery = mean(judgeTokens);
      const cost = {
        answerTokensPerQuery,
        judgeTokensPerQuery,
        totalTokensPerQuery: answerTokensPerQuery + judgeTokensPerQuery,
        answerCostUsd: answerCosts.reduce((sum, x) => sum + x, 0),
        judgeCostUsd: judgeCosts.reduce((sum, x) => sum + x, 0),
      };
      const latency = {
        recallP50Ms: percentile(recallLatencies, 50),
        recallP95Ms: percentile(recallLatencies, 95),
        answerP50Ms: percentile(answerLatencies, 50),
        answerP95Ms: percentile(answerLatencies, 95),
        judgeP50Ms: percentile(judgeLatencies, 50),
        judgeP95Ms: percentile(judgeLatencies, 95),
        endToEndP50Ms: percentile(endToEndLatencies, 50),
        endToEndP95Ms: percentile(endToEndLatencies, 95),
      };

      // REPORT -- record ONLY {provider,modelId} per role (the builder
      // structurally omits any api key even if one were passed). Dataset sha256 from
      // beforeAll. Production-representative defaults recorded for reproducibility.
      const report = buildBenchmarkReport(
        {
          benchmark: "combined",
          models: {
            // The extractor that BUILT the store: for the bench ingest there is no LLM
            // extraction step (docs are ingested verbatim), so it is recorded as "none".
            extraction: { provider: "none", modelId: "none" },
            answer: { provider: ANSWER_PROVIDER ?? "", modelId: ANSWER_MODEL ?? "" },
            judge: { provider: JUDGE_PROVIDER ?? "", modelId: JUDGE_MODEL ?? "" },
            embedding: embeddingEnabled
              ? { provider: "local", modelUri: LLAMA_MODEL_PATH }
              : { provider: "none" },
            reranker:
              LLAMA_RERANKER_MODEL_PATH !== undefined && LLAMA_RERANKER_MODEL_PATH.length > 0
                ? { provider: "local", modelUri: LLAMA_RERANKER_MODEL_PATH }
                : { provider: "none" },
          },
          dataset: {
            name: COMIS_BENCH_DATA ? "operator-haystack" : "vendored-fixture",
            itemCount: datasetItemCount,
            source: COMIS_BENCH_DATA ? "operator" : "vendored-fixture",
            sha256: datasetSha,
          },
          defaults: {
            maxResults: 5,
            includeTrustLevels: ["system", "learned"],
            rerankEnabled:
              LLAMA_RERANKER_MODEL_PATH !== undefined && LLAMA_RERANKER_MODEL_PATH.length > 0,
            scoringAlphas: { recency: 0.2, temporal: 0.2, proof: 0.1, trust: 0.1 },
          },
          harnessVersion: HARNESS_VERSION,
          cost: cost,
          latency: latency,
          // CONTROL row: the Letta-style filesystem-baseline,
          // recorded under an explicit label so it is impossible to mistake for Comis's
          // score. The headline `report.results` stays the recall accuracy (`metrics`).
          control: { label: CONTROL_LABEL, results: controlMetrics },
        },
        metrics,
        Date.now(),
      );
      reportJson = JSON.stringify(report, null, 2);

      // WRITE the report via the CONFINED writer -- O_NOFOLLOW + EXCL +
      // confinement; never a raw fs.writeFileSync.
      const writeResult = writeRegularFile({
        path: join(reportDir, "qa-report.json"),
        content: reportJson,
        confinedBaseDir: reportDir,
      });
      expect(writeResult.ok, "report written to the confined dir").toBe(true);

      // Operator-visible number (like the retrieval-harness sibling's BENCH recall@k/MRR line).
      // ONLY the structured metrics -- never an api key or a model answer.
      // eslint-disable-next-line no-console -- gated bench harness reports its number (this is a .test.ts, not packages/cli)
      console.log(
        "BENCH QA accuracy",
        JSON.stringify(metrics),
        "embedding:",
        embeddingEnabled,
        "rerank:",
        !!LLAMA_RERANKER_MODEL_PATH,
      );
      // CONTROL line -- printed SEPARATELY under an explicit
      // "CONTROL (filesystem baseline, NOT Comis)" prefix so the run output can NEVER
      // conflate the full-haystack control with Comis's recall score.
      // eslint-disable-next-line no-console -- gated bench harness reports the control number alongside Comis's
      console.log(
        "BENCH QA accuracy — CONTROL (filesystem baseline, NOT Comis):",
        CONTROL_LABEL,
        JSON.stringify(controlMetrics),
      );

      // STRUCTURAL invariants ONLY (never a hard accuracy floor -- the
      // number is machine/model-dependent).
      expect(metrics.overall).toBeGreaterThanOrEqual(0);
      expect(metrics.overall).toBeLessThanOrEqual(100);
      expect(metrics.validTotal).toBe(metrics.total - metrics.invalid);
      for (const c of Object.values(metrics.perCategory)) {
        expect(c.correct).toBeLessThanOrEqual(c.total - c.invalid);
        expect(c.accuracy).toBeGreaterThanOrEqual(0);
        expect(c.accuracy).toBeLessThanOrEqual(100);
      }
      // The report must carry NO secret substring -- the ONLY allowed
      // occurrence of these tokens in this file is inside this negation.
      expect(reportJson).not.toMatch(/apiKey|sk-|Bearer/);
      // (Per-item bench stores were already closed in beforeAll; nothing to close here.)
    },
    // The full ~4080-call run (≈2040 answer + ≈2040
    // judge LLM round-trips, serial) exceeds the prior ten-minute Vitest `it`
    // ceiling. Raise to a 2h bound sized for the full set: ≈2040 calls × up to 120s
    // each (worst case) still fits, while the per-call LLM_TIMEOUT_MS=120_000
    // AbortController (above) keeps bounding any single hung call — only the aggregate
    // serial loop is bounded by this ceiling. (Sharding by dataset across separate
    // retrieval/qa invocations would also work; raising this `it` ceiling
    // is the minimal change that lets one `pnpm bench:memory qa` complete.)
    7_200_000,
  );

  // INGEST-ONCE structural witness: the store-call count equals the
  // doc count -- the harness ingested ONCE in beforeAll, never re-ingesting per
  // question (re-ingesting would inflate storedCount to docCount * questionCount).
  // This runs even when the provider-backed it is skipped (no model env needed).
  it("ingests docs ONCE (store count == doc count, not re-ingested per question)", () => {
    expect(docCount).toBeGreaterThanOrEqual(1);
    expect(storedCount).toBe(docCount);
  });
});
