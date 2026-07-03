// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { ok, type Result } from "@comis/shared";
// Side-effecting (value) import so the RED state is reproducible from this test
// commit alone: vitest must RESOLVE `./memory-temporal-store.js` at runtime. The
// module is type-only (mirrors reranker.ts / memory-entity-store.ts) so it resolves
// to an empty namespace; the types are pulled via the `import type` below. A bare
// `import type` would be stripped by the transform and never resolve, hiding RED if
// the symbols were missing.
//
// Because this port is type-only, the type-level assertions below erase at runtime
// (vitest does not type-check). The runtime RED proof is therefore the source-grep
// guard in the first test: it FAILS on the absent/empty `memory-temporal-store.ts`
// (the interface + method do not exist yet) and the type-only port stays type-only
// (no zod, no @comis/memory import).
import "./memory-temporal-store.js";
import type { MemoryTemporalStore } from "./memory-temporal-store.js";
import type { MemorySearchResult } from "./memory.js";

const here = dirname(fileURLToPath(import.meta.url));
const portSrc = readFileSync(resolve(here, "./memory-temporal-store.ts"), "utf8");

// The two PUBLIC core barrels must BOTH carry the port (a
// ports/index-only add fails the @comis/memory build TS2724 — the public barrel
// exports/ports.ts is what consumers see). Grep them as a source-level RED guard.
const portsIndexSrc = readFileSync(resolve(here, "./index.ts"), "utf8");
const exportsPortsSrc = readFileSync(resolve(here, "../exports/ports.ts"), "utf8");

/**
 * The temporal-spread recall lane port. Type-only.
 *
 * An implementer must expose `spreadLane(seedOccurredAts, scope, windowMs, cap)`
 * returning `Promise<Result<MemorySearchResult[], Error>>`. Given the seed
 * memories' event times, it returns OTHER memories (scoped to (tenant, agent),
 * seeds excluded) whose `occurred_at` is within `windowMs` of ANY seed time,
 * hydrated nearest-first. Empty when no seeds / no neighbours (the no-op —
 * the lane is then empty and RRF ranking is unchanged). This is a NEW segregated
 * port — it does NOT widen the security-reviewed `MemoryPort`.
 */
describe("MemoryTemporalStore — temporal-spread recall port", () => {
  it("declares the port interface and stays a type-only port (no zod, no @comis/memory)", () => {
    // Runtime RED proof: fails on the absent/empty source where the interface +
    // method do not exist yet.
    expect(portSrc, "MemoryTemporalStore interface must be declared").toMatch(
      /export\s+interface\s+MemoryTemporalStore\b/,
    );
    expect(portSrc, "spreadLane method must be on the port").toMatch(/\bspreadLane\s*\(/);
    // The port must stay type-only (mirrors reranker.ts / memory-entity-store.ts) —
    // neither a zod dependency nor a runtime import of @comis/memory (that would
    // invert the dependency direction + break the agent↛memory build cut).
    expect(portSrc, "no zod in a type-only port").not.toMatch(/\bz\.[a-z]/);
    expect(portSrc, "no @comis/memory import in core port").not.toMatch(
      /^\s*import\b[^\n]*@comis\/memory/m,
    );
  });

  it("is exported from BOTH core barrels (a ports/index.ts-only export fails the consumer build with TS2724)", () => {
    expect(portsIndexSrc, "MemoryTemporalStore must be re-exported from ports/index.ts").toMatch(
      /\bMemoryTemporalStore\b/,
    );
    expect(
      exportsPortsSrc,
      "MemoryTemporalStore must be re-exported from the PUBLIC exports/ports.ts barrel",
    ).toMatch(/\bMemoryTemporalStore\b/);
  });

  it("accepts a structurally-valid implementation and exercises spreadLane", async () => {
    const sample: MemorySearchResult[] = [
      { entry: { id: "m2" } as MemorySearchResult["entry"], score: 0.9 },
    ];
    const stub: MemoryTemporalStore = {
      spreadLane: async (): Promise<Result<MemorySearchResult[], Error>> => ok(sample),
    };

    const res = await stub.spreadLane([1_000], { tenantId: "t", agentId: "a" }, 86_400_000, 50);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toHaveLength(1);
      expect(res.value[0]?.entry.id).toBe("m2");
    }
  });

  it("checks spreadLane is typed as (seedOccurredAts, scope, windowMs, cap) => Promise<Result<MemorySearchResult[], Error>>", () => {
    const stub: MemoryTemporalStore = {
      spreadLane: async (): Promise<Result<MemorySearchResult[], Error>> => ok([]),
    };
    expectTypeOf(stub.spreadLane).parameters.toEqualTypeOf<
      [number[], { tenantId: string; agentId: string }, number, number]
    >();
    expectTypeOf(stub.spreadLane).returns.toEqualTypeOf<
      Promise<Result<MemorySearchResult[], Error>>
    >();
  });
});
