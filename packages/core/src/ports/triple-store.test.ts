// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { ok, type Result } from "@comis/shared";
// Side-effecting (value) import so the RED state is reproducible from this test
// commit alone: vitest must RESOLVE `./triple-store.js` at runtime. The module is
// type-only (mirrors memory-causal-store.ts) so it resolves to an empty
// namespace; the types are pulled via the `import type` below. A bare
// `import type` would be stripped by the transform and never resolve, hiding RED
// if the symbols were missing.
//
// Because this port is type-only, the type-level assertions below erase at
// runtime (vitest does not type-check). The runtime RED proof for the
// TripleStorePort port shape is therefore the source-grep guard in the first
// test: it FAILS on pre-patch (the file/method/type literals do not exist yet)
// and the type-only port stays type-only (no zod, no @comis/memory import).
import "./triple-store.js";
import type {
  TripleStorePort,
  TripleScope,
  TripleTrust,
  TripleInput,
} from "./triple-store.js";
import type { MemorySearchResult } from "./memory.js";

const here = dirname(fileURLToPath(import.meta.url));
const portSrc = readFileSync(resolve(here, "./triple-store.ts"), "utf8");

/**
 * The segregated `TripleStorePort` foundation.
 *
 * The trust-first bi-temporal knowledge-graph port lives type-only in
 * @comis/core (mirrors memory-causal-store.ts): the agent consumes it by TYPE,
 * the sole adapter lives in @comis/memory, the daemon injects it. The port
 * carries the WRITE (`upsertTriple`), the as-of READ (`asOf`), and the
 * graph-spread lane READ (`spreadLane`).
 */
describe("TripleStorePort — type-only segregated KG port", () => {
  it("declares upsertTriple/asOf/spreadLane on TripleStorePort and stays type-only (no zod, no @comis/memory)", () => {
    // Runtime RED proof: fails on pre-patch source where the file/method/type are absent.
    expect(portSrc, "TripleStorePort interface must be declared").toMatch(
      /export\s+interface\s+TripleStorePort\b/,
    );
    expect(portSrc, "upsertTriple method must be on the port").toMatch(/\bupsertTriple\s*\(/);
    expect(portSrc, "asOf method must be on the port").toMatch(/\basOf\s*\(/);
    expect(portSrc, "spreadLane method must be on the port").toMatch(/\bspreadLane\s*\(/);
    // The port must stay type-only (mirrors memory-causal-store.ts) — neither a
    // zod dependency nor a runtime import of @comis/memory (that would invert the
    // dependency direction + break the agent↛memory build cut).
    expect(portSrc, "no zod in a type-only port").not.toMatch(/\bz\.[a-z]/);
    expect(portSrc, "no @comis/memory import in core port").not.toMatch(
      /^\s*import\b[^\n]*@comis\/memory/m,
    );
  });

  it("accepts a structurally-valid TripleStorePort implementation and exercises each method", async () => {
    const sampleTriple: TripleInput = {
      subject: "alice",
      predicate: "lives_in",
      object: "berlin",
      trust: "learned",
      tValidStart: 1_700_000_000_000,
    };
    const stub: TripleStorePort = {
      upsertTriple: async (
        _triple: TripleInput,
        _scope: TripleScope,
      ): Promise<Result<void, Error>> => ok(undefined),
      asOf: async (
        _t: number,
        _scope: Omit<TripleScope, "now">,
        _mode?: "valid" | "txn",
      ): Promise<Result<TripleInput[], Error>> => ok([sampleTriple]),
      currentTruth: async (
        _scope: Omit<TripleScope, "now">,
        _cap?: number,
      ): Promise<Result<TripleInput[], Error>> => ok([sampleTriple]),
      spreadLane: async (
        _seedSubjects: string[],
        _scope: Omit<TripleScope, "now">,
        _maxDepth: number,
        _fanOut: number,
        _cap: number,
      ): Promise<Result<MemorySearchResult[], Error>> => ok([]),
    };

    const wrote = await stub.upsertTriple(sampleTriple, {
      tenantId: "tenant-1",
      agentId: "agent-1",
      now: 1_700_000_000_000,
    });
    expect(wrote.ok).toBe(true);

    const asOfRes = await stub.asOf(1_700_000_000_001, { tenantId: "tenant-1", agentId: "agent-1" });
    expect(asOfRes.ok).toBe(true);
    if (asOfRes.ok) {
      expect(asOfRes.value).toHaveLength(1);
      expect(asOfRes.value[0]?.subject).toBe("alice");
      expect(asOfRes.value[0]?.object).toBe("berlin");
    }

    const laneRes = await stub.spreadLane(["alice"], { tenantId: "tenant-1", agentId: "agent-1" }, 2, 8, 50);
    expect(laneRes.ok).toBe(true);
    if (laneRes.ok) expect(laneRes.value).toEqual([]);
  });

  it("exposes upsertTriple typed as (TripleInput, TripleScope) => Promise<Result<void, Error>>", () => {
    const stub: TripleStorePort = {
      upsertTriple: async (): Promise<Result<void, Error>> => ok(undefined),
      asOf: async (): Promise<Result<TripleInput[], Error>> => ok([]),
      currentTruth: async (): Promise<Result<TripleInput[], Error>> => ok([]),
      spreadLane: async (): Promise<Result<MemorySearchResult[], Error>> => ok([]),
    };
    expectTypeOf(stub.upsertTriple).parameters.toEqualTypeOf<[TripleInput, TripleScope]>();
    expectTypeOf(stub.upsertTriple).returns.toEqualTypeOf<Promise<Result<void, Error>>>();
  });

  it("exposes asOf typed as (number, Omit<TripleScope,'now'>) => Promise<Result<TripleInput[], Error>>", () => {
    const stub: TripleStorePort = {
      upsertTriple: async (): Promise<Result<void, Error>> => ok(undefined),
      asOf: async (): Promise<Result<TripleInput[], Error>> => ok([]),
      currentTruth: async (): Promise<Result<TripleInput[], Error>> => ok([]),
      spreadLane: async (): Promise<Result<MemorySearchResult[], Error>> => ok([]),
    };
    expectTypeOf(stub.asOf).parameters.toEqualTypeOf<[number, Omit<TripleScope, "now">]>();
    expectTypeOf(stub.asOf).returns.toEqualTypeOf<Promise<Result<TripleInput[], Error>>>();
  });

  it("types spreadLane to return Promise<Result<MemorySearchResult[], Error>> (fuses as a lane)", () => {
    const stub: TripleStorePort = {
      upsertTriple: async (): Promise<Result<void, Error>> => ok(undefined),
      asOf: async (): Promise<Result<TripleInput[], Error>> => ok([]),
      currentTruth: async (): Promise<Result<TripleInput[], Error>> => ok([]),
      spreadLane: async (): Promise<Result<MemorySearchResult[], Error>> => ok([]),
    };
    expectTypeOf(stub.spreadLane).returns.toEqualTypeOf<Promise<Result<MemorySearchResult[], Error>>>();
    expectTypeOf(stub.spreadLane).parameters.toEqualTypeOf<
      [string[], Omit<TripleScope, "now">, number, number, number]
    >();
  });

  it("TripleScope carries (tenantId, agentId, now); TripleTrust is the system/learned/external ladder", () => {
    const scope: TripleScope = { tenantId: "t", agentId: "a", now: 123 };
    expectTypeOf(scope.tenantId).toEqualTypeOf<string>();
    expectTypeOf(scope.agentId).toEqualTypeOf<string>();
    expectTypeOf(scope.now).toEqualTypeOf<number>();
    expect(scope.now).toBe(123);

    const tSystem: TripleTrust = "system";
    const tLearned: TripleTrust = "learned";
    const tExternal: TripleTrust = "external";
    expectTypeOf(tSystem).toEqualTypeOf<TripleTrust>();
    expect([tSystem, tLearned, tExternal]).toEqual(["system", "learned", "external"]);
  });

  it("TripleInput carries S/P/O + trust + tValidStart and optional occurred range/provenance/confidence", () => {
    const full: TripleInput = {
      subject: "s",
      predicate: "p",
      object: "o",
      trust: "external",
      tValidStart: 1,
      tOccurred: 2,
      tOccurredEnd: 3,
      sourceMemoryId: "mem-1",
      confidence: 0.5,
    };
    expectTypeOf(full.subject).toEqualTypeOf<string>();
    expectTypeOf(full.predicate).toEqualTypeOf<string>();
    expectTypeOf(full.object).toEqualTypeOf<string>();
    expectTypeOf(full.trust).toEqualTypeOf<TripleTrust>();
    expectTypeOf(full.tValidStart).toEqualTypeOf<number>();
    expectTypeOf(full.tOccurred).toEqualTypeOf<number | undefined>();
    expectTypeOf(full.tOccurredEnd).toEqualTypeOf<number | undefined>();
    expectTypeOf(full.sourceMemoryId).toEqualTypeOf<string | undefined>();
    expectTypeOf(full.confidence).toEqualTypeOf<number | undefined>();
    expect(full.confidence).toBe(0.5);
  });
});

/**
 * The as-of time-travel contract.
 *
 * Beyond the valid-time `asOf`, the port carries (a) a txn-time variant of
 * `asOf` (the `mode: "valid" | "txn"` discriminator — valid-time answers "what
 * was BELIEVED true at instant t", txn-time answers "what the system had
 * RECORDED as of t") and (b) `currentTruth`, the default-recall read that
 * default-filters expired/invalidated edges (`t_valid_end IS NULL`) — the fix
 * for Graphiti's opt-in-filter stale-fact leak (where default search leaks
 * superseded edges). All three reads stay (tenant, agent) scoped.
 */
describe("TripleStorePort — as-of time-travel + current-truth default-filter", () => {
  const portSrcKg03 = readFileSync(resolve(here, "./triple-store.ts"), "utf8");

  it("declares currentTruth + the asOf txn-time mode and stays type-only (no zod, no @comis/memory)", () => {
    // Runtime RED proof: fails on pre-patch source where the new symbol/literals
    // do not exist yet. `currentTruth` is the default-recall current-truth read;
    // the `mode` discriminator distinguishes the valid-time vs txn-time as-of.
    expect(portSrcKg03, "currentTruth method must be on the port").toMatch(/\bcurrentTruth\s*\(/);
    expect(portSrcKg03, "asOf must take a valid|txn mode discriminator").toMatch(
      /mode\??\s*:\s*["']valid["']\s*\|\s*["']txn["']/,
    );
    // The default-recall current-truth filter is documented as `t_valid_end IS
    // NULL` (the Graphiti leak fix) — keep the contract self-describing.
    expect(portSrcKg03, "currentTruth doc cites the t_valid_end IS NULL default filter").toMatch(
      /t_valid_end IS NULL/,
    );
    // The port must stay type-only (mirrors memory-causal-store.ts).
    expect(portSrcKg03, "no zod in a type-only port").not.toMatch(/\bz\.[a-z]/);
    expect(portSrcKg03, "no @comis/memory import in core port").not.toMatch(
      /^\s*import\b[^\n]*@comis\/memory/m,
    );
  });

  it("exposes asOf with an optional mode discriminator defaulting to valid-time", () => {
    const stub: TripleStorePort = {
      upsertTriple: async (): Promise<Result<void, Error>> => ok(undefined),
      asOf: async (): Promise<Result<TripleInput[], Error>> => ok([]),
      currentTruth: async (): Promise<Result<TripleInput[], Error>> => ok([]),
      spreadLane: async (): Promise<Result<MemorySearchResult[], Error>> => ok([]),
    };
    // The mode is OPTIONAL (default valid) — so a 2-arg call still type-checks
    // (the original valid-time callers are unbroken) AND a 3-arg txn call does.
    expectTypeOf(stub.asOf).parameters.toEqualTypeOf<
      [number, Omit<TripleScope, "now">, ("valid" | "txn")?]
    >();
    expectTypeOf(stub.asOf).returns.toEqualTypeOf<Promise<Result<TripleInput[], Error>>>();
  });

  it("exposes currentTruth typed as (Omit<TripleScope,'now'>, cap?) => Promise<Result<TripleInput[], Error>>", () => {
    const stub: TripleStorePort = {
      upsertTriple: async (): Promise<Result<void, Error>> => ok(undefined),
      asOf: async (): Promise<Result<TripleInput[], Error>> => ok([]),
      currentTruth: async (): Promise<Result<TripleInput[], Error>> => ok([]),
      spreadLane: async (): Promise<Result<MemorySearchResult[], Error>> => ok([]),
    };
    expectTypeOf(stub.currentTruth).parameters.toEqualTypeOf<
      [Omit<TripleScope, "now">, (number | undefined)?]
    >();
    expectTypeOf(stub.currentTruth).returns.toEqualTypeOf<Promise<Result<TripleInput[], Error>>>();
  });
});
