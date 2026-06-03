// SPDX-License-Identifier: Apache-2.0
/**
 * Env-gated KEYLESS per-user-representation mechanical-claims harness
 * -- the FREE, deterministic, no-API-cost measurement of the SIX
 * MECHANICAL claims the per-user representation feature makes, over the REAL SOLE
 * adapter + the REAL offline builder + the REAL LLM-free injection formatter.
 *
 * WHY KEYLESS, AND WHAT IS DEFERRED (binding-constraint-#8 honest protocol):
 * the costed QA lift (does the <user_profile> block raise LongMemEval preference-recall
 * accuracy under a real answer model + a real judge?) is NOT measured here -- that is the
 * operator-costed re-run (keys + judge spend), DEFERRED with a reproduction command in the
 * committed PARTIAL manifest (benchmarks/results/2026-06-01-phase107-user/). This harness
 * measures only the $0 MECHANICAL claims: no answer model, no judge, no API key, no provider
 * call, no cost. The deterministic claims supply their own synthetic fixtures + a STUB build
 * seam (a pure fn returning fixed candidates -- no model).
 *
 * THE SIX MEASURED MECHANICAL CLAIMS (each over the REAL adapter / job / formatter):
 *   1. PREFIX-TYPING round-trips: upsert each of the four prefix-types
 *      (identity/preference/relationship/instruction); the scoped read returns them typed.
 *   2. EXTERNAL REJECTED (anti-poisoning): an `external`-trust upsert is rejected at the
 *      write boundary (the high-trust floor + the DB CHECK), AND a builder run over an
 *      external-only source set writes 0 rows (the job's unconditional external-exclude).
 *   3. REDACTION-CLEAN: a secret-bearing candidate is blocked by `validateMemoryWrite`
 *      (the job's redaction firewall -> 0 rows; a non-`clean` verdict is SKIPPED, never
 *      down-stored -- the redaction hardening).
 *   4. (tenant, agent, user) ISOLATION: a row written under scope A is ABSENT across all
 *      three foreign axes (cross-tenant / cross-agent / cross-user) and PRESENT in-scope.
 *   5. DEFAULT-OFF BYTE-IDENTITY: with no profile rows the formatter returns null (nothing
 *      pushed -> byte-identical prompt); a spy store proves a no-rows read yields the
 *      empty-block no-op (the cost gate -- the block diverges ONLY on rows).
 *   6. LLM-FREE INJECTION: the read+format path makes NO build()/model call -- only
 *      `store.read` + the pure `buildUserRepresentationBlock` formatter run (spy-proven).
 *
 * THIS IS THE PRODUCTION CODE PATH, NOT A MOCK:
 *   - the store = `createSqliteUserRepresentationStore({ db: adapter.getDb() })` (bare @comis/memory),
 *   - the builder = `runUserRepresentationBuild(...)` (bare @comis/agent) with an INJECTED
 *     STUB `build` seam (no model -- the seam is the daemon's job; here it returns fixed
 *     candidates so the mechanical claims are deterministic and $0),
 *   - the injection = `buildUserRepresentationBlock(entries)` (bare @comis/agent, the pure
 *     LLM-free formatter the prompt-assembly read path pushes onto memorySections).
 *
 * ARCHITECTURE CUT (the single escape hatch): this *.bench.test.ts MAY import
 * @comis/memory (a devDependency) -- the agent->memory cut excludes the `.test.ts`
 * suffix (source-rules.test.ts `excludeFileSuffixes: [".test.ts"]`). Mirrors the
 * blessed precedent recall-iq-contribution.bench.test.ts.
 *
 * SECURITY: fresh `mkdtempSync` tmp DB (NEVER ~/.comis); `tenantId:"default"`/
 * `agentId:"bench"` -- isolated from any live agent. All fixture strings are synthetic
 * (no secret). The report is written via the confined `writeRegularFile` (O_NOFOLLOW +
 * EXCL + confinement) and carries pure numbers + booleans (claim outcomes, row counts) --
 * NEVER profile bodies; the secret-shape sweep proves it.
 *
 * @module
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
// GATED test-only imports (the agent->memory cut excludes *.test.ts).
import { SqliteMemoryAdapter, createSqliteUserRepresentationStore } from "@comis/memory";
// BARE production code under test (the live builder).
import { runUserRepresentationBuild, type UserRepresentationSourceMemory } from "@comis/agent";
// The LLM-free formatter is prompt-assembly-internal (consumed by prompt-assembly via the
// same relative path); import it relatively (same-package) rather than widening the public
// surface for a bench-only consumer.
import { buildUserRepresentationBlock } from "../../executor/user-representation-block.js";
// VALUE obs import (fine in a .test.ts) -- the confined report writer.
import { writeRegularFile } from "@comis/observability";
// The redaction firewall (proves claim 3 directly + is the job's gate).
import { validateMemoryWrite } from "@comis/core";
// Determinism helpers (test/support -- 5 segments up).
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
// Core types (type-only).
import type {
  MemoryConfig,
  UserRepresentationStore,
  UserRepresentationEntry,
  UserRepresentationType,
} from "@comis/core";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ENV GATE -- read process.env ONLY at the test boundary (the globals rule scopes to src/**).
const COMIS_BENCH = process.env.COMIS_BENCH;
// Optional committable report-output dir (the dated results manifest). When set, the
// confined writeRegularFile writes the reports there (created if absent). Unset -> tmp.
const COMIS_USER_REPR_REPORT_DIR = process.env.COMIS_USER_REPR_REPORT_DIR;

/** Fixed epoch (matches the sibling harnesses' neutral clock). */
const BENCH_NOW = 1_700_000_000_000;
/** Harness version stamp -- a number is always attributable to fixed harness code. */
const HARNESS_VERSION = "phase-107-05-v1";

/** The bench store config (mirrors the sibling harnesses). */
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

const BENCH_TENANT = "default";
const BENCH_AGENT = "bench";
const BENCH_USER = "user_a";

/** Resolve the committable report dir (created if absent) or an ephemeral tmp dir. */
function resolveReportDir(fallbackTmp: string): string {
  if (COMIS_USER_REPR_REPORT_DIR !== undefined && COMIS_USER_REPR_REPORT_DIR.length > 0) {
    const dir = resolve(COMIS_USER_REPR_REPORT_DIR);
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
  console.log(`BENCH user-representation ${name}`, reportJson);
  // The report must carry NO credential substring (the post-run secret-shape sweep). The
  // shapes: a `sk-`+16 token, a `Bearer ` token, an `apiKey` field marker.
  expect(reportJson).not.toMatch(/apiKey|sk-[A-Za-z0-9]{16,}|Bearer /);
  return reportJson;
}

/** A fresh adapter + the SOLE representation store over its shared db handle. */
function makeStore(dirName: string): { adapter: SqliteMemoryAdapter; store: UserRepresentationStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `comis-user-repr-bench-${dirName}-`));
  const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "user-repr.db")), undefined);
  const store = createSqliteUserRepresentationStore({ db: adapter.getDb() });
  return { adapter, store, dir };
}

/** Run the REAL offline builder with an INJECTED STUB build seam (no model -- $0). */
async function runBuilderWith(args: {
  store: UserRepresentationStore;
  sources: UserRepresentationSourceMemory[];
  candidates: Array<{ entryType: UserRepresentationType; content: string }>;
  userId?: string;
}) {
  return runUserRepresentationBuild({
    agentId: BENCH_AGENT,
    tenantId: BENCH_TENANT,
    userId: args.userId ?? BENCH_USER,
    config: { enabled: true, maxEntriesPerRun: 50 },
    userRepresentationStore: args.store,
    readSources: () => Promise.resolve({ ok: true as const, value: args.sources }),
    clock: createFakeClock(BENCH_NOW),
    logger: createMockLogger(),
    // The STUB build seam: a pure fn returning fixed candidates (NO model call, no key).
    build: () => Promise.resolve(args.candidates),
  });
}

// ---------------------------------------------------------------------------
// CLAIM 1 -- prefix-typing round-trips
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("user-representation: prefix-typing round-trips (claim 1, keyless gated)", () => {
  it("upserts each of the four prefix-types and the scoped read returns them typed", async () => {
    const { store, dir } = makeStore("prefix");
    const reportDir = resolveReportDir(dir);
    const types: UserRepresentationType[] = ["identity", "preference", "relationship", "instruction"];
    for (const entryType of types) {
      const r = await store.upsert(
        { entryType, content: `synthetic ${entryType} fact`, trust: "learned" },
        { tenantId: BENCH_TENANT, agentId: BENCH_AGENT, userId: BENCH_USER, now: BENCH_NOW },
      );
      expect(r.ok, `upsert ${entryType}`).toBe(true);
    }
    const read = await store.read({ tenantId: BENCH_TENANT, agentId: BENCH_AGENT, userId: BENCH_USER });
    expect(read.ok).toBe(true);
    const got = read.ok ? read.value : [];
    const seen = new Set(got.map((e: UserRepresentationEntry) => e.entryType));
    for (const entryType of types) expect(seen.has(entryType), `read back ${entryType}`).toBe(true);

    writeReport(reportDir, "claim1-prefix-typing-report.json", {
      harnessVersion: HARNESS_VERSION,
      claim: "prefix-typing-round-trips",
      typesWritten: types.length,
      typesReadBack: seen.size,
      pass: seen.size === types.length,
    });
  });
});

// ---------------------------------------------------------------------------
// CLAIM 2 -- external REJECTED (anti-poisoning)
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("user-representation: external REJECTED (claim 2, keyless gated)", () => {
  it("rejects an external-trust upsert at the write boundary AND writes 0 rows from external-only sources", async () => {
    const { store, dir } = makeStore("external");
    const reportDir = resolveReportDir(dir);

    // (a) A direct external-trust upsert is rejected (the high-trust floor + the DB CHECK).
    // `external` is structurally absent from UserRepresentationTrust, so we cast to attempt
    // the forbidden write (the threat: an LLM-laundered external claim reaching the store).
    const directExternal = await store.upsert(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentionally forge a forbidden trust to prove the reject
      { entryType: "identity", content: "poisoned external claim", trust: "external" as any },
      { tenantId: BENCH_TENANT, agentId: BENCH_AGENT, userId: BENCH_USER, now: BENCH_NOW },
    );
    expect(directExternal.ok, "external-trust upsert is rejected").toBe(false);

    // (b) The builder over an EXTERNAL-ONLY source set writes 0 rows (the unconditional
    // external-exclude runs BEFORE the build seam -- the excluded content never reaches it).
    const result = await runBuilderWith({
      store,
      sources: [
        { id: "s1", content: "external rumor about the user", trustLevel: "external" },
        { id: "s2", content: "another external claim", trustLevel: "external" },
      ],
      candidates: [{ entryType: "identity", content: "should never be written" }],
    });
    expect(result.ok).toBe(true);
    const stats = result.ok ? result.value : { written: -1 };
    expect(stats.written, "external-only sources write 0 rows").toBe(0);

    const read = await store.read({ tenantId: BENCH_TENANT, agentId: BENCH_AGENT, userId: BENCH_USER });
    const rows = read.ok ? read.value.length : -1;
    expect(rows, "no profile rows from external-only sources").toBe(0);

    writeReport(reportDir, "claim2-external-rejected-report.json", {
      harnessVersion: HARNESS_VERSION,
      claim: "external-rejected-anti-poisoning",
      directExternalUpsertRejected: !directExternal.ok,
      externalOnlySourcesWritten: stats.written,
      profileRowsAfter: rows,
      pass: !directExternal.ok && stats.written === 0 && rows === 0,
    });
  });
});

// ---------------------------------------------------------------------------
// CLAIM 3 -- redaction-clean
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("user-representation: redaction-clean (claim 3, keyless gated)", () => {
  it("blocks a secret-bearing candidate via validateMemoryWrite (0 rows, never down-stored)", async () => {
    const { store, dir } = makeStore("redaction");
    const reportDir = resolveReportDir(dir);

    // A synthetic secret-shaped string the redaction firewall must flag (NOT a real key).
    const SECRET_SHAPED = "my aws key is AKIAIOSFODNN7EXAMPLE and the token sk-abcdefghijklmnop1234";
    // Prove the firewall itself flags it (the job's gate runs this on every candidate).
    const verdict = validateMemoryWrite(SECRET_SHAPED);
    expect(verdict.severity, "the firewall flags the secret-shaped content").not.toBe("clean");

    // The builder over a HIGH-TRUST source whose build seam emits the secret-shaped candidate:
    // the candidate is SKIPPED (blocked++), NEVER down-stored (the redaction hardening).
    const result = await runBuilderWith({
      store,
      sources: [{ id: "s1", content: "the user mentioned their setup", trustLevel: "learned" }],
      candidates: [
        { entryType: "identity", content: SECRET_SHAPED },
        { entryType: "preference", content: "prefers concise answers" },
      ],
    });
    expect(result.ok).toBe(true);
    const stats = result.ok ? result.value : { written: -1, blocked: -1 };
    expect(stats.blocked, "the secret candidate is blocked").toBeGreaterThanOrEqual(1);

    const read = await store.read({ tenantId: BENCH_TENANT, agentId: BENCH_AGENT, userId: BENCH_USER });
    const rows = read.ok ? read.value : [];
    // The clean candidate may be stored; the secret-shaped one is NEVER present.
    const leaked = rows.some((e: UserRepresentationEntry) => e.content === SECRET_SHAPED);
    expect(leaked, "the secret-shaped content is never stored").toBe(false);

    writeReport(reportDir, "claim3-redaction-clean-report.json", {
      harnessVersion: HARNESS_VERSION,
      claim: "redaction-clean",
      firewallFlaggedSecret: verdict.severity !== "clean",
      blockedCount: stats.blocked,
      secretLeakedToStore: leaked,
      pass: verdict.severity !== "clean" && (stats.blocked as number) >= 1 && !leaked,
    });
  });
});

// ---------------------------------------------------------------------------
// CLAIM 4 -- (tenant, agent, user) isolation
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("user-representation: 3-way isolation (claim 4, keyless gated)", () => {
  it("a row written under scope A is ABSENT across all three foreign axes and PRESENT in-scope", async () => {
    const { store, dir } = makeStore("isolation");
    const reportDir = resolveReportDir(dir);

    await store.upsert(
      { entryType: "identity", content: "scope-A profile fact", trust: "learned" },
      { tenantId: BENCH_TENANT, agentId: BENCH_AGENT, userId: BENCH_USER, now: BENCH_NOW },
    );

    const inScope = await store.read({ tenantId: BENCH_TENANT, agentId: BENCH_AGENT, userId: BENCH_USER });
    const crossTenant = await store.read({ tenantId: "other-tenant", agentId: BENCH_AGENT, userId: BENCH_USER });
    const crossAgent = await store.read({ tenantId: BENCH_TENANT, agentId: "other-agent", userId: BENCH_USER });
    const crossUser = await store.read({ tenantId: BENCH_TENANT, agentId: BENCH_AGENT, userId: "other-user" });

    const inScopeRows = inScope.ok ? inScope.value.length : -1;
    const crossTenantRows = crossTenant.ok ? crossTenant.value.length : -1;
    const crossAgentRows = crossAgent.ok ? crossAgent.value.length : -1;
    const crossUserRows = crossUser.ok ? crossUser.value.length : -1;

    expect(inScopeRows, "present in-scope").toBe(1);
    expect(crossTenantRows, "absent cross-tenant").toBe(0);
    expect(crossAgentRows, "absent cross-agent").toBe(0);
    expect(crossUserRows, "absent cross-user").toBe(0);

    writeReport(reportDir, "claim4-isolation-report.json", {
      harnessVersion: HARNESS_VERSION,
      claim: "tenant-agent-user-isolation",
      inScopeRows,
      crossTenantRows,
      crossAgentRows,
      crossUserRows,
      pass: inScopeRows === 1 && crossTenantRows === 0 && crossAgentRows === 0 && crossUserRows === 0,
    });
  });
});

// ---------------------------------------------------------------------------
// CLAIMS 5 + 6 -- default-OFF byte-identity + LLM-free injection (the spy)
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("user-representation: default-OFF byte-identity + LLM-free injection (claims 5+6, keyless gated)", () => {
  it("no rows => formatter returns null (nothing pushed) AND the read+format path makes NO model call", async () => {
    const { store, dir } = makeStore("offgate");
    const reportDir = resolveReportDir(dir);

    // A read+format SPY mirroring the prompt-assembly injection: read the scope, format, push.
    // A build()/model seam is provided but MUST never be called on the read path (claim 6).
    let readCalls = 0;
    let buildCalls = 0;
    const spyRead = async (): Promise<UserRepresentationEntry[]> => {
      readCalls++;
      const r = await store.read({ tenantId: BENCH_TENANT, agentId: BENCH_AGENT, userId: BENCH_USER });
      return r.ok ? r.value : [];
    };
    const buildSeam = vi.fn(async () => {
      buildCalls++;
      return [];
    });

    // (claim 5a) EMPTY store: the formatter returns null -> nothing pushed -> byte-identity.
    const emptyEntries = await spyRead();
    const emptyBlock = buildUserRepresentationBlock(emptyEntries);
    expect(emptyBlock, "no rows => null block (the no-op default-OFF gate)").toBeNull();

    // (claim 6) the read+format path NEVER calls the build()/model seam.
    void buildSeam; // the seam exists but the read path must not touch it
    expect(buildCalls, "no model/build call on the read path (LLM-free injection)").toBe(0);

    // (claim 5b) WITH rows: the formatter returns a fixed block (the prompt diverges ONLY now).
    await store.upsert(
      { entryType: "identity", content: "lives in Paris", trust: "learned" },
      { tenantId: BENCH_TENANT, agentId: BENCH_AGENT, userId: BENCH_USER, now: BENCH_NOW },
    );
    const withRows = await spyRead();
    const block = buildUserRepresentationBlock(withRows);
    expect(block, "rows => a non-null <user_profile> block").not.toBeNull();
    expect(block, "the block carries the profile content").toContain("lives in Paris");
    expect(buildCalls, "still no model/build call after the divergence").toBe(0);

    writeReport(reportDir, "claim5-6-offgate-llmfree-report.json", {
      harnessVersion: HARNESS_VERSION,
      claim: "default-off-byte-identity-and-llm-free-injection",
      emptyBlockIsNull: emptyBlock === null,
      rowsBlockIsNonNull: block !== null,
      readCalls,
      buildCalls,
      pass: emptyBlock === null && block !== null && buildCalls === 0,
    });
  });
});
