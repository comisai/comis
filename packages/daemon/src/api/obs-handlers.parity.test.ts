// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { stableStringify } from "../../../../test/support/stable-stringify.js";
import { createObsHandlers, type ObsHandlerDeps } from "./obs-handlers.js";

/**
 * Phase 43 parity protection (FILE-SPLIT-09).
 *
 * These snapshots lock the byte-identical output of obs-handlers.ts's
 * public-API factory BEFORE the Phase 43 split refactor lands.
 *
 * The post-refactor behavior MUST match these snapshots exactly. Any byte
 * change FAILS this test, which fails `pnpm test`, which fails the
 * per-commit gate.
 *
 * Captured: in Phase 43 Wave 7 sub-plan 43-07a Task 1. Subsequent split
 * commits in 43-07b must keep this test green. Per FILE-SPLIT-17 + OQ-5
 * (progressive deletion), this file is DELETED at the end of 43-07b's
 * obs-handlers split commit once each new structure has at least one
 * independent behavior test per extracted module.
 *
 * Source-symbol surface as of capture (obs-handlers.ts at the merge base):
 *   value: createObsHandlers
 *   type:  ObsHandlerDeps (re-exported from api/types.ts)
 *
 * The behavior matrix targets:
 *   1. Public API surface (createObsHandlers + the returned handler-map's
 *      method names + helper exports).
 *   2. Representative method invocations against a minimal-deps factory.
 *
 * Methods chosen for behavior snapshots:
 *   obs.diagnostics      (dual-source merge; in-memory empty path)
 *   obs.delivery.stats   (dual-source merge; in-memory empty path)
 *   obs.channels.stale   (in-memory only; empty list)
 *   obs.context.pipeline (no in-handler admin gate; nullish collector)
 *   obs.getCacheStats    (no tokenTracker path returns zeros)
 */

// ---------------------------------------------------------------------------
// Minimal deps factory: vi.fn() stubs only; no IO and no `vi.useFakeTimers()`
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<ObsHandlerDeps>): ObsHandlerDeps {
  return {
    diagnosticCollector: {
      getRecent: vi.fn().mockReturnValue([]),
      getCounts: vi.fn().mockReturnValue({
        usage: 0,
        webhook: 0,
        message: 0,
        session: 0,
      }),
      reset: vi.fn(),
      prune: vi.fn().mockReturnValue(0),
      dispose: vi.fn(),
    },
    billingEstimator: {
      byProvider: vi.fn().mockReturnValue([]),
      byAgent: vi.fn().mockReturnValue({
        totalCost: 0,
        totalTokens: 0,
        callCount: 0,
      }),
      bySession: vi.fn().mockReturnValue({
        totalCost: 0,
        totalTokens: 0,
        callCount: 0,
      }),
      total: vi.fn().mockReturnValue({
        totalCost: 0,
        totalTokens: 0,
        callCount: 0,
      }),
      usage24h: vi
        .fn()
        .mockReturnValue(
          Array.from({ length: 24 }, (_, i) => ({ hour: i, tokens: 0 })),
        ),
    },
    channelActivityTracker: {
      getAll: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(null),
      getStale: vi.fn().mockReturnValue([]),
      recordActivity: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
    },
    deliveryTracer: {
      getRecent: vi.fn().mockReturnValue([]),
      getStats: vi.fn().mockReturnValue({
        total: 0,
        successes: 0,
        failures: 0,
        avgLatencyMs: 0,
      }),
      reset: vi.fn(),
      dispose: vi.fn(),
    },
    agents: {},
    ...overrides,
  } as unknown as ObsHandlerDeps;
}

// ---------------------------------------------------------------------------
// Parity describe: sorted by (a) public-API surface (b) behavior matrix
// ---------------------------------------------------------------------------

describe("obs-handlers parity (FILE-SPLIT-09)", () => {
  describe("public API surface", () => {
    it("createObsHandlers: returned handler map has expected method names", () => {
      const handlers = createObsHandlers(makeDeps());
      expect(stableStringify(Object.keys(handlers).sort())).toMatchSnapshot();
    });
  });

  describe("behavior matrix: representative inputs", () => {
    it("obs.diagnostics: returns expected shape for empty in-memory store with admin trust", async () => {
      const handlers = createObsHandlers(makeDeps());
      const result = await handlers["obs.diagnostics"]!({
        _trustLevel: "admin",
      });
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("obs.delivery.stats: returns expected shape for empty in-memory store with admin trust", async () => {
      const handlers = createObsHandlers(makeDeps());
      const result = await handlers["obs.delivery.stats"]!({
        _trustLevel: "admin",
      });
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("obs.channels.stale: returns expected shape for empty in-memory store with admin trust", async () => {
      const handlers = createObsHandlers(makeDeps());
      const result = await handlers["obs.channels.stale"]!({
        _trustLevel: "admin",
      });
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("obs.context.pipeline: returns empty array for missing collector with no admin gate", async () => {
      const handlers = createObsHandlers(makeDeps());
      const result = await handlers["obs.context.pipeline"]!({});
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("obs.getCacheStats: returns zero shape when tokenTracker is absent", async () => {
      const handlers = createObsHandlers(makeDeps());
      const result = await handlers["obs.getCacheStats"]!({
        _trustLevel: "admin",
      });
      expect(stableStringify(result)).toMatchSnapshot();
    });
  });
});
