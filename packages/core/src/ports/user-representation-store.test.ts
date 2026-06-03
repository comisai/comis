// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { ok, type Result } from "@comis/shared";
// Side-effecting (value) import so the RED state is reproducible from this test
// commit alone: vitest must RESOLVE `./user-representation-store.js` at runtime.
// The module is type-only (mirrors triple-store.ts) so it resolves to an empty
// namespace; the types are pulled via the `import type` below. A bare
// `import type` would be stripped by the transform and never resolve, hiding RED
// if the symbols were missing.
//
// Because this port is type-only, the type-level assertions below erase at
// runtime (vitest does not type-check). The runtime RED proof for the
// UserRepresentationStore port shape is therefore the source-grep guard in the
// first test: it FAILS on pre-patch (the file/method/type literals do not exist
// yet) and the type-only port stays type-only (no zod, no @comis/memory import).
import "./user-representation-store.js";
import type {
  UserRepresentationStore,
  UserRepresentationScope,
  UserRepresentationTrust,
  UserRepresentationEntry,
  UserRepresentationInput,
} from "./user-representation-store.js";
// Public-surface RED proof: the port types + the prefix-type enum must
// be re-exported on the @comis/core barrel (../index.js is the in-package
// equivalent of the bare `@comis/core` specifier — index.ts `export *`s the
// curated exports/ports.js + exports/domain.js). These imports fail to resolve
// (a tsc build error) until the export-wiring in ports/index.ts + exports/ports.ts
// + the domain barrels lands. The value import of the enum schema also forces
// runtime resolution of the public barrel.
import {
  UserRepresentationTypeSchema as PublicUserRepresentationTypeSchema,
  type UserRepresentationStore as PublicUserRepresentationStore,
  type UserRepresentationScope as PublicUserRepresentationScope,
  type UserRepresentationEntry as PublicUserRepresentationEntry,
  type UserRepresentationInput as PublicUserRepresentationInput,
  type UserRepresentationType as PublicUserRepresentationType,
} from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const portSrc = readFileSync(resolve(here, "./user-representation-store.ts"), "utf8");

/**
 * The segregated `UserRepresentationStore` foundation.
 *
 * The per-user representation port lives type-only in @comis/core (mirrors
 * triple-store.ts / memory-causal-store.ts): the agent-side write path (the
 * offline profile-builder) and the read path (prompt-assembly's LLM-free
 * profile-injection block) consume it by TYPE, the sole adapter lives in
 * @comis/memory, the daemon injects it. The port carries the WRITE (`upsert`)
 * and the (tenant, agent, user)-scoped READ (`read`) — the dual write+read shape
 * (NOT a split read/write port).
 */
describe("UserRepresentationStore — type-only segregated per-user port", () => {
  it("declares upsert/read on UserRepresentationStore and stays type-only (no zod, no @comis/memory)", () => {
    // Runtime RED proof: fails on pre-patch source where the file/method/type are absent.
    expect(portSrc, "UserRepresentationStore interface must be declared").toMatch(
      /export\s+interface\s+UserRepresentationStore\b/,
    );
    expect(portSrc, "upsert method must be on the port").toMatch(/\bupsert\s*\(/);
    expect(portSrc, "read method must be on the port").toMatch(/\bread\s*\(/);
    // The 3-way scope: (tenant, agent, user) — the TripleScope 2-way scope extended.
    expect(portSrc, "UserRepresentationScope must carry userId").toMatch(/\buserId\s*:\s*string/);
    // The high-trust floor as a TYPE: external is structurally absent.
    expect(portSrc, "UserRepresentationTrust must be 'system' | 'learned' only").toMatch(
      /UserRepresentationTrust\s*=\s*["']system["']\s*\|\s*["']learned["']/,
    );
    // The port must stay type-only (mirrors triple-store.ts) — neither a zod
    // dependency nor a runtime import of @comis/memory (that would invert the
    // dependency direction + break the agent↛memory build cut).
    expect(portSrc, "no zod in a type-only port").not.toMatch(/\bz\.[a-z]/);
    expect(portSrc, "no @comis/memory import in core port").not.toMatch(
      /^\s*import\b[^\n]*@comis\/memory/m,
    );
  });

  it("accepts a structurally-valid UserRepresentationStore implementation and exercises each method", async () => {
    const sampleInput: UserRepresentationInput = {
      entryType: "preference",
      content: "Prefers concise answers.",
      trust: "learned",
    };
    const sampleEntry: UserRepresentationEntry = {
      ...sampleInput,
      id: "rep-1",
      createdAt: 1_700_000_000_000,
    };
    const stub: UserRepresentationStore = {
      upsert: async (
        _entry: UserRepresentationInput,
        _scope: UserRepresentationScope,
      ): Promise<Result<void, Error>> => ok(undefined),
      read: async (
        _scope: Omit<UserRepresentationScope, "now">,
        _cap?: number,
      ): Promise<Result<UserRepresentationEntry[], Error>> => ok([sampleEntry]),
    };

    const wrote = await stub.upsert(sampleInput, {
      tenantId: "tenant-1",
      agentId: "agent-1",
      userId: "user-1",
      now: 1_700_000_000_000,
    });
    expect(wrote.ok).toBe(true);

    const readRes = await stub.read({ tenantId: "tenant-1", agentId: "agent-1", userId: "user-1" }, 50);
    expect(readRes.ok).toBe(true);
    if (readRes.ok) {
      expect(readRes.value).toHaveLength(1);
      expect(readRes.value[0]?.entryType).toBe("preference");
      expect(readRes.value[0]?.content).toBe("Prefers concise answers.");
    }
  });

  it("exposes upsert typed as (UserRepresentationInput, UserRepresentationScope) => Promise<Result<void, Error>>", () => {
    const stub: UserRepresentationStore = {
      upsert: async (): Promise<Result<void, Error>> => ok(undefined),
      read: async (): Promise<Result<UserRepresentationEntry[], Error>> => ok([]),
    };
    expectTypeOf(stub.upsert).parameters.toEqualTypeOf<
      [UserRepresentationInput, UserRepresentationScope]
    >();
    expectTypeOf(stub.upsert).returns.toEqualTypeOf<Promise<Result<void, Error>>>();
  });

  it("exposes read typed as (Omit<UserRepresentationScope,'now'>, cap?) => Promise<Result<UserRepresentationEntry[], Error>>", () => {
    const stub: UserRepresentationStore = {
      upsert: async (): Promise<Result<void, Error>> => ok(undefined),
      read: async (): Promise<Result<UserRepresentationEntry[], Error>> => ok([]),
    };
    // The READ takes no clock (mirror TripleStorePort.asOf's Omit<…,"now">).
    expectTypeOf(stub.read).parameters.toEqualTypeOf<
      [Omit<UserRepresentationScope, "now">, (number | undefined)?]
    >();
    expectTypeOf(stub.read).returns.toEqualTypeOf<
      Promise<Result<UserRepresentationEntry[], Error>>
    >();
  });

  it("UserRepresentationScope carries (tenantId, agentId, userId, now) — the 3-way scope + injected clock", () => {
    const scope: UserRepresentationScope = {
      tenantId: "t",
      agentId: "a",
      userId: "u",
      now: 123,
    };
    expectTypeOf(scope.tenantId).toEqualTypeOf<string>();
    expectTypeOf(scope.agentId).toEqualTypeOf<string>();
    expectTypeOf(scope.userId).toEqualTypeOf<string>();
    expectTypeOf(scope.now).toEqualTypeOf<number>();
    expect(scope.now).toBe(123);
  });

  it("UserRepresentationTrust is the HIGH-TRUST floor ('system' | 'learned') — 'external' is structurally absent", () => {
    const tSystem: UserRepresentationTrust = "system";
    const tLearned: UserRepresentationTrust = "learned";
    expectTypeOf(tSystem).toEqualTypeOf<UserRepresentationTrust>();
    expect([tSystem, tLearned]).toEqual(["system", "learned"]);

    // The LLM has NO say in trust — the type only admits the floor values. An
    // `external` claim cannot be typed onto an input at the contract layer
    // (defense-in-depth with the DB CHECK in the adapter). `@ts-expect-error` FAILS
    // the build if the error is ABSENT — i.e. if `external` ever became assignable.
    // @ts-expect-error 'external' is excluded from UserRepresentationTrust at the type level
    const _bad: UserRepresentationInput = {
      entryType: "preference",
      content: "x",
      trust: "external",
    };
    void _bad;
  });

  it("UserRepresentationInput carries entryType + content + trust + optional sourceMemoryId; Entry adds id/createdAt/updatedAt?", () => {
    const input: UserRepresentationInput = {
      entryType: "identity",
      content: "Name is Alice.",
      trust: "system",
      sourceMemoryId: "mem-1",
    };
    expectTypeOf(input.entryType).toEqualTypeOf<UserRepresentationEntry["entryType"]>();
    expectTypeOf(input.content).toEqualTypeOf<string>();
    expectTypeOf(input.trust).toEqualTypeOf<UserRepresentationTrust>();
    expectTypeOf(input.sourceMemoryId).toEqualTypeOf<string | undefined>();

    const entry: UserRepresentationEntry = {
      ...input,
      id: "rep-9",
      createdAt: 1,
      updatedAt: 2,
    };
    expectTypeOf(entry.id).toEqualTypeOf<string>();
    expectTypeOf(entry.createdAt).toEqualTypeOf<number>();
    expectTypeOf(entry.updatedAt).toEqualTypeOf<number | undefined>();
    expect(entry.id).toBe("rep-9");
  });
});

/**
 * The public @comis/core surface re-export.
 *
 * The offline builder, the prompt-assembly injection, and
 * the daemon wiring import these TYPES from `@comis/core` (never
 * @comis/memory). This block proves the port types AND the prefix-type enum are
 * on the public barrel — the same names, structurally identical to the
 * relative-path types.
 */
describe("UserRepresentationStore — public @comis/core re-export", () => {
  it("re-exports the port types on the public barrel, identical to the relative-path types", () => {
    // Structural identity: the public-barrel types equal the relative-path types.
    expectTypeOf<PublicUserRepresentationStore>().toEqualTypeOf<UserRepresentationStore>();
    expectTypeOf<PublicUserRepresentationScope>().toEqualTypeOf<UserRepresentationScope>();
    expectTypeOf<PublicUserRepresentationEntry>().toEqualTypeOf<UserRepresentationEntry>();
    expectTypeOf<PublicUserRepresentationInput>().toEqualTypeOf<UserRepresentationInput>();

    // A downstream consumer can name the port type from the public surface.
    const _check: PublicUserRepresentationStore = {
      upsert: async () => ok(undefined),
      read: async () => ok([]),
    };
    void _check;
  });

  it("re-exports the UserRepresentationType enum (value + type) on the public barrel", () => {
    // The runtime enum schema is reachable from the public surface (value import).
    expect(PublicUserRepresentationTypeSchema.parse("preference")).toBe("preference");
    expect(PublicUserRepresentationTypeSchema.safeParse("semantic").success).toBe(false);
    // The inferred type is reachable too.
    const t: PublicUserRepresentationType = "identity";
    expectTypeOf(t).toEqualTypeOf<UserRepresentationInput["entryType"]>();
    expect(t).toBe("identity");
  });
});
