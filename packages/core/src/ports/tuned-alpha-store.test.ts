// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { ok, type Result } from "@comis/shared";
// Side-effecting (value) import so the RED state is reproducible from this test
// commit alone: vitest must RESOLVE `./tuned-alpha-store.js` at runtime. The
// module is type-only (mirrors user-representation-store.ts / triple-store.ts) so
// it resolves to an empty namespace; the types are pulled via the `import type`
// below. A bare `import type` would be stripped by the transform and never
// resolve, hiding RED if the symbols were missing.
//
// Because this port is type-only, the type-level assertions below erase at
// runtime (vitest does not type-check). The runtime RED proof for the
// TunedAlphaStore port shape is therefore the source-grep guard in the first
// test: it FAILS on pre-patch (the file/method/type literals do not exist yet)
// and the type-only port stays type-only (no zod, no @comis/memory import, NO
// trust field).
import "./tuned-alpha-store.js";
import type {
  TunedAlphaStore,
  TunedAlphaScope,
  TunedAlphaVector,
} from "./tuned-alpha-store.js";
// Public-surface RED proof: the port types must be re-exported on the
// @comis/core barrel (../index.js is the in-package equivalent of the bare
// `@comis/core` specifier — index.ts `export *`s the curated exports/ports.js).
// These imports fail to resolve (a tsc build error) until the export-wiring in
// ports/index.ts + exports/ports.ts lands. The public-export-consumers gate
// requires the port be on the public surface; the consumers (the agent overlay +
// adapter) land in later cuts.
import type {
  TunedAlphaStore as PublicTunedAlphaStore,
  TunedAlphaScope as PublicTunedAlphaScope,
  TunedAlphaVector as PublicTunedAlphaVector,
} from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const portSrc = readFileSync(resolve(here, "./tuned-alpha-store.ts"), "utf8");

/**
 * The segregated `TunedAlphaStore` foundation.
 *
 * The tuned-alpha port lives type-only in @comis/core (mirrors
 * user-representation-store.ts / memory-usefulness-store.ts): the agent-side
 * apply path (the deterministic overlay) and the offline update job
 * consume it by TYPE, the sole adapter lives in @comis/memory,
 * the daemon injects it. The port carries the WRITE (`upsert`) and the
 * (tenant, agent)-scoped READ (`read`) — the dual write+read shape (NOT a split
 * read/write port).
 *
 * THE binding constraint (the ship-gate): the tunable vector is a
 * 4-tuple {recency, temporal, proof, usefulness} that NEVER names trust.
 * `trustAlpha` does NOT exist on `TunedAlphaVector` — trust is frozen under
 * tuning, sourced ONLY from static config at the apply site. This block
 * RED-proves that structural trust-exclusion (compile-time + grep-0).
 */
describe("TunedAlphaStore — type-only segregated tuned-alpha port", () => {
  it("declares upsert/read on TunedAlphaStore and stays type-only (no zod, no @comis/memory)", () => {
    // Runtime RED proof: fails on pre-patch source where the file/method/type are absent.
    expect(portSrc, "TunedAlphaStore interface must be declared").toMatch(
      /export\s+interface\s+TunedAlphaStore\b/,
    );
    expect(portSrc, "TunedAlphaVector interface must be declared").toMatch(
      /export\s+interface\s+TunedAlphaVector\b/,
    );
    expect(portSrc, "upsert method must be on the port").toMatch(/\bupsert\s*\(/);
    expect(portSrc, "read method must be on the port").toMatch(/\bread\s*\(/);
    // The (tenant, agent) scope + the injected clock (never Date.now()).
    expect(portSrc, "TunedAlphaScope must carry tenantId").toMatch(/\btenantId\s*:\s*string/);
    expect(portSrc, "TunedAlphaScope must carry agentId").toMatch(/\bagentId\s*:\s*string/);
    expect(portSrc, "TunedAlphaScope must carry the injected clock now").toMatch(
      /\bnow\s*:\s*number/,
    );
    // The port must stay type-only (mirrors user-representation-store.ts) —
    // neither a zod dependency nor a runtime import of @comis/memory (that would
    // invert the dependency direction + break the agent↛memory build cut).
    expect(portSrc, "no zod in a type-only port").not.toMatch(/\bz\.[a-z]/);
    expect(portSrc, "no @comis/memory import in core port").not.toMatch(
      /^\s*import\b[^\n]*@comis\/memory/m,
    );
  });

  it("STRUCTURAL TRUST-FREEZE belt #1: the source names NO trust field (grep-0)", () => {
    // The ship-gate: the tunable vector + scope NEVER name trust.
    // This is the reproducible runtime RED for the trust-exclusion: were a future
    // contributor to add `trustAlpha`/`trust_alpha`/`trust:` "for symmetry", this
    // grep would flip RED. The compile-time @ts-expect-error below is the second
    // belt; this source-grep is the one that survives the type-erasure at runtime.
    expect(portSrc, "no trustAlpha on the tuned-alpha port").not.toMatch(/trustAlpha/);
    expect(portSrc, "no trust_alpha column reference on the tuned-alpha port").not.toMatch(
      /trust_alpha/,
    );
    expect(portSrc, "no `trust:` field on the tuned-alpha port").not.toMatch(/\btrust\s*:/);
  });

  it("the port is TYPE-ONLY: zero runtime value exports (no export const/function/class)", () => {
    // Runtime erasure belt: a type-only port must compile to an empty namespace.
    // (The same guard the source-rules architecture gate enforces, asserted here
    // co-located so the RED is reproducible from this commit.)
    expect(portSrc, "no `export const` in a type-only port").not.toMatch(/^\s*export\s+const\s/m);
    expect(portSrc, "no `export function` in a type-only port").not.toMatch(
      /^\s*export\s+function\s/m,
    );
    expect(portSrc, "no `export class` in a type-only port").not.toMatch(/^\s*export\s+class\s/m);
  });

  it("TunedAlphaVector is EXACTLY the 4-tuple {recency,temporal,proof,usefulness} alphas", () => {
    const vec: TunedAlphaVector = {
      recencyAlpha: 0.1,
      temporalAlpha: 0.2,
      proofAlpha: 0.3,
      usefulnessAlpha: 0.4,
    };
    // The 4 fields are present + numeric.
    expectTypeOf(vec.recencyAlpha).toEqualTypeOf<number>();
    expectTypeOf(vec.temporalAlpha).toEqualTypeOf<number>();
    expectTypeOf(vec.proofAlpha).toEqualTypeOf<number>();
    expectTypeOf(vec.usefulnessAlpha).toEqualTypeOf<number>();
    // Exactly these four keys — no fifth (trustAlpha) key.
    expect(Object.keys(vec).sort()).toEqual([
      "proofAlpha",
      "recencyAlpha",
      "temporalAlpha",
      "usefulnessAlpha",
    ]);
  });

  it("STRUCTURAL TRUST-FREEZE belt #1 (compile-time): trustAlpha is NOT a field on TunedAlphaVector", () => {
    // `@ts-expect-error` FAILS the build if the error is ABSENT — i.e. if
    // `trustAlpha` ever became assignable to a TunedAlphaVector literal. This is
    // the compile-time half of the trust-exclusion (the source-grep above is the
    // runtime half). The 4-tuple is NON-NEGOTIABLE (REQUIREMENTS "Out of Scope: a
    // bandit that can move trustAlpha").
    const bad: TunedAlphaVector = {
      recencyAlpha: 0.1,
      temporalAlpha: 0.2,
      proofAlpha: 0.3,
      usefulnessAlpha: 0.4,
      // @ts-expect-error trustAlpha is structurally ABSENT from TunedAlphaVector (the ship-gate)
      trustAlpha: 0.5,
    };
    void bad;
    // Reading the (non-existent) field is also a compile error.
    // @ts-expect-error trustAlpha cannot be read off a TunedAlphaVector — it does not exist
    const _t: number = ({ recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, usefulnessAlpha: 0 } as TunedAlphaVector).trustAlpha;
    void _t;
  });

  it("accepts a structurally-valid TunedAlphaStore implementation and exercises each method", async () => {
    const sample: TunedAlphaVector = {
      recencyAlpha: 0.5,
      temporalAlpha: 0.25,
      proofAlpha: 0.1,
      usefulnessAlpha: 0.3,
    };
    const stub: TunedAlphaStore = {
      upsert: async (
        _vector: TunedAlphaVector,
        _scope: TunedAlphaScope,
      ): Promise<Result<void, Error>> => ok(undefined),
      read: async (
        _scope: Omit<TunedAlphaScope, "now">,
      ): Promise<Result<TunedAlphaVector | undefined, Error>> => ok(sample),
    };

    const wrote = await stub.upsert(sample, {
      tenantId: "tenant-1",
      agentId: "agent-1",
      now: 1_700_000_000_000,
    });
    expect(wrote.ok).toBe(true);

    const readRes = await stub.read({ tenantId: "tenant-1", agentId: "agent-1" });
    expect(readRes.ok).toBe(true);
    if (readRes.ok) {
      expect(readRes.value?.usefulnessAlpha).toBe(0.3);
    }
  });

  it("exposes upsert typed as (TunedAlphaVector, TunedAlphaScope) => Promise<Result<void, Error>>", () => {
    const stub: TunedAlphaStore = {
      upsert: async (): Promise<Result<void, Error>> => ok(undefined),
      read: async (): Promise<Result<TunedAlphaVector | undefined, Error>> => ok(undefined),
    };
    expectTypeOf(stub.upsert).parameters.toEqualTypeOf<[TunedAlphaVector, TunedAlphaScope]>();
    expectTypeOf(stub.upsert).returns.toEqualTypeOf<Promise<Result<void, Error>>>();
  });

  it("exposes read typed as (Omit<TunedAlphaScope,'now'>) => Promise<Result<TunedAlphaVector|undefined, Error>>", () => {
    const stub: TunedAlphaStore = {
      upsert: async (): Promise<Result<void, Error>> => ok(undefined),
      read: async (): Promise<Result<TunedAlphaVector | undefined, Error>> => ok(undefined),
    };
    // The READ takes no clock (mirror UserRepresentationStore.read's Omit<…,"now">).
    expectTypeOf(stub.read).parameters.toEqualTypeOf<[Omit<TunedAlphaScope, "now">]>();
    expectTypeOf(stub.read).returns.toEqualTypeOf<
      Promise<Result<TunedAlphaVector | undefined, Error>>
    >();
  });

  it("read returns undefined when no tuned row exists (→ apply site falls back to config alphas)", async () => {
    const stub: TunedAlphaStore = {
      upsert: async (): Promise<Result<void, Error>> => ok(undefined),
      read: async (): Promise<Result<TunedAlphaVector | undefined, Error>> => ok(undefined),
    };
    const res = await stub.read({ tenantId: "t", agentId: "a" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBeUndefined();
  });

  it("TunedAlphaScope carries (tenantId, agentId, now) — the 2-way scope + injected clock", () => {
    const scope: TunedAlphaScope = { tenantId: "t", agentId: "a", now: 123 };
    expectTypeOf(scope.tenantId).toEqualTypeOf<string>();
    expectTypeOf(scope.agentId).toEqualTypeOf<string>();
    expectTypeOf(scope.now).toEqualTypeOf<number>();
    expect(scope.now).toBe(123);
  });
});

/**
 * The public @comis/core surface re-export.
 *
 * The deterministic overlay, the offline update job, and the
 * daemon wiring consume these TYPES from `@comis/core` (never @comis/memory).
 * This block proves the port types are on the public barrel — the same names,
 * structurally identical to the relative-path types. (The public-export-consumers
 * gate requires the export; its consumers land in later cuts, so this is an
 * ahead-of-consumer planned-orphan.)
 */
describe("TunedAlphaStore — public @comis/core re-export", () => {
  it("re-exports the port types on the public barrel, identical to the relative-path types", () => {
    expectTypeOf<PublicTunedAlphaStore>().toEqualTypeOf<TunedAlphaStore>();
    expectTypeOf<PublicTunedAlphaScope>().toEqualTypeOf<TunedAlphaScope>();
    expectTypeOf<PublicTunedAlphaVector>().toEqualTypeOf<TunedAlphaVector>();

    // A downstream consumer can name the port type from the public surface.
    const _check: PublicTunedAlphaStore = {
      upsert: async () => ok(undefined),
      read: async () => ok(undefined),
    };
    void _check;
  });

  it("the public TunedAlphaVector is ALSO the 4-tuple with no trustAlpha (belt #1 on the public surface)", () => {
    const vec: PublicTunedAlphaVector = {
      recencyAlpha: 0,
      temporalAlpha: 0,
      proofAlpha: 0,
      usefulnessAlpha: 0,
    };
    expect(Object.keys(vec).sort()).toEqual([
      "proofAlpha",
      "recencyAlpha",
      "temporalAlpha",
      "usefulnessAlpha",
    ]);
    // @ts-expect-error trustAlpha is absent from the PUBLIC TunedAlphaVector too
    const _t: number = vec.trustAlpha;
    void _t;
  });
});
