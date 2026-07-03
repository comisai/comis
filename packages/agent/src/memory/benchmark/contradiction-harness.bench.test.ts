// SPDX-License-Identifier: Apache-2.0
/**
 * Env-gated end-to-end TRUST-FIRST CONTRADICTION-CORRECTNESS harness --
 * the benchmark the KG gate consumes. It measures
 * whether a NEWER low-trust claim wrongly supersedes an OLDER high-trust fact at
 * recall time, exercising the SHIPPED trust-first behavior -- NOT new code:
 *   1. the recall TRUST-FILTER (`createMemoryRecall` step 5 hard-filters by
 *      `includeTrustLevels`; the shipped default `["system","learned"]` EXCLUDES
 *      the newer `external` contradiction -- the strongest trust-first outcome),
 *   2. `score.ts` `compareBoosted`: on an EQUAL-relevance tie the higher
 *      `trustWeight` wins (system 1.0 / learned 0.5 / external 0.0), so an OLDER
 *      high-trust memory out-ranks a NEWER low-trust one, and
 *   3. `score.ts` `trustAlpha` (nonzero, the shipped 0.1): the trust boost is LIVE
 *      so the tie-break is exercised when both pass the filter.
 *
 * THE INVARIANT: Comis is trust-FIRST, recency-SECOND -- a newer low-trust claim
 * NEVER wins. The CORRECT answer is the OLDER high-trust fact. The pure
 * {@link scoreContradiction} folds the per-pair verdicts into the
 * trust-first-correct RATE; a HIGH rate is good, a rate near
 * 0 is the failure the KG work must fix. The harness asserts only
 * STRUCTURAL invariants (`0 <= rate <= 100`, `validTotal === total - invalid`, the
 * secret-omission gate); the rate itself is a model-dependent MEASUREMENT.
 *
 * READ-TIME GUIDANCE BLOCK: prepending
 * `buildTemporalGuidanceBlock(...)` (the "higher-TRUST wins even if older"
 * instruction the production injector adds). That symbol is NOT on the
 * `@comis/agent` barrel (`grep -n buildTemporalGuidanceBlock packages/agent/src/index.ts`
 * -> absent; it lives in `rag/temporal-guidance.ts`, used internally by
 * `executor/prompt-assembly.ts`). This harness
 * therefore measures the trust-first property via the recall RANKING + trust
 * FILTER ONLY; the guidance-block property is unit-tested separately in
 * `rag/temporal-guidance.test.ts`.
 *
 * ARCHITECTURE CUT (the single escape hatch): this *.bench.test.ts MAY import
 * @comis/memory (a devDependency) -- the agent->memory cut excludes the `.test.ts`
 * suffix (source-rules.test.ts `excludeFileSuffixes: [".test.ts"]`). The pure
 * modules it consumes (contradiction-scorer.ts, suite-scenario.ts, suite-report.ts,
 * qa-*) import ONLY @comis/core types. Mirrors the blessed precedent
 * qa-judge-harness.bench.test.ts / poisoning-harness.bench.test.ts.
 *
 * DUPLICATED INGEST WIRING (intentional, a known anti-pattern): makeBenchConfig /
 * BENCH_SESSION_KEY / extractResponseText / resolveReportDir are DUPLICATED from
 * the QA/poisoning harnesses rather than factored into a shared non-`.test.ts`
 * helper -- a shared helper importing @comis/memory WOULD trip the cut.
 *
 * TWO-TIER GATE (mirrors poisoning-harness.bench.test.ts):
 * - UNGATED (default CI, `pnpm test`/`pnpm validate`): the pure scorer's
 *   correctness is unit-tested in contradiction-scorer.test.ts (the keyless-CI
 *   value). The gated describe (this file) is SKIPPED without COMIS_BENCH.
 * - GATED (this file): `COMIS_BENCH=1` enables the describe; the provider-backed
 *   `it` additionally nests behind `COMIS_BENCH_ANSWER_*` + `COMIS_BENCH_JUDGE_*`.
 *   Judge/answer model ids MUST be pi-ai-registry ids (gpt-4o / gpt-4.1;
 *   `claude-opus-4-8` entered the pi-ai registry in 0.78.0; under 0.75.3 it graded
 *   all-invalid as a same-provider answer+judge pair on one Anthropic key) -- an unresolved
 *   id makes every probe `invalid` (excluded), never a silent wrong number. The
 *   no-LLM structural witness lives inside the gated describe (it imports
 *   @comis/memory); it proves the SHIPPED trust filter without a provider.
 *
 * SECURITY:
 * - Bench store is a fresh `mkdtempSync` tmp DB (NEVER ~/.comis), `tenantId:
 *   "default"` / `agentId:"bench"` -- isolated from any live agent.
 *   Closed per pair.
 * - The contradiction fixture content is ingested as memory CONTENT only, never
 *   `eval`'d; the judge rubric is placed FIRST (buildJudgePrompt) so injected
 *   fixture content cannot masquerade as a judge instruction (accepted --
 *   the judge is advisory measurement only).
 * - The report is built via buildSuiteReport (structural secret omission) and
 *   written via the confined `writeRegularFile` (O_NOFOLLOW + EXCL + confinement,
 *   outside Pino's redaction net); the gated body asserts the serialized report
 *   carries none of `/apiKey|sk-|Bearer/`. The harness `console.log`s
 *   ONLY the rate, never a key or a model answer.
 *
 * @module
 */

import { describe, it, expect, beforeAll } from "vitest";
// GATED test-only imports (the agent->memory cut excludes *.test.ts).
import {
  SqliteMemoryAdapter,
  createEmbeddingProvider,
  createLocalRerankerProvider,
} from "@comis/memory";
// BARE production orchestrator (the live recall pipeline this harness drives).
import { createMemoryRecall, type MemoryRecallDeps } from "@comis/agent";
// VALUE completion entry point (fine in a .test.ts) -- the answer + judge LLM calls.
import { completeSimple, getModel } from "@earendil-works/pi-ai/compat";
// VALUE obs import (fine in a .test.ts) -- the confined report writer.
import { writeRegularFile } from "@comis/observability";
// RELATIVE constructed contradiction pairs -- no external corpus.
import { buildContradictionPairs } from "./suite-scenario.js";
// RELATIVE secret-free per-tier report builder.
import { buildSuiteReport } from "./suite-report.js";
// RELATIVE pure trust-first-correctness scorer.
import { scoreContradiction } from "./contradiction-scorer.js";
// RELATIVE existing pure logic (the answer/judge split + verdict parse + accuracy).
import { ANSWER_SYSTEM_PROMPT, formatAnswerContext, buildAnswerPrompt } from "./qa-answer-prompt.js";
import { buildJudgePrompt } from "./qa-judge-prompt.js";
import { parseJudgeVerdict } from "./qa-judge-parse.js";
import { aggregateAccuracy, type CategorizedVerdict } from "./qa-accuracy.js";
// Determinism helpers (test/support -- 5 segments up from packages/agent/src/memory/benchmark/).
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
// Core types (type-only).
import type { MemoryConfig, MemorySearchResult, SessionKey, TrustLevel } from "@comis/core";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ENV GATES -- read process.env ONLY at the test boundary (allowed in a .test.ts;
// the globals rule scopes to src/**). Names shared with the sibling QA harness.
const COMIS_BENCH = process.env.COMIS_BENCH; // enables the full ingest+recall+answer+judge run
const LLAMA_MODEL_PATH = process.env.LLAMA_MODEL_PATH; // optional vector lane (embeddings)
const LLAMA_RERANKER_MODEL_PATH = process.env.LLAMA_RERANKER_MODEL_PATH; // optional rerank lift
const COMIS_BENCH_DATA = process.env.COMIS_BENCH_DATA; // optional report-output base
// Answer/judge model lanes (the provider-backed run nests on these; absent -> it.skip).
const ANSWER_PROVIDER = process.env.COMIS_BENCH_ANSWER_PROVIDER;
const ANSWER_MODEL = process.env.COMIS_BENCH_ANSWER_MODEL;
const ANSWER_API_KEY = process.env.COMIS_BENCH_ANSWER_API_KEY;
const JUDGE_PROVIDER = process.env.COMIS_BENCH_JUDGE_PROVIDER;
const JUDGE_MODEL = process.env.COMIS_BENCH_JUDGE_MODEL;
const JUDGE_API_KEY = process.env.COMIS_BENCH_JUDGE_API_KEY;

/** Fixed epoch (matches the sibling harnesses' neutral clock). */
const BENCH_NOW = 1_700_000_000_000;
/** Per-LLM-call wall-clock deadline (a standard timer is allowed in a .test.ts). */
const LLM_TIMEOUT_MS = 120_000;
/** The trust-contradiction tier's harness version stamp (recorded in the report). */
const HARNESS_VERSION = "phase-99-v1";

/**
 * The bench store config (mirrors the sibling harnesses). `as MemoryConfig`:
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
 * The pi-ai content-block walk. DUPLICATED VERBATIM from
 * qa-judge-harness.bench.test.ts (there is no shared export; copying it is
 * consistent with that intentional duplication). Sums the `{type:"text"}` blocks.
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
 * Resolve the report output directory (DUPLICATED from the QA harness). The write
 * itself uses `writeRegularFile({ confinedBaseDir })`, so the O_NOFOLLOW + EXCL +
 * confinement guard applies regardless.
 */
function resolveReportDir(fallbackTmpDir: string): string {
  if (COMIS_BENCH_DATA !== undefined && COMIS_BENCH_DATA.length > 0) {
    return fallbackTmpDir; // operator base handled by the confined writer; keep tmp
  }
  return fallbackTmpDir;
}

/**
 * The fully-prepared, recalled contradiction pair captured ONCE in beforeAll: the
 * answerable context (recall with the shipped trust filter ON) + the CORRECT answer
 * (the OLDER high-trust fact) the judge grades against + the ranked trust levels
 * (the evidence: did the external get filtered, did the high-trust fact survive).
 */
interface PreparedPair {
  query: string;
  correctAnswerSubstring: string;
  context: string;
  rankedTrust: TrustLevel[];
  /** Whether the OLDER high-trust doc survived recall (the structural witness). */
  olderPresent: boolean;
}

describe.skipIf(!COMIS_BENCH)("trust-first contradiction correctness (gated)", () => {
  // Built ONCE in beforeAll (ingest + the LLM-free recall); the gated it body only
  // drives the answer + judge LLMs.
  const prepared: PreparedPair[] = [];
  // Resolved in beforeAll; the gated it body writes the report under it.
  let reportDir = "";
  let reportJson = "";

  // Provider-backed run nests on the answer/judge model env (the same lanes the QA harness reads).
  const haveAnswer = !!ANSWER_PROVIDER && !!ANSWER_MODEL && !!ANSWER_API_KEY;
  const haveJudge = !!JUDGE_PROVIDER && !!JUDGE_MODEL && !!JUDGE_API_KEY;

  beforeAll(async () => {
    // 1. PAIRS -- constructed; no external corpus, no download. Each pair
    //    has an OLDER high-trust fact + a NEWER low-trust contradicting claim; the
    //    CORRECT answer is the OLDER high-trust fact.
    const pairs = buildContradictionPairs();
    expect(pairs.length, "constructed contradiction pairs").toBeGreaterThanOrEqual(1);

    // 2. EMBEDDING PROVIDER -- built ONCE; only when LLAMA_MODEL_PATH is set, else
    //    honest FTS-only (dims=4, the vector lane does not contribute).
    let embed: Awaited<ReturnType<typeof createEmbeddingProvider>> | undefined;
    let dims = 4;
    if (LLAMA_MODEL_PATH !== undefined && LLAMA_MODEL_PATH.length > 0) {
      embed = await createEmbeddingProvider({
        provider: "local",
        local: { modelUri: LLAMA_MODEL_PATH, modelsDir: "/tmp/comis-test-models" },
      });
      if (embed.ok) dims = embed.value.dimensions;
    }

    // 3. SHARED reranker (built ONCE, reused across every per-pair store).
    const dir = mkdtempSync(join(tmpdir(), "comis-contra-bench-"));
    const reportDirResolved = resolveReportDir(dir);
    const reranker =
      LLAMA_RERANKER_MODEL_PATH !== undefined && LLAMA_RERANKER_MODEL_PATH.length > 0
        ? await createLocalRerankerProvider({
            modelUri: LLAMA_RERANKER_MODEL_PATH,
            modelsDir: "/tmp/comis-test-models",
            threads: 8,
          })
        : undefined;
    const rerankerPort = reranker?.ok ? reranker.value : undefined;

    // A fresh recall pipeline bound to ONE pair's store. `includeTrustLevels` is the
    // SHIPPED default (`["system","learned"]` -> the newer external contradiction is
    // EXCLUDED, the strongest trust-first outcome). `trustAlpha` is nonzero (the
    // shipped 0.1) so the `compareBoosted` tie-break is exercised for the
    // learned-vs-external pair if both ever pass the filter. All other alphas 0 to
    // isolate the trust signal (trust-FIRST).
    const makeRecall = (port: SqliteMemoryAdapter, includeTrustLevels: TrustLevel[]) =>
      createMemoryRecall(
        {
          memoryPort: port,
          clock: createFakeClock(BENCH_NOW),
          timers: createFakeTimers(BENCH_NOW),
          logger: createMockLogger(),
          ...(rerankerPort ? { reranker: rerankerPort } : {}),
        } as MemoryRecallDeps,
        {
          maxResults: 10,
          minScore: 0,
          includeTrustLevels,
          rerank: { enabled: !!rerankerPort, maxCandidates: 40, minResults: 1, timeoutMs: 800 },
          scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0.1 },
        },
      );

    // 4. INGEST + RECALL per pair, each in its OWN store. The OLDER high-trust fact
    //    at its trustLevel (system/learned) with its EARLIER createdAt; the NEWER
    //    low-trust claim at "external" with the LATER createdAt. (Ingest BOTH so the
    //    contradiction is REAL -- the trust-first behavior must keep the older
    //    high-trust fact on top despite the newer claim.) The correct answer rides
    //    the prepared channel only -- never a recall input.
    for (const [index, pair] of pairs.entries()) {
      const adapter = new SqliteMemoryAdapter(
        makeBenchConfig(join(dir, `contra-${index}.db`), dims),
        embed?.ok ? embed.value : undefined,
      );

      const storedOlder = await adapter.store({
        id: randomUUID(),
        tenantId: "default",
        agentId: "bench",
        userId: "user_a",
        content: pair.olderHighTrustDoc.content,
        trustLevel: pair.olderHighTrustDoc.trustLevel,
        source: { who: "bench" },
        tags: ["bench"],
        createdAt: pair.olderHighTrustDoc.createdAt,
      });
      expect(storedOlder.ok, "older high-trust doc stored").toBe(true);

      const storedNewer = await adapter.store({
        id: randomUUID(),
        tenantId: "default",
        agentId: "bench",
        userId: "user_a",
        content: pair.newerLowTrustDoc.content,
        trustLevel: pair.newerLowTrustDoc.trustLevel, // "external"
        source: { who: "bench" },
        tags: ["bench", "contradiction"],
        createdAt: pair.newerLowTrustDoc.createdAt,
      });
      expect(storedNewer.ok, "newer low-trust doc stored").toBe(true);

      // RECALL with the SHIPPED trust filter ON (external excluded). The guidance
      // block is NOT on the @comis/agent barrel, so the context is the ranked recall
      // ONLY (the trust-first property is measured via ranking + filter; the guidance
      // block is unit-tested in rag/temporal-guidance.test.ts).
      const recall = makeRecall(adapter, ["system", "learned"]);
      const r = await recall.recall(pair.query, BENCH_SESSION_KEY);
      const ranked: MemorySearchResult[] = r.ok ? r.value : [];

      prepared.push({
        query: pair.query,
        correctAnswerSubstring: pair.correctAnswerSubstring,
        context: formatAnswerContext(ranked),
        rankedTrust: ranked.map((m) => m.entry.trustLevel),
        olderPresent: ranked.some((m) => m.entry.content === pair.olderHighTrustDoc.content),
      });

      adapter.close();
    }

    // Stash the resolved report dir on the closure for the gated it body.
    reportDir = reportDirResolved;

    await rerankerPort?.dispose?.();
    // 2h hook timeout: ingest + the LLM-free recall for every pair runs HERE (the it
    // body only grades). The 2-min default trips on a non-trivial set before any
    // grading begins -- must match the raised it-body budget.
  }, 7_200_000);

  it.skipIf(!haveAnswer || !haveJudge)(
    "measures trust-first contradiction correctness (older high-trust fact wins)",
    async () => {
      // Resolve BOTH model lanes up front (the getModel guard). The judge/answer ids
      // MUST be pi-ai-registry ids (gpt-4o / gpt-4.1; claude-opus-4-8 is now a registry id as of pi 0.78.0 but graded all-invalid as a same-provider judge)
      // -- an unresolved id makes every probe invalid (excluded), never a
      // silent wrong number.
      let answerModel: ReturnType<typeof getModel> | undefined;
      let judgeModel: ReturnType<typeof getModel> | undefined;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic provider/modelId strings
        answerModel = getModel(ANSWER_PROVIDER as any, ANSWER_MODEL as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic provider/modelId strings
        judgeModel = getModel(JUDGE_PROVIDER as any, JUDGE_MODEL as any);
      } catch {
        // Unresolved at the lane level -> every probe invalid (non-fatal).
      }

      const verdicts: CategorizedVerdict[] = [];

      for (const p of prepared) {
        // An unresolved lane => INVALID (excluded), never wrong. Continue (non-fatal).
        if (!answerModel || !judgeModel) {
          verdicts.push({ category: "trust-first-contradiction", correct: false, invalid: true });
          continue;
        }

        // ANSWER LLM -- ANSWER_SYSTEM_PROMPT is the systemPrompt; buildAnswerPrompt is
        // the USER content only. The operator key is forwarded ONLY to pi-ai's apiKey
        // option (never stored/logged/reported; the secret-omission assertion proves it).
        const answerController = new AbortController();
        const answerTimer = setTimeout(() => answerController.abort(), LLM_TIMEOUT_MS);
        let modelAnswer = "";
        try {
          const answerResp = await completeSimple(
            answerModel,
            {
              systemPrompt: ANSWER_SYSTEM_PROMPT,
              messages: [
                { role: "user" as const, content: buildAnswerPrompt(p.query, p.context), timestamp: Date.now() },
              ],
            },
            { apiKey: ANSWER_API_KEY, temperature: 0.0, maxTokens: 4096, signal: answerController.signal },
          );
          modelAnswer = extractResponseText(answerResp);
        } finally {
          clearTimeout(answerTimer);
        }

        // JUDGE LLM -- a SEPARATE lane, temperature 0. Grade against the OLDER
        // high-trust fact (the knowledge-update rubric is the closest fit: the
        // response is correct iff it carries the required answer -- here the OLDER
        // high-trust fact, NOT the newer low-trust claim). Rubric-first.
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
                  content: buildJudgePrompt(
                    "knowledge-update",
                    p.query,
                    p.correctAnswerSubstring,
                    modelAnswer,
                  ),
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

        const verdict = parseJudgeVerdict(judgeText);
        verdicts.push(
          verdict === undefined
            ? { category: "trust-first-contradiction", correct: false, invalid: true }
            : { category: "trust-first-contradiction", correct: verdict.correct, invalid: false },
        );
      }

      // SCORE -- the trust-first-correct rate (the metric the KG gate reads);
      // the per-ability accuracy fold feeds the report row.
      const score = scoreContradiction(verdicts);
      const acc = aggregateAccuracy(verdicts);

      // REPORT -- the builder structurally omits any secret even if one were hung off
      // the input.
      const report = buildSuiteReport(
        {
          tier: "trust-contradiction",
          harnessVersion: HARNESS_VERSION,
          abilities: [{ ability: "older-high-trust-wins", result: acc }],
        },
        Date.now(),
      );
      reportJson = JSON.stringify(report, null, 2);

      // WRITE via the CONFINED writer -- O_NOFOLLOW + EXCL + confinement.
      const writeResult = writeRegularFile({
        path: join(reportDir, "trust-contradiction-report.json"),
        content: reportJson,
        confinedBaseDir: reportDir,
      });
      expect(writeResult.ok, "trust-contradiction report written to the confined dir").toBe(true);

      // Operator-visible number -- ONLY the rate, never a key or a model answer. A
      // HIGH trust-first-correct rate is good (the older high-trust fact won); a rate
      // near 0 is the failure the KG work must fix.
      // eslint-disable-next-line no-console -- gated bench harness reports its number (this is a .test.ts, not packages/cli)
      console.log("BENCH trust-first contradiction", JSON.stringify(score));
      // Trust-evidence (counts only -- no secret, no content): the ranked trust bands
      // per pair (did the external get filtered, did the high-trust fact survive).
      // eslint-disable-next-line no-console -- gated bench harness reports its trust evidence (this is a .test.ts, not packages/cli)
      console.log(
        "BENCH trust-first contradiction ranked-trust",
        JSON.stringify(prepared.map((p) => ({ rankedTrust: p.rankedTrust, olderPresent: p.olderPresent }))),
      );

      // STRUCTURAL invariants ONLY (never a hard rate floor -- the
      // number is machine/model-dependent).
      expect(score.trustFirstCorrectRate).toBeGreaterThanOrEqual(0);
      expect(score.trustFirstCorrectRate).toBeLessThanOrEqual(100);
      expect(score.validTotal).toBe(score.total - score.invalid);

      // The report must carry NO secret substring -- the ONLY allowed
      // occurrence of these tokens in this file is inside this negation.
      expect(reportJson).not.toMatch(/apiKey|sk-|Bearer/);
    },
    // 2h `it` budget -- the serial answer+judge loop can exceed the prior
    // ceiling; the per-call LLM_TIMEOUT_MS AbortController bounds any single hung call.
    7_200_000,
  );

  // NO-LLM structural witness of the SHIPPED trust-first behavior (inside the gated
  // describe because it reads `prepared`, which was built from the @comis/memory
  // store in beforeAll): with the shipped trust filter ["system","learned"], the
  // NEWER external (low-trust) contradiction is EXCLUDED entirely (the strongest
  // trust-first outcome), while the OLDER high-trust fact SURVIVES the recall. This
  // proves the trust filter + ladder do the right thing WITHOUT any provider. (The
  // keyless-CI value is the scorer unit test, which is ungated.)
  it("recall keeps the older high-trust fact and excludes the newer low-trust claim", () => {
    expect(prepared.length).toBeGreaterThanOrEqual(1);
    let witnessed = 0;
    for (const p of prepared) {
      // The newer external (low-trust) contradiction must NOT appear in the recall.
      expect(p.rankedTrust).not.toContain("external");
      // The older high-trust fact must survive recall.
      expect(p.olderPresent).toBe(true);
      witnessed += 1;
    }
    expect(witnessed).toBeGreaterThan(0);
  });
});
