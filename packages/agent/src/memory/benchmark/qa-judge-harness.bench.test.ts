// SPDX-License-Identifier: Apache-2.0
/**
 * Env-gated end-to-end QA + LLM-judge harness (BENCH-03 + BENCH-04) -- the phase's
 * apples-to-apples ACCURACY engine.
 *
 * It REUSES Phase 88's ingest + live-recall block verbatim (ingest the Plan-01
 * LongMemEval + LoCoMo documents ONCE into a real `SqliteMemoryAdapter` in
 * `beforeAll`, then run the live `createMemoryRecall` pipeline per question), and
 * ADDS the QA path after recall: format the recalled context (Plan 01
 * `formatAnswerContext`) -> drive it through an ANSWER LLM (`completeSimple`) ->
 * grade with a category-specific JUDGE LLM (`completeSimple`, temperature 0) ->
 * parse the verdict (Plan 02 `parseJudgeVerdict`) -> aggregate overall +
 * per-category accuracy (Plan 02 `aggregateAccuracy`) -> build the reproducible
 * BENCH-04 report (Plan 02 `buildBenchmarkReport`) -> write it via the confined
 * `writeRegularFile`. The number this prints is the v2.6 "better memory" claim
 * turned into an end-to-end QA-accuracy figure (NOT recall@k -- that is Phase 88).
 *
 * ARCHITECTURE CUT (the single escape hatch in this phase): this *.test.ts MAY
 * import the memory package (a devDependency); the agent->memory architecture cut
 * excludes .test.ts via findForbiddenImports' suffix filter (source-rules.test.ts,
 * excludeFileSuffixes: [".test.ts"]). The five pure Plan-01/02 modules
 * (qa-answer-prompt.ts, qa-judge-prompt.ts, qa-judge-parse.ts, qa-accuracy.ts,
 * qa-report.ts) + the loaders import ONLY @comis/core types -- this harness is the
 * single cut escape. Mirrors the blessed precedent retrieval-harness.bench.test.ts
 * (the Phase-88 sibling) and recall-eval.test.ts.
 *
 * DUPLICATED INGEST (intentional, RESEARCH A1 / Anti-Pattern): the ingest + recall
 * block is DUPLICATED VERBATIM from retrieval-harness.bench.test.ts rather than
 * factored into a shared `__support__` helper -- a non-`.test.ts` helper importing
 * @comis/memory WOULD trip the agent->memory cut (only the `.test.ts` suffix is the
 * escape). The two harnesses are independent gates; the block is small.
 *
 * TWO-TIER GATE (mirrors retrieval-harness.bench.test.ts):
 * - UNGATED (default CI, `pnpm test`/`pnpm validate`): the deterministic, structural
 *   correctness of the pure modules is unit-tested in Plan 01/02's co-located
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
 *   agent (T-89-03-05). No live daemon.
 * - The operator-provided `COMIS_BENCH_DATA` base is resolved and each dataset file
 *   path is asserted to live under it before any read (rejects `..`-escape;
 *   T-89-03-01, ASVS V5).
 * - Content comes from Plan 01's loaders, which strip `has_answer` (LongMemEval) and
 *   exclude the `qa` block (LoCoMo); gold (`answer`) lives only on the question-list
 *   channel, never ingested (T-89-03-02).
 * - The report records ONLY `{provider, modelId}` per role (the Plan-02 builder
 *   structurally omits keys); the report is written via the confined `writeRegularFile`
 *   (O_NOFOLLOW + EXCL + confinement; T-89-03-01). The harness `console.log`s only the
 *   structured `metrics`, never an api key or a model answer (T-89-03-03; Pitfall 3,6).
 * - The judge is advisory MEASUREMENT only -- prompt injection from dataset content
 *   into answer->judge is a documented, non-eliminable caveat (T-89-03-04, accept);
 *   the rubric is placed first (Plan-01 buildJudgePrompt) and content is never `eval`'d.
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
// BARE production orchestrator (the live recall pipeline reused from Phase 88).
import { createMemoryRecall, type MemoryRecallDeps } from "@comis/agent";
// VALUE completion entry point (fine in a .test.ts) -- the answer + judge LLM calls.
import { completeSimple, getModel } from "@earendil-works/pi-ai";
// VALUE obs import (fine in a .test.ts) -- the confined report writer.
import { writeRegularFile } from "@comis/observability";
// RELATIVE Plan 01 loaders (consumed verbatim; the loaders own field shapes).
import { loadLongMemEval } from "./longmemeval-loader.js";
import { loadLocomo } from "./locomo-loader.js";
// RELATIVE Plan 01 prompt builders (the system/user answer split + the per-category judge rubric).
import { ANSWER_SYSTEM_PROMPT, formatAnswerContext, buildAnswerPrompt } from "./qa-answer-prompt.js";
import { buildJudgePrompt } from "./qa-judge-prompt.js";
// RELATIVE Plan 02 pure logic (verdict parse -> accuracy -> reproducible report).
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
// the globals rule scopes to src/**). Names pinned by PATTERNS/RESEARCH Env-Gating Plan.
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

/** Fixed epoch (matches the Phase-88 sibling's neutral clock). */
const BENCH_NOW = 1_700_000_000_000;
/** Per-LLM-call wall-clock deadline (standard timer is allowed in a .test.ts). */
const LLM_TIMEOUT_MS = 120_000;
/** Harness version stamp -- a number is always attributable to fixed harness code. */
const HARNESS_VERSION = "phase-89-v1";

/**
 * The bench store config (mirrors the Phase-88 sibling). `as MemoryConfig`:
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
 * duplication, PATTERNS Correction #4). Sums the `{type:"text"}` blocks.
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
 * Read a vendored fixture (default) or an operator-placed dataset file under
 * `COMIS_BENCH_DATA`. When the operator base is set, resolve it and assert the
 * resolved file path stays under it BEFORE `readFileSync` -- this rejects a
 * `..`-escape on the operator path (T-89-03-01, ASVS V5). DUPLICATED VERBATIM
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
 * guard applies regardless (T-89-03-01).
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
  // The ingest-once structural witness (BENCH-03 SC-3): store-call count vs doc count.
  let storedCount = 0;
  let docCount = 0;
  // The live recall pipeline + the unified question list (built once in beforeAll).
  let recall: ReturnType<typeof createMemoryRecall> | undefined;
  let unifiedQuestions: Array<{ questionId: string; query: string; answer: string; category?: string }> = [];
  let reportDir = "";
  let datasetSha = "";
  let datasetItemCount = 0;
  let embeddingEnabled = false;

  // Provider-backed run nests on the answer/judge model env (RESEARCH Env-Gating Plan).
  const haveAnswer = !!ANSWER_PROVIDER && !!ANSWER_MODEL && !!ANSWER_API_KEY;
  const haveJudge = !!JUDGE_PROVIDER && !!JUDGE_MODEL && !!JUDGE_API_KEY;

  beforeAll(async () => {
    // 1. DATASETS -- tiny vendored fixtures by default; full operator haystack when set.
    //    Capture raw bytes for the reproducibility sha256 (computed HERE; Correction #5).
    const lmeRead = readDataset("./__fixtures__/longmemeval-sample.json", "longmemeval.json");
    const locomoRead = readDataset("./__fixtures__/locomo-sample.json", "locomo.json");
    const lmeResult = loadLongMemEval(lmeRead.parsed);
    expect(lmeResult.ok, "LongMemEval fixture parses").toBe(true);
    const locomoResult = loadLocomo(locomoRead.parsed);
    expect(locomoResult.ok, "LoCoMo fixture parses").toBe(true);
    if (!lmeResult.ok || !locomoResult.ok) return;
    const lme = lmeResult.value;
    const locomo = locomoResult.value;

    // Reproducibility hash over BOTH dataset byte streams (identity only; no secret).
    datasetSha = createHash("sha256").update(lmeRead.raw).update(locomoRead.raw).digest("hex");

    // 2. EMBEDDING PROVIDER -- only when LLAMA_MODEL_PATH is set; else honest FTS-only
    //    (dims=4, the vector lane does not contribute). DUPLICATED from the sibling.
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

    // 3. REAL STORE -- a fresh tmp DB (NOT ~/.comis). 2nd ctor arg present only when the
    //    embedding provider built -> the vector lane contributes; omitted -> FTS-only.
    const dir = mkdtempSync(join(tmpdir(), "comis-qa-bench-"));
    reportDir = resolveReportDir(dir);
    const adapter = new SqliteMemoryAdapter(
      makeBenchConfig(join(dir, "qa-bench.db"), dims),
      embed?.ok ? embed.value : undefined,
    );

    // 4. INGEST ONCE (DUPLICATED VERBATIM from retrieval-harness.bench.test.ts:199-236).
    //    A fresh `randomUUID()` per doc (NEVER the dataset ref). The gold answer/category
    //    are NOT touched here -- they ride the question-list channel only (anti-leak).
    docCount = lme.docs.length + locomo.docs.length;
    for (const doc of lme.docs) {
      const id = randomUUID();
      const stored = await adapter.store({
        id,
        tenantId: "default",
        agentId: "bench",
        userId: "user_a",
        content: doc.content,
        trustLevel: "learned",
        source: { who: "bench" },
        tags: ["bench"],
        createdAt: doc.createdAt,
      });
      expect(stored.ok, "LongMemEval doc stored").toBe(true);
      if (stored.ok) storedCount++;
    }
    for (const doc of locomo.docs) {
      const id = randomUUID();
      const stored = await adapter.store({
        id,
        tenantId: "default",
        agentId: "bench",
        userId: "user_a",
        content: doc.content,
        trustLevel: "learned",
        source: { who: "bench" },
        tags: ["bench"],
        createdAt: doc.createdAt,
      });
      expect(stored.ok, "LoCoMo doc stored").toBe(true);
      if (stored.ok) storedCount++;
    }

    // 5. LIVE RECALL -- createMemoryRecall with PRODUCTION-REPRESENTATIVE defaults
    //    (RESEARCH Open-Q2: trust/recency/temporal/proof alphas AS SHIPPED, NOT the
    //    Phase-88 all-zero -- QA accuracy must reflect the defaults being measured;
    //    they are recorded in the report's `defaults` block). Values verified against
    //    schema-agent-prompt.ts (maxResults 5, minScore 0.1,
    //    includeTrustLevels ["system","learned"], rerank default-OFF, scoring alphas
    //    0.2/0.2/0.1/0.1). The reranker lane lights up only when its GGUF is provided.
    const reranker =
      LLAMA_RERANKER_MODEL_PATH !== undefined && LLAMA_RERANKER_MODEL_PATH.length > 0
        ? await createLocalRerankerProvider({
            modelUri: LLAMA_RERANKER_MODEL_PATH,
            modelsDir: "/tmp/comis-test-models",
            threads: 8,
          })
        : undefined;
    const rerankerPort = reranker?.ok ? reranker.value : undefined;

    recall = createMemoryRecall(
      {
        memoryPort: adapter,
        clock: createFakeClock(BENCH_NOW),
        timers: createFakeTimers(BENCH_NOW),
        logger: createMockLogger(),
        ...(rerankerPort ? { reranker: rerankerPort } : {}),
      } as MemoryRecallDeps,
      {
        maxResults: 5,
        minScore: 0.1,
        includeTrustLevels: ["system", "learned"],
        rerank: {
          enabled: !!rerankerPort,
          maxCandidates: 40,
          minResults: 1,
          timeoutMs: 800,
        },
        // Production-representative alphas (schema defaults) -- recorded in the report.
        scoring: { recencyAlpha: 0.2, temporalAlpha: 0.2, proofAlpha: 0.1, trustAlpha: 0.1 },
      },
    );

    // 6. ONE unified question list. LongMemEval questions carry the GAP `category` +
    //    `answer`; LoCoMo qa carry `answer` but NO `category` (the W3 case handled in
    //    the it body). Both carry { questionId, query }, so reading q.query is uniform.
    unifiedQuestions = [...lme.questions, ...locomo.qa];
    datasetItemCount = unifiedQuestions.length;

    await rerankerPort?.dispose?.();
    // NOTE: adapter is intentionally NOT closed here -- the per-question recall in the
    // it.skipIf body reads from it. It is closed at the end of that body.
    // (When the provider-backed it is skipped, the tmp DB is reaped with the tmp dir.)
    (globalThis as Record<string, unknown>).__qaBenchAdapter = adapter;
  }, 120_000);

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

      for (const q of unifiedQuestions) {
        // category extraction (W3 -- LoCoMo qa[] has NO `category`, so `q.category` is
        // undefined for LoCoMo and buildJudgePrompt(category: string, ...) would TS-error):
        // LongMemEval qa carry the Plan-01 GAP `category`; LoCoMo fall to the literal
        // "locomo", an unknown key that routes to buildJudgePrompt's DEFAULT (LoCoMo) rubric.
        const category = 'category' in q ? (q as { category: string }).category : "locomo";
        const goldAnswer = q.answer;

        // RECALL (reuse -- NOT a new search path). Empty/failed -> [] (formatAnswerContext
        // emits its sentinel; the answer LLM is told "say you don't know").
        const recalled = recall ? await recall.recall(q.query, BENCH_SESSION_KEY) : undefined;
        const ranked: MemorySearchResult[] = recalled?.ok ? recalled.value : [];
        const context = formatAnswerContext(ranked);

        // If a model lane failed to resolve, this question is INVALID (excluded from
        // the denominator), NOT wrong. Continue (non-fatal).
        if (!answerModel || !judgeModel) {
          verdicts.push({ category, correct: false, invalid: true });
          continue;
        }

        // ANSWER LLM -- ANSWER_SYSTEM_PROMPT is the systemPrompt; buildAnswerPrompt is the
        // USER content only (the Info-4 split -- no preamble duplication). Low temperature.
        // The operator key is forwarded to pi-ai's typed option field (the only way to
        // authenticate the call -- exactly memory-review-job.ts:361) and is never stored,
        // logged, or placed in the report (T-89-03-03; the secret-omission assertion below
        // proves the report carries none of it).
        const answerController = new AbortController();
        const answerTimer = setTimeout(() => answerController.abort(), LLM_TIMEOUT_MS);
        let modelAnswer = "";
        try {
          const answerResp = await completeSimple(
            answerModel,
            {
              systemPrompt: ANSWER_SYSTEM_PROMPT,
              messages: [
                { role: "user" as const, content: buildAnswerPrompt(q.query, context), timestamp: Date.now() },
              ],
            },
            { apiKey: ANSWER_API_KEY, temperature: 0.0, maxTokens: 4096, signal: answerController.signal },
          );
          modelAnswer = extractResponseText(answerResp);
        } finally {
          clearTimeout(answerTimer);
        }

        // JUDGE LLM -- a SEPARATE model lane, temperature 0 (Pitfall 2 determinism). The
        // category-specific rubric is placed FIRST (prompt-injection ordering, Plan 01).
        const judgeController = new AbortController();
        const judgeTimer = setTimeout(() => judgeController.abort(), LLM_TIMEOUT_MS);
        let judgeText = "";
        try {
          const judgeResp = await completeSimple(
            judgeModel,
            {
              messages: [
                {
                  role: "user" as const,
                  content: buildJudgePrompt(category, q.query, goldAnswer, modelAnswer),
                  timestamp: Date.now(),
                },
              ],
            },
            { apiKey: JUDGE_API_KEY, temperature: 0, maxTokens: 1024, signal: judgeController.signal },
          );
          judgeText = extractResponseText(judgeResp);
        } finally {
          clearTimeout(judgeTimer);
        }

        // PARSE -- undefined => INVALID (excluded from the denominator), NEVER wrong.
        const verdict = parseJudgeVerdict(judgeText);
        verdicts.push(
          verdict === undefined
            ? { category, correct: false, invalid: true }
            : { category, correct: verdict.correct, invalid: false },
        );
      }

      // AGGREGATE -- overall + per-category, invalid-excluded denominator (Plan 02).
      metrics = aggregateAccuracy(verdicts);

      // REPORT -- record ONLY {provider,modelId} per role (Pitfall 6; the builder
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
        },
        metrics,
        Date.now(),
      );
      reportJson = JSON.stringify(report, null, 2);

      // WRITE the report via the CONFINED writer (T-89-03-01) -- O_NOFOLLOW + EXCL +
      // confinement; never a raw fs.writeFileSync.
      const writeResult = writeRegularFile({
        path: join(reportDir, "qa-report.json"),
        content: reportJson,
        confinedBaseDir: reportDir,
      });
      expect(writeResult.ok, "report written to the confined dir").toBe(true);

      // Operator-visible number (like the Phase-88 sibling's BENCH recall@k/MRR line).
      // ONLY the structured metrics -- never an api key or a model answer (Pitfall 3,6).
      // eslint-disable-next-line no-console -- gated bench harness reports its number (this is a .test.ts, not packages/cli)
      console.log(
        "BENCH QA accuracy",
        JSON.stringify(metrics),
        "embedding:",
        embeddingEnabled,
        "rerank:",
        !!LLAMA_RERANKER_MODEL_PATH,
      );

      // STRUCTURAL invariants ONLY (Anti-Pattern: never a hard accuracy floor -- the
      // number is machine/model-dependent).
      expect(metrics.overall).toBeGreaterThanOrEqual(0);
      expect(metrics.overall).toBeLessThanOrEqual(100);
      expect(metrics.validTotal).toBe(metrics.total - metrics.invalid);
      for (const c of Object.values(metrics.perCategory)) {
        expect(c.correct).toBeLessThanOrEqual(c.total - c.invalid);
        expect(c.accuracy).toBeGreaterThanOrEqual(0);
        expect(c.accuracy).toBeLessThanOrEqual(100);
      }
      // The report must carry NO secret substring (T-89-03-03) -- the ONLY allowed
      // occurrence of these tokens in this file is inside this negation.
      expect(reportJson).not.toMatch(/apiKey|sk-|Bearer/);

      // Close the bench store now that all per-question recalls are done.
      const adapter = (globalThis as Record<string, unknown>).__qaBenchAdapter as
        | { close?: () => void }
        | undefined;
      adapter?.close?.();
    },
    600_000,
  );

  // INGEST-ONCE structural witness (BENCH-03 SC-3): the store-call count equals the
  // doc count -- the harness ingested ONCE in beforeAll, never re-ingesting per
  // question (re-ingesting would inflate storedCount to docCount * questionCount).
  // This runs even when the provider-backed it is skipped (no model env needed).
  it("ingests Phase-88 docs ONCE (store count == doc count, not re-ingested per question)", () => {
    expect(docCount).toBeGreaterThanOrEqual(1);
    expect(storedCount).toBe(docCount);
  });
});
