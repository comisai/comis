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
import "./memory-consolidation.js";
import type { MemoryConsolidationStore } from "./memory-consolidation.js";
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
    content: "an observation",
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
 * `MemoryConsolidationStore` is LIMITED to its LIVE read/maintenance surface.
 *
 * There is deliberately NO consolidation-writer surface on the port: no
 * `listConsolidationCandidates`, `applyConsolidation`, `foldIntoExisting`,
 * `knnDistances` (a surprisal-gate read), or `markReasoned` (a deductive-only
 * drain), and no candidate/plan input types (`ConsolidationCandidate`,
 * `ConsolidationPlan`, `ConsolidationFoldPlan`).
 *
 * KEPT (each has a live consumer that must keep working):
 *   - `listObservations`           — the `comis memory` observation listing CLI
 *                                    (daemon `memory.observations` handler).
 *   - `unlinkDeletedSources`       — deletion reconciliation
 *   - `purgeConsolidatedDerivedFrom` (`session.reset_conversation --memory`).
 *
 * The port stays type-only (mirrors the entity-store port): no zod, no
 * @comis/memory runtime import (the load-bearing agent↛memory build cut).
 */
describe("MemoryConsolidationStore — limited to the live read/maintenance surface", () => {
  it("KEEPS listObservations + the deletion-reconciliation unlink/purge maintenance methods", () => {
    expect(portSrc, "listObservations (the comis-memory CLI read) must stay on the port").toMatch(
      /\blistObservations\s*\(/,
    );
    expect(portSrc, "unlinkDeletedSources (deletion reconciliation) must stay on the port").toMatch(
      /\bunlinkDeletedSources\s*\(/,
    );
    expect(portSrc, "purgeConsolidatedDerivedFrom (deletion reconciliation) must stay on the port").toMatch(
      /\bpurgeConsolidatedDerivedFrom\s*\(/,
    );
  });

  it("declares NO consolidation-writer methods on the port surface", () => {
    // Runtime guard: each writer method must be ABSENT from the port
    // interface — the port exposes no consolidation-writer surface.
    expect(portSrc, "listConsolidationCandidates must not be on the port (no writer surface)").not.toMatch(
      /\blistConsolidationCandidates\s*\(/,
    );
    expect(portSrc, "applyConsolidation must not be on the port (no writer surface)").not.toMatch(
      /\bapplyConsolidation\s*\(/,
    );
    expect(portSrc, "foldIntoExisting must not be on the port (no writer surface)").not.toMatch(
      /\bfoldIntoExisting\s*\(/,
    );
    expect(portSrc, "knnDistances must not be on the port (no surprisal-gate read)").not.toMatch(
      /\bknnDistances\s*\(/,
    );
    expect(portSrc, "markReasoned must not be on the port (no deductive-only drain)").not.toMatch(
      /\bmarkReasoned\s*\(/,
    );
  });

  it("declares NO consolidation candidate/plan input types", () => {
    expect(portSrc, "ConsolidationCandidate type must not be declared").not.toMatch(
      /\binterface\s+ConsolidationCandidate\b/,
    );
    expect(portSrc, "ConsolidationPlan type must not be declared").not.toMatch(
      /\binterface\s+ConsolidationPlan\b/,
    );
    expect(portSrc, "ConsolidationFoldPlan type must not be declared").not.toMatch(
      /\binterface\s+ConsolidationFoldPlan\b/,
    );
  });

  it("stays a type-only port (no zod, no @comis/memory import)", () => {
    expect(portSrc, "no zod in a type-only port").not.toMatch(/\bz\.[a-z]/);
    expect(portSrc, "no @comis/memory import in core port").not.toMatch(
      /^\s*import\b[^\n]*@comis\/memory/m,
    );
  });

  it("accepts a structurally-valid implementation exposing ONLY the trimmed surface", async () => {
    const obs = makeObservation();
    const stub: MemoryConsolidationStore = {
      listObservations: async (): Promise<Result<MemoryEntry[], Error>> => ok([obs]),
      unlinkDeletedSources: async (): Promise<Result<number, Error>> => ok(0),
      purgeConsolidatedDerivedFrom: async (): Promise<Result<number, Error>> => ok(0),
    };

    const obsRes = await stub.listObservations("agent_a", "tenant_a", 50);
    expect(obsRes.ok).toBe(true);
    if (obsRes.ok) expect(obsRes.value[0]?.proofCount).toBe(3);

    const unlink = await stub.unlinkDeletedSources("sess-1", "tenant_a", "agent_a");
    expect(unlink.ok).toBe(true);
    const purge = await stub.purgeConsolidatedDerivedFrom("sess-1", "tenant_a", "agent_a", ["m1"]);
    expect(purge.ok).toBe(true);
  });

  it("exposes listObservations typed as (agentId, tenantId, limit) => Promise<Result<MemoryEntry[], Error>>", () => {
    const obs = makeObservation();
    const stub: MemoryConsolidationStore = {
      listObservations: async (): Promise<Result<MemoryEntry[], Error>> => ok([obs]),
      unlinkDeletedSources: async (): Promise<Result<number, Error>> => ok(0),
      purgeConsolidatedDerivedFrom: async (): Promise<Result<number, Error>> => ok(0),
    };
    expectTypeOf(stub.listObservations).parameters.toEqualTypeOf<[string, string, number]>();
    expectTypeOf(stub.listObservations).returns.toEqualTypeOf<Promise<Result<MemoryEntry[], Error>>>();
    expectTypeOf(stub.unlinkDeletedSources).parameters.toEqualTypeOf<[string, string, string]>();
    expectTypeOf(stub.purgeConsolidatedDerivedFrom).parameters.toEqualTypeOf<
      [string, string, string, string[]]
    >();
  });
});
