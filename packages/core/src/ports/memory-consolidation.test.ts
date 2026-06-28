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
 * Phase 226 (SIMPLIFY-02) — `MemoryConsolidationStore` is TRIMMED to its LIVE
 * read/maintenance surface, NOT deleted.
 *
 * The consolidation CRON (the writer) was retired in phase 225, so its writer
 * methods — `listConsolidationCandidates`, `applyConsolidation`,
 * `foldIntoExisting`, `knnDistances` (the surprisal-gate read), `markReasoned`
 * (the deductive-only drain) — plus the candidate/plan input types
 * (`ConsolidationCandidate`, `ConsolidationPlan`, `ConsolidationFoldPlan`) are
 * DEAD (grep-proven: 0 live, non-test callers). They are cut.
 *
 * KEPT (each has a live, NON-cron consumer that must keep working):
 *   - `listObservations`           — the `comis memory` observation listing CLI
 *                                    (daemon `memory.observations` handler).
 *   - `unlinkDeletedSources`       — DIST-05 deletion reconciliation
 *   - `purgeConsolidatedDerivedFrom` (`session.reset_conversation --memory`).
 *
 * The port stays type-only (mirrors the entity-store port): no zod, no
 * @comis/memory runtime import (the load-bearing agent↛memory build cut).
 */
describe("MemoryConsolidationStore — trimmed to the live read/maintenance surface (SIMPLIFY-02)", () => {
  it("KEEPS listObservations + the DIST-05 unlink/purge maintenance methods", () => {
    expect(portSrc, "listObservations (the comis-memory CLI read) must stay on the port").toMatch(
      /\blistObservations\s*\(/,
    );
    expect(portSrc, "unlinkDeletedSources (DIST-05) must stay on the port").toMatch(
      /\bunlinkDeletedSources\s*\(/,
    );
    expect(portSrc, "purgeConsolidatedDerivedFrom (DIST-05) must stay on the port").toMatch(
      /\bpurgeConsolidatedDerivedFrom\s*\(/,
    );
  });

  it("CUTS the dead consolidation-cron writer methods (writer retired in phase 225)", () => {
    // Runtime RED proof: these FAIL on the pre-trim source (the methods still
    // exist there). After the trim each must be GONE from the port interface.
    expect(portSrc, "listConsolidationCandidates must be cut (dead writer surface)").not.toMatch(
      /\blistConsolidationCandidates\s*\(/,
    );
    expect(portSrc, "applyConsolidation must be cut (dead writer surface)").not.toMatch(
      /\bapplyConsolidation\s*\(/,
    );
    expect(portSrc, "foldIntoExisting must be cut (dead writer surface)").not.toMatch(
      /\bfoldIntoExisting\s*\(/,
    );
    expect(portSrc, "knnDistances must be cut (dead surprisal-gate read)").not.toMatch(
      /\bknnDistances\s*\(/,
    );
    expect(portSrc, "markReasoned must be cut (dead deductive-only drain)").not.toMatch(
      /\bmarkReasoned\s*\(/,
    );
  });

  it("CUTS the orphaned candidate/plan input types", () => {
    expect(portSrc, "ConsolidationCandidate type must be cut").not.toMatch(
      /\binterface\s+ConsolidationCandidate\b/,
    );
    expect(portSrc, "ConsolidationPlan type must be cut").not.toMatch(
      /\binterface\s+ConsolidationPlan\b/,
    );
    expect(portSrc, "ConsolidationFoldPlan type must be cut").not.toMatch(
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
