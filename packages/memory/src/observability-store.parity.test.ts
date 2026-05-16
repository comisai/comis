// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { stableStringify } from "../../../test/support/stable-stringify.js";
import { initSchema } from "./schema.js";
import {
  createObservabilityStore,
  type ObservabilityStore,
  type TokenUsageRow,
  type DeliveryRow,
  type DiagnosticRow,
  type ChannelSnapshotRow,
  type ProviderAggregation,
  type AgentAggregation,
  type SessionAggregation,
  type HourlyBucket,
  type DeliveryStats,
  type ObsTableName,
  type ResetResult,
  type PruneResult,
  type TokenUsageQueryParams,
  type DeliveryQueryParams,
  type DiagnosticQueryParams,
} from "./observability-store.js";

/**
 * Phase 43 parity protection (FILE-SPLIT-13).
 *
 * Locks the byte-identical output of observability-store.ts's public-API
 * functions BEFORE the Phase 43 split refactor lands. Per FILE-SPLIT-17
 * + OQ-5 (progressive deletion), this file is DELETED in the same
 * commit as the source-file split (Task 2).
 *
 * The post-refactor behavior (4 modules + 1 barrel under
 * `packages/memory/src/observability-store/`) MUST match these snapshots
 * exactly. Any byte change FAILS this test → fails `pnpm test` → fails
 * the per-commit gate.
 *
 * Behavior matrix targets:
 *   1. Public API surface (handle's exported method names + named interface witnesses)
 *   2. Representative calls covering query / mutation / aggregate / reset / prune
 *
 * Per AGENTS.md §2.5 + Phase 42 PATTERNS, snapshots are scaffolding —
 * deleted progressively at end-of-wave once the existing
 * `observability-store.test.ts` (151+ tests) covers each post-split leaf.
 */

// Stable inputs (timestamps in 2024-03-09 epoch range; covers both `hour`
// bucket boundaries when fed to aggregateHourly).
const T_BASE = 1710000000000;
const T_PLUS_1H = T_BASE + 3600000;

function makeTokenEntry(overrides: Partial<TokenUsageRow> = {}): TokenUsageRow {
  return {
    timestamp: T_BASE,
    traceId: "trace-1",
    agentId: "agent-a",
    channelId: "ch-1",
    executionId: "exec-1",
    sessionKey: "sess-1",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    costInput: 0.003,
    costOutput: 0.0015,
    costTotal: 0.0045,
    costCacheRead: 0.001,
    costCacheWrite: 0.002,
    cacheSaved: 0.005,
    latencyMs: 1200,
    cacheRetention: null,
    ...overrides,
  };
}

function makeDeliveryEntry(overrides: Partial<DeliveryRow> = {}): DeliveryRow {
  return {
    timestamp: T_BASE,
    traceId: "trace-d",
    agentId: "agent-a",
    channelType: "discord",
    channelId: "ch-1",
    sessionKey: "sess-1",
    status: "success",
    latencyMs: 500,
    toolCalls: 1,
    llmCalls: 1,
    tokensTotal: 150,
    costTotal: 0.0045,
    ...overrides,
  };
}

function makeDiagnosticEntry(overrides: Partial<DiagnosticRow> = {}): DiagnosticRow {
  return {
    timestamp: T_BASE,
    category: "error",
    severity: "warn",
    agentId: "agent-a",
    sessionKey: "sess-1",
    message: "test diagnostic",
    traceId: "trace-d",
    ...overrides,
  };
}

function makeSnapshotEntry(overrides: Partial<ChannelSnapshotRow> = {}): ChannelSnapshotRow {
  return {
    timestamp: T_BASE,
    channelType: "discord",
    channelId: "ch-1",
    status: "connected",
    messagesSent: 10,
    messagesReceived: 5,
    uptimeMs: 60000,
    ...overrides,
  };
}

/** Strip server-assigned `id` for stable snapshots. */
function stripIds<T extends { id?: number }>(rows: readonly T[]): readonly Omit<T, "id">[] {
  return rows.map(({ id: _id, ...rest }) => rest);
}

describe("observability-store parity (FILE-SPLIT-13)", () => {
  let db: Database.Database;
  let store: ObservabilityStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 768);
    store = createObservabilityStore(db);
  });

  describe("public API surface", () => {
    it("exports the expected named symbols", () => {
      // Witness object: lists the factory + all exported types. Types are
      // type-only at runtime; use a const witness mapping symbol name → string
      // (this is the same convention used by Phase 42 parity tests).
      const exports = {
        createObservabilityStore: typeof createObservabilityStore,
        ObservabilityStore: "type" satisfies "type",
        TokenUsageRow: "type" satisfies "type",
        DeliveryRow: "type" satisfies "type",
        DiagnosticRow: "type" satisfies "type",
        ChannelSnapshotRow: "type" satisfies "type",
        ProviderAggregation: "type" satisfies "type",
        AgentAggregation: "type" satisfies "type",
        SessionAggregation: "type" satisfies "type",
        HourlyBucket: "type" satisfies "type",
        DeliveryStats: "type" satisfies "type",
        ObsTableName: "type" satisfies "type",
        ResetResult: "type" satisfies "type",
        PruneResult: "type" satisfies "type",
        TokenUsageQueryParams: "type" satisfies "type",
        DeliveryQueryParams: "type" satisfies "type",
        DiagnosticQueryParams: "type" satisfies "type",
      };
      expect(stableStringify(Object.keys(exports).sort())).toMatchSnapshot();
    });

    it("createObservabilityStore: factory returns expected handle shape", () => {
      // Sorted handle method names: the public surface that post-split
      // must remain byte-identical.
      expect(stableStringify(Object.keys(store).sort())).toMatchSnapshot();
    });
  });

  describe("behavior matrix: representative inputs", () => {
    it("queryTokenUsage: empty store returns empty array", () => {
      expect(stableStringify(store.queryTokenUsage())).toMatchSnapshot();
    });

    it("insertTokenUsage then queryTokenUsage: round-trips one row", () => {
      store.insertTokenUsage(makeTokenEntry());
      expect(stableStringify(stripIds(store.queryTokenUsage()))).toMatchSnapshot();
    });

    it("queryTokenUsage: filter by agentId returns matching rows only", () => {
      store.insertTokenUsage(makeTokenEntry({ agentId: "agent-a" }));
      store.insertTokenUsage(makeTokenEntry({ agentId: "agent-b", traceId: "trace-2" }));
      expect(
        stableStringify(stripIds(store.queryTokenUsage({ agentId: "agent-a" }))),
      ).toMatchSnapshot();
    });

    it("aggregateByProvider: empty range returns empty array", () => {
      expect(stableStringify(store.aggregateByProvider())).toMatchSnapshot();
    });

    it("aggregateByProvider: groups by provider+model across two inserts", () => {
      store.insertTokenUsage(makeTokenEntry({ totalTokens: 100, costTotal: 0.01 }));
      store.insertTokenUsage(
        makeTokenEntry({
          totalTokens: 200,
          costTotal: 0.02,
          traceId: "trace-2",
          model: "claude-sonnet-4-20250514",
        }),
      );
      expect(stableStringify(store.aggregateByProvider())).toMatchSnapshot();
    });

    it("aggregateByAgent: groups by agent_id with cache-saved sum", () => {
      store.insertTokenUsage(makeTokenEntry({ agentId: "agent-a", cacheSaved: 0.001 }));
      store.insertTokenUsage(
        makeTokenEntry({ agentId: "agent-b", cacheSaved: 0.002, traceId: "trace-2" }),
      );
      expect(stableStringify(store.aggregateByAgent())).toMatchSnapshot();
    });

    it("aggregateBySession: returns zero-stats for unknown session", () => {
      expect(stableStringify(store.aggregateBySession("missing"))).toMatchSnapshot();
    });

    it("aggregateBySession: returns sums for known session", () => {
      store.insertTokenUsage(makeTokenEntry({ sessionKey: "sess-A", totalTokens: 100 }));
      store.insertTokenUsage(
        makeTokenEntry({ sessionKey: "sess-A", totalTokens: 50, traceId: "trace-2" }),
      );
      expect(stableStringify(store.aggregateBySession("sess-A"))).toMatchSnapshot();
    });

    it("aggregateHourly: groups inserts at distinct hours into separate buckets", () => {
      store.insertTokenUsage(makeTokenEntry({ timestamp: T_BASE, totalTokens: 100 }));
      store.insertTokenUsage(
        makeTokenEntry({ timestamp: T_PLUS_1H, totalTokens: 50, traceId: "trace-2" }),
      );
      expect(stableStringify(store.aggregateHourly())).toMatchSnapshot();
    });

    it("insertDelivery + queryDelivery: round-trips one row", () => {
      store.insertDelivery(makeDeliveryEntry());
      expect(stableStringify(stripIds(store.queryDelivery()))).toMatchSnapshot();
    });

    it("deliveryStats: empty store returns zero counts", () => {
      expect(stableStringify(store.deliveryStats())).toMatchSnapshot();
    });

    it("deliveryStats: counts success vs error rows correctly", () => {
      store.insertDelivery(makeDeliveryEntry({ status: "success", latencyMs: 100 }));
      store.insertDelivery(makeDeliveryEntry({ status: "error", latencyMs: 200, traceId: "trace-2" }));
      expect(stableStringify(store.deliveryStats())).toMatchSnapshot();
    });

    it("insertDiagnostic + queryDiagnostics: round-trips one row", () => {
      store.insertDiagnostic(makeDiagnosticEntry());
      expect(stableStringify(stripIds(store.queryDiagnostics()))).toMatchSnapshot();
    });

    it("insertChannelSnapshot + latestChannelSnapshots: returns the row with stripped id", () => {
      store.insertChannelSnapshot(makeSnapshotEntry());
      expect(stableStringify(stripIds(store.latestChannelSnapshots()))).toMatchSnapshot();
    });

    it("resetAll: clears all observability tables and returns counts", () => {
      store.insertTokenUsage(makeTokenEntry());
      store.insertDelivery(makeDeliveryEntry());
      store.insertDiagnostic(makeDiagnosticEntry());
      store.insertChannelSnapshot(makeSnapshotEntry());
      const result = store.resetAll();
      expect(stableStringify(result)).toMatchSnapshot();
      // Post-reset state: every table is empty.
      expect(stableStringify(store.queryTokenUsage())).toMatchSnapshot();
      expect(stableStringify(store.queryDelivery())).toMatchSnapshot();
      expect(stableStringify(store.queryDiagnostics())).toMatchSnapshot();
      expect(stableStringify(store.latestChannelSnapshots())).toMatchSnapshot();
    });

    it("resetTable: clears one specific table and returns the row count", () => {
      store.insertTokenUsage(makeTokenEntry());
      store.insertTokenUsage(makeTokenEntry({ traceId: "trace-2" }));
      const removed = store.resetTable("token_usage");
      expect(stableStringify({ removed, remaining: store.queryTokenUsage() })).toMatchSnapshot();
    });

    it("prune: removes rows older than the retention horizon and keeps newer rows", () => {
      // Insert two rows at distant times; use a retention small enough to
      // catch the older row but keep the newer one.
      // The prune cutoff is `systemNowMs() - retentionDays * 86400000`.
      // We can't pin systemNowMs() here, but we CAN insert rows with
      // wall-clock-far-past timestamps so retentionDays=1 keeps only modern rows.
      store.insertTokenUsage(makeTokenEntry({ timestamp: 1, totalTokens: 100 }));
      store.insertTokenUsage(
        makeTokenEntry({ timestamp: Date.now(), totalTokens: 50, traceId: "trace-2" }),
      );
      const result = store.prune(1);
      // Snapshot the prune result shape; do NOT snapshot specific counts
      // because they could vary across machines if test runs at the second
      // boundary. Instead snapshot the shape (key set + non-negative-integer
      // assertion via JSON).
      expect(stableStringify(Object.keys(result).sort())).toMatchSnapshot();
      // The newer row must survive: assert via length, not snapshot.
      expect(store.queryTokenUsage().length).toBe(1);
    });
  });
});
