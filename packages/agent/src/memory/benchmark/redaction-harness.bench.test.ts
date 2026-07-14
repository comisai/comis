// SPDX-License-Identifier: Apache-2.0
/**
 * Env-gated PRIVACY / REDACTION leak-rate harness -- measures whether
 * a planted SYNTHETIC secret/PII can reach Comis's RECALLED context, exercising
 * the SHIPPED redaction firewall -- NOT new security code:
 *   1. write-time `validateMemoryWrite` (the shipped block at the write boundary:
 *      `critical` when `scrubSecretsFromText` would redact the content -> SKIP the
 *      store; the secret never enters memory at all), and
 *   2. recall-time `scrubSecretsFromText` over the recalled context (the keystone
 *      egress scrubber -- the second net that redacts any secret-shaped value that
 *      slipped through to recall).
 *
 * THE LEAK DETECTOR (the measurement -- a deterministic string check, so NO
 * answer/judge LLM is needed; gate on `COMIS_BENCH` only, like
 * retrieval-harness.bench.test.ts): a probe LEAKED iff a planted secret reaches
 * the (post-mitigation, for the ON arm) recalled context. Detected via the UNION
 * of: `scanForSecrets(context).length >= 1` (catches the secret-SHAPED API key),
 * `looksLikeSecretValue` over the recalled snippets, AND a direct substring check
 * that the EXACT planted secret string is present (catches the PII -- email/phone
 * -- that is NOT secret-shaped but is still a planted-value leak).
 *
 * THE ABLATION (the evidence the mitigations drive leaks
 * down): every haystack is recalled into TWO stores -- mitigations ON (the
 * write-time block applied at ingest + the recall-time scrub applied to the
 * recalled context) and mitigations OFF (every doc ingested verbatim, no scrub).
 * The gated body asserts `scoreOn.leakRate <= scoreOff.leakRate` (DIRECTIONAL --
 * the shipped block + scrub drive the leak-rate DOWN; never a hard floor).
 *
 * THE NUMBER: leak-rate = leaked-probes / valid-probes (LOWER is better;
 * scoreRedaction). The harness asserts only STRUCTURAL invariants
 * (`0 <= leakRate <= 100`, `validTotal === total - invalid`) plus the ON<=OFF
 * ablation and the secret-omission gate.
 *
 * CRITICAL (the secret-omission threat): the committed `redaction-report.json` records
 * ONLY the aggregate leak-rate + counts -- NEVER a `plantedSecrets` string, NEVER
 * a leaked snippet. The report is built via `buildSuiteReport` (which structurally
 * carries only numeric AccuracyResult fields) and the gated body asserts the
 * serialized report matches NONE of `/apiKey|sk-|Bearer/` AND -- a second,
 * redaction-specific omission sweep -- contains no `plantedSecrets[i]` substring.
 * The `console.log` emits ONLY the two leak-rate numbers + the blocked-at-write
 * count, never a secret.
 *
 * ARCHITECTURE CUT (the single escape hatch): this *.bench.test.ts MAY import
 * @comis/memory (a devDependency) -- the agent->memory cut excludes the `.test.ts`
 * suffix (source-rules.test.ts `excludeFileSuffixes: [".test.ts"]`). The pure
 * modules it consumes (redaction-scorer.ts, suite-scenario.ts, suite-report.ts,
 * qa-answer-prompt.ts) import ONLY @comis/core types (or nothing). Mirrors the
 * blessed precedent retrieval-harness.bench.test.ts / poisoning-harness.bench.test.ts.
 *
 * DUPLICATED INGEST WIRING (intentional, a documented anti-pattern): makeBenchConfig /
 * BENCH_SESSION_KEY / resolveReportDir are DUPLICATED from the sibling harnesses
 * rather than factored into a shared non-`.test.ts` helper -- a shared helper
 * importing @comis/memory WOULD trip the cut. The harnesses are independent gates.
 *
 * SECURITY:
 * - Both bench stores are fresh `mkdtempSync` tmp DBs (NEVER ~/.comis), `tenantId:
 *   "default"` / `agentId:"bench"` -- isolated from any live agent.
 *   Closed after the run.
 * - The planted secrets are SYNTHETIC / obviously-fake (`sk-FAKE…` family, a
 *   `*.example.test` reserved-domain email, an all-zero phone) -- a
 *   leaked fixture discloses nothing real -- but the report STILL omits them.
 * - Content is ingested as memory VALUES only, never an object key;
 *   scanForSecrets walks defensively.
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
// VALUE core imports -- the SHIPPED redaction firewall (the defenses under test):
// the write-time validator, the recall-time scrubber, and the leak detector.
import {
  validateMemoryWrite,
  scrubSecretsFromText,
  scanForSecrets,
  looksLikeSecretValue,
} from "@comis/core";
// VALUE obs import (fine in a .test.ts) -- the confined report writer.
import { writeRegularFile } from "@comis/observability";
// RELATIVE constructed redaction haystack -- synthetic secrets, no corpus.
import { buildRedactionHaystack } from "./suite-scenario.js";
// RELATIVE secret-free per-tier report builder.
import { buildSuiteReport } from "./suite-report.js";
// RELATIVE pure leak-rate scorer (takes boolean flags only).
import { scoreRedaction, type RedactionProbe } from "./redaction-scorer.js";
// RELATIVE existing pure context formatter (the recalled-context rendering).
import { formatAnswerContext } from "./qa-answer-prompt.js";
// Determinism helpers (test/support -- 5 segments up from packages/agent/src/memory/benchmark/).
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
// Core types (type-only).
import type { MemoryConfig, MemorySearchResult, SessionKey, TrustLevel } from "@comis/core";
import { MemoryConfigSchema } from "@comis/core";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ENV GATES -- read process.env ONLY at the test boundary (allowed in a .test.ts;
// the globals rule scopes to src/**). Leak detection is a deterministic string
// check, so gate on COMIS_BENCH ONLY -- no answer/judge model env (like retrieval).
const COMIS_BENCH = process.env.COMIS_BENCH; // enables the full ingest + ablated recall + leak-detect run
const LLAMA_MODEL_PATH = process.env.LLAMA_MODEL_PATH; // optional vector lane (embeddings)
const LLAMA_RERANKER_MODEL_PATH = process.env.LLAMA_RERANKER_MODEL_PATH; // optional rerank lift
const COMIS_BENCH_DATA = process.env.COMIS_BENCH_DATA; // optional report-output base

/** Fixed epoch (matches the sibling harnesses' neutral clock). */
const BENCH_NOW = 1_700_000_000_000;
/** The redaction tier's harness version stamp (recorded in the report). */
const HARNESS_VERSION = "phase-99-v1";

/**
 * The bench store config (mirrors the sibling harnesses). Built through
 * `MemoryConfigSchema.parse` so schema drift fails loudly here instead of at
 * adapter runtime; `dims` = the probed embedding dimensions (or 4 for the
 * FTS-only honest fallback).
 */
function makeBenchConfig(dbPath: string, dims: number): MemoryConfig {
  return MemoryConfigSchema.parse({
    dbPath,
    walMode: false,
    recall: { embeddingModel: "local", embeddingDimensions: dims },
    compaction: { enabled: false, threshold: 1000, targetSize: 500 },
    retention: { maxAgeDays: 0 },
  });
}

/** The bench recall scope -- neutral placeholders, isolated from any live session. */
const BENCH_SESSION_KEY: SessionKey = {
  tenantId: "default",
  userId: "user_a",
  channelId: "default",
};

/**
 * Resolve the report output directory (DUPLICATED from the sibling harnesses).
 * The write itself uses `writeRegularFile({ confinedBaseDir })`, so O_NOFOLLOW +
 * EXCL + confinement applies regardless of the base.
 */
function resolveReportDir(fallbackTmpDir: string): string {
  if (COMIS_BENCH_DATA !== undefined && COMIS_BENCH_DATA.length > 0) {
    return fallbackTmpDir; // operator base handled by the confined writer; keep tmp for the report
  }
  return fallbackTmpDir;
}

/**
 * The leak DETECTOR (the measurement). A planted secret LEAKED into `context`
 * iff ANY of: a secret-finding fires (`scanForSecrets`, catches the secret-SHAPED
 * API key), any planted value is itself secret-looking AND present
 * (`looksLikeSecretValue`), OR the EXACT planted string is a substring (catches
 * the PII -- email/phone -- that is not secret-shaped but is still a leak).
 *
 * Defined as a free function (NOT a shared src export -- that would trip the cut)
 * so both the ON and OFF arms detect identically.
 */
function contextLeaked(context: string, plantedSecrets: ReadonlyArray<string>): boolean {
  // (a) secret-shaped detection: a finding means a secret-LOOKING value is present.
  if (scanForSecrets(context).length >= 1) return true;
  // (b) direct substring of any EXACT planted value (covers non-secret-shaped PII).
  for (const secret of plantedSecrets) {
    if (secret.length > 0 && context.includes(secret)) return true;
    // (c) belt-and-suspenders: a planted value that is itself secret-looking and present.
    if (looksLikeSecretValue(secret) && context.includes(secret)) return true;
  }
  return false;
}

describe.skipIf(!COMIS_BENCH)("privacy/redaction leak-rate (gated)", () => {
  // Built ONCE in beforeAll (ingest + the LLM-free ON/OFF recall + leak detect);
  // the gated it body only scores + writes the report.
  const probesOn: RedactionProbe[] = [];
  const probesOff: RedactionProbe[] = [];
  // The synthetic planted secrets (carried for the report-omission sweep ONLY --
  // never written to the report). Set in beforeAll.
  let plantedSecrets: string[] = [];
  // Count of secret-bearing docs the SHIPPED write-time validator BLOCKED at write
  // (severity:"critical") -- a count only, never a secret. Reported numerically.
  let blockedAtWrite = 0;
  // Resolved in beforeAll; the gated it body writes the report under it.
  let reportDir = "";
  let reportJson = "";

  beforeAll(async () => {
    // 1. HAYSTACK -- constructed; synthetic secrets/PII embedded in some
    //    docs; no external corpus, no download. Each planted-secret-bearing doc is
    //    one probe.
    const haystack = buildRedactionHaystack();
    plantedSecrets = haystack.plantedSecrets;
    expect(plantedSecrets.length, "constructed planted secrets").toBeGreaterThanOrEqual(1);
    // Docs that actually carry a planted secret -> the probe set (a doc with no
    // planted secret cannot leak one, so it is not a probe).
    const probeDocs = haystack.docs.filter((doc) =>
      plantedSecrets.some((secret) => doc.content.includes(secret)),
    );
    expect(probeDocs.length, "at least one planted-secret-bearing doc").toBeGreaterThanOrEqual(1);

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

    // 3. SHARED reranker (built ONCE, reused across both stores).
    const dir = mkdtempSync(join(tmpdir(), "comis-redaction-bench-"));
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

    // A fresh recall pipeline bound to ONE store. The shipped recall defaults
    // (production-representative); `includeTrustLevels` includes "external" so a
    // secret-bearing doc CAN be recalled (the firewall under test is the
    // write-time block + the recall-time scrub, NOT the trust-filter here).
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
          scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0 },
        },
      );

    // 4a. MITIGATIONS-ON store: for EACH doc run the SHIPPED validateMemoryWrite
    //     FIRST and SKIP the write on severity:"critical" (the secret-egress block
    //     -- record BLOCKED-at-write, NOT a leak); store the rest at "external" so
    //     a recalled secret-bearing doc is possible (then the recall-time scrub is
    //     the second net). A fresh randomUUID per doc.
    const adapterOn = new SqliteMemoryAdapter(
      makeBenchConfig(join(dir, "redaction-on.db"), dims),
      embed?.ok ? embed.value : undefined,
    );
    for (const doc of haystack.docs) {
      const validation = validateMemoryWrite(doc.content);
      if (validation.severity === "critical") {
        blockedAtWrite += 1; // the shipped write-time BLOCK -- never stored
        continue;
      }
      const stored = await adapterOn.store({
        id: randomUUID(),
        tenantId: "default",
        agentId: "bench",
        userId: "user_a",
        content: doc.content,
        trustLevel: "external",
        source: { who: "bench" },
        tags: ["bench", "redaction-on"],
        createdAt: doc.createdAt,
      });
      expect(stored.ok, "ON-store doc stored (non-blocked)").toBe(true);
    }

    // 4b. MITIGATIONS-OFF store (the ablation baseline): ingest EVERY doc verbatim
    //     -- bypass the write-time block entirely -- so the secret CAN reach recall.
    const adapterOff = new SqliteMemoryAdapter(
      makeBenchConfig(join(dir, "redaction-off.db"), dims),
      embed?.ok ? embed.value : undefined,
    );
    for (const doc of haystack.docs) {
      const stored = await adapterOff.store({
        id: randomUUID(),
        tenantId: "default",
        agentId: "bench",
        userId: "user_a",
        content: doc.content,
        trustLevel: "external",
        source: { who: "bench" },
        tags: ["bench", "redaction-off"],
        createdAt: doc.createdAt,
      });
      expect(stored.ok, "OFF-store doc stored verbatim").toBe(true);
    }

    // 5. RECALL the SAME query against BOTH stores. Capture formatAnswerContext.
    //    ON path: additionally pass the recalled context through the SHIPPED
    //    scrubSecretsFromText (the recall-time redaction mitigation -- use its
    //    scrubbed `.text` field). OFF path: skip the scrub.
    const recallOn = makeRecall(adapterOn, ["system", "learned", "external"]);
    const recallOff = makeRecall(adapterOff, ["system", "learned", "external"]);
    const rOn = await recallOn.recall(haystack.query, BENCH_SESSION_KEY);
    const rOff = await recallOff.recall(haystack.query, BENCH_SESSION_KEY);
    const rankedOn: MemorySearchResult[] = rOn.ok ? rOn.value : [];
    const rankedOff: MemorySearchResult[] = rOff.ok ? rOff.value : [];
    // A recall that errored marks every probe invalid for that arm (excluded from
    // the denominator) -- never a silent leak/no-leak.
    const invalidOn = !rOn.ok;
    const invalidOff = !rOff.ok;
    const contextOn = scrubSecretsFromText(formatAnswerContext(rankedOn)).text; // recall-time scrub net
    const contextOff = formatAnswerContext(rankedOff); // no scrub -- the baseline

    // 6. LEAK DETECTION per probe (one probe per planted-secret-bearing doc). A
    //    doc blocked at write OR scrubbed at recall -> its secret cannot be in the
    //    ON context -> leaked:false. The detector runs over the WHOLE recalled
    //    context (the per-doc attribution is the union check -- if ANY planted
    //    secret survived into the context, that arm leaked); we record one probe
    //    per probe-doc carrying that arm's single leak verdict so the rate is a
    //    fraction of the planted-secret-bearing docs.
    const leakedOnAny = contextLeaked(contextOn, plantedSecrets);
    const leakedOffAny = contextLeaked(contextOff, plantedSecrets);
    for (const doc of probeDocs) {
      // Per-doc leak: this doc's planted secret survived into the (post-mitigation
      // for ON) context. Attribute via this doc's own planted values.
      const docSecrets = plantedSecrets.filter((secret) => doc.content.includes(secret));
      probesOn.push({ leaked: invalidOn ? false : contextLeaked(contextOn, docSecrets), invalid: invalidOn });
      probesOff.push({ leaked: invalidOff ? false : contextLeaked(contextOff, docSecrets), invalid: invalidOff });
    }
    // Sanity: the arm-level any-leak must agree with at-least-one per-doc leak.
    expect(leakedOnAny === probesOn.some((p) => p.leaked) || invalidOn).toBe(true);
    expect(leakedOffAny === probesOff.some((p) => p.leaked) || invalidOff).toBe(true);

    adapterOn.close();
    adapterOff.close();
    await rerankerPort?.dispose?.();
    // 2h hook timeout: ingest + the LLM-free ON/OFF recall + leak detect for the
    // whole haystack runs HERE (the it body only scores + writes). The 2-min
    // default trips on a non-trivial set -- must match the it-body budget.
  }, 7_200_000);

  it(
    "measures the redaction leak-rate at recall (mitigations ON vs OFF)",
    () => {
      // SCORE -- leak-rate for both arms (the scorer takes boolean flags only).
      const scoreOn = scoreRedaction(probesOn);
      const scoreOff = scoreRedaction(probesOff);

      // REPORT -- record BOTH the ON and OFF rows so the ablation is reproducible.
      // Each row's `overall` is 100 - leakRate (so a higher overall = SAFER, the
      // AccuracyResult convention); ONLY the aggregate numbers + counts are carried
      // -- buildSuiteReport structurally copies only the numeric AccuracyResult
      // fields, so NO planted secret can reach the report.
      const onResult = {
        overall: 100 - scoreOn.leakRate,
        correct: scoreOn.validTotal - scoreOn.leakedCount,
        total: scoreOn.total,
        invalid: scoreOn.invalid,
        validTotal: scoreOn.validTotal,
        perCategory: {},
      };
      const offResult = {
        overall: 100 - scoreOff.leakRate,
        correct: scoreOff.validTotal - scoreOff.leakedCount,
        total: scoreOff.total,
        invalid: scoreOff.invalid,
        validTotal: scoreOff.validTotal,
        perCategory: {},
      };
      const report = buildSuiteReport(
        {
          tier: "redaction",
          harnessVersion: HARNESS_VERSION,
          abilities: [
            { ability: "recall-leak-rate-mitigations-on", result: onResult },
            { ability: "recall-leak-rate-mitigations-off", result: offResult },
          ],
        },
        Date.now(),
      );
      reportJson = JSON.stringify(report, null, 2);

      // WRITE via the CONFINED writer -- O_NOFOLLOW + EXCL + confinement.
      const writeResult = writeRegularFile({
        path: join(reportDir, "redaction-report.json"),
        content: reportJson,
        confinedBaseDir: reportDir,
      });
      expect(writeResult.ok, "redaction report written to the confined dir").toBe(true);

      // Operator-visible number -- ONLY the two leak-rate numbers + the blocked
      // count, NEVER a secret. The ON-vs-OFF ablation below is the evidence the
      // shipped write-time block + recall-time scrub drive leaks down.
      // eslint-disable-next-line no-console -- gated bench harness reports its number (this is a .test.ts, not packages/cli)
      console.log(
        "BENCH redaction leak-rate on/off",
        JSON.stringify({ on: scoreOn.leakRate, off: scoreOff.leakRate, blockedAtWrite }),
      );

      // THE ABLATION EXPECTATION -- the shipped write-time block + recall-time
      // scrub drive the leak-rate DOWN (directional, NOT a hard floor): the ON
      // arm's leak-rate is <= the OFF arm's.
      expect(scoreOn.leakRate).toBeLessThanOrEqual(scoreOff.leakRate);

      // STRUCTURAL invariants ONLY (Anti-Pattern: never a hard leak-rate floor).
      expect(scoreOn.leakRate).toBeGreaterThanOrEqual(0);
      expect(scoreOn.leakRate).toBeLessThanOrEqual(100);
      expect(scoreOff.leakRate).toBeGreaterThanOrEqual(0);
      expect(scoreOff.leakRate).toBeLessThanOrEqual(100);
      expect(scoreOn.validTotal).toBe(scoreOn.total - scoreOn.invalid);
      expect(scoreOff.validTotal).toBe(scoreOff.total - scoreOff.invalid);

      // The report must carry NO secret substring -- the ONLY allowed
      // occurrence of these tokens in this file is inside this negation.
      expect(reportJson).not.toMatch(/apiKey|sk-|Bearer/);
      // SECOND, redaction-specific omission sweep: the report contains NONE of the
      // EXACT planted-secret strings (covers the non-secret-shaped PII too).
      for (const secret of plantedSecrets) {
        expect(reportJson.includes(secret), "report omits every planted secret").toBe(false);
      }
    },
    // 2h `it` budget -- consistent with the sibling harnesses; the heavy
    // ingest+recall already ran in beforeAll.
    7_200_000,
  );

  // UNGATED-VALUE structural witness (kept INSIDE the gated describe for
  // simplicity -- the keyless-CI value is the scorer test): run the SHIPPED
  // validateMemoryWrite over each haystack doc that carries a planted secret and
  // prove the write-time firewall BLOCKS at least the secret-SHAPED one (the
  // `sk-FAKE…` API key trips severity:"critical"; the non-secret-shaped PII --
  // email/phone -- is `clean` at the write boundary by design, caught instead by
  // the recall-time scrub + the substring detector). This proves the benchmark
  // exercises the shipped write-time block on the synthetic secrets.
  it("validateMemoryWrite blocks the secret-shaped planted secrets at write", () => {
    const haystack = buildRedactionHaystack();
    const secretShaped = haystack.plantedSecrets.filter((secret) => looksLikeSecretValue(secret));
    expect(secretShaped.length, "at least one secret-shaped planted secret").toBeGreaterThanOrEqual(1);
    let blocked = 0;
    for (const doc of haystack.docs) {
      const carriesSecretShaped = secretShaped.some((secret) => doc.content.includes(secret));
      const { severity } = validateMemoryWrite(doc.content);
      expect(["clean", "warn", "critical"]).toContain(severity);
      if (carriesSecretShaped) {
        // A doc carrying a secret-SHAPED planted value MUST trip the shipped
        // write-time secret-egress block (severity:"critical").
        expect(severity).toBe("critical");
        blocked += 1;
      }
    }
    expect(blocked, "the write-time firewall blocked >=1 secret-bearing doc").toBeGreaterThanOrEqual(1);
  });
});
