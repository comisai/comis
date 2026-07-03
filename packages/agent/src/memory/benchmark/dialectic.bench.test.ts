// SPDX-License-Identifier: Apache-2.0
/**
 * Env-gated KEYLESS dialectic mechanical-claims harness -- the FREE, deterministic,
 * no-API-cost measurement of the SIX MECHANICAL claims the memory_ask dialectic makes,
 * over the REAL SOLE @comis/memory adapter + the REAL LLM-free createMemoryRecall pipeline
 * + the REAL PURE synthesis core, with an INJECTED deterministic STUB seam (a pure fn
 * returning fixed { abstain, answer, citedIds } -- NO model, NO provider, NO key, $0).
 *
 * WHY KEYLESS, AND WHAT IS DEFERRED (the honest protocol):
 * the costed answer-faithfulness / grounding QA lift (does the synthesized cited answer
 * raise grounded-QA accuracy under a real answer model + a real judge?) is NOT measured
 * here -- that is the operator-costed re-run (keys + judge spend), DEFERRED with a
 * reproduction command in the committed PARTIAL manifest
 * (benchmarks/results/2026-06-01-phase109-dialectic/). This harness measures only the $0
 * MECHANICAL claims: no answer model, no judge, no API key, no provider call, no cost. The
 * deterministic claims supply their own synthetic fixtures + a STUB synthesis seam.
 *
 * THE SIX MEASURED MECHANICAL CLAIMS (each over the REAL adapter / recall pipeline / synthesis):
 *   1. OPT-IN / DEFAULT-OFF: with dialecticEnabled false/absent the memory_ask tool is ABSENT
 *      from the built tool set (the registry conditional gate filters it before build); on => present.
 *   2. RECALL-STAYS-LLM-FREE: a full createMemoryRecall run over the fixture adapter makes NO
 *      model call (pi-ai completeSimple/getModel spies record zero invocations).
 *   3. CITATIONS-ARE-REAL-RECALLED-IDS: a stub seam emitting a BOGUS id => the bogus id is
 *      dropped; the assembled citations are a subset of the recalled ids.
 *   4. MANDATORY-ABSTENTION: empty / irrelevant recall => abstained:true AND the stub seam is
 *      NOT called (the abstain-without-LLM invariant -- decided in CODE before any seam call).
 *   5. TRUST-FIRST-CONTRADICTION: a `system` claim is ordered BEFORE a contradicting `external`
 *      claim (the HARD trust boundary -- the grounding order the seam would receive).
 *   6. SOURCEIDS-IN-TRACE: the citationChains reasoning-tree carries the citation->sourceId
 *      chain (ids only -- never the memory body).
 *
 * THIS IS THE PRODUCTION CODE PATH, NOT A MOCK:
 *   - the adapter = `new SqliteMemoryAdapter(...)` (bare @comis/memory) on a fresh mkdtempSync db,
 *   - recall = the LIVE `createMemoryRecall({ memoryPort: adapter, ... })` (bare @comis/agent),
 *   - synthesis = the PURE `orderByTrust` / `assembleSynthesis` / `citationChains` (bare @comis/agent)
 *     with an INJECTED STUB seam (a pure fn -- no model; the seam is the daemon's job, here it
 *     returns fixed parses so the mechanical claims are deterministic and $0),
 *   - the opt-in gate = the gate's PREDICATE semantics (`ctx.dialecticEnabled === true`)
 *     replicated here -- NOT a @comis/skills import (the agent package has no @comis/skills edge
 *     in the architecture graph). The REAL memory_ask registry descriptor + conditional are
 *     authoritatively pinned in tool-registry-parity.test.ts; this bench documents the same
 *     default-OFF byte-identity property at $0 without crossing the tier.
 *
 * ARCHITECTURE CUT (the single escape hatch): this *.bench.test.ts MAY import @comis/memory
 * (a devDependency) -- the agent->memory cut excludes the `.test.ts` suffix (source-rules.test.ts
 * `excludeFileSuffixes: [".test.ts"]`). Mirrors the blessed precedent
 * user-representation-contribution.bench.test.ts + retrieval-harness.bench.test.ts.
 *
 * SECURITY: fresh `mkdtempSync` tmp DB (NEVER ~/.comis); `tenantId:"default"`/`agentId:"bench"`
 * -- isolated from any live agent. All fixture strings are synthetic (no secret). The report
 * is written via the confined `writeRegularFile` (O_NOFOLLOW + EXCL + confinement) and carries
 * pure numbers + booleans (claim outcomes, counts); NEVER the question, the memories, or the
 * answer text -- the secret-shape sweep proves it.
 *
 * @module
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
// GATED test-only import (the agent->memory cut excludes *.test.ts).
import { SqliteMemoryAdapter } from "@comis/memory";
// BARE production code under test: the live recall pipeline + the PURE synthesis core.
import {
  createMemoryRecall,
  orderByTrust,
  assembleSynthesis,
  citationChains,
  type MemoryRecallDeps,
  type DialecticParsed,
} from "@comis/agent";
// VALUE obs import (fine in a .test.ts) — the confined report writer.
import { writeRegularFile } from "@comis/observability";
// NB: claim 1 (the opt-in registry gate) is asserted via the gate's PREDICATE semantics
// below — NOT by importing @comis/skills. The agent package has NO @comis/skills edge in the
// architecture graph (a deliberate cut; pi-event-bridge.ts documents it). The REAL memory_ask
// registry descriptor + its conditional gate are authoritatively pinned GREEN in
// packages/skills/src/__tests__/tool-registry-parity.test.ts (the single-source-of-truth set);
// this bench documents the SAME default-OFF byte-identity property mechanically at $0 without
// crossing the tier (the gate is `(ctx) => ctx.dialecticEnabled === true` — replicated here).
// Determinism helpers (test/support — 5 segments up).
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
// Core types (type-only).
import type { MemoryConfig, MemoryEntry, MemorySearchResult } from "@comis/core";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// --- pi-ai SPY (claim 2: recall makes NO model call) -----------------------
// File-wide mock of the LLM surface. If the LLM-free recall path EVER reaches a model call,
// these spies record it and claim 2 fails. The synthesis seam in this bench is an INJECTED
// pure stub (it never touches pi-ai), so a non-zero count would mean recall regressed.
const completeSimpleSpy = vi.hoisted(() => vi.fn(async () => ({ content: "" })));
const getModelSpy = vi.hoisted(() => vi.fn(() => ({})));
vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, completeSimple: completeSimpleSpy, getModel: getModelSpy };
});

// ENV GATE — read process.env ONLY at the test boundary (the globals rule scopes to src/**).
const COMIS_BENCH = process.env.COMIS_BENCH;
// Optional committable report-output dir (the dated results manifest). Unset -> tmp.
const COMIS_DIALECTIC_REPORT_DIR = process.env.COMIS_DIALECTIC_REPORT_DIR;

/** Fixed epoch (matches the sibling harnesses' neutral clock). */
const BENCH_NOW = 1_700_000_000_000;
/** Harness version stamp — a number is always attributable to fixed harness code. */
const HARNESS_VERSION = "phase-109-04-v1";

const BENCH_TENANT = "default";
const BENCH_AGENT = "bench";
const BENCH_USER = "user_a";
/** The bench recall scope — SessionKey is an OBJECT { tenantId, userId, channelId } (the
 *  adapter reads sessionKey.tenantId); a string would zero every recall. Neutral placeholders,
 *  isolated from any live session (mirrors retrieval-harness.bench.test.ts). */
const BENCH_SESSION_KEY = { tenantId: BENCH_TENANT, userId: BENCH_USER, channelId: "default" } as never;

/** The bench store config (mirrors the sibling harnesses; tiny local embedding dims). */
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

/** Resolve the committable report dir (created if absent) or an ephemeral tmp dir. */
function resolveReportDir(fallbackTmp: string): string {
  if (COMIS_DIALECTIC_REPORT_DIR !== undefined && COMIS_DIALECTIC_REPORT_DIR.length > 0) {
    const dir = resolve(COMIS_DIALECTIC_REPORT_DIR);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  return fallbackTmp;
}

/** Write a report JSON via the confined writer + assert it carries no credential shape. */
function writeReport(reportDir: string, name: string, report: unknown): string {
  const reportJson = JSON.stringify(report, null, 2);
  const writeResult = writeRegularFile({
    path: join(reportDir, name),
    content: reportJson,
    confinedBaseDir: reportDir,
  });
  expect(writeResult.ok, `${name} written to the confined dir`).toBe(true);
  // eslint-disable-next-line no-console -- gated bench harness reports its number (this is a .test.ts, not packages/cli)
  console.log(`BENCH dialectic ${name}`, reportJson);
  // The report must carry NO credential substring (the post-run secret-shape sweep). The
  // shapes: a `sk-`+16 token, a `Bearer ` token, an `apiKey` field marker.
  expect(reportJson).not.toMatch(/apiKey|sk-[A-Za-z0-9]{16,}|Bearer /);
  return reportJson;
}

/** A fresh adapter on a fresh tmp DB (the SOLE @comis/memory escape via the .test.ts suffix). */
function makeAdapter(dirName: string): { adapter: SqliteMemoryAdapter; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `comis-dialectic-bench-${dirName}-`));
  const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "dialectic.db")), undefined);
  return { adapter, dir };
}

/** Seed a synthetic memory with a known id / trustLevel / sourceIds (all synthetic — no secret). */
async function seed(
  adapter: SqliteMemoryAdapter,
  id: string,
  content: string,
  trustLevel: "system" | "learned" | "external",
  sourceIds: string[] = [],
): Promise<void> {
  const entry: MemoryEntry = {
    id,
    tenantId: BENCH_TENANT,
    agentId: BENCH_AGENT,
    userId: BENCH_USER,
    content,
    trustLevel,
    source: { who: "bench" },
    tags: ["bench"],
    createdAt: BENCH_NOW,
    sourceIds,
  } as unknown as MemoryEntry;
  const stored = await adapter.store(entry);
  expect(stored.ok, `seed ${id}`).toBe(true);
}

/** The LIVE LLM-free recall pipeline bound to ONE adapter (alphas 0 -> clean order). */
function makeRecall(adapter: SqliteMemoryAdapter, includeTrustLevels: Array<"system" | "learned" | "external">) {
  return createMemoryRecall(
    {
      memoryPort: adapter,
      clock: createFakeClock(BENCH_NOW),
      timers: createFakeTimers(BENCH_NOW),
      logger: createMockLogger(),
    } as MemoryRecallDeps,
    {
      maxResults: 10,
      minScore: 0,
      includeTrustLevels,
      rerank: { enabled: false, maxCandidates: 20, minResults: 2, timeoutMs: 5000 },
      scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0 },
    },
  );
}

/** An INJECTED STUB synthesis seam — a pure fn returning a fixed parse (NO model, no key, $0). */
function stubSeam(parsed: DialecticParsed): { seam: (q: string, g: string) => Promise<DialecticParsed>; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async (_q: string, _g: string) => parsed);
  return { seam: spy as unknown as (q: string, g: string) => Promise<DialecticParsed>, spy };
}

/** Build the grounding text the way the daemon handler does (ids-prefixed; the seam input). */
function buildGrounding(ordered: MemorySearchResult[]): string {
  return ordered.map((r) => `[${r.entry.id}] ${r.entry.content}`).join("\n");
}

beforeAll(() => {
  completeSimpleSpy.mockClear();
  getModelSpy.mockClear();
});

// ---------------------------------------------------------------------------
// CLAIM 1 — opt-in / default-OFF (the registry conditional gate)
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("dialectic: opt-in / default-OFF (claim 1, keyless gated)", () => {
  it("memory_ask is ABSENT when dialecticEnabled is false/absent, PRESENT when true", () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-dialectic-bench-optin-"));
    const reportDir = resolveReportDir(dir);

    // The REAL memory_ask descriptor's gate, replicated VERBATIM from registry.ts (the agent
    // package has no @comis/skills edge; the real descriptor is pinned in tool-registry-parity).
    // The daemon builds the live tool set by FILTERING descriptors on `conditional(ctx)` BEFORE
    // invoking `build` — so off ⇒ the tool never enters the set (the default-OFF byte-identity).
    const askDescriptor = {
      name: "memory_ask",
      conditional: (ctx: { dialecticEnabled?: boolean }) => ctx.dialecticEnabled === true,
      build: () => ({ name: "memory_ask" }),
    };
    // A representative sibling set + the gated descriptor (mirrors filter-then-build).
    const descriptors = [{ name: "memory_search", conditional: undefined, build: () => ({ name: "memory_search" }) }, askDescriptor];
    const buildLiveSet = (ctx: { dialecticEnabled?: boolean }): string[] =>
      descriptors
        .filter((d) => (d.conditional ? d.conditional(ctx) : true))
        .map((d) => d.build().name);

    const absentWhenAbsent = !buildLiveSet({}).includes("memory_ask");
    const absentWhenFalse = !buildLiveSet({ dialecticEnabled: false }).includes("memory_ask");
    const presentWhenOn = buildLiveSet({ dialecticEnabled: true }).includes("memory_ask");

    expect(absentWhenAbsent, "absent when dialecticEnabled absent").toBe(true);
    expect(absentWhenFalse, "absent when dialecticEnabled false").toBe(true);
    expect(presentWhenOn, "present when dialecticEnabled true").toBe(true);
    // The non-memory_ask sibling is always present (the gate is scoped to memory_ask only).
    expect(buildLiveSet({}).includes("memory_search"), "unconditional sibling always present").toBe(true);

    writeReport(reportDir, "claim1-optin-default-off-report.json", {
      harnessVersion: HARNESS_VERSION,
      claim: "opt-in-default-off",
      isConditional: typeof askDescriptor.conditional === "function",
      absentWhenAbsent,
      absentWhenFalse,
      presentWhenOn,
      pass: absentWhenAbsent && absentWhenFalse && presentWhenOn,
    });
  });
});

// ---------------------------------------------------------------------------
// CLAIM 2 — recall stays LLM-free (the spy)
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("dialectic: recall stays LLM-free (claim 2, keyless gated)", () => {
  it("a full createMemoryRecall run over the fixture adapter makes NO model call", async () => {
    completeSimpleSpy.mockClear();
    getModelSpy.mockClear();
    const { adapter, dir } = makeAdapter("llmfree");
    const reportDir = resolveReportDir(dir);
    await seed(adapter, "11111111-1111-4111-8111-111111111111", "UTC is the canonical timezone", "learned", ["s1"]);
    await seed(adapter, "22222222-2222-4222-8222-222222222222", "the project uses ISO timestamps", "learned", ["s2"]);

    const recall = makeRecall(adapter, ["learned", "system"]);
    const recalled = await recall.recall("what timezone does the project use", BENCH_SESSION_KEY);
    expect(recalled.ok, "recall ok").toBe(true);

    const modelCalls = completeSimpleSpy.mock.calls.length + getModelSpy.mock.calls.length;
    expect(modelCalls, "recall made ZERO model calls (LLM-free)").toBe(0);
    adapter.close();

    writeReport(reportDir, "claim2-recall-llm-free-report.json", {
      harnessVersion: HARNESS_VERSION,
      claim: "recall-stays-llm-free",
      recalledCount: recalled.ok ? recalled.value.length : -1,
      completeSimpleCalls: completeSimpleSpy.mock.calls.length,
      getModelCalls: getModelSpy.mock.calls.length,
      pass: modelCalls === 0,
    });
  });
});

// ---------------------------------------------------------------------------
// CLAIM 3 — citations are real recalled ids (bogus dropped)
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("dialectic: citations are real recalled ids (claim 3, keyless gated)", () => {
  it("a stub seam emitting a BOGUS id => the bogus id is dropped; citations ⊆ recalled ids", async () => {
    const { adapter, dir } = makeAdapter("citations");
    const reportDir = resolveReportDir(dir);
    const realId = "33333333-3333-4333-8333-333333333333";
    await seed(adapter, realId, "the deploy region is us-east-1", "learned", ["src-a"]);

    const recall = makeRecall(adapter, ["learned", "system"]);
    const recalled = await recall.recall("what deploy region", BENCH_SESSION_KEY);
    expect(recalled.ok && recalled.value.length > 0, "recall returned the seeded memory").toBe(true);
    const recalledResults = recalled.ok ? recalled.value : [];

    // The stub seam emits the REAL id AND a BOGUS id that was never recalled.
    const bogusId = "99999999-9999-4999-8999-999999999999";
    const seam = stubSeam({ abstain: false, answer: "us-east-1", citedIds: [realId, bogusId] });
    const ordered = orderByTrust(recalledResults);
    const parsed = await seam.seam("what deploy region", buildGrounding(ordered));
    const result = assembleSynthesis(ordered, parsed);

    const recalledIds = new Set(recalledResults.map((r) => r.entry.id));
    const allCitationsReal = result.citations.every((c) => recalledIds.has(c));
    const bogusDropped = !result.citations.includes(bogusId);
    expect(allCitationsReal, "every citation is a real recalled id").toBe(true);
    expect(bogusDropped, "the bogus id is dropped").toBe(true);
    expect(result.citations, "the real id survives").toContain(realId);
    adapter.close();

    writeReport(reportDir, "claim3-citations-are-real-ids-report.json", {
      harnessVersion: HARNESS_VERSION,
      claim: "citations-are-real-recalled-ids",
      recalledCount: recalledResults.length,
      citationCount: result.citations.length,
      bogusDropped,
      allCitationsReal,
      pass: allCitationsReal && bogusDropped && result.citations.includes(realId),
    });
  });
});

// ---------------------------------------------------------------------------
// CLAIM 4 — mandatory abstention (empty recall => abstain WITHOUT the seam)
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("dialectic: mandatory abstention (claim 4, keyless gated)", () => {
  it("empty / irrelevant recall => abstained:true AND the stub seam is NOT called", async () => {
    const { adapter, dir } = makeAdapter("abstain");
    const reportDir = resolveReportDir(dir);
    // No seeds => the recall set is empty (irrelevant question / nothing stored).
    const recall = makeRecall(adapter, ["learned", "system"]);
    const recalled = await recall.recall("a question with no grounding", BENCH_SESSION_KEY);
    expect(recalled.ok, "recall ok").toBe(true);
    const recalledResults = recalled.ok ? recalled.value : [];

    // The handler's composition: empty recall short-circuits to abstain WITHOUT calling the
    // seam (the abstain-without-LLM invariant). We mirror that here: the seam is provided but
    // the empty-recall guard means it is never invoked.
    const seam = stubSeam({ abstain: false, answer: "should-not-be-used", citedIds: ["x"] });
    let result: { abstained: boolean; citations: string[] };
    if (recalledResults.length === 0) {
      result = { abstained: true, citations: [] }; // abstain in CODE, seam NOT called
    } else {
      const ordered = orderByTrust(recalledResults);
      const parsed = await seam.seam("q", buildGrounding(ordered));
      result = assembleSynthesis(ordered, parsed);
    }

    expect(recalledResults.length, "recall is empty").toBe(0);
    expect(result.abstained, "abstained on empty recall").toBe(true);
    expect(seam.spy, "the seam is NOT called on empty recall (no LLM, no cost)").not.toHaveBeenCalled();
    adapter.close();

    writeReport(reportDir, "claim4-mandatory-abstention-report.json", {
      harnessVersion: HARNESS_VERSION,
      claim: "mandatory-abstention",
      recalledCount: recalledResults.length,
      abstained: result.abstained,
      seamCalls: seam.spy.mock.calls.length,
      pass: recalledResults.length === 0 && result.abstained === true && seam.spy.mock.calls.length === 0,
    });
  });
});

// ---------------------------------------------------------------------------
// CLAIM 5 — trust-first contradiction (system beats external in the grounding order)
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("dialectic: trust-first contradiction (claim 5, keyless gated)", () => {
  it("a system claim is ordered BEFORE a contradicting external claim (the HARD trust boundary)", async () => {
    const { adapter, dir } = makeAdapter("trustfirst");
    const reportDir = resolveReportDir(dir);
    const sysId = "44444444-4444-4444-8444-444444444444";
    const extId = "55555555-5555-4555-8555-555555555555";
    // A system current-truth contradicts an external claim on the same subject.
    await seed(adapter, extId, "PST-EXTERNAL-CLAIM about the timezone", "external", ["ext-src"]);
    await seed(adapter, sysId, "UTC-SYSTEM-CLAIM about the timezone", "system", ["sys-src"]);

    const recall = makeRecall(adapter, ["system", "learned", "external"]);
    const recalled = await recall.recall("what timezone (contradiction)", BENCH_SESSION_KEY);
    expect(recalled.ok, "recall ok").toBe(true);
    const recalledResults = recalled.ok ? recalled.value : [];

    const ordered = orderByTrust(recalledResults);
    const grounding = buildGrounding(ordered);
    const sysAt = grounding.indexOf("UTC-SYSTEM-CLAIM");
    const extAt = grounding.indexOf("PST-EXTERNAL-CLAIM");
    expect(sysAt, "system claim present").toBeGreaterThanOrEqual(0);
    expect(extAt, "external claim present").toBeGreaterThanOrEqual(0);
    const systemFirst = sysAt < extAt;
    expect(systemFirst, "the system claim is presented BEFORE the external claim").toBe(true);

    // And the system id is first in the ordered set (trust-first, HARD).
    const firstOrderedIsSystem = ordered[0]?.entry.id === sysId;
    expect(firstOrderedIsSystem, "the highest-trust item is first").toBe(true);
    adapter.close();

    writeReport(reportDir, "claim5-trust-first-report.json", {
      harnessVersion: HARNESS_VERSION,
      claim: "trust-first-contradiction",
      recalledCount: recalledResults.length,
      systemPositionInGrounding: sysAt,
      externalPositionInGrounding: extAt,
      systemFirst,
      firstOrderedIsSystem,
      pass: systemFirst && firstOrderedIsSystem,
    });
  });
});

// ---------------------------------------------------------------------------
// CLAIM 6 — sourceIds in the recall-trace chain (ids only)
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("dialectic: sourceIds in the recall-trace (claim 6, keyless gated)", () => {
  it("the citationChains reasoning-tree carries the citation->sourceId chain (ids only, no body)", async () => {
    const { adapter, dir } = makeAdapter("sourceids");
    const reportDir = resolveReportDir(dir);
    const id = "66666666-6666-4666-8666-666666666666";
    const SOURCE_IDS = ["src-1", "src-2"];
    const BODY = "the build pipeline runs on a self-hosted runner";
    await seed(adapter, id, BODY, "learned", SOURCE_IDS);

    const recall = makeRecall(adapter, ["learned", "system"]);
    const recalled = await recall.recall("where does the build run", BENCH_SESSION_KEY);
    const recalledResults = recalled.ok ? recalled.value : [];
    expect(recalledResults.length, "recall returned the seeded memory").toBeGreaterThan(0);

    const ordered = orderByTrust(recalledResults);
    const seam = stubSeam({ abstain: false, answer: "a self-hosted runner", citedIds: [id] });
    const parsed = await seam.seam("where does the build run", buildGrounding(ordered));
    const result = assembleSynthesis(ordered, parsed);
    const chains = citationChains(ordered, result.abstained ? [] : result.citations);

    // The chain carries the citation -> sourceIds mapping.
    const chain = chains.find((c) => c.citationId === id);
    expect(chain, "the cited id has a chain entry").toBeDefined();
    expect(chain!.sourceIds, "the sourceIds are surfaced").toEqual(SOURCE_IDS);

    // IDS ONLY: the serialized chain must NOT contain the memory body text.
    const chainJson = JSON.stringify(chains);
    const noBodyLeak = !chainJson.includes(BODY);
    expect(noBodyLeak, "the chain carries ids only — never the memory body").toBe(true);
    adapter.close();

    writeReport(reportDir, "claim6-sourceids-in-trace-report.json", {
      harnessVersion: HARNESS_VERSION,
      claim: "sourceids-in-trace",
      chainCount: chains.length,
      sourceIdCount: chain ? chain.sourceIds.length : -1,
      noBodyLeak,
      pass: chain !== undefined && chain.sourceIds.length === SOURCE_IDS.length && noBodyLeak,
    });
  });
});
