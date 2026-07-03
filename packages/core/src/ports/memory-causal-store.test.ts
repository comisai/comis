// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { ok, type Result } from "@comis/shared";
// Side-effecting (value) import so the RED state is reproducible from this test
// commit alone: vitest must RESOLVE `./memory-causal-store.js` at runtime. The
// module is type-only (mirrors memory-temporal-store.ts / memory-entity-store.ts) so
// it resolves to an empty namespace; the types are pulled via the `import type` below.
// A bare `import type` would be stripped by the transform and never resolve, hiding
// RED if the symbols were missing.
//
// Because this port is type-only, the type-level assertions below erase at runtime
// (vitest does not type-check). The runtime RED proof is therefore the source-grep
// guard in the first test: it FAILS on the absent/empty `memory-causal-store.ts` (the
// interface + both methods do not exist yet) and the type-only port stays type-only
// (no zod, no @comis/memory import).
import "./memory-causal-store.js";
import type { MemoryCausalStore } from "./memory-causal-store.js";
import type { MemorySearchResult } from "./memory.js";

const here = dirname(fileURLToPath(import.meta.url));
const portSrc = readFileSync(resolve(here, "./memory-causal-store.ts"), "utf8");

// Both PUBLIC core barrels must carry the port (a
// ports/index-only add fails the @comis/memory build TS2724 — the public barrel
// exports/ports.ts is what consumers see). Grep them as a source-level RED guard.
const portsIndexSrc = readFileSync(resolve(here, "./index.ts"), "utf8");
const exportsPortsSrc = readFileSync(resolve(here, "../exports/ports.ts"), "utf8");

/**
 * The combined causal-edge store port. Type-only.
 *
 * An implementer must expose BOTH `linkCausal(sourceMemoryId, effectText, scope,
 * confidence)` (WRITE — record a directed cause→effect edge, idempotent,
 * returning the count of edges written) AND `causalLane(seedMemoryIds, scope,
 * cap)` (READ — return OTHER memories linked by a causal edge, seeds excluded,
 * hydrated as MemorySearchResult[]). This is the `MemoryEntityStore` dual-method
 * shape (NOT a split read/write port, NOT a bus pattern). It is a NEW
 * segregated port — it does NOT widen the security-reviewed `MemoryPort`.
 */
describe("MemoryCausalStore — combined causal-edge store port", () => {
  it("declares the port interface with linkCausal + causalLane and stays type-only (no zod, no @comis/memory)", () => {
    // Runtime RED proof: fails on the absent/empty source where the interface +
    // both methods do not exist yet.
    expect(portSrc, "MemoryCausalStore interface must be declared").toMatch(
      /export\s+interface\s+MemoryCausalStore\b/,
    );
    expect(portSrc, "linkCausal (WRITE) method must be on the port").toMatch(/\blinkCausal\s*\(/);
    expect(portSrc, "causalLane (READ) method must be on the port").toMatch(/\bcausalLane\s*\(/);
    // The port must stay type-only (mirrors memory-temporal-store.ts /
    // memory-entity-store.ts) — neither a zod dependency nor a runtime import of
    // @comis/memory (that would invert the dependency direction + break the
    // agent↛memory build cut).
    expect(portSrc, "no zod in a type-only port").not.toMatch(/\bz\.[a-z]/);
    expect(portSrc, "no @comis/memory import in core port").not.toMatch(
      /^\s*import\b[^\n]*@comis\/memory/m,
    );
  });

  it("is exported from BOTH core barrels (a ports/index.ts-only export fails the consumer build with TS2724)", () => {
    expect(portsIndexSrc, "MemoryCausalStore must be re-exported from ports/index.ts").toMatch(
      /\bMemoryCausalStore\b/,
    );
    expect(
      exportsPortsSrc,
      "MemoryCausalStore must be re-exported from the PUBLIC exports/ports.ts barrel",
    ).toMatch(/\bMemoryCausalStore\b/);
  });

  it("accepts a structurally-valid implementation and exercises linkCausal + causalLane", async () => {
    const sample: MemorySearchResult[] = [
      { entry: { id: "m2" } as MemorySearchResult["entry"], score: 0.9 },
    ];
    const stub: MemoryCausalStore = {
      linkCausal: async (): Promise<Result<number, Error>> => ok(1),
      causalLane: async (): Promise<Result<MemorySearchResult[], Error>> => ok(sample),
    };

    const written = await stub.linkCausal("m1", "an effect", { tenantId: "t", agentId: "a", now: 1 }, 1);
    expect(written.ok).toBe(true);
    if (written.ok) expect(written.value).toBe(1);

    const read = await stub.causalLane(["m1"], { tenantId: "t", agentId: "a" }, 50);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toHaveLength(1);
      expect(read.value[0]?.entry.id).toBe("m2");
    }
  });

  it("types linkCausal as (sourceMemoryId, effectText, scope, confidence) => Promise<Result<number, Error>>", () => {
    const stub: MemoryCausalStore = {
      linkCausal: async (): Promise<Result<number, Error>> => ok(0),
      causalLane: async (): Promise<Result<MemorySearchResult[], Error>> => ok([]),
    };
    expectTypeOf(stub.linkCausal).parameters.toEqualTypeOf<
      [string, string, { tenantId: string; agentId: string; now: number }, number]
    >();
    expectTypeOf(stub.linkCausal).returns.toEqualTypeOf<Promise<Result<number, Error>>>();
  });

  it("types causalLane as (seedMemoryIds, scope, cap) => Promise<Result<MemorySearchResult[], Error>>", () => {
    const stub: MemoryCausalStore = {
      linkCausal: async (): Promise<Result<number, Error>> => ok(0),
      causalLane: async (): Promise<Result<MemorySearchResult[], Error>> => ok([]),
    };
    expectTypeOf(stub.causalLane).parameters.toEqualTypeOf<
      [string[], { tenantId: string; agentId: string }, number]
    >();
    expectTypeOf(stub.causalLane).returns.toEqualTypeOf<
      Promise<Result<MemorySearchResult[], Error>>
    >();
  });
});
