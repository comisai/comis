// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { ok, type Result } from "@comis/shared";
// Side-effecting (value) import so the RED state is reproducible from this
// test commit alone: vitest must RESOLVE `./memory-entity-store.js` at runtime.
// The module is type-only (mirrors reranker.ts) so it resolves to an empty
// namespace; the types are pulled via the `import type` below. A bare
// `import type` would be stripped by the transform and never resolve, hiding
// RED if the symbols were missing.
//
// Because this port is type-only, the type-level assertions below erase at
// runtime (vitest does not type-check). The runtime RED proof for the
// `listEntities` / `EntityRow` ADDITIONS is therefore the source-grep guard
// in the first test: it FAILS on pre-patch `memory-entity-store.ts` (the
// method/type do not exist yet) and the type-only port stays type-only (no
// zod, no @comis/memory import).
import "./memory-entity-store.js";
import type {
  MemoryEntityStore,
  EntityScope,
  EntityRow,
} from "./memory-entity-store.js";
import type { MemorySearchResult } from "./memory.js";

const here = dirname(fileURLToPath(import.meta.url));
const portSrc = readFileSync(resolve(here, "./memory-entity-store.ts"), "utf8");

/**
 * The scoped `listEntities` read on `MemoryEntityStore`.
 *
 * Type-only assertions: an implementer must expose `listEntities(agentId,
 * tenantId, limit)` returning `Promise<Result<EntityRow[], Error>>` — a
 * NON-seed scoped read for the entity-graph diagnostic (distinct from the
 * seed-based `associativeLane`). The `(tenant, agent)` scope is the same
 * SQL-baked entity-isolation boundary.
 */
describe("MemoryEntityStore.listEntities — scoped entity-graph read", () => {
  it("declares listEntities + EntityRow and stays a type-only port (no zod, no @comis/memory)", () => {
    // Runtime RED proof: fails on pre-patch source where the method/type are absent.
    expect(portSrc, "EntityRow type must be declared").toMatch(/export\s+interface\s+EntityRow\b/);
    expect(portSrc, "listEntities method must be on the port").toMatch(/\blistEntities\s*\(/);
    // The port must stay type-only (mirrors reranker.ts) — neither a zod
    // dependency nor a runtime import of @comis/memory (that would invert the
    // dependency direction + break the agent↛memory build cut).
    expect(portSrc, "no zod in a type-only port").not.toMatch(/\bz\.[a-z]/);
    expect(portSrc, "no @comis/memory import in core port").not.toMatch(
      /^\s*import\b[^\n]*@comis\/memory/m,
    );
  });

  it("accepts a structurally-valid implementation exposing listEntities and exercises it", async () => {
    const rows: EntityRow[] = [
      { id: "ent-1", name: "alice", mentionCount: 7, firstSeen: 1, lastSeen: 2 },
      { id: "ent-2", name: "bob", mentionCount: 1 },
    ];
    const stub: MemoryEntityStore = {
      resolveAndLink: async (): Promise<Result<string, Error>> => ok("ent-1"),
      associativeLane: async (): Promise<Result<MemorySearchResult[], Error>> => ok([]),
      listEntities: async (
        _agentId: string,
        _tenantId: string,
        _limit: number,
      ): Promise<Result<EntityRow[], Error>> => ok(rows),
    };

    const res = await stub.listEntities("agent-1", "tenant-1", 50);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toHaveLength(2);
      expect(res.value[0]?.name).toBe("alice");
      expect(res.value[0]?.mentionCount).toBe(7);
      // optional bookkeeping fields may be absent on a row
      expect(res.value[1]?.firstSeen).toBeUndefined();
    }
  });

  it("checks listEntities is typed as (agentId, tenantId, limit) => Promise<Result<EntityRow[], Error>>", () => {
    const stub: MemoryEntityStore = {
      resolveAndLink: async (): Promise<Result<string, Error>> => ok("x"),
      associativeLane: async (): Promise<Result<MemorySearchResult[], Error>> => ok([]),
      listEntities: async (): Promise<Result<EntityRow[], Error>> => ok([]),
    };
    expectTypeOf(stub.listEntities).parameters.toEqualTypeOf<[string, string, number]>();
    expectTypeOf(stub.listEntities).returns.toEqualTypeOf<Promise<Result<EntityRow[], Error>>>();
  });

  it("EntityRow carries id, name, mentionCount + optional firstSeen/lastSeen", () => {
    const row: EntityRow = { id: "e", name: "n", mentionCount: 0 };
    expectTypeOf(row.id).toEqualTypeOf<string>();
    expectTypeOf(row.name).toEqualTypeOf<string>();
    expectTypeOf(row.mentionCount).toEqualTypeOf<number>();
    expectTypeOf(row.firstSeen).toEqualTypeOf<number | undefined>();
    expectTypeOf(row.lastSeen).toEqualTypeOf<number | undefined>();
    expect(row.mentionCount).toBe(0);
  });

  it("EntityScope keeps its (tenant, agent, now) write-path shape unchanged", () => {
    const scope: EntityScope = { tenantId: "t", agentId: "a", now: 123 };
    expect(scope.now).toBe(123);
  });
});
