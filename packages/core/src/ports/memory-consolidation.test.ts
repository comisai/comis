// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { ok, type Result } from "@comis/shared";
// Side-effecting (value) import so the RED state is reproducible from this test
// commit alone: vitest must RESOLVE `./memory-consolidation.js` at runtime. The
// module is type-only (mirrors reranker.ts + memory-entity-store.ts) so it
// resolves to an empty namespace; the types are pulled via the `import type`
// below. A bare `import type` would be stripped by the transform and never
// resolve, hiding RED if the symbols were missing.
//
// Because this port is type-only, the type-level assertions below erase at
// runtime (vitest does not type-check). The runtime RED proof for the
// `foldIntoExisting` / `ConsolidationFoldPlan` ADDITIONS is therefore the
// source-grep guard in the first test: it FAILS on pre-patch
// `memory-consolidation.ts` (the method/type do not exist yet) and asserts the
// type-only port stays type-only (no zod, no @comis/memory import).
import "./memory-consolidation.js";
import type {
  MemoryConsolidationStore,
  ConsolidationCandidate,
  ConsolidationFoldPlan,
} from "./memory-consolidation.js";
import type { MemoryEntry } from "../domain/memory-entry.js";

const here = dirname(fileURLToPath(import.meta.url));
const portSrc = readFileSync(resolve(here, "./memory-consolidation.ts"), "utf8");

/** A structurally-valid MemoryEntry observation the stub returns. */
function makeObservation(): MemoryEntry {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "tenant_a",
    agentId: "agent_a",
    userId: "user_a",
    content: "the grown observation",
    trustLevel: "learned",
    source: { who: "agent", channel: "test" },
    tags: [],
    createdAt: 1_000,
    proofCount: 3,
    sourceIds: [
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ],
    confidence: 1,
    occurredAt: 9_000,
  };
}

/**
 * Phase 94 (FOLD-01/FOLD-02) — the proof-accrual `foldIntoExisting` write on
 * `MemoryConsolidationStore` + its `ConsolidationFoldPlan` input.
 *
 * Type-only assertions: an implementer must expose `foldIntoExisting(plan:
 * ConsolidationFoldPlan)` returning `Promise<Result<MemoryEntry, Error>>` — the
 * EXTENSION of the Phase-84 create-only port (it does NOT replace the existing
 * three methods). The port stays type-only (mirrors the entity-store port):
 * neither a zod dependency nor a runtime import of @comis/memory.
 */
describe("MemoryConsolidationStore.foldIntoExisting — proof accrual (FOLD-01/02)", () => {
  it("declares foldIntoExisting + ConsolidationFoldPlan and stays a type-only port (no zod, no @comis/memory)", () => {
    // Runtime RED proof: fails on pre-patch source where the method/type are absent.
    expect(portSrc, "ConsolidationFoldPlan type must be declared").toMatch(
      /export\s+interface\s+ConsolidationFoldPlan\b/,
    );
    expect(portSrc, "foldIntoExisting method must be on the port").toMatch(
      /\bfoldIntoExisting\s*\(/,
    );
    // The stale Phase-84 "create-only, no fold method — deferred" class-doc
    // sentence must be gone now that the 4th method exists.
    expect(portSrc, "the stale 'is deferred' class-doc sentence must be removed").not.toMatch(
      /is deferred/,
    );
    // The port must stay type-only (mirrors reranker.ts / memory-entity-store.ts)
    // — neither a zod dependency nor a runtime import of @comis/memory (that
    // would invert the dependency direction + break the agent↛memory build cut).
    expect(portSrc, "no zod in a type-only port").not.toMatch(/\bz\.[a-z]/);
    expect(portSrc, "no @comis/memory import in core port").not.toMatch(
      /^\s*import\b[^\n]*@comis\/memory/m,
    );
  });

  it("accepts a structurally-valid implementation exposing all four methods incl. foldIntoExisting", async () => {
    const grown = makeObservation();
    const stub: MemoryConsolidationStore = {
      listConsolidationCandidates: async (): Promise<Result<ConsolidationCandidate[], Error>> =>
        ok([]),
      listObservations: async (): Promise<Result<MemoryEntry[], Error>> => ok([]),
      applyConsolidation: async (): Promise<Result<MemoryEntry, Error>> => ok(grown),
      foldIntoExisting: async (
        _plan: ConsolidationFoldPlan,
      ): Promise<Result<MemoryEntry, Error>> => ok(grown),
      knnDistances: async (): Promise<Result<number[], Error>> => ok([]),
    };

    const plan: ConsolidationFoldPlan = {
      targetObservationId: grown.id,
      newSourceIds: ["44444444-4444-4444-8444-444444444444"],
      trustLevel: "learned",
      confidence: 1,
      occurredAt: 9_000,
      tenantId: "tenant_a",
      now: 5_000,
    };
    const res = await stub.foldIntoExisting(plan);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.proofCount).toBe(3);
      expect(res.value.sourceIds).toHaveLength(2);
    }
  });

  it("checks foldIntoExisting is typed as (ConsolidationFoldPlan) => Promise<Result<MemoryEntry, Error>>", () => {
    const grown = makeObservation();
    const stub: MemoryConsolidationStore = {
      listConsolidationCandidates: async (): Promise<Result<ConsolidationCandidate[], Error>> =>
        ok([]),
      listObservations: async (): Promise<Result<MemoryEntry[], Error>> => ok([]),
      applyConsolidation: async (): Promise<Result<MemoryEntry, Error>> => ok(grown),
      foldIntoExisting: async (): Promise<Result<MemoryEntry, Error>> => ok(grown),
      knnDistances: async (): Promise<Result<number[], Error>> => ok([]),
    };
    expectTypeOf(stub.foldIntoExisting).parameters.toEqualTypeOf<[ConsolidationFoldPlan]>();
    expectTypeOf(stub.foldIntoExisting).returns.toEqualTypeOf<Promise<Result<MemoryEntry, Error>>>();
  });

  it("ConsolidationFoldPlan carries the fold contract fields (target id, new sources, trust ceiling, refresh, scope, clock)", () => {
    const plan: ConsolidationFoldPlan = {
      targetObservationId: "55555555-5555-4555-8555-555555555555",
      newSourceIds: ["66666666-6666-4666-8666-666666666666"],
      trustLevel: "learned",
      confidence: 1,
      occurredAt: 9_000,
      tenantId: "tenant_a",
      now: 5_000,
    };
    expectTypeOf(plan.targetObservationId).toEqualTypeOf<string>();
    expectTypeOf(plan.newSourceIds).toEqualTypeOf<string[]>();
    expectTypeOf(plan.trustLevel).toEqualTypeOf<MemoryEntry["trustLevel"]>();
    expectTypeOf(plan.confidence).toEqualTypeOf<number>();
    expectTypeOf(plan.occurredAt).toEqualTypeOf<number>();
    expectTypeOf(plan.tenantId).toEqualTypeOf<string>();
    expectTypeOf(plan.now).toEqualTypeOf<number>();
    // `content` is optional (omit to keep existing content — no FTS churn).
    expectTypeOf(plan.content).toEqualTypeOf<string | undefined>();
    expect(plan.newSourceIds).toHaveLength(1);
  });
});

/**
 * Phase 101 (REASON-04) — the surprisal-gate engine: a corpus-wide k-NN cosine
 * DISTANCES read on `MemoryConsolidationStore`. The agent cannot run SQL, so the
 * read crosses the agent↛memory cut as a port TYPE method (the adapter
 * implements it in 101-03). The method is (tenantId, agentId)-scoped and returns
 * the distances sorted ascending, or `ok([])` when sqlite-vec is unavailable
 * (graceful degrade).
 *
 * Type-only assertions: an implementer MUST expose `knnDistances(embedding,
 * k, agentId, tenantId)` returning `Promise<Result<number[], Error>>`. The port
 * stays type-only — no zod, no @comis/memory runtime import (the CUT INVARIANT).
 */
describe("MemoryConsolidationStore.knnDistances — surprisal k-NN read (REASON-04)", () => {
  it("declares knnDistances on the port and stays type-only (no zod, no @comis/memory)", () => {
    // Runtime RED proof: fails on pre-patch source where the method is absent.
    expect(portSrc, "knnDistances method must be on the port").toMatch(
      /\bknnDistances\s*\(/,
    );
    // The port must stay type-only — neither a zod dependency nor a runtime
    // import of @comis/memory (that would break the agent↛memory build cut).
    expect(portSrc, "no zod in a type-only port").not.toMatch(/\bz\.[a-z]/);
    expect(portSrc, "no @comis/memory import in core port").not.toMatch(
      /^\s*import\b[^\n]*@comis\/memory/m,
    );
  });

  it("accepts a structurally-valid implementation exposing knnDistances returning sorted distances", async () => {
    const grown = makeObservation();
    const stub: MemoryConsolidationStore = {
      listConsolidationCandidates: async (): Promise<Result<ConsolidationCandidate[], Error>> =>
        ok([]),
      listObservations: async (): Promise<Result<MemoryEntry[], Error>> => ok([]),
      applyConsolidation: async (): Promise<Result<MemoryEntry, Error>> => ok(grown),
      foldIntoExisting: async (): Promise<Result<MemoryEntry, Error>> => ok(grown),
      knnDistances: async (
        _embedding: number[],
        _k: number,
        _agentId: string,
        _tenantId: string,
      ): Promise<Result<number[], Error>> => ok([0.1, 0.3, 0.42]),
    };
    const res = await stub.knnDistances([0.1, 0.2, 0.3], 3, "agent_a", "tenant_a");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual([0.1, 0.3, 0.42]);
    }
  });

  it("returns ok([]) when sqlite-vec is unavailable (graceful degrade)", async () => {
    const grown = makeObservation();
    const stub: MemoryConsolidationStore = {
      listConsolidationCandidates: async (): Promise<Result<ConsolidationCandidate[], Error>> =>
        ok([]),
      listObservations: async (): Promise<Result<MemoryEntry[], Error>> => ok([]),
      applyConsolidation: async (): Promise<Result<MemoryEntry, Error>> => ok(grown),
      foldIntoExisting: async (): Promise<Result<MemoryEntry, Error>> => ok(grown),
      knnDistances: async (): Promise<Result<number[], Error>> => ok([]),
    };
    const res = await stub.knnDistances([0.1, 0.2], 5, "agent_a", "tenant_a");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual([]);
    }
  });

  it("checks knnDistances is typed as (number[], number, string, string) => Promise<Result<number[], Error>>", () => {
    const grown = makeObservation();
    const stub: MemoryConsolidationStore = {
      listConsolidationCandidates: async (): Promise<Result<ConsolidationCandidate[], Error>> =>
        ok([]),
      listObservations: async (): Promise<Result<MemoryEntry[], Error>> => ok([]),
      applyConsolidation: async (): Promise<Result<MemoryEntry, Error>> => ok(grown),
      foldIntoExisting: async (): Promise<Result<MemoryEntry, Error>> => ok(grown),
      knnDistances: async (): Promise<Result<number[], Error>> => ok([]),
    };
    expectTypeOf(stub.knnDistances).parameters.toEqualTypeOf<
      [number[], number, string, string]
    >();
    expectTypeOf(stub.knnDistances).returns.toEqualTypeOf<Promise<Result<number[], Error>>>();
  });
});
