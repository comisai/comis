// SPDX-License-Identifier: Apache-2.0
/**
 * Env-gated KEYLESS reasoning-observations harness (REASON-05, Phase 101-06) --
 * the FREE, deterministic, no-API-cost measurement of the two MECHANICAL claims of
 * the offline reasoning job (Plan 101-05): WRITE-correctness + DEFAULT-OFF
 * byte-identity. Mirrors the Phase-100 KG-05 keyless harness
 * (graph-spread-lane-contribution.bench.test.ts) including its honest-PARTIAL split.
 *
 * WHY THIS HARNESS EXISTS (the honest gap the Phase-101 gate must measure): the
 * shipped QA + retrieval + contradiction harnesses do NOT wire the reasoning
 * observations into recall (the SAME KG-05 structural gap, verified), so a costed
 * QA cross-judge lift cannot be measured without a harness extension + a costed
 * reasoning pass over the corpus. Rather than guess a delta, this harness proves
 * the two claims that CAN be measured deterministically at $0:
 *
 *   1. WRITE-correctness (the real production job, KEYLESS): a DETERMINISTIC injected
 *      reason() seam (a fixed function returning typed deductive + inductive
 *      candidates -- NO real LLM, NO key) drives the REAL `runMemoryReasoning` over
 *      a REAL createSqliteMemoryConsolidationStore + createSqliteTripleStore on a
 *      SHARED db. ASSERT (the binding constraints, proven at the STORAGE layer where
 *      a poisoning attempt would land):
 *        - an INDUCTIVE observation is written at trustLevel <= learned with
 *          observationKind="inductive" -- an all-`system` cluster STILL yields
 *          `learned`, NEVER `system` (REASON-03, T-101-05-01);
 *        - a DEDUCTIVE knowledge-update is current-truth via the real upsertTriple
 *          (REASON-02), and -- for the trust-first case -- an OLDER higher-trust
 *          incumbent SURVIVES a NEWER lower-trust deductive claim (anti-poisoning).
 *
 *   2. DEFAULT-OFF byte-identity (the no-regression proof): with config.enabled=false
 *      the injected reason() seam is invoked 0 times AND the row count (observations +
 *      triples) is UNCHANGED. Because the SHIPPING default ships the reasoning job OFF
 *      (memoryReasoning is `.optional()` + default-OFF, 101-02), this is the
 *      byte-identity-to-Phase-98 proof by construction: no recall path changes when
 *      the job is off.
 *
 * HONESTLY DEFERRED (the costed item -- VERDICT: PARTIAL, FOLLOW-UP-style): the QA
 * cross-judge multi-session accuracy lift from the reasoning observations. The
 * shipped QA harness does not wire the reasoning observations into recall, and a
 * KG-ON QA cross-judge needs the QA harness extended + a costed reasoning pass over
 * the corpus (the offline reason seam needs a costed model). That is an OPERATOR
 * COSTED RE-RUN, not a number this keyless gate may quote. See the manifest's
 * GATE-REPORT.md and run-provenance.json.
 *
 * THIS IS THE PRODUCTION CODE PATH, NOT A MOCK:
 *   - the job = `runMemoryReasoning(deps)` (bare @comis/agent production job),
 *   - deps.consolidationStore = `createSqliteMemoryConsolidationStore({ db })` (bare @comis/memory),
 *   - deps.tripleStore = `createSqliteTripleStore({ db })` (bare @comis/memory),
 *   - the writes are the REAL applyConsolidation (inductive) + the REAL trust-first
 *     upsertTriple (deductive); the trust ceilings are computed in the job's CODE.
 * The only thing the harness injects is the `reason` seam -- a DETERMINISTIC fixed
 * function (no provider call, no key) so the test is reproducible + LLM-free.
 *
 * KEYLESS (T-89-03 family): no model, no API key, no provider call, no cost. The
 * injected reason() seam returns fixed typed candidates.
 *
 * ARCHITECTURE CUT (the single escape hatch): this *.bench.test.ts MAY import
 * @comis/memory (a devDependency) -- the agent->memory cut excludes the `.test.ts`
 * suffix (source-rules.test.ts `excludeFileSuffixes: [".test.ts"]`). Mirrors the
 * blessed precedent graph-spread-lane-contribution.bench.test.ts.
 *
 * SECURITY: fresh `mkdtempSync` tmp DB (NEVER ~/.comis), synthetic fixture strings
 * (no secret), `tenantId:"default"`/`agentId:"bench"` -- isolated from any live
 * agent. The report is written via the confined `writeRegularFile` (O_NOFOLLOW +
 * EXCL + confinement) and carries pure numbers + booleans -- the secret-omission
 * assertion proves it.
 *
 * @module
 */

import { describe, it, expect, beforeAll } from "vitest";
// GATED test-only imports (the agent->memory cut excludes *.test.ts).
import {
  SqliteMemoryAdapter,
  createSqliteTripleStore,
  createSqliteMemoryConsolidationStore,
} from "@comis/memory";
// BARE production job (the live reasoning pipeline this harness drives).
import { runMemoryReasoning, type MemoryReasoningConfig, type ReasoningOutput } from "@comis/agent";
// VALUE obs import (fine in a .test.ts) -- the confined report writer.
import { writeRegularFile } from "@comis/observability";
// Determinism helper (test/support -- 5 segments up).
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
// Core types (type-only).
import type { MemoryConfig, MemoryEntry, TripleScope } from "@comis/core";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ENV GATE -- read process.env ONLY at the test boundary (the globals rule scopes to src/**).
const COMIS_BENCH = process.env.COMIS_BENCH;
// Optional committable report-output dir (the dated results manifest). When set, the
// confined writeRegularFile writes the report there (the dir is created if absent);
// the O_NOFOLLOW + EXCL + confinement guard still applies. Unset -> ephemeral tmp dir.
const COMIS_REASON_REPORT_DIR = process.env.COMIS_REASON_REPORT_DIR;

/** Fixed epoch (matches the sibling harnesses' neutral clock). */
const BENCH_NOW = 1_700_000_000_000;
/** Harness version stamp -- a number is always attributable to fixed harness code. */
const HARNESS_VERSION = "phase-101-06-v1";

const BENCH_TENANT = "default";
const BENCH_AGENT = "bench";

/** A deterministic clock the job reads for every timestamp + scope `now`. */
const benchClock = { now: () => BENCH_NOW };

/** The bench store config (FTS-only base, dims=4 -- the surprisal gate degrades to
 *  the full pool since the test-model leaves rows un-vectorized; that degrade path
 *  is itself part of the production job, RED-proven in 101-05). */
function makeBenchConfig(dbPath: string): MemoryConfig {
  return {
    dbPath,
    walMode: false,
    embeddingModel: "local",
    embeddingDimensions: 4,
    compaction: { enabled: false, threshold: 1000, targetSize: 500 },
    retention: { maxAgeDays: 0 },
  } as MemoryConfig;
}

/** A full reasoning config (default-OFF flipped per scenario). Bounded cost axes. */
function makeReasoningConfig(enabled: boolean): MemoryReasoningConfig {
  return {
    enabled,
    maxCandidatesPerRun: 200,
    surprisalTopFraction: 1, // keep all (the degrade path reasons over the full pool anyway)
    knnK: 10,
    maxObservationsPerRun: 25,
    maxReasoningTokens: 1024,
    reasonExternal: false,
    autoTags: [],
  };
}

/** Seed a raw memory (no proofCount => a consolidation candidate). */
function seedEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: randomUUID(),
    tenantId: BENCH_TENANT,
    agentId: BENCH_AGENT,
    userId: "user_a",
    content: overrides.content ?? "a fact",
    trustLevel: overrides.trustLevel ?? "system",
    source: { who: "system", channel: "bench" },
    tags: overrides.tags ?? ["bench"],
    createdAt: overrides.createdAt ?? BENCH_NOW - 10_000,
    sourceType: "conversation",
    ...overrides,
  };
}

describe.skipIf(!COMIS_BENCH)("reasoning observations WRITE-correctness (REASON-05, keyless gated)", () => {
  // Captured in beforeAll: the structural witnesses the assertions + the report read.
  let inductiveWritten = false;
  let inductiveTrust = "";
  let inductiveKind = "";
  let inductiveTrustIsLearned = false;
  let deductiveCurrentObjects: string[] = [];
  let trustFirstIncumbentSurvived = false;
  let trustFirstExternalIsCurrent = true;
  let reportDir = "";
  let reportJson = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-reason-bench-"));
    if (COMIS_REASON_REPORT_DIR !== undefined && COMIS_REASON_REPORT_DIR.length > 0) {
      reportDir = resolve(COMIS_REASON_REPORT_DIR);
      mkdirSync(reportDir, { recursive: true });
    } else {
      reportDir = dir;
    }

    // ----- Scenario A: INDUCTIVE <= learned (the binding constraint) + DEDUCTIVE
    //       current-truth, over an ALL-`system` cluster (so the cap is exercised). -----
    const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "reason-write.db")), undefined);
    const db = adapter.getDb();
    const consolidationStore = createSqliteMemoryConsolidationStore({ db });
    const tripleStore = createSqliteTripleStore({ db });

    // Two all-`system` raw memories => one homogeneous scope; the inductive cap MUST
    // floor the observation at `learned`, NEVER `system`.
    const s1 = await adapter.store(seedEntry({ content: "alice asked for short replies on Monday", trustLevel: "system" }));
    const s2 = await adapter.store(seedEntry({ content: "alice asked for short replies again on Tuesday", trustLevel: "system" }));
    expect(s1.ok && s2.ok, "seed memories stored").toBe(true);

    // A DETERMINISTIC reason() seam: one deductive S/P/O + one inductive pattern.
    // No real LLM, no key. (The job computes trust in CODE; the seam never sets it.)
    const reasonA = async (_clusterText: string): Promise<ReasoningOutput> => ({
      deductive: [{ subject: "alice", predicate: "prefers", object: "short replies" }],
      inductive: [{ content: "alice prefers concise answers", patternType: "preference" }],
    });

    const rA = await runMemoryReasoning({
      agentId: BENCH_AGENT,
      tenantId: BENCH_TENANT,
      config: makeReasoningConfig(true),
      consolidationStore,
      tripleStore,
      clock: benchClock,
      logger: createMockLogger(),
      reason: reasonA,
    });
    expect(rA.ok, "reasoning run A ok").toBe(true);

    // READ-BACK the inductive observation at the STORAGE layer (direct SQL on the
    // memories table -- the place a poisoning attempt would have to land).
    const obsRow = db
      .prepare(
        "SELECT trust_level, observation_kind, proof_count FROM memories " +
          "WHERE tenant_id = ? AND agent_id = ? AND observation_kind = 'inductive' LIMIT 1",
      )
      .get(BENCH_TENANT, BENCH_AGENT) as { trust_level?: string; observation_kind?: string; proof_count?: number } | undefined;
    inductiveWritten = obsRow !== undefined;
    inductiveTrust = obsRow?.trust_level ?? "";
    inductiveKind = obsRow?.observation_kind ?? "";
    // The HARD constraint: an all-`system` cluster yields `learned`, NEVER `system`.
    inductiveTrustIsLearned = inductiveTrust === "learned";
    // Defense-in-depth: assert NO inductive row exists at trust_level='system'.
    const systemInductive = db
      .prepare(
        "SELECT COUNT(*) AS n FROM memories WHERE observation_kind = 'inductive' AND trust_level = 'system'",
      )
      .get() as { n: number };

    // The DEDUCTIVE knowledge-update is current-truth (REASON-02).
    const ctA = await tripleStore.currentTruth({ tenantId: BENCH_TENANT, agentId: BENCH_AGENT });
    deductiveCurrentObjects = ctA.ok
      ? ctA.value.filter((t) => t.subject === "alice" && t.predicate === "prefers").map((t) => t.object)
      : [];

    adapter.close();

    // ----- Scenario B: the TRUST-FIRST anti-poisoning case. A pre-seeded `system`
    //       current-truth (alice -> Paris) must SURVIVE a NEWER `external` deductive
    //       claim (alice -> Berlin) the reason seam emits. -----
    const adapterB = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "reason-trustfirst.db")), undefined);
    const dbB = adapterB.getDb();
    const consolidationStoreB = createSqliteMemoryConsolidationStore({ db: dbB });
    const tripleStoreB = createSqliteTripleStore({ db: dbB });
    const scopeB: TripleScope = { tenantId: BENCH_TENANT, agentId: BENCH_AGENT, now: BENCH_NOW };

    // 1. Pre-seed the OLDER high-trust incumbent (alice -> Paris, system).
    const wOlder = await tripleStoreB.upsertTriple(
      { subject: "alice", predicate: "lives_in", object: "Paris", trust: "system", tValidStart: BENCH_NOW - 100_000 },
      scopeB,
    );
    expect(wOlder.ok, "older high-trust incumbent written").toBe(true);

    // 2. Seed an EXTERNAL raw memory so the job reasons over an external scope, and
    //    have the deductive seam emit a contradicting external claim (alice -> Berlin).
    //    reasonExternal:true so the external source is reasoned at all (the deductive
    //    write then caps at external -- a NEWER LOW-trust claim must NOT supersede).
    const se = await adapterB.store(seedEntry({ content: "alice posted from Berlin once", trustLevel: "external", createdAt: BENCH_NOW - 5_000 }));
    expect(se.ok, "external seed stored").toBe(true);

    const reasonB = async (_clusterText: string): Promise<ReasoningOutput> => ({
      deductive: [{ subject: "alice", predicate: "lives_in", object: "Berlin" }],
      inductive: [],
    });

    const cfgB = makeReasoningConfig(true);
    cfgB.reasonExternal = true; // exercise the external write path
    const rB = await runMemoryReasoning({
      agentId: BENCH_AGENT,
      tenantId: BENCH_TENANT,
      config: cfgB,
      consolidationStore: consolidationStoreB,
      tripleStore: tripleStoreB,
      clock: benchClock,
      logger: createMockLogger(),
      reason: reasonB,
    });
    expect(rB.ok, "reasoning run B ok").toBe(true);

    // READ current-truth: Paris (system) MUST remain; Berlin (external) MUST NOT be current.
    const ctB = await tripleStoreB.currentTruth({ tenantId: BENCH_TENANT, agentId: BENCH_AGENT });
    const currentB = ctB.ok
      ? ctB.value.filter((t) => t.subject === "alice" && t.predicate === "lives_in").map((t) => t.object)
      : [];
    trustFirstIncumbentSurvived = currentB.includes("Paris");
    trustFirstExternalIsCurrent = currentB.includes("Berlin");

    adapterB.close();

    // ----- PERSIST the committable manifest (pure numbers + booleans, keyless). -----
    const report = {
      harnessVersion: HARNESS_VERSION,
      benchmark: "reasoning-observations-write-correctness",
      scenario: "inductive <= learned + deductive current-truth + trust-first anti-poisoning",
      inductiveWritten,
      inductiveObservationKind: inductiveKind,
      inductiveTrust,
      inductiveTrustIsLearned,
      systemInductiveRows: systemInductive.n,
      deductiveCurrentTruthObjects: deductiveCurrentObjects,
      deductiveIsCurrentTruth: deductiveCurrentObjects.includes("short replies"),
      trustFirst: {
        incumbent: "Paris (system)",
        newerClaim: "Berlin (external)",
        incumbentSurvived: trustFirstIncumbentSurvived,
        externalIsCurrent: trustFirstExternalIsCurrent,
      },
    };
    reportJson = JSON.stringify(report, null, 2);
    const writeResult = writeRegularFile({
      path: join(reportDir, "reasoning-write-correctness-report.json"),
      content: reportJson,
      confinedBaseDir: reportDir,
    });
    expect(writeResult.ok, "reasoning-write-correctness-report.json written to the confined dir").toBe(true);

    // eslint-disable-next-line no-console -- gated bench harness reports its number (this is a .test.ts, not packages/cli)
    console.log("BENCH reasoning write-correctness", JSON.stringify(report));
  }, 600_000);

  it("writes an INDUCTIVE observation at trust 'learned' (NEVER 'system') with observationKind='inductive'", () => {
    expect(inductiveWritten, "an inductive observation was written").toBe(true);
    expect(inductiveKind, "the written observation is inductive").toBe("inductive");
    // The binding constraint (REASON-03, T-101-05-01): an all-`system` cluster yields
    // `learned`, NEVER `system`. Hard-assert the exact value.
    expect(inductiveTrust, "inductive trust is HARD-capped at learned").toBe("learned");
    expect(inductiveTrustIsLearned).toBe(true);
  });

  it("writes a DEDUCTIVE knowledge-update as current-truth via the real upsertTriple (REASON-02)", () => {
    expect(deductiveCurrentObjects, "the deductive S/P/O is current-truth").toContain("short replies");
  });

  it("keeps the OLDER higher-trust fact current-truth after a NEWER lower-trust deductive claim (trust-first)", () => {
    // The anti-poisoning invariant the KG adds: trust-FIRST, not recency-first.
    expect(trustFirstIncumbentSurvived, "Paris (system) stays current-truth").toBe(true);
    expect(trustFirstExternalIsCurrent, "Berlin (external) is NOT current-truth").toBe(false);
  });

  it("the write-correctness manifest carries NO secret substring (keyless, confined writer)", () => {
    expect(reportJson.length, "the manifest was produced").toBeGreaterThan(0);
    expect(reportJson).not.toMatch(/apiKey|sk-|Bearer/);
  });
});

/**
 * DEFAULT-OFF byte-identity (the no-regression proof). With config.enabled=false the
 * job is a TRUE no-op: the injected reason() seam is invoked 0 times AND the row
 * count (observations + triples) is unchanged. Because the SHIPPING default ships the
 * reasoning job OFF, this is the byte-identity-to-Phase-98 proof by construction.
 */
describe.skipIf(!COMIS_BENCH)("reasoning observations DEFAULT-OFF byte-identity (REASON-05, keyless gated)", () => {
  let reasonCallCount = 0;
  let memoriesBefore = 0;
  let memoriesAfter = 0;
  let triplesBefore = 0;
  let triplesAfter = 0;
  let reportDir = "";
  let reportJson = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-reason-off-bench-"));
    if (COMIS_REASON_REPORT_DIR !== undefined && COMIS_REASON_REPORT_DIR.length > 0) {
      reportDir = resolve(COMIS_REASON_REPORT_DIR);
      mkdirSync(reportDir, { recursive: true });
    } else {
      reportDir = dir;
    }

    const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "reason-off.db")), undefined);
    const db = adapter.getDb();
    const consolidationStore = createSqliteMemoryConsolidationStore({ db });
    const tripleStore = createSqliteTripleStore({ db });

    // Seed candidates so a RUNNING job would have something to write.
    await adapter.store(seedEntry({ content: "alice asked for short replies on Monday", trustLevel: "system" }));
    await adapter.store(seedEntry({ content: "alice asked for short replies again on Tuesday", trustLevel: "system" }));

    // Pre-run row counts (the byte-identity baseline).
    memoriesBefore = (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
    triplesBefore = (db.prepare("SELECT COUNT(*) AS n FROM memory_triples").get() as { n: number }).n;

    // A seam that COUNTS its invocations -- it must be invoked 0 times when OFF.
    const countingReason = async (_clusterText: string): Promise<ReasoningOutput> => {
      reasonCallCount += 1;
      return { deductive: [{ subject: "alice", predicate: "prefers", object: "short replies" }], inductive: [{ content: "x" }] };
    };

    const r = await runMemoryReasoning({
      agentId: BENCH_AGENT,
      tenantId: BENCH_TENANT,
      config: makeReasoningConfig(false), // DEFAULT-OFF
      consolidationStore,
      tripleStore,
      clock: benchClock,
      logger: createMockLogger(),
      reason: countingReason,
    });
    expect(r.ok, "default-off run ok").toBe(true);

    memoriesAfter = (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
    triplesAfter = (db.prepare("SELECT COUNT(*) AS n FROM memory_triples").get() as { n: number }).n;

    adapter.close();

    const report = {
      harnessVersion: HARNESS_VERSION,
      benchmark: "reasoning-observations-default-off-byte-identity",
      scenario: "config.enabled=false => 0 reason() calls + unchanged row count",
      reasonCallCount,
      memoriesBefore,
      memoriesAfter,
      triplesBefore,
      triplesAfter,
      defaultOffWroteNothing: memoriesAfter === memoriesBefore && triplesAfter === triplesBefore && reasonCallCount === 0,
    };
    reportJson = JSON.stringify(report, null, 2);
    const writeResult = writeRegularFile({
      path: join(reportDir, "reasoning-default-off-report.json"),
      content: reportJson,
      confinedBaseDir: reportDir,
    });
    expect(writeResult.ok, "reasoning-default-off-report.json written to the confined dir").toBe(true);

    // eslint-disable-next-line no-console -- gated bench harness reports its number (this is a .test.ts, not packages/cli)
    console.log("BENCH reasoning default-off byte-identity", JSON.stringify(report));
  }, 600_000);

  it("invokes the reason() seam 0 times when the job is disabled (the cost gate)", () => {
    expect(reasonCallCount).toBe(0);
  });

  it("writes NOTHING when disabled: memory + triple row counts are unchanged (byte-identity)", () => {
    expect(memoriesAfter, "memory row count unchanged").toBe(memoriesBefore);
    expect(triplesAfter, "triple row count unchanged").toBe(triplesBefore);
  });

  it("the default-off manifest carries NO secret substring and hard-asserts the no-write invariant", () => {
    expect(reportJson).not.toMatch(/apiKey|sk-|Bearer/);
    // The deterministic invariant (the graph-spread bench's `toBe(100)` analog): the
    // disabled job wrote nothing and never called the seam.
    const report = JSON.parse(reportJson) as { defaultOffWroteNothing: boolean };
    expect(report.defaultOffWroteNothing).toBe(true);
  });
});
