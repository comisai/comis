// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ok } from "@comis/shared";
import type { Result } from "@comis/shared";
import {
  createBeforeToolCallGuard,
  mergeSessionStats,
  type PiExecutorDeps,
} from "./pi-executor.js";
import type { StepCounter } from "./step-counter.js";
import type { BudgetGuard, BudgetSnapshot } from "../budget/budget-guard.js";
import type { CircuitBreaker, CircuitState } from "../safety/circuit-breaker.js";

/**
 * Phase 42 parity protection — EXEC-SPLIT-01.
 *
 * These snapshots lock the byte-identical output of pi-executor.ts's
 * public-API functions BEFORE the Phase 42 split refactor lands.
 *
 * The post-refactor behavior MUST match these snapshots exactly. Any byte
 * change FAILS this test → fails `pnpm test` → fails the per-commit gate.
 *
 * Captured: in the Phase 42 reference commit (plan 42-01). Subsequent split
 * commits (Wave 2 cache-detection → Wave 3 request-body → Wave 4
 * prompt-runner → Wave 5 pi-executor) must keep this test green. Per
 * EXEC-SPLIT-14, this file is DELETED in plan 42-06 after each new
 * structure has ≥1 independent behavior test per extracted module.
 *
 * Open-question Q1 decision (locked): signatures + 5-8 behavior matrix
 * it() blocks per file.
 * Open-question Q3 decision (locked): `stableStringify` copied verbatim in
 * each parity test file.
 *
 * Note on the `createPiExecutor` factory: the factory requires the full
 * `PiExecutorDeps` interface (15+ adapter ports + safety controls + session
 * adapter + workspace dir) to construct. RESEARCH §"Pattern 1" calls this
 * "too expensive for a parity test" — we snapshot the `PiExecutorDeps`
 * key surface (type-level via the TypeScript compiler) via the exports
 * symbol-set + a sentinel that names the required `PiExecutorDeps` fields.
 */

function stableStringify(value: unknown): string {
  // Sort keys deterministically; drop `description: undefined` keys consistently;
  // produces a snapshot string that does not vary across Node patch versions.
  return JSON.stringify(
    value,
    (_key, val) => {
      if (val !== null && typeof val === "object" && !Array.isArray(val)) {
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(val as Record<string, unknown>).sort()) {
          const v = (val as Record<string, unknown>)[k];
          if (v !== undefined) sorted[k] = v;
        }
        return sorted;
      }
      return val;
    },
    2,
  );
}

// ---------------------------------------------------------------------------
// In-line fakes (Phase 39 pattern — `packages/agent/src/executor/cache-break-detection.test.ts:12-44`)
// No `vi.mock` ceremony; minimal shapes implementing only the methods the SUT calls.
// ---------------------------------------------------------------------------

function makeStepCounter(shouldHalt: boolean): StepCounter {
  return {
    increment: () => 0,
    shouldHalt: () => shouldHalt,
    reset: () => undefined,
    getCount: () => 0,
  };
}

function makeBudgetGuard(blocked: boolean): BudgetGuard {
  const snapshot: BudgetSnapshot = { perExecution: 0, perHour: 0, perDay: 0 };
  return {
    estimateCost: () => 0,
    checkBudget: (): Result<void, never> =>
      blocked
        ? // Use a literal err-shape — the production code only inspects `.ok`.
          ({ ok: false, error: undefined as never })
        : ok(undefined),
    recordUsage: () => undefined,
    resetExecution: () => undefined,
    getSnapshot: () => snapshot,
  };
}

function makeCircuitBreaker(open: boolean): CircuitBreaker {
  const state: CircuitState = open ? "open" : "closed";
  return {
    isOpen: () => open,
    recordSuccess: () => undefined,
    recordFailure: () => undefined,
    getState: () => state,
    reset: () => undefined,
  };
}

describe("pi-executor parity (EXEC-SPLIT-01)", () => {
  describe("public API surface", () => {
    it("exports the expected named symbols", () => {
      const exports = { createBeforeToolCallGuard, mergeSessionStats };
      expect(stableStringify(Object.keys(exports).sort())).toMatchSnapshot();
    });

    it("createBeforeToolCallGuard and mergeSessionStats: typeof witness", () => {
      expect(
        stableStringify({
          createBeforeToolCallGuard: typeof createBeforeToolCallGuard,
          mergeSessionStats: typeof mergeSessionStats,
        }),
      ).toMatchSnapshot();
    });

    it("PiExecutorDeps — type-level key witness (required-only proxy)", () => {
      // The interface is type-level; we snapshot a witness object whose keys
      // mirror the required (non-optional) `PiExecutorDeps` fields. The list
      // is hand-maintained because TypeScript does not expose interface keys at
      // runtime. Drift between this witness and the actual interface is caught
      // by the EXEC-SPLIT-06 architecture test in Wave 5.
      const requiredKeys: Array<keyof PiExecutorDeps> = [
        "circuitBreaker",
        "budgetGuard",
        "costTracker",
        "stepCounter",
        "eventBus",
        "logger",
        "authStorage",
        "modelRegistry",
        "sessionAdapter",
        "workspaceDir",
        "customTools",
        "agentDir",
      ];
      expect(stableStringify([...requiredKeys].sort())).toMatchSnapshot();
    });
  });

  describe("behavior matrix — representative inputs", () => {
    it("createBeforeToolCallGuard blocks when stepCounter.shouldHalt() is true", async () => {
      const guard = createBeforeToolCallGuard(
        makeStepCounter(true),
        makeBudgetGuard(false),
        makeCircuitBreaker(false),
      );
      const verdict = await guard({ toolCall: { name: "bash" }, args: { cmd: "ls" } });
      expect(stableStringify(verdict)).toMatchSnapshot();
    });

    it("createBeforeToolCallGuard blocks when budgetGuard.checkBudget(0) is err", async () => {
      const guard = createBeforeToolCallGuard(
        makeStepCounter(false),
        makeBudgetGuard(true),
        makeCircuitBreaker(false),
      );
      const verdict = await guard({ toolCall: { name: "bash" }, args: { cmd: "ls" } });
      expect(stableStringify(verdict)).toMatchSnapshot();
    });

    it("createBeforeToolCallGuard blocks when circuitBreaker.isOpen() is true", async () => {
      const guard = createBeforeToolCallGuard(
        makeStepCounter(false),
        makeBudgetGuard(false),
        makeCircuitBreaker(true),
      );
      const verdict = await guard({ toolCall: { name: "bash" }, args: { cmd: "ls" } });
      expect(stableStringify(verdict)).toMatchSnapshot();
    });

    it("createBeforeToolCallGuard allows execution when all checks pass", async () => {
      const guard = createBeforeToolCallGuard(
        makeStepCounter(false),
        makeBudgetGuard(false),
        makeCircuitBreaker(false),
      );
      const verdict = await guard({ toolCall: { name: "bash" }, args: { cmd: "ls" } });
      // `undefined` returns become `null` after JSON.stringify; we snapshot
      // the typeof witness alongside to make the contract explicit.
      expect(
        stableStringify({ verdict, typeof: typeof verdict, isUndefined: verdict === undefined }),
      ).toMatchSnapshot();
    });

    it("mergeSessionStats additively merges two SessionStats records", () => {
      const result = {
        tokensUsed: { input: 100, output: 50, total: 150, cacheRead: 0, cacheWrite: 0 },
      };
      mergeSessionStats(result, () => ({
        tokens: { input: 200, output: 80, total: 280, cacheRead: 1000, cacheWrite: 500 },
      }));
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("mergeSessionStats is a no-op when getSessionStats is undefined", () => {
      const baseline = {
        tokensUsed: { input: 100, output: 50, total: 150, cacheRead: 10, cacheWrite: 20 },
      };
      const result = JSON.parse(JSON.stringify(baseline));
      mergeSessionStats(result, undefined);
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("mergeSessionStats preserves bridge cacheRead/cacheWrite when stats are partial", () => {
      const result = {
        tokensUsed: { input: 100, output: 50, total: 150, cacheRead: 999, cacheWrite: 888 },
      };
      // Source stats lacking cacheRead/cacheWrite — fall back to bridge values.
      mergeSessionStats(result, () => ({
        tokens: { input: 200, output: 80, total: 280 },
      }));
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("mergeSessionStats handles getSessionStats throwing (non-fatal fallback)", () => {
      const baseline = {
        tokensUsed: { input: 100, output: 50, total: 150, cacheRead: 7, cacheWrite: 8 },
      };
      const result = JSON.parse(JSON.stringify(baseline));
      mergeSessionStats(result, () => {
        throw new Error("aborted");
      });
      expect(stableStringify(result)).toMatchSnapshot();
    });
  });
});
