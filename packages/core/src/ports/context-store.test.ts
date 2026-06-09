// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
// Side-effecting (value) imports so the RED state is reproducible from this test
// commit alone: vitest must RESOLVE the modules at runtime. Both are type-only
// (core ports are zero-runtime-zod by rule) so they resolve to empty namespaces;
// the types are pulled via the `import type` blocks below. A bare `import type`
// would be stripped by the transform and never resolve, hiding RED if the
// symbols were missing.
//
// Because these ports are type-only, the type-level assertions below ERASE at
// runtime (vitest does not type-check). The runtime RED proof for the new E1
// surface is therefore the source-grep guard in the first test: it FAILS on
// pre-patch (the LcdSearchHit DTO + the 3 methods do not exist yet). The
// compile-time RED is `pnpm build --filter @comis/core` (the @ts-expect-error /
// expectTypeOf assertions only bite under tsc).
import "./context-store.js";
import "./context-store-types.js";
import type { ContextStorePort } from "./context-store.js";
import type {
  LcdSearchHit,
  LcdSearchResult,
  LcdSummary,
  LcdMessage,
  LcdContextItem,
  AppendMessageInput,
  AppendSummaryInput,
  AppendCondensedSummaryInput,
} from "./context-store-types.js";
// Public-surface RED proof: LcdSearchHit must be re-exported on the @comis/core
// barrel (../index.js is the in-package equivalent of the bare `@comis/core`
// specifier — index.ts `export *`s the curated exports/ports.js). This import
// fails to resolve (a tsc build error) until the export-wiring in ports/index.ts
// lands. @comis/skills and @comis/memory consume LcdSearchHit from this surface.
import type { LcdSearchHit as PublicLcdSearchHit } from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const portSrc = readFileSync(resolve(here, "./context-store.ts"), "utf8");
const typesSrc = readFileSync(resolve(here, "./context-store-types.ts"), "utf8");
const barrelSrc = readFileSync(resolve(here, "./index.ts"), "utf8");

/**
 * The Phase-131 E1 expansion-loop read surface on `ContextStorePort`.
 *
 * This is the INTERFACE-FIRST contract the memory adapter (Plan 02) implements
 * and the skills `ctx_*` tools (Plan 03) consume: three region-resolution +
 * search read methods plus the `LcdSearchHit` return DTO. All type-only (core
 * ports are zero-runtime-zod by rule) and synchronous (better-sqlite3 is
 * synchronous — the methods return arrays directly, never Promises).
 *
 * The runtime RED proof is the source-grep guards (the symbols are absent on
 * pre-patch source); the compile-time RED is the @ts-expect-error / expectTypeOf
 * assertions under tsc.
 */
describe("ContextStorePort — Phase-131 E1 expansion-loop read surface", () => {
  it("source declares getSummaryChildren / getSummaryMessages / searchLcd and stays type-only", () => {
    // Runtime RED proof: fails on pre-patch source where the 3 methods are absent.
    expect(portSrc, "getSummaryChildren must be on the port").toMatch(/\bgetSummaryChildren\s*\(/);
    expect(portSrc, "getSummaryMessages must be on the port").toMatch(/\bgetSummaryMessages\s*\(/);
    expect(portSrc, "searchLcd must be on the port").toMatch(/\bsearchLcd\s*\(/);
    // The port must stay type-only + synchronous: no zod, no @comis/memory
    // import (that would invert the dependency direction + break the agent↛memory
    // build cut), and the new methods must NOT return Promises (line 34-35:
    // "All operations are synchronous").
    expect(portSrc, "no zod in a type-only port").not.toMatch(/\bz\.[a-z]/);
    expect(portSrc, "no @comis/memory import in core port").not.toMatch(
      /^\s*import\b[^\n]*@comis\/memory/m,
    );
    expect(portSrc, "searchLcd must be synchronous (no Promise return)").not.toMatch(
      /searchLcd\s*\([^)]*\)\s*:\s*Promise/,
    );
  });

  it("source declares the LcdSearchHit DTO with a CLOSED message|summary discriminator (not string)", () => {
    // Runtime RED proof: fails on pre-patch types where LcdSearchHit is absent.
    expect(typesSrc, "LcdSearchHit interface must be declared").toMatch(
      /export\s+interface\s+LcdSearchHit\b/,
    );
    // The discriminator is the closed string-literal union (AGENTS.md §2.8),
    // mirroring LcdRefKind — NOT `kind: string`.
    expect(typesSrc, "LcdSearchHit.kind must be the closed message|summary union").toMatch(
      /kind:\s*"message"\s*\|\s*"summary"/,
    );
    // Type-only rule: no zod, no Promise smuggled onto the DTO.
    expect(typesSrc, "no zod added to the type-only DTO file").not.toMatch(
      /^\s*import\b[^\n]*\bzod\b/m,
    );
  });

  it("barrel re-exports LcdSearchHit on the public @comis/core surface", () => {
    // Runtime RED proof: fails on pre-patch barrel where LcdSearchHit is not exported.
    expect(barrelSrc, "LcdSearchHit must be re-exported from ports/index.ts").toMatch(
      /\bLcdSearchHit\b/,
    );
  });

  it("Test 1: a valid LcdSearchHit literal is assignable; rank is optional", () => {
    const hit: LcdSearchHit = { kind: "message", refId: "m1", snippet: "x" };
    expectTypeOf(hit.kind).toEqualTypeOf<"message" | "summary">();
    expectTypeOf(hit.refId).toEqualTypeOf<string>();
    expectTypeOf(hit.snippet).toEqualTypeOf<string>();
    // rank is OPTIONAL (undefined for the LIKE fallback — no BM25 ranking).
    expectTypeOf(hit.rank).toEqualTypeOf<number | undefined>();
    expect(hit.refId).toBe("m1");

    // A summary-kind hit with a rank is equally valid.
    const ranked: LcdSearchHit = { kind: "summary", refId: "s1", snippet: "y", rank: -3.2 };
    expect(ranked.rank).toBe(-3.2);
  });

  it("Test 1 (compile-time): kind is a CLOSED union — `other` is NOT assignable", () => {
    const bad: LcdSearchHit = {
      // @ts-expect-error kind is the closed "message"|"summary" union — "other" is rejected
      kind: "other",
      refId: "m1",
      snippet: "x",
    };
    void bad;
  });

  it("Test 2: a stub implementing ALL 9 methods is assignable to ContextStorePort", () => {
    // The full extended surface: the existing 6 + the new 3. Proves the 3 methods
    // are actually ON the interface (a hand-built object literal, AGENTS.md §2.5).
    const stub: ContextStorePort = {
      append: (_input: AppendMessageInput): void => undefined,
      getMessages: (_conversationId: string): LcdMessage[] => [],
      appendLeafSummary: (_input: AppendSummaryInput): string => "s",
      appendCondensedSummary: (_input: AppendCondensedSummaryInput): string => "s",
      getContextItems: (_conversationId: string): LcdContextItem[] => [],
      getSummaries: (_conversationId: string): LcdSummary[] => [],
      // The 3 NEW E1 methods:
      getSummaryChildren: (_conversationId: string, _parentSummaryId: string): LcdSummary[] => [],
      getSummaryMessages: (_conversationId: string, _summaryId: string): string[] => [],
      searchLcd: (
        _conversationId: string,
        _query: string,
        _opts: { limit: number; scope?: "messages" | "summaries" | "both" },
      ): LcdSearchResult => ({ hits: [], cjkZeroHit: false }),
    };

    // The new methods are SYNCHRONOUS (return arrays directly, never Promises).
    expectTypeOf(stub.getSummaryChildren).returns.toEqualTypeOf<LcdSummary[]>();
    expectTypeOf(stub.getSummaryMessages).returns.toEqualTypeOf<string[]>();
    expectTypeOf(stub.searchLcd).returns.toEqualTypeOf<LcdSearchResult>();

    expect(stub.getSummaryChildren("c", "p")).toEqual([]);
    expect(stub.getSummaryMessages("c", "s")).toEqual([]);
    expect(stub.searchLcd("c", "q", { limit: 10 })).toEqual({ hits: [], cjkZeroHit: false });
  });

  it("Test 2 (compile-time): a ContextStorePort impl missing searchLcd is NOT assignable", () => {
    // @ts-expect-error the stub omits `searchLcd` (and the other new methods) — not a ContextStorePort
    const incomplete: ContextStorePort = {
      append: (): void => undefined,
      getMessages: (): LcdMessage[] => [],
      appendLeafSummary: (): string => "s",
      appendCondensedSummary: (): string => "s",
      getContextItems: (): LcdContextItem[] => [],
      getSummaries: (): LcdSummary[] => [],
    };
    void incomplete;
  });

  it("getSummaryChildren / getSummaryMessages are (conversationId, summaryId)-scoped + sync", () => {
    const stub = {
      getSummaryChildren: (_c: string, _p: string): LcdSummary[] => [],
      getSummaryMessages: (_c: string, _s: string): string[] => [],
    } as Pick<ContextStorePort, "getSummaryChildren" | "getSummaryMessages">;
    // Both take (conversationId, summaryId) — scoped by conversationId (E2/R4).
    expectTypeOf(stub.getSummaryChildren).parameters.toEqualTypeOf<[string, string]>();
    expectTypeOf(stub.getSummaryMessages).parameters.toEqualTypeOf<[string, string]>();
    // getSummaryMessages returns message IDS (strings), NOT LcdMessage rows.
    expectTypeOf(stub.getSummaryMessages).returns.toEqualTypeOf<string[]>();
  });

  it("Test 3: searchLcd opts accepts {limit} and {limit, scope:'both'}; scope is a closed union", () => {
    const stub = {
      searchLcd: (
        _c: string,
        _q: string,
        _opts: { limit: number; scope?: "messages" | "summaries" | "both" },
      ): LcdSearchResult => ({ hits: [], cjkZeroHit: false }),
    } as Pick<ContextStorePort, "searchLcd">;
    // limit-only (scope optional) and an explicit valid scope both type-check.
    expect(stub.searchLcd("c", "q", { limit: 10 })).toEqual({ hits: [], cjkZeroHit: false });
    expect(stub.searchLcd("c", "q", { limit: 10, scope: "both" })).toEqual({ hits: [], cjkZeroHit: false });
    expect(stub.searchLcd("c", "q", { limit: 5, scope: "messages" })).toEqual({ hits: [], cjkZeroHit: false });
    expect(stub.searchLcd("c", "q", { limit: 5, scope: "summaries" })).toEqual({ hits: [], cjkZeroHit: false });
  });

  it("Test 3 (compile-time): searchLcd rejects an invalid scope literal", () => {
    const stub = {
      searchLcd: (
        _c: string,
        _q: string,
        _opts: { limit: number; scope?: "messages" | "summaries" | "both" },
      ): LcdSearchResult => ({ hits: [], cjkZeroHit: false }),
    } as Pick<ContextStorePort, "searchLcd">;
    // @ts-expect-error scope is the closed "messages"|"summaries"|"both" union — "invalid" is rejected
    stub.searchLcd("c", "q", { limit: 10, scope: "invalid" });
  });

  it("Test 3 (compile-time): searchLcd requires limit (it is not optional)", () => {
    const stub = {
      searchLcd: (
        _c: string,
        _q: string,
        _opts: { limit: number; scope?: "messages" | "summaries" | "both" },
      ): LcdSearchResult => ({ hits: [], cjkZeroHit: false }),
    } as Pick<ContextStorePort, "searchLcd">;
    // @ts-expect-error limit is REQUIRED on the opts param — an empty opts object is rejected
    stub.searchLcd("c", "q", {});
  });
});

/**
 * The public @comis/core surface re-export of LcdSearchHit.
 *
 * Both downstream consumers cross the @comis/core barrel: @comis/skills (the
 * ctx_* tools that taint-wrap each hit's snippet) and @comis/memory (the sole
 * adapter that returns LcdSearchHit[] from searchLcd). This block proves the DTO
 * is structurally identical on the public surface.
 */
describe("LcdSearchHit — public @comis/core re-export", () => {
  it("re-exports LcdSearchHit on the public barrel, identical to the relative-path type", () => {
    expectTypeOf<PublicLcdSearchHit>().toEqualTypeOf<LcdSearchHit>();
    // A downstream consumer can name + build the DTO from the public surface.
    const hit: PublicLcdSearchHit = { kind: "summary", refId: "s1", snippet: "z" };
    expect(hit.kind).toBe("summary");
  });
});
