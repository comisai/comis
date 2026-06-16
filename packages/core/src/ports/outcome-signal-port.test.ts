// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { ok, type Result } from "@comis/shared";
// Side-effecting (value) import so the RED state is reproducible from this
// test commit alone: vitest must RESOLVE `./outcome-signal-port.js` at runtime.
// The module is type-only (mirrors memory-usefulness-store.ts) so it resolves to
// an empty namespace; the types are pulled via the `import type` below. A bare
// `import type` would be stripped by the transform and never resolve, hiding RED
// if the symbols were missing.
//
// Because this port is type-only, the type-level assertions below erase at
// runtime (vitest does not type-check). The runtime RED proof is therefore the
// source-grep guard in the first test: it FAILS on the absent/empty
// `outcome-signal-port.ts` (the interfaces + methods do not exist yet) and the
// type-only port stays type-only (no zod, no @comis/memory import).
import "./outcome-signal-port.js";
import type {
  OutcomeSignalPort,
  LearningScope,
  ResolvedOutcome,
  OutcomeObservation,
  OutcomePruneResult,
} from "./outcome-signal-port.js";

const here = dirname(fileURLToPath(import.meta.url));
const portSrc = readFileSync(resolve(here, "./outcome-signal-port.ts"), "utf8");

/**
 * The OutcomeSignalPort: the SEGREGATED hexagonal boundary for the v2.26
 * outcome-signal feature (WS1). An implementer must expose `observe(obs)`
 * (idempotent WRITE), `resolve(trajectoryId, scope)` (precedence-first READ),
 * and `prune(retentionDays)` (age-based housekeeping). `observe`/`resolve`
 * return `Promise<Result<T, Error>>`. The `(tenant, agent)` scope (`LearningScope
 * = { tenantId, agentId, now? }`) is the SQL-baked isolation boundary the sole
 * adapter enforces. This is a NEW segregated port — it does NOT widen the
 * security-reviewed `MemoryPort`. There is NO `MemoryError` type — `Result<T,
 * Error>` only.
 */
describe("OutcomeSignalPort — outcome-signal contract (observe/resolve/prune)", () => {
  it("declares the port + DTO interfaces and stays a type-only port (no zod, no @comis/memory)", () => {
    // Runtime RED proof: fails on the absent/empty source where the interfaces
    // + methods do not exist yet.
    expect(portSrc, "OutcomeSignalPort interface must be declared").toMatch(
      /export\s+interface\s+OutcomeSignalPort\b/,
    );
    expect(portSrc, "LearningScope interface must be declared").toMatch(
      /export\s+interface\s+LearningScope\b/,
    );
    expect(portSrc, "ResolvedOutcome interface must be declared").toMatch(
      /export\s+interface\s+ResolvedOutcome\b/,
    );
    expect(portSrc, "OutcomeObservation interface must be declared").toMatch(
      /export\s+interface\s+OutcomeObservation\b/,
    );
    expect(portSrc, "observe method must be on the port").toMatch(/\bobserve\s*\(/);
    expect(portSrc, "resolve method must be on the port").toMatch(/\bresolve\s*\(/);
    expect(portSrc, "prune method must be on the port").toMatch(/\bprune\s*\(/);
    // The port must stay type-only (mirrors memory-usefulness-store.ts) — neither
    // a zod dependency nor a runtime import of @comis/memory (that would invert
    // the dependency direction + break the agent↛memory build cut).
    expect(portSrc, "no zod in a type-only port").not.toMatch(/\bz\.[a-z]/);
    expect(portSrc, "no @comis/memory import in core port").not.toMatch(
      /^\s*import\b[^\n]*@comis\/memory/m,
    );
    // There is NO MemoryError type — the port returns Result<T, Error>. Assert
    // it is never IMPORTED nor USED as the Result error channel (prose mentions
    // of the word in doc comments are fine — the contract is about type usage).
    expect(portSrc, "no MemoryError import").not.toMatch(/import[^\n]*\bMemoryError\b/);
    expect(portSrc, "Result error channel is Error, never MemoryError").not.toMatch(
      /Result<[^>]*,\s*MemoryError\s*>/,
    );
  });

  it("accepts a structurally-valid implementation exposing observe/resolve/prune and exercises them", async () => {
    const resolved: ResolvedOutcome = {
      outcome: "success",
      confidence: 0.9,
      sources: ["tool", "pipeline"],
      recalledIds: ["m1", "m2"],
      usedSkillIds: [],
    };
    const stub: OutcomeSignalPort = {
      observe: async (): Promise<Result<void, Error>> => ok(undefined),
      resolve: async (): Promise<Result<ResolvedOutcome, Error>> => ok(resolved),
      prune: (): OutcomePruneResult => ({ changes: 0 }),
    };

    const obs: OutcomeObservation = {
      tenantId: "t",
      agentId: "a",
      sessionId: "s",
      trajectoryId: "trace-1",
      outcome: "success",
      source: "tool",
      confidence: 0.9,
      observedAt: 1_000,
    };
    const wrote = await stub.observe(obs);
    expect(wrote.ok).toBe(true);

    const read = await stub.resolve("trace-1", { tenantId: "t", agentId: "a" });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.outcome).toBe("success");
      expect(read.value.sources).toContain("tool");
      expect(read.value.recalledIds).toEqual(["m1", "m2"]);
      // usedSkillIds is an EMPTY sink in P0 (populated Phase 201).
      expect(read.value.usedSkillIds).toEqual([]);
    }

    const pruned = stub.prune(30);
    expect(pruned.changes).toBe(0);
  });

  it("checks observe is typed as (OutcomeObservation) => Promise<Result<void, Error>>", () => {
    const stub: OutcomeSignalPort = {
      observe: async (): Promise<Result<void, Error>> => ok(undefined),
      resolve: async (): Promise<Result<ResolvedOutcome, Error>> =>
        ok({ outcome: "unknown", confidence: 0, sources: [], recalledIds: [], usedSkillIds: [] }),
      prune: (): OutcomePruneResult => ({ changes: 0 }),
    };
    expectTypeOf(stub.observe).parameters.toEqualTypeOf<[OutcomeObservation]>();
    expectTypeOf(stub.observe).returns.toEqualTypeOf<Promise<Result<void, Error>>>();
  });

  it("checks resolve is typed as (string, LearningScope) => Promise<Result<ResolvedOutcome, Error>>", () => {
    const stub: OutcomeSignalPort = {
      observe: async (): Promise<Result<void, Error>> => ok(undefined),
      resolve: async (): Promise<Result<ResolvedOutcome, Error>> =>
        ok({ outcome: "unknown", confidence: 0, sources: [], recalledIds: [], usedSkillIds: [] }),
      prune: (): OutcomePruneResult => ({ changes: 0 }),
    };
    expectTypeOf(stub.resolve).parameters.toEqualTypeOf<[string, LearningScope]>();
    expectTypeOf(stub.resolve).returns.toEqualTypeOf<Promise<Result<ResolvedOutcome, Error>>>();
  });

  it("LearningScope keeps its { tenantId, agentId, now? } shape (mirrors UsefulnessScope)", () => {
    const scope: LearningScope = { tenantId: "t", agentId: "a", now: 123 };
    expect(scope.now).toBe(123);
    expectTypeOf(scope.now).toEqualTypeOf<number | undefined>();
    // `now` is OPTIONAL — a read scope without it still type-checks.
    const minimal: LearningScope = { tenantId: "t", agentId: "a" };
    expect(minimal.now).toBeUndefined();
  });

  it("ResolvedOutcome.outcome is the closed success|failure|corrected|unknown union", () => {
    const r: ResolvedOutcome = {
      outcome: "corrected",
      confidence: 0.5,
      sources: ["correction"],
      recalledIds: [],
      usedSkillIds: [],
    };
    expectTypeOf(r.outcome).toEqualTypeOf<"success" | "failure" | "corrected" | "unknown">();
    expectTypeOf(r.confidence).toEqualTypeOf<number>();
    expectTypeOf(r.recalledIds).toEqualTypeOf<string[]>();
    expectTypeOf(r.usedSkillIds).toEqualTypeOf<string[]>();
    expectTypeOf(r.sources).toEqualTypeOf<
      Array<"tool" | "pipeline" | "correction" | "judge" | "reaction" | "explicit">
    >();
    expect(r.outcome).toBe("corrected");
  });

  it("resolve's Result<ResolvedOutcome, Error> value type-checks — proving NO MemoryError", () => {
    // A Result<ResolvedOutcome, Error> value satisfies the resolve return — the
    // error channel is the plain Error, never a MemoryError (which does not exist).
    const value: Result<ResolvedOutcome, Error> = ok({
      outcome: "failure",
      confidence: 1,
      sources: ["pipeline"],
      recalledIds: [],
      usedSkillIds: [],
    });
    expect(value.ok).toBe(true);
    expectTypeOf<Awaited<ReturnType<OutcomeSignalPort["resolve"]>>>().toEqualTypeOf<
      Result<ResolvedOutcome, Error>
    >();
  });
});
