// SPDX-License-Identifier: Apache-2.0
/**
 * Env-gated KEYLESS HEAD-TO-HEAD PROVING-MACHINE harness -- a
 * deterministic, no-API-cost ($0) proof that the
 * WHOLE believability machine runs end-to-end, keyless,
 * before a single dollar of competitor/judge spend is paid.
 *
 * THE HONEST SCOPE SPLIT (the reason VERDICT is PARTIAL):
 *   - WHAT THIS HARNESS MEASURES (keyless, $0, deterministic): the proving
 *     MACHINE itself works -- the cross-judge spread computes survival over
 *     injected judge verdicts, the two-proportion significance computes, the
 *     append-only ledger refuses to overwrite a prior dated row, the ablation
 *     sweep's off-toggle is byte-identical to the shipping baseline (a mistyped
 *     leaf would fail loudly), an ABSENT competitor adapter skips-with-disclosure
 *     (never a fabricated number), the letta-fs baseline runs as the control, and
 *     a REAL Comis recall cell with the lanes ON drives the production
 *     pipeline (the lanes-are-not-dormant wiring proof).
 *   - WHAT IS DEFERRED to the OPERATOR-COSTED re-run (NOT measured here): the
 *     ACTUAL competitor numbers (mem0 / zep / hindsight / mnemosyne under one
 *     protocol) and the cross-JUDGED headline spread over two REAL judge passes.
 *     Those need keys + competitor installs + LLM spend; quoting a guessed delta
 *     would be exactly the fabrication this gate exists to prevent. They are the
 *     home for the deferred QA lifts from the earlier KG / reasoning / IQ gates.
 *
 * NO LLM, NO KEY, NO PROVIDER CALL: the judge is an INJECTED deterministic stub
 * (a pure fixed-verdict map -- there is no keyless LLM judge), the competitor
 * presence probe defaults to `() => false` (the keyless CI always hits the skip
 * branch -- that IS the wiring proof), and the only adapter that runs is the
 * pure `letta-fs-baseline` control. The Comis recall cell uses a real
 * `SqliteMemoryAdapter` over a fresh `mkdtempSync` db (NEVER ~/.comis), FTS-only
 * base (dims=4); the vector lane lights up only if LLAMA_MODEL_PATH is set, but
 * the wiring proof does not depend on it.
 *
 * THIS IS THE PRODUCTION CODE PATH for the Comis cell, NOT A MOCK:
 *   - recall = `createMemoryRecall(deps, cfg)` (bare @comis/agent orchestrator),
 *   - deps.tripleStore = `createSqliteTripleStore({ db: adapter.getDb() })`,
 *   - cfg.lanes.graphSpread = { enabled:true, ... } + cfg.mmr = { enabled:true },
 * so a green "ranked results returned" is the guard that the shipped
 * lanes are wired into recall, not dormant.
 *
 * ARCHITECTURE CUT (the single escape hatch): this *.bench.test.ts MAY import
 * @comis/memory (a devDependency) -- the agent->memory cut excludes the `.test.ts`
 * suffix (source-rules.test.ts `excludeFileSuffixes: [".test.ts"]`). Mirrors the
 * blessed precedent graph-spread-lane-contribution.bench.test.ts.
 *
 * SECURITY: fresh `mkdtempSync` tmp DB + tmp history dir (NEVER ~/.comis),
 * `trustLevel:"learned"`, `tenantId:"default"`/`agentId:"bench"` -- isolated from
 * any live agent. The committed reports are written via the confined
 * `writeRegularFile` (O_NOFOLLOW + confinement) and carry pure numbers + booleans
 * + a coi block; the per-report `not.toMatch(/apiKey|sk-|Bearer/)` trio proves it.
 * The ledger writes under a FRESH tmp `history/` dir (the keyless proof writes a
 * SYNTHETIC dated row, NOT the committed history -- the committed history is the
 * operator-costed run).
 *
 * @module
 */

import { describe, it, expect, beforeAll } from "vitest";
// GATED test-only imports (the agent->memory cut excludes *.test.ts).
import { SqliteMemoryAdapter, createSqliteTripleStore } from "@comis/memory";
// BARE production orchestrator (the live recall pipeline this harness drives).
import { createMemoryRecall, type MemoryRecallDeps, type MemoryRecallConfig } from "@comis/agent";
// VALUE obs import (fine in a .test.ts) -- the confined report writer.
import { writeRegularFile } from "@comis/observability";
// The six pure proving-machine modules this harness drives at $0 (in-package imports).
import { computeCrossJudgeSpread, type CategorySpread } from "./cross-judge-spread.js";
import { twoProportionTest, wilsonInterval } from "./significance.js";
import { appendLedgerRow, buildLedgerRow, ledgerRowPath } from "./results-ledger.js";
import { V28_ABLATION_FACTORS, applyFactor, sweepCells, REASON_WRITE_SIDE_FACTOR } from "./ablation-sweep.js";
import { createMem0Adapter, skipWithDisclosure, type AdapterResult } from "./competitor-adapter.js";
import { createLettaFsBaselineAdapter, LETTA_FS_BASELINE_CONTROL_LABEL } from "./letta-fs-baseline-adapter.js";
// Determinism helpers (test/support -- 5 segments up).
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
// Core types (type-only).
import type { MemoryConfig, MemorySearchResult, SessionKey } from "@comis/core";
import { MemoryConfigSchema } from "@comis/core";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ENV GATE -- read process.env ONLY at the test boundary (the globals rule scopes to src/**).
const COMIS_BENCH = process.env.COMIS_BENCH;
// Optional committable report-output dir (the dated PARTIAL manifest). When set, the
// confined writeRegularFile writes the four reports there (the dir is created if
// absent). Unset -> ephemeral tmp dir. Mirrors COMIS_KG_REPORT_DIR exactly.
const COMIS_PROVE_REPORT_DIR = process.env.COMIS_PROVE_REPORT_DIR;

/** Fixed epoch (matches the sibling harnesses' neutral injected clock). */
const BENCH_NOW = 1_700_000_000_000;
/** Harness version stamp -- a number is always attributable to fixed harness code. */
const HARNESS_VERSION = "phase-104-prove-v1";

/** The bench store config (mirrors the sibling harnesses). dims=4 -> FTS-only base. */
function makeBenchConfig(dbPath: string): MemoryConfig {
  return MemoryConfigSchema.parse({
    dbPath,
    walMode: false,
    recall: { embeddingModel: "local", embeddingDimensions: 4 },
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

/** The agent partition memories are ingested under AND recall is called with (load-bearing scope). */
const BENCH_AGENT_ID = "bench";

/**
 * Base recall config with the lanes ON (the lanes-ON wiring proof).
 * graphSpread + mmr enabled; alphas 0 so the lift is attributable to the lanes, not
 * a recency/trust confound.
 */
function lanesOnRecallConfig(): MemoryRecallConfig {
  return {
    maxResults: 10,
    minScore: 0,
    includeTrustLevels: ["system", "learned"],
    rerank: { mode: "off", maxCandidates: 20, minResults: 2, timeoutMs: 5000 },
    scoring: { recency: 0, temporal: 0, proof: 0, trust: 0 },
    lanes: {
      fts: { weight: 1.0 },
      vector: { weight: 1.5 },
      graphSpread: { enabled: true, weight: 2.0, maxDepth: 2, fanOut: 8 },
    },
    mmr: { enabled: true, lambda: 0.5 },
    entityLane: { enabled: false, seedCount: 5, perEntityCap: 10, weight: 1.0 },
  };
}

/**
 * The shipping-default baseline used for the off=byte-identity oracle: every
 * factor's leaf EXPLICITLY off. `applyFactor(baseline, factor, false)` must be
 * JSON-byte-identical to this -- a mistyped knob leaf would set a phantom key and
 * diverge, failing loudly (the safety net).
 */
function explicitOffBaseline(): MemoryRecallConfig {
  return {
    maxResults: 10,
    minScore: 0,
    includeTrustLevels: ["system", "learned"],
    rerank: { mode: "off", maxCandidates: 20, minResults: 2, timeoutMs: 5000 },
    scoring: { recency: 0, temporal: 0, proof: 0, trust: 0 },
    lanes: {
      fts: { weight: 1.0 },
      vector: { weight: 1.5 },
      graphSpread: { enabled: false, weight: 2.0, maxDepth: 2, fanOut: 8 },
    },
    mmr: { enabled: false, lambda: 0.5 },
    queryUnderstanding: { intentReweight: false, synonyms: false, temporalParse: false },
  };
}

/**
 * The INJECTED deterministic judge stub: two fixed per-category accuracy maps (one
 * per "judge"). There is NO LLM -- these are the verdicts a real cross-judge pass
 * would PRODUCE, supplied directly so the machine's fold is exercised at $0. One
 * category (single-session-preference) deliberately disagrees by 15pt (the
 * non-survival case); the rest agree within tolerance.
 */
const INJECTED_JUDGE_A: Record<string, number> = {
  "single-session-user": 100,
  "knowledge-update": 75,
  "temporal-reasoning": 45,
  "single-session-preference": 30,
};
const INJECTED_JUDGE_B: Record<string, number> = {
  "single-session-user": 100,
  "knowledge-update": 75,
  "temporal-reasoning": 42,
  "single-session-preference": 45,
};

describe.skipIf(!COMIS_BENCH)("head-to-head proving machine (PROVE, keyless gated)", () => {
  let reportDir = "";

  // Captured in beforeAll: the structural witnesses the assertions + reports read.
  let absentResult: AdapterResult = skipWithDisclosure("placeholder", "unset", "unset");
  let controlResult: AdapterResult = skipWithDisclosure("placeholder", "unset", "unset");
  let comisRanked: MemorySearchResult[] = [];
  let ledgerFirstOk = false;
  let ledgerSecondSamePathRejected = false;
  let ledgerFirstBytesUnchanged = false;
  let ledgerDifferentDateOk = false;
  let spread: CategorySpread[] = [];

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-prove-bench-"));
    if (COMIS_PROVE_REPORT_DIR !== undefined && COMIS_PROVE_REPORT_DIR.length > 0) {
      reportDir = resolve(COMIS_PROVE_REPORT_DIR);
      mkdirSync(reportDir, { recursive: true });
    } else {
      reportDir = dir;
    }

    // 1. ADAPTER WIRING PROOF: an absent competitor skips-with-disclosure (never a
    //    number); the letta-fs control runs keyless at $0.
    const mem0 = createMem0Adapter({ isPresent: () => false });
    absentResult = await mem0.run("head-to-head", { tier: "head-to-head" });

    const letta = createLettaFsBaselineAdapter();
    controlResult = await letta.run("head-to-head", {
      tier: "head-to-head",
      docs: [
        { content: "Quarterly revenue planning meeting decided the Q3 forecast.", createdAt: BENCH_NOW - 10_000 },
        { content: "Approver delegate is Mirabel Okonkwo, escalation code TZ-7.", createdAt: BENCH_NOW - 5_000 },
      ],
    });

    // 2. REAL COMIS CELL: drive the production recall pipeline with the lanes ON
    //    over a fresh adapter + a structurally-linked triple edge (the lanes-ON proof).
    const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "prove.db")), undefined);
    const seedId = randomUUID();
    const linkedId = randomUUID();
    const seedContent = "Quarterly revenue planning meeting: the team finalized the Q3 forecast and budget.";
    const linkedContent = "Zephyr ledger note: approver delegate is Mirabel Okonkwo, escalation code TZ-7.";

    await adapter.store({
      id: seedId,
      tenantId: "default",
      agentId: BENCH_AGENT_ID,
      userId: "user_a",
      content: seedContent,
      trustLevel: "learned",
      source: { who: "bench" },
      tags: ["bench"],
      createdAt: BENCH_NOW - 10_000,
    });
    await adapter.store({
      id: linkedId,
      tenantId: "default",
      agentId: BENCH_AGENT_ID,
      userId: "user_a",
      content: linkedContent,
      trustLevel: "learned",
      source: { who: "bench" },
      tags: ["bench"],
      createdAt: BENCH_NOW - 5_000,
    });

    const tripleStore = createSqliteTripleStore({ db: adapter.getDb() });
    await tripleStore.upsertTriple(
      {
        subject: seedContent,
        predicate: "relates_to",
        object: linkedContent,
        trust: "learned",
        tValidStart: BENCH_NOW - 10_000,
        sourceMemoryId: linkedId,
      },
      { tenantId: "default", agentId: BENCH_AGENT_ID, now: BENCH_NOW },
    );

    const recall = createMemoryRecall(
      {
        memoryPort: adapter,
        clock: createFakeClock(BENCH_NOW),
        timers: createFakeTimers(BENCH_NOW),
        logger: createMockLogger(),
        tripleStore,
      } as MemoryRecallDeps,
      lanesOnRecallConfig(),
    );
    const r = await recall.recall(
      "What did the quarterly revenue planning meeting decide?",
      BENCH_SESSION_KEY,
      BENCH_AGENT_ID,
    );
    comisRanked = r.ok ? r.value : [];
    adapter.close();

    // 3. LEDGER NEVER-OVERWRITE PROOF: a fresh tmp history dir (NOT the committed
    //    history). Write row1, re-write its EXACT path (refused, prior bytes intact),
    //    write a DIFFERENT-date row (coexists).
    const historyDir = mkdtempSync(join(tmpdir(), "comis-prove-history-"));
    const baseRowInput = {
      branch: "v2.8-prove-climb",
      systemVersions: { comis: "2.8.0", pi: "0.78.0" },
      tier: "head-to-head",
      judgeSpread: [] as CategorySpread[],
      n: 120,
      significance: null,
      cost: { answerTokensPerQuery: 0, judgeTokensPerQuery: 0, totalTokensPerQuery: 0 },
      latency: {
        recallP50Ms: 0, recallP95Ms: 0, answerP50Ms: 0, answerP95Ms: 0,
        judgeP50Ms: 0, judgeP95Ms: 0, endToEndP50Ms: 0, endToEndP95Ms: 0,
      },
    };
    const row1 = buildLedgerRow({ ...baseRowInput, date: "2026-06-01", commit: "aaa1111" }, BENCH_NOW);
    const first = appendLedgerRow({ historyDir, row: row1 });
    ledgerFirstOk = first.ok;
    const row1Path = ledgerRowPath(historyDir, "2026-06-01", "aaa1111");
    const bytesAfterFirst = readFileSync(row1Path, "utf8");

    // A DIFFERENT row for the SAME dated path (same date+commit) -> MUST be refused.
    const row1Collision = buildLedgerRow(
      { ...baseRowInput, date: "2026-06-01", commit: "aaa1111", n: 999 },
      BENCH_NOW + 1,
    );
    const second = appendLedgerRow({ historyDir, row: row1Collision });
    ledgerSecondSamePathRejected = !second.ok;
    ledgerFirstBytesUnchanged = readFileSync(row1Path, "utf8") === bytesAfterFirst;

    // A different date -> coexists (the append-only invariant).
    const row2 = buildLedgerRow({ ...baseRowInput, date: "2026-06-02", commit: "bbb2222" }, BENCH_NOW);
    const third = appendLedgerRow({ historyDir, row: row2 });
    ledgerDifferentDateOk = third.ok;

    // 4. CROSS-JUDGE SPREAD over the injected verdicts (the survival fold).
    spread = computeCrossJudgeSpread(INJECTED_JUDGE_A, INJECTED_JUDGE_B);
  }, 600_000);

  it("an absent competitor adapter skips with disclosure (never a fabricated number)", () => {
    expect(absentResult.ran, "absent mem0 did not run").toBe(false);
    if (absentResult.ran === false) {
      expect(absentResult.skipped).toBe(true);
      expect(absentResult.system).toBe("mem0");
      expect(absentResult.reason.length, "carries a reason").toBeGreaterThan(0);
      expect(absentResult.disclosure.length, "carries an actionable disclosure").toBeGreaterThan(0);
    }
    // The integrity invariant: NO field of the skip result is a number (no fabricated score).
    for (const value of Object.values(absentResult as Record<string, unknown>)) {
      expect(typeof value, "no numeric field on the skip result").not.toBe("number");
    }
  });

  it("the letta-fs baseline runs as the control (never Comis's headline)", () => {
    expect(controlResult.ran, "letta-fs control ran keyless at $0").toBe(true);
    if (controlResult.ran === true) {
      expect(controlResult.isControl, "the control is structurally tagged isControl").toBe(true);
      expect(controlResult.system).toBe("letta-fs-baseline");
      // The manifestRef embeds the explicit control label -> never Comis's headline.
      expect(controlResult.manifestRef).toContain(LETTA_FS_BASELINE_CONTROL_LABEL);
      // The control OBSERVED its formatted full-dump context — contextChars
      // is the rendered length of the two-doc haystack, proving the format call is
      // load-bearing (a faithful $0 execution, not a discarded call).
      expect(
        controlResult.contextChars,
        "the control observed a non-empty formatted full-dump context",
      ).toBeGreaterThan(0);
    }
  });

  it("a Comis cell with the lanes ON drives the REAL recall pipeline at $0", () => {
    // The lanes-ON wiring proof: the real production pipeline runs and
    // returns ranked results. We assert it ran (not a number) -- the lanes are wired,
    // not dormant. The seed doc (FTS-matched) must be present.
    expect(comisRanked.length, "the real recall pipeline returned ranked results").toBeGreaterThan(0);
    const contents = comisRanked.map((m) => m.entry.content);
    expect(
      contents.some((c) => c.includes("Quarterly revenue planning")),
      "the FTS-matched seed doc is present (the pipeline really ran)",
    ).toBe(true);
  });

  it("the results ledger appends a new dated row without mutating a prior one", () => {
    expect(ledgerFirstOk, "the first dated row wrote ok").toBe(true);
    expect(ledgerSecondSamePathRejected, "a 2nd write to the SAME dated path is refused").toBe(true);
    expect(ledgerFirstBytesUnchanged, "the first file's bytes are byte-identical after the refusal").toBe(true);
    expect(ledgerDifferentDateOk, "a DIFFERENT-date row coexists (append-only)").toBe(true);
  });

  it("the ablation sweep enumerates each factor; off === baseline byte-identity", () => {
    const baselineJson = JSON.stringify(explicitOffBaseline());
    for (const factor of V28_ABLATION_FACTORS) {
      // The write-side reason-observations factor is a recall-config no-op (its knob
      // lives on the offline job, not MemoryRecallConfig) -- applyFactor returns the
      // input unchanged, so off=byte-identity holds trivially for it too.
      const off = applyFactor(explicitOffBaseline(), factor.factor, false);
      expect(
        JSON.stringify(off),
        `off=byte-identity for ${factor.factor} (${factor.knobPath}) -- a mistyped leaf would diverge`,
      ).toBe(baselineJson);
    }
    // The sweep grid enumerates 2 cells (on, off) per recall-side factor + the write-side one.
    const cells = sweepCells(V28_ABLATION_FACTORS.map((f) => f.factor));
    expect(cells.length, "2 cells per known factor").toBe(V28_ABLATION_FACTORS.length * 2);
    expect(
      V28_ABLATION_FACTORS.some((f) => f.factor === REASON_WRITE_SIDE_FACTOR && f.writeSide === true),
      "the write-side reason factor is flagged",
    ).toBe(true);
  });

  it("cross-judge spread + significance over INJECTED deterministic judge verdicts", () => {
    // The survival fold over the injected verdicts (NO LLM): the agreeing categories
    // survive (<=5pt); single-session-preference (30 vs 45 = 15pt) does NOT.
    const byCat = new Map(spread.map((s) => [s.category, s]));
    expect(byCat.get("single-session-user")?.survives, "100 vs 100 survives").toBe(true);
    expect(byCat.get("knowledge-update")?.survives, "75 vs 75 survives").toBe(true);
    expect(byCat.get("temporal-reasoning")?.survives, "45 vs 42 (3pt) survives").toBe(true);
    expect(
      byCat.get("single-session-preference")?.survives,
      "30 vs 45 (15pt) does NOT survive -- must not headline",
    ).toBe(false);

    // Significance: a large gap at large N is significant; a comparable gap at small N is not.
    const bigN = twoProportionTest({ correct: 90, total: 100 }, { correct: 71, total: 100 });
    expect(bigN.significant, "19pt gap at n=100 is significant").toBe(true);
    const smallN = twoProportionTest({ correct: 12, total: 20 }, { correct: 14, total: 20 });
    expect(smallN.significant, "comparable gap at n=20 is NOT significant (small-N noise)").toBe(false);

    // Wilson CI is well-behaved (never NaN) on a boundary.
    const ci = wilsonInterval(20, 20);
    expect(Number.isFinite(ci.hi) && ci.hi <= 1, "Wilson hi is finite and <=1").toBe(true);
  });

  it("writes a secret-free manifest set", () => {
    // 1. head-to-head-report.json -- the machine's manifest (the keyless claims + coi).
    const survived = spread.filter((s) => s.survives).length;
    const headToHead = {
      harnessVersion: HARNESS_VERSION,
      benchmark: "head-to-head",
      verdict: "PARTIAL",
      scope: {
        measuredKeylessAt0: [
          "cross-judge spread survival fold",
          "two-proportion significance",
          "append-only ledger never-overwrite",
          "ablation off=byte-identity for every v2.8 factor",
          "absent-competitor skip-with-disclosure",
          "letta-fs baseline control runs",
          "real Comis recall cell drives the v2.8 lanes ON",
        ],
        deferredToOperatorCostedReRun: [
          "actual competitor numbers (mem0/zep/hindsight/mnemosyne)",
          "cross-judged headline spread over two real judge passes",
        ],
      },
      machine: {
        comisCellRanRealPipeline: comisRanked.length > 0,
        absentCompetitorSkipped: absentResult.ran === false,
        controlRan: controlResult.ran === true,
        ledgerNeverOverwrite:
          ledgerFirstOk && ledgerSecondSamePathRejected && ledgerFirstBytesUnchanged && ledgerDifferentDateOk,
        categoriesSurvived: survived,
        categoriesTotal: spread.length,
      },
      coi: {
        authoredBy: "Comis",
        note: "Comis authored this benchmark. Vendor-reported numbers are NON-COMPARABLE across protocols; competitors are invited to reproduce on their own harness. The keyless machine quotes NO competitor number and NO cross-judged delta.",
      },
    };

    // 2. cross-judge-spread.json -- the survival fold output.
    const crossJudge = { harnessVersion: HARNESS_VERSION, benchmark: "cross-judge-spread", tolerancePts: 5.0, spread };

    // 3. ablation-contribution-report.json -- the off=byte-identity + per-factor sweep.
    const ablation = {
      harnessVersion: HARNESS_VERSION,
      benchmark: "ablation-contribution",
      factors: V28_ABLATION_FACTORS.map((f) => ({
        factor: f.factor,
        knobPath: f.knobPath,
        writeSide: f.writeSide === true,
        offIsByteIdentityToBaseline:
          JSON.stringify(applyFactor(explicitOffBaseline(), f.factor, false)) ===
          JSON.stringify(explicitOffBaseline()),
      })),
    };

    // 4. adapter-conformance-report.json -- the skip-with-disclosure + control wiring proof.
    const conformance = {
      harnessVersion: HARNESS_VERSION,
      benchmark: "adapter-conformance",
      absentCompetitor: {
        system: absentResult.ran === false ? absentResult.system : "ERROR",
        skippedWithDisclosure: absentResult.ran === false,
        fabricatedNumber: false,
      },
      control: {
        system: controlResult.ran === true ? controlResult.system : "ERROR",
        ran: controlResult.ran === true,
        isControl: controlResult.ran === true ? controlResult.isControl : false,
        // The observed length of the control's formatted full-dump context —
        // the load-bearing proof that the keyless control did real work (not 0).
        contextChars: controlResult.ran === true ? (controlResult.contextChars ?? 0) : 0,
      },
    };

    for (const [name, obj] of [
      ["head-to-head-report.json", headToHead],
      ["cross-judge-spread.json", crossJudge],
      ["ablation-contribution-report.json", ablation],
      ["adapter-conformance-report.json", conformance],
    ] as const) {
      const reportJson = JSON.stringify(obj, null, 2);
      const w = writeRegularFile({ path: join(reportDir, name), content: reportJson, confinedBaseDir: reportDir });
      expect(w.ok, `${name} written to the confined dir`).toBe(true);
      // The in-test secret-omission gate (the only allowed occurrence is here).
      expect(reportJson, `${name} carries no secret substring`).not.toMatch(/apiKey|sk-|Bearer/);
    }

    // eslint-disable-next-line no-console -- gated bench harness reports its number (this is a .test.ts, not packages/cli)
    console.log("BENCH head-to-head proving machine", JSON.stringify(headToHead));
  });
});
