// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { ok, type Result } from "@comis/shared";
// Side-effecting (value) import so the RED state is reproducible from this test
// commit alone: vitest must RESOLVE `./relationship-store.js` at runtime. The
// module is type-only (mirrors user-representation-store.ts / triple-store.ts) so
// it resolves to an empty namespace; the types are pulled via the `import type`
// below. A bare `import type` would be stripped by the transform and never
// resolve, hiding RED if the symbols were missing.
//
// Because this port is type-only, the type-level assertions below erase at
// runtime (vitest does not type-check). The runtime RED proof for the
// RelationshipStore port shape is therefore the source-grep guard in the first
// test: it FAILS on pre-patch (the file/method/type literals do not exist yet)
// and the type-only port stays type-only (no zod, no @comis/memory import).
import "./relationship-store.js";
import type {
  RelationshipStore,
  RelationshipScope,
  RelationshipTrust,
  RelationshipEntry,
  RelationshipInput,
} from "./relationship-store.js";
// Public-surface RED proof (Task 3): the port types must be re-exported on the
// @comis/core barrel (../index.js is the in-package equivalent of the bare
// `@comis/core` specifier — index.ts `export *`s the curated exports/ports.js).
// These imports fail to resolve (a tsc build error) until the export-wiring in
// ports/index.ts + exports/ports.ts lands.
import type {
  RelationshipStore as PublicRelationshipStore,
  RelationshipScope as PublicRelationshipScope,
  RelationshipEntry as PublicRelationshipEntry,
  RelationshipInput as PublicRelationshipInput,
  RelationshipTrust as PublicRelationshipTrust,
} from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const portSrc = readFileSync(resolve(here, "./relationship-store.ts"), "utf8");

/**
 * Phase 108 (SOCIAL-01) — the segregated `RelationshipStore` foundation.
 *
 * The directional relationship port lives type-only in @comis/core (mirrors
 * user-representation-store.ts / triple-store.ts): the agent-side write path (the
 * offline directional builder) and the read path (the LLM-free injection block)
 * consume it by TYPE, the sole adapter lives in @comis/memory, the daemon injects
 * it. The port carries the WRITE (`upsert`) and the (tenant, agent, channel)-scoped
 * READ (`read`) — the dual write+read shape (NOT a split read/write port). The row
 * carries the DIRECTIONAL (subjectUserId, aboutUserId) pair instead of one userId.
 */
describe("RelationshipStore — type-only segregated directional port (SOCIAL-01)", () => {
  it("declares upsert/read on RelationshipStore and stays type-only (no zod, no @comis/memory)", () => {
    // Runtime RED proof: fails on pre-patch source where the file/method/type are absent.
    expect(portSrc, "RelationshipStore interface must be declared").toMatch(
      /export\s+interface\s+RelationshipStore\b/,
    );
    expect(portSrc, "upsert method must be on the port").toMatch(/\bupsert\s*\(/);
    expect(portSrc, "read method must be on the port").toMatch(/\bread\s*\(/);
    // The directional pair: a relationship edge is subjectUser → aboutUser.
    expect(portSrc, "RelationshipInput must carry subjectUserId").toMatch(
      /\bsubjectUserId\s*:\s*string/,
    );
    expect(portSrc, "RelationshipInput must carry aboutUserId").toMatch(
      /\baboutUserId\s*:\s*string/,
    );
    // The NEW isolation axis: channelId on the scope (SOCIAL-02 privacy boundary).
    expect(portSrc, "RelationshipScope must carry channelId").toMatch(
      /\bchannelId\s*:\s*string/,
    );
    // The high-trust floor as a TYPE: external is structurally absent.
    expect(portSrc, "RelationshipTrust must be 'system' | 'learned' only").toMatch(
      /RelationshipTrust\s*=\s*["']system["']\s*\|\s*["']learned["']/,
    );
    // The port must stay type-only (mirrors user-representation-store.ts) — neither a
    // zod dependency nor a runtime import of @comis/memory (that would invert the
    // dependency direction + break the agent↛memory build cut).
    expect(portSrc, "no zod in a type-only port").not.toMatch(/\bz\.[a-z]/);
    expect(portSrc, "no @comis/memory import in core port").not.toMatch(
      /^\s*import\b[^\n]*@comis\/memory/m,
    );
  });

  it("accepts a structurally-valid RelationshipStore implementation and exercises each method", async () => {
    const sampleInput: RelationshipInput = {
      subjectUserId: "user-a",
      aboutUserId: "user-b",
      content: "A defers to B on scheduling.",
      trust: "learned",
    };
    const sampleEntry: RelationshipEntry = {
      ...sampleInput,
      id: "rel-1",
      createdAt: 1_700_000_000_000,
    };
    const stub: RelationshipStore = {
      upsert: async (
        _entry: RelationshipInput,
        _scope: RelationshipScope,
      ): Promise<Result<void, Error>> => ok(undefined),
      read: async (
        _scope: Omit<RelationshipScope, "now">,
        _cap?: number,
      ): Promise<Result<RelationshipEntry[], Error>> => ok([sampleEntry]),
    };

    const wrote = await stub.upsert(sampleInput, {
      tenantId: "tenant-1",
      agentId: "agent-1",
      channelId: "channel-1",
      now: 1_700_000_000_000,
    });
    expect(wrote.ok).toBe(true);

    const readRes = await stub.read(
      { tenantId: "tenant-1", agentId: "agent-1", channelId: "channel-1" },
      50,
    );
    expect(readRes.ok).toBe(true);
    if (readRes.ok) {
      expect(readRes.value).toHaveLength(1);
      expect(readRes.value[0]?.subjectUserId).toBe("user-a");
      expect(readRes.value[0]?.aboutUserId).toBe("user-b");
      expect(readRes.value[0]?.content).toBe("A defers to B on scheduling.");
    }
  });

  it("exposes upsert typed as (RelationshipInput, RelationshipScope) => Promise<Result<void, Error>>", () => {
    const stub: RelationshipStore = {
      upsert: async (): Promise<Result<void, Error>> => ok(undefined),
      read: async (): Promise<Result<RelationshipEntry[], Error>> => ok([]),
    };
    expectTypeOf(stub.upsert).parameters.toEqualTypeOf<
      [RelationshipInput, RelationshipScope]
    >();
    expectTypeOf(stub.upsert).returns.toEqualTypeOf<Promise<Result<void, Error>>>();
  });

  it("exposes read typed as (Omit<RelationshipScope,'now'>, cap?) => Promise<Result<RelationshipEntry[], Error>>", () => {
    const stub: RelationshipStore = {
      upsert: async (): Promise<Result<void, Error>> => ok(undefined),
      read: async (): Promise<Result<RelationshipEntry[], Error>> => ok([]),
    };
    // The READ takes no clock (mirror TripleStorePort.asOf's Omit<…,"now">).
    expectTypeOf(stub.read).parameters.toEqualTypeOf<
      [Omit<RelationshipScope, "now">, (number | undefined)?]
    >();
    expectTypeOf(stub.read).returns.toEqualTypeOf<
      Promise<Result<RelationshipEntry[], Error>>
    >();
  });

  it("RelationshipScope carries (tenantId, agentId, channelId, now) — the (tenant,agent,channel) scope + injected clock", () => {
    const scope: RelationshipScope = {
      tenantId: "t",
      agentId: "a",
      channelId: "c",
      now: 123,
    };
    expectTypeOf(scope.tenantId).toEqualTypeOf<string>();
    expectTypeOf(scope.agentId).toEqualTypeOf<string>();
    expectTypeOf(scope.channelId).toEqualTypeOf<string>();
    expectTypeOf(scope.now).toEqualTypeOf<number>();
    expect(scope.now).toBe(123);
  });

  it("RelationshipTrust is the HIGH-TRUST floor ('system' | 'learned') — 'external' is structurally absent", () => {
    const tSystem: RelationshipTrust = "system";
    const tLearned: RelationshipTrust = "learned";
    expectTypeOf(tSystem).toEqualTypeOf<RelationshipTrust>();
    expect([tSystem, tLearned]).toEqual(["system", "learned"]);

    // The LLM has NO say in trust — the type only admits the floor values. An
    // `external` claim cannot be typed onto an input at the contract layer
    // (defense-in-depth with the DB CHECK in Plan 02). `@ts-expect-error` FAILS
    // the build if the error is ABSENT — i.e. if `external` ever became assignable.
    // @ts-expect-error 'external' is excluded from RelationshipTrust at the type level
    const _bad: RelationshipInput = {
      subjectUserId: "a",
      aboutUserId: "b",
      content: "x",
      trust: "external",
    };
    void _bad;
  });

  it("RelationshipInput carries the directional pair + content + trust + optional sourceMemoryId; Entry adds id/createdAt/updatedAt?", () => {
    const input: RelationshipInput = {
      subjectUserId: "user-a",
      aboutUserId: "user-b",
      content: "A trusts B's code reviews.",
      trust: "system",
      sourceMemoryId: "mem-1",
    };
    expectTypeOf(input.subjectUserId).toEqualTypeOf<string>();
    expectTypeOf(input.aboutUserId).toEqualTypeOf<string>();
    expectTypeOf(input.content).toEqualTypeOf<string>();
    expectTypeOf(input.trust).toEqualTypeOf<RelationshipTrust>();
    expectTypeOf(input.sourceMemoryId).toEqualTypeOf<string | undefined>();

    const entry: RelationshipEntry = {
      ...input,
      id: "rel-9",
      createdAt: 1,
      updatedAt: 2,
    };
    expectTypeOf(entry.id).toEqualTypeOf<string>();
    expectTypeOf(entry.createdAt).toEqualTypeOf<number>();
    expectTypeOf(entry.updatedAt).toEqualTypeOf<number | undefined>();
    expect(entry.id).toBe("rel-9");
  });

  it("preserves directionality: A→B is a DISTINCT input from B→A (the row is never symmetrized)", () => {
    const aToB: RelationshipInput = {
      subjectUserId: "user-a",
      aboutUserId: "user-b",
      content: "A's view of B.",
      trust: "learned",
    };
    const bToA: RelationshipInput = {
      subjectUserId: "user-b",
      aboutUserId: "user-a",
      content: "B's view of A.",
      trust: "learned",
    };
    // The directional pair is structural: swapping subject/about yields a
    // semantically distinct edge — the contract carries both ids, never a single
    // collapsed/symmetric key.
    expect(aToB.subjectUserId).toBe(bToA.aboutUserId);
    expect(aToB.aboutUserId).toBe(bToA.subjectUserId);
    expect(aToB.content).not.toBe(bToA.content);
  });
});

/**
 * Phase 108 (SOCIAL-01) — the public @comis/core surface re-export.
 *
 * The offline directional builder (Plan 02), the LLM-free injection (Plans 03/04),
 * and the daemon wiring (Plan 05) import these TYPES from `@comis/core` (never
 * @comis/memory). This block proves the port types are on the public barrel — the
 * same names, structurally identical to the relative-path types.
 */
describe("RelationshipStore — public @comis/core re-export (SOCIAL-01)", () => {
  it("re-exports the port types on the public barrel, identical to the relative-path types", () => {
    // Structural identity: the public-barrel types equal the relative-path types.
    expectTypeOf<PublicRelationshipStore>().toEqualTypeOf<RelationshipStore>();
    expectTypeOf<PublicRelationshipScope>().toEqualTypeOf<RelationshipScope>();
    expectTypeOf<PublicRelationshipEntry>().toEqualTypeOf<RelationshipEntry>();
    expectTypeOf<PublicRelationshipInput>().toEqualTypeOf<RelationshipInput>();
    expectTypeOf<PublicRelationshipTrust>().toEqualTypeOf<RelationshipTrust>();

    // A downstream consumer can name the port type from the public surface.
    const _check: PublicRelationshipStore = {
      upsert: async () => ok(undefined),
      read: async () => ok([]),
    };
    void _check;
  });
});
