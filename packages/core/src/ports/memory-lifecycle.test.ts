// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { ok, type Result } from "@comis/shared";
// Side-effecting (value) import so the RED state is reproducible from this test
// commit alone: vitest must RESOLVE `./memory-lifecycle.js` at runtime. The
// module is type-only (mirrors tuned-alpha-store.ts / user-representation-store.ts)
// so it resolves to an empty namespace; the types are pulled via the `import type`
// below. A bare `import type` would be stripped by the transform and never
// resolve, hiding RED if the symbols were missing.
//
// Because this port is type-only, the type-level assertions below erase at
// runtime (vitest does not type-check). The runtime RED proof for the
// MemoryLifecyclePort shape is therefore the source-grep guard in the first
// test: it FAILS on pre-patch (the file/method/type literals do not exist yet)
// and the type-only port stays type-only (no zod, no @comis/memory import).
import "./memory-lifecycle.js";
import type {
  MemoryLifecyclePort,
  MemoryLifecycleScope,
  MemoryTier,
  LifecycleSweepReport,
} from "./memory-lifecycle.js";
// Public-surface RED proof: the port types must be re-exported on the
// @comis/core barrel (../index.js is the in-package equivalent of the bare
// `@comis/core` specifier — index.ts `export *`s the curated exports/ports.js).
// These imports fail to resolve (a tsc build error) until the export-wiring in
// ports/index.ts + exports/ports.ts lands. The public-export-consumers gate
// requires the port be on the public surface; the consumers (the @comis/memory
// adapter + the daemon cron) land in later implementation phases.
import type {
  MemoryLifecyclePort as PublicMemoryLifecyclePort,
  MemoryLifecycleScope as PublicMemoryLifecycleScope,
  LifecycleSweepReport as PublicLifecycleSweepReport,
} from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const portSrc = readFileSync(resolve(here, "./memory-lifecycle.ts"), "utf8");

/**
 * The segregated, LIVE-but-gated `MemoryLifecyclePort` foundation.
 *
 * The lifecycle port lives type-only in @comis/core (mirrors tuned-alpha-store.ts /
 * user-representation-store.ts): the sole adapter lands in @comis/memory, the
 * daemon cron wires it; they consume it by TYPE. The port carries the maintenance
 * `runLifecycleSweep` (scoped per (tenant, agent) with an injected `now`, Result-returning)
 * + the reversal `unevict`, plus the optional per-call `MemoryLifecycleEvictionOverride`
 * the daemon threads from each agent's `learningForgetting` policy (FORGET-06).
 *
 * THE binding contract (FORGET-01): the port soft-evicts ONLY under an eviction-enabled
 * policy (the `evicted_at` marker, never a DELETE; reversible via `unevict`), and stays
 * DORMANT (evicts/demotes nothing — byte-identical) by default. The default-OFF gate is the
 * behavior switch, not a back-compat fallback. Tier promote/demote moves remain deferred
 * (promoted/demoted stay 0). The port is a NEW segregated port — it does NOT widen the
 * security-reviewed MemoryPort.
 */
describe("MemoryLifecyclePort — type-only segregated lifecycle port", () => {
  it("declares runLifecycleSweep on the port and stays type-only (no zod, no @comis/memory)", () => {
    // Runtime RED proof: fails on pre-patch source where the file/method/type are absent.
    expect(portSrc, "MemoryLifecyclePort interface must be declared").toMatch(
      /export\s+interface\s+MemoryLifecyclePort\b/,
    );
    expect(portSrc, "MemoryLifecycleScope interface must be declared").toMatch(
      /export\s+interface\s+MemoryLifecycleScope\b/,
    );
    expect(portSrc, "runLifecycleSweep method must be on the port").toMatch(
      /\brunLifecycleSweep\s*\(/,
    );
    // The (tenant, agent) scope + the injected clock (never Date.now()).
    expect(portSrc, "MemoryLifecycleScope must carry tenantId").toMatch(/\btenantId\s*:\s*string/);
    expect(portSrc, "MemoryLifecycleScope must carry agentId").toMatch(/\bagentId\s*:\s*string/);
    expect(portSrc, "MemoryLifecycleScope must carry the injected clock now").toMatch(
      /\bnow\s*:\s*number/,
    );
    // The port must stay type-only (mirrors tuned-alpha-store.ts) — neither a zod
    // dependency nor a runtime import of @comis/memory (that would invert the
    // dependency direction + break the agent↛memory build cut; the sole adapter
    // lives in @comis/memory).
    expect(portSrc, "no zod in a type-only port").not.toMatch(/\bz\.[a-z]/);
    expect(portSrc, "no @comis/memory import in core port").not.toMatch(
      /^\s*import\b[^\n]*@comis\/memory/m,
    );
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

  it("documents the LIVE-but-gated soft-eviction contract VERBATIM (the FORGET-01 default-OFF gate + the agent↛memory cut)", () => {
    // The LIVE-but-gated framing is load-bearing: 200-05 activated soft eviction behind the
    // eviction-enabled policy (FORGET-01), so the doc must record that the sweep soft-evicts
    // ONLY under the policy and stays DORMANT (byte-identical) by default — so a future reader
    // understands the default-OFF gate is the behavior switch, NOT a back-compat fallback.
    expect(portSrc, "the doc must name LIVE soft eviction").toMatch(/LIVE soft eviction/);
    expect(portSrc, "the doc must record the DORMANT default (byte-identity)").toMatch(/DORMANT/);
    expect(portSrc, "the doc must record the (still-deferred) tier moves").toMatch(/deferred/i);
    expect(portSrc, "the doc must cite the FORGET-01 requirement").toMatch(/FORGET-01/);
    // The NEW-port framing carried verbatim from tuned-alpha-store.ts.
    expect(portSrc, "the doc must state the port does NOT widen MemoryPort").toMatch(
      /does NOT widen/i,
    );
  });

  it("MemoryTier is the closed union 'durable' | 'ephemeral' (mirror the trustWeight closed switch)", () => {
    const durable: MemoryTier = "durable";
    const ephemeral: MemoryTier = "ephemeral";
    expectTypeOf(durable).toEqualTypeOf<MemoryTier>();
    expect(durable).toBe("durable");
    expect(ephemeral).toBe("ephemeral");
    // @ts-expect-error a tier outside the closed union is rejected at compile time
    const _bad: MemoryTier = "archived";
    void _bad;
  });

  it("LifecycleSweepReport is a counts-only summary {scanned,promoted,demoted,evicted} (§2.7)", () => {
    const report: LifecycleSweepReport = {
      scanned: 10,
      promoted: 0,
      demoted: 0,
      evicted: 0,
    };
    expectTypeOf(report.scanned).toEqualTypeOf<number>();
    expectTypeOf(report.promoted).toEqualTypeOf<number>();
    expectTypeOf(report.demoted).toEqualTypeOf<number>();
    expectTypeOf(report.evicted).toEqualTypeOf<number>();
    // Exactly these four counts — no id-list, no memory body (the §2.7 counts-only contract).
    expect(Object.keys(report).sort()).toEqual(["demoted", "evicted", "promoted", "scanned"]);
  });

  it("accepts a structurally-valid MemoryLifecyclePort implementation and exercises the sweep", async () => {
    // The SCAFFOLD-DORMANT contract in action: a conformant adapter scans rows but
    // promotes/demotes/evicts NOTHING (all 0) until an operator enables it.
    const stub: MemoryLifecyclePort = {
      runLifecycleSweep: async (
        _scope: MemoryLifecycleScope,
      ): Promise<Result<LifecycleSweepReport, Error>> =>
        ok({ scanned: 3, promoted: 0, demoted: 0, evicted: 0 }),
    };

    const res = await stub.runLifecycleSweep({
      tenantId: "tenant-1",
      agentId: "agent-1",
      now: 1_700_000_000_000,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Dormant: scanned may be > 0, but the demote/evict step performs nothing.
      expect(res.value.promoted).toBe(0);
      expect(res.value.demoted).toBe(0);
      expect(res.value.evicted).toBe(0);
    }
  });

  it("exposes runLifecycleSweep typed as (MemoryLifecycleScope) => Promise<Result<LifecycleSweepReport, Error>>", () => {
    const stub: MemoryLifecyclePort = {
      runLifecycleSweep: async (): Promise<Result<LifecycleSweepReport, Error>> =>
        ok({ scanned: 0, promoted: 0, demoted: 0, evicted: 0 }),
    };
    expectTypeOf(stub.runLifecycleSweep).parameters.toEqualTypeOf<[MemoryLifecycleScope]>();
    expectTypeOf(stub.runLifecycleSweep).returns.toEqualTypeOf<
      Promise<Result<LifecycleSweepReport, Error>>
    >();
  });

  it("MemoryLifecycleScope carries (tenantId, agentId, now) — the isolation boundary + injected clock", () => {
    const scope: MemoryLifecycleScope = { tenantId: "t", agentId: "a", now: 123 };
    expectTypeOf(scope.tenantId).toEqualTypeOf<string>();
    expectTypeOf(scope.agentId).toEqualTypeOf<string>();
    expectTypeOf(scope.now).toEqualTypeOf<number>();
    expect(scope.now).toBe(123);
  });
});

/**
 * The public @comis/core surface re-export.
 *
 * The sole adapter and the daemon cron wiring consume these
 * TYPES from `@comis/core` (never @comis/memory). This block proves the port types
 * are on the public barrel — the same names, structurally identical to the
 * relative-path types. (The public-export-consumers gate requires the export; its
 * consumers land in later implementation phases, so this is an ahead-of-consumer
 * planned-orphan.)
 */
describe("MemoryLifecyclePort — public @comis/core re-export", () => {
  it("re-exports the port types on the public barrel, identical to the relative-path types", () => {
    expectTypeOf<PublicMemoryLifecyclePort>().toEqualTypeOf<MemoryLifecyclePort>();
    expectTypeOf<PublicMemoryLifecycleScope>().toEqualTypeOf<MemoryLifecycleScope>();
    expectTypeOf<PublicLifecycleSweepReport>().toEqualTypeOf<LifecycleSweepReport>();

    // A downstream consumer can name the port type from the public surface.
    const _check: PublicMemoryLifecyclePort = {
      runLifecycleSweep: async () => ok({ scanned: 0, promoted: 0, demoted: 0, evicted: 0 }),
    };
    void _check;
  });
});
