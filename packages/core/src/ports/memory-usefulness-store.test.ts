// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { ok, type Result } from "@comis/shared";
// Side-effecting (value) import so the RED state is reproducible from this
// test commit alone: vitest must RESOLVE `./memory-usefulness-store.js` at
// runtime. The module is type-only (mirrors reranker.ts / memory-entity-store.ts)
// so it resolves to an empty namespace; the types are pulled via the
// `import type` below. A bare `import type` would be stripped by the transform
// and never resolve, hiding RED if the symbols were missing.
//
// Because this port is type-only, the type-level assertions below erase at
// runtime (vitest does not type-check). The runtime RED proof is therefore the
// source-grep guard in the first test: it FAILS on the absent/empty
// `memory-usefulness-store.ts` (the interfaces + methods do not exist yet) and
// the type-only port stays type-only (no zod, no @comis/memory import).
import "./memory-usefulness-store.js";
import type {
  MemoryUsefulnessStore,
  UsefulnessScope,
  UsefulnessSignal,
} from "./memory-usefulness-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const portSrc = readFileSync(resolve(here, "./memory-usefulness-store.ts"), "utf8");

/**
 * Phase 93 (FEED-02) — the durable per-memory usefulness signal port.
 *
 * Type-only assertions: an implementer must expose `recordUsage(usedIds,
 * ignoredIds, scope)` (WRITE) and `readUsefulness(memoryIds, scope)` (READ),
 * both returning `Promise<Result<T, Error>>`, scoped by `UsefulnessScope`
 * (`{ tenantId, agentId, now }`). The `(tenant, agent)` scope is the SQL-baked
 * isolation boundary the sole adapter enforces. This is a NEW segregated port —
 * it does NOT widen the security-reviewed `MemoryPort`.
 */
describe("MemoryUsefulnessStore — durable recall-utility port (FEED-02)", () => {
  it("declares the port + signal interfaces and stays a type-only port (no zod, no @comis/memory)", () => {
    // Runtime RED proof: fails on the absent/empty source where the interfaces
    // + methods do not exist yet.
    expect(portSrc, "MemoryUsefulnessStore interface must be declared").toMatch(
      /export\s+interface\s+MemoryUsefulnessStore\b/,
    );
    expect(portSrc, "UsefulnessSignal interface must be declared").toMatch(
      /export\s+interface\s+UsefulnessSignal\b/,
    );
    expect(portSrc, "recordUsage method must be on the port").toMatch(/\brecordUsage\s*\(/);
    expect(portSrc, "readUsefulness method must be on the port").toMatch(/\breadUsefulness\s*\(/);
    // The port must stay type-only (mirrors reranker.ts / memory-entity-store.ts)
    // — neither a zod dependency nor a runtime import of @comis/memory (that
    // would invert the dependency direction + break the agent↛memory build cut).
    expect(portSrc, "no zod in a type-only port").not.toMatch(/\bz\.[a-z]/);
    expect(portSrc, "no @comis/memory import in core port").not.toMatch(
      /^\s*import\b[^\n]*@comis\/memory/m,
    );
  });

  it("accepts a structurally-valid implementation exposing both methods and exercises them", async () => {
    const sample = new Map<string, UsefulnessSignal>([
      ["m1", { usedCount: 3, ignoredCount: 1, lastUsefulAt: 1_000 }],
      ["m2", { usedCount: 0, ignoredCount: 2 }],
    ]);
    const stub: MemoryUsefulnessStore = {
      recordUsage: async (): Promise<Result<void, Error>> => ok(undefined),
      readUsefulness: async (): Promise<Result<Map<string, UsefulnessSignal>, Error>> => ok(sample),
    };

    const wrote = await stub.recordUsage(["m1"], ["m2"], { tenantId: "t", agentId: "a", now: 1_000 });
    expect(wrote.ok).toBe(true);

    const read = await stub.readUsefulness(["m1", "m2"], { tenantId: "t", agentId: "a" });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.get("m1")?.usedCount).toBe(3);
      expect(read.value.get("m1")?.lastUsefulAt).toBe(1_000);
      // A signal with no "used" attribution carries no lastUsefulAt.
      expect(read.value.get("m2")?.ignoredCount).toBe(2);
      expect(read.value.get("m2")?.lastUsefulAt).toBeUndefined();
    }
  });

  it("checks recordUsage is typed as (usedIds, ignoredIds, scope) => Promise<Result<void, Error>>", () => {
    const stub: MemoryUsefulnessStore = {
      recordUsage: async (): Promise<Result<void, Error>> => ok(undefined),
      readUsefulness: async (): Promise<Result<Map<string, UsefulnessSignal>, Error>> => ok(new Map()),
    };
    expectTypeOf(stub.recordUsage).parameters.toEqualTypeOf<[string[], string[], UsefulnessScope]>();
    expectTypeOf(stub.recordUsage).returns.toEqualTypeOf<Promise<Result<void, Error>>>();
  });

  it("checks readUsefulness returns Promise<Result<Map<string, UsefulnessSignal>, Error>>", () => {
    const stub: MemoryUsefulnessStore = {
      recordUsage: async (): Promise<Result<void, Error>> => ok(undefined),
      readUsefulness: async (): Promise<Result<Map<string, UsefulnessSignal>, Error>> => ok(new Map()),
    };
    expectTypeOf(stub.readUsefulness).returns.toEqualTypeOf<
      Promise<Result<Map<string, UsefulnessSignal>, Error>>
    >();
  });

  it("UsefulnessSignal carries usedCount, ignoredCount + optional lastUsefulAt", () => {
    const sig: UsefulnessSignal = { usedCount: 0, ignoredCount: 0 };
    expectTypeOf(sig.usedCount).toEqualTypeOf<number>();
    expectTypeOf(sig.ignoredCount).toEqualTypeOf<number>();
    expectTypeOf(sig.lastUsefulAt).toEqualTypeOf<number | undefined>();
    expect(sig.usedCount).toBe(0);
  });

  it("UsefulnessScope keeps its (tenant, agent, now) write-path shape", () => {
    const scope: UsefulnessScope = { tenantId: "t", agentId: "a", now: 123 };
    expect(scope.now).toBe(123);
  });
});
