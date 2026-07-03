// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
// Side-effecting (value) imports so vitest must RESOLVE the modules at
// runtime. Both are type-only (core ports are zero-runtime-zod by rule) so
// they resolve to empty namespaces; the types are pulled via the `import type`
// blocks below. A bare `import type` would be stripped by the transform and
// never resolve, hiding a missing module.
//
// Because these ports are type-only, the type-level assertions below ERASE at
// runtime (vitest does not type-check). The runtime guard for the read
// surface is therefore the source-grep test below: it FAILS if the
// LcdSearchHit DTO or the 3 read methods are removed from the port. The
// compile-time guard is `pnpm build --filter @comis/core` (the @ts-expect-error /
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
// Public-surface guard: LcdSearchHit must be re-exported on the @comis/core
// barrel (../index.js is the in-package equivalent of the bare `@comis/core`
// specifier — index.ts `export *`s the curated exports/ports.js). This import
// fails to resolve (a tsc build error) if the export-wiring in ports/index.ts
// is missing. @comis/skills and @comis/memory consume LcdSearchHit from this surface.
import type { LcdSearchHit as PublicLcdSearchHit } from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const portSrc = readFileSync(resolve(here, "./context-store.ts"), "utf8");
const typesSrc = readFileSync(resolve(here, "./context-store-types.ts"), "utf8");
const barrelSrc = readFileSync(resolve(here, "./index.ts"), "utf8");

/**
 * The expansion-loop read surface on `ContextStorePort`.
 *
 * This is the INTERFACE-FIRST contract the memory adapter implements
 * and the skills `ctx_*` tools consume: three region-resolution +
 * search read methods plus the `LcdSearchHit` return DTO. All type-only (core
 * ports are zero-runtime-zod by rule) and synchronous (better-sqlite3 is
 * synchronous — the methods return arrays directly, never Promises).
 *
 * The runtime guard is the source-grep tests (they fail if the symbols leave
 * the port source); the compile-time guard is the @ts-expect-error /
 * expectTypeOf assertions under tsc.
 */
describe("ContextStorePort — expansion-loop read surface", () => {
  it("source declares getSummaryChildren / getSummaryMessages / searchLcd and stays type-only", () => {
    // Runtime guard: fails if the 3 methods are removed from the port source.
    expect(portSrc, "getSummaryChildren must be on the port").toMatch(/\bgetSummaryChildren\s*\(/);
    expect(portSrc, "getSummaryMessages must be on the port").toMatch(/\bgetSummaryMessages\s*\(/);
    expect(portSrc, "searchLcd must be on the port").toMatch(/\bsearchLcd\s*\(/);
    // The port must stay type-only + synchronous: no zod, no @comis/memory
    // import (that would invert the dependency direction + break the agent↛memory
    // build cut), and the read methods must NOT return Promises (the port doc:
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
    // Runtime guard: fails if LcdSearchHit is removed from the types file.
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
    // Runtime guard: fails if the barrel stops exporting LcdSearchHit.
    expect(barrelSrc, "LcdSearchHit must be re-exported from ports/index.ts").toMatch(
      /\bLcdSearchHit\b/,
    );
  });

  it("a valid LcdSearchHit literal is assignable; rank is optional", () => {
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

  it("kind is a CLOSED union — `other` is NOT assignable (compile-time)", () => {
    const bad: LcdSearchHit = {
      // @ts-expect-error kind is the closed "message"|"summary" union — "other" is rejected
      kind: "other",
      refId: "m1",
      snippet: "x",
    };
    void bad;
  });

  it("a stub implementing ALL 9 methods is assignable to ContextStorePort", () => {
    // The full extended surface: the 6 write/read methods + the 3 region-walk/
    // search methods. Proves the 3 methods are actually ON the interface (a
    // hand-built object literal, AGENTS.md §2.5).
    const stub: ContextStorePort = {
      append: (_input: AppendMessageInput): void => undefined,
      getMessages: (_conversationId: string): LcdMessage[] => [],
      appendLeafSummary: (_input: AppendSummaryInput): string => "s",
      appendCondensedSummary: (_input: AppendCondensedSummaryInput): string => "s",
      getContextItems: (_conversationId: string): LcdContextItem[] => [],
      getSummaries: (_conversationId: string): LcdSummary[] => [],
      // The 3 region-walk/search read methods:
      getSummaryChildren: (_conversationId: string, _parentSummaryId: string): LcdSummary[] => [],
      getSummaryMessages: (_conversationId: string, _summaryId: string): string[] => [],
      searchLcd: (
        _conversationId: string,
        _query: string,
        _opts: { limit: number; scope?: "messages" | "summaries" | "both" },
      ): LcdSearchResult => ({ hits: [], cjkZeroHit: false, lane: "word", matchErrored: false }),
    };

    // The read methods are SYNCHRONOUS (return arrays directly, never Promises).
    expectTypeOf(stub.getSummaryChildren).returns.toEqualTypeOf<LcdSummary[]>();
    expectTypeOf(stub.getSummaryMessages).returns.toEqualTypeOf<string[]>();
    expectTypeOf(stub.searchLcd).returns.toEqualTypeOf<LcdSearchResult>();

    expect(stub.getSummaryChildren("c", "p")).toEqual([]);
    expect(stub.getSummaryMessages("c", "s")).toEqual([]);
    expect(stub.searchLcd("c", "q", { limit: 10 })).toEqual({ hits: [], cjkZeroHit: false, lane: "word", matchErrored: false });
  });

  it("a ContextStorePort impl missing searchLcd is NOT assignable (compile-time)", () => {
    // @ts-expect-error the stub omits `searchLcd` (and the other read methods) — not a ContextStorePort
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
    // Both take (conversationId, summaryId) — scoped by conversationId.
    expectTypeOf(stub.getSummaryChildren).parameters.toEqualTypeOf<[string, string]>();
    expectTypeOf(stub.getSummaryMessages).parameters.toEqualTypeOf<[string, string]>();
    // getSummaryMessages returns message IDS (strings), NOT LcdMessage rows.
    expectTypeOf(stub.getSummaryMessages).returns.toEqualTypeOf<string[]>();
  });

  it("searchLcd opts accepts {limit} and {limit, scope:'both'}; scope is a closed union", () => {
    const stub = {
      searchLcd: (
        _c: string,
        _q: string,
        _opts: { limit: number; scope?: "messages" | "summaries" | "both" },
      ): LcdSearchResult => ({ hits: [], cjkZeroHit: false, lane: "word", matchErrored: false }),
    } as Pick<ContextStorePort, "searchLcd">;
    // limit-only (scope optional) and an explicit valid scope both type-check.
    expect(stub.searchLcd("c", "q", { limit: 10 })).toEqual({ hits: [], cjkZeroHit: false, lane: "word", matchErrored: false });
    expect(stub.searchLcd("c", "q", { limit: 10, scope: "both" })).toEqual({ hits: [], cjkZeroHit: false, lane: "word", matchErrored: false });
    expect(stub.searchLcd("c", "q", { limit: 5, scope: "messages" })).toEqual({ hits: [], cjkZeroHit: false, lane: "word", matchErrored: false });
    expect(stub.searchLcd("c", "q", { limit: 5, scope: "summaries" })).toEqual({ hits: [], cjkZeroHit: false, lane: "word", matchErrored: false });
  });

  it("searchLcd rejects an invalid scope literal (compile-time)", () => {
    const stub = {
      searchLcd: (
        _c: string,
        _q: string,
        _opts: { limit: number; scope?: "messages" | "summaries" | "both" },
      ): LcdSearchResult => ({ hits: [], cjkZeroHit: false, lane: "word", matchErrored: false }),
    } as Pick<ContextStorePort, "searchLcd">;
    // @ts-expect-error scope is the closed "messages"|"summaries"|"both" union — "invalid" is rejected
    stub.searchLcd("c", "q", { limit: 10, scope: "invalid" });
  });

  it("searchLcd requires limit on opts (it is not optional) — compile-time", () => {
    const stub = {
      searchLcd: (
        _c: string,
        _q: string,
        _opts: { limit: number; scope?: "messages" | "summaries" | "both" },
      ): LcdSearchResult => ({ hits: [], cjkZeroHit: false, lane: "word", matchErrored: false }),
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
