// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { ok, type Result } from "@comis/shared";
// Side-effecting (value) import so the RED state is reproducible from this test
// commit alone: vitest must RESOLVE `./memory.js` at runtime. The module is
// type-only (no runtime exports), so it resolves to an empty namespace; the
// types are pulled via the `import type` below. A bare `import type` would be
// stripped by the transform and never resolve, hiding RED if the symbol were missing.
import "./memory.js";
import type {
  MemoryPort,
  MemorySearchOptions,
  MemorySearchResult,
  SessionKey,
} from "./memory.js";

const here = dirname(fileURLToPath(import.meta.url));
const portSrc = readFileSync(resolve(here, "./memory.ts"), "utf8");

const SESSION: SessionKey = { tenantId: "t", userId: "u", channelId: "c" } as unknown as SessionKey;

/**
 * The OPTIONAL `searchLanes` method on `MemoryPort`.
 *
 * Surfaces the FTS-ranked and vector-ranked candidate lists SEPARATELY across
 * the port boundary (the un-fused split), so the agent's `fuse()` can fuse them
 * with operator-tunable weights. It is OPTIONAL — `search()` stays a required,
 * standalone method (the security-reviewed surface is never widened).
 */
describe("MemoryPort.searchLanes — the un-fused per-lane split", () => {
  it("declares an OPTIONAL searchLanes method and keeps search() unchanged (source grep — RED on pre-patch)", () => {
    // Runtime RED proof: fails on pre-patch source where searchLanes is absent.
    expect(portSrc, "searchLanes must be declared on MemoryPort").toMatch(/\bsearchLanes\?\s*\(/);
    // It must be OPTIONAL (the `?` after the method name) so an adapter MAY omit it
    // and callers fall back to search().
    expect(portSrc, "searchLanes must be optional").toMatch(/searchLanes\?\s*\(/);
    // search() stays a required method (byte-unchanged) — its signature line is intact.
    expect(portSrc, "search() must remain a required method").toMatch(/\n\s*search\s*\(/);
    // The return surfaces TWO named lanes: { fts, vector }.
    expect(portSrc, "searchLanes returns { fts, vector } lanes").toMatch(/fts:\s*MemorySearchResult\[\]/);
    expect(portSrc, "searchLanes returns { fts, vector } lanes").toMatch(/vector:\s*MemorySearchResult\[\]/);
  });

  it("accepts a structurally-valid adapter exposing searchLanes and exercises it", async () => {
    const ftsHit: MemorySearchResult = {
      entry: {
        id: "m1",
        tenantId: "t",
        agentId: "a",
        userId: "u",
        content: "fts hit",
        trustLevel: "learned",
        source: { who: "u" },
        tags: [],
        createdAt: 1,
      },
      score: 0.9,
    };
    const vecHit: MemorySearchResult = { ...ftsHit, entry: { ...ftsHit.entry, id: "m2" }, score: 0.8 };

    const stub: MemoryPort = {
      store: async () => ok(ftsHit.entry),
      search: async (): Promise<Result<MemorySearchResult[], Error>> => ok([ftsHit]),
      delete: async () => ok(true),
      searchLanes: async (): Promise<Result<{ fts: MemorySearchResult[]; vector: MemorySearchResult[] }, Error>> =>
        ok({ fts: [ftsHit], vector: [vecHit] }),
    };

    expect(stub.searchLanes).toBeDefined();
    const res = await stub.searchLanes?.(SESSION, "query", { limit: 10 });
    expect(res?.ok).toBe(true);
    if (res?.ok) {
      expect(res.value.fts).toHaveLength(1);
      expect(res.value.vector).toHaveLength(1);
      expect(res.value.fts[0]?.entry.id).toBe("m1");
      expect(res.value.vector[0]?.entry.id).toBe("m2");
    }
  });

  it("checks searchLanes is typed (sessionKey, query, options?) => Promise of Result of fts+vector lanes", () => {
    const stub: MemoryPort = {
      store: async () => ok({} as MemorySearchResult["entry"]),
      search: async (): Promise<Result<MemorySearchResult[], Error>> => ok([]),
      delete: async () => ok(true),
      searchLanes: async (): Promise<Result<{ fts: MemorySearchResult[]; vector: MemorySearchResult[] }, Error>> =>
        ok({ fts: [], vector: [] }),
    };
    type Lanes = { fts: MemorySearchResult[]; vector: MemorySearchResult[] };
    expectTypeOf(stub.searchLanes).toEqualTypeOf<
      | ((
          sessionKey: SessionKey,
          query: string | number[],
          options?: MemorySearchOptions,
        ) => Promise<Result<Lanes, Error>>)
      | undefined
    >();
  });

  it("permits an adapter WITHOUT searchLanes (the optional-method fallback contract)", () => {
    // A search-only adapter is still a valid MemoryPort — searchLanes is optional, so
    // a caller must fall back to search() when it is absent.
    const searchOnly: MemoryPort = {
      store: async () => ok({} as MemorySearchResult["entry"]),
      search: async (): Promise<Result<MemorySearchResult[], Error>> => ok([]),
      delete: async () => ok(true),
    };
    expect(searchOnly.searchLanes).toBeUndefined();
  });
});
