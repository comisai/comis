// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "./schema.js";
import { createObservabilityStore } from "./observability-store/index.js";
import type { ObservabilityStore } from "./observability-store/index.js";

describe("ObservabilityStore", () => {
  let db: Database.Database;
  let store: ObservabilityStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 768);
    store = createObservabilityStore(db);
  });

  function insertRawDelivery(input: {
    id?: unknown;
    timestamp: unknown;
    traceId: string;
    status: string;
    latencyMs: unknown;
    toolCalls?: unknown;
    llmCalls?: unknown;
    tokensTotal?: unknown;
    costTotal?: unknown;
  }): void {
    db.prepare(`
      INSERT INTO obs_delivery (
        id, timestamp, trace_id, agent_id, channel_type, channel_id, status,
        latency_ms, tool_calls, llm_calls, tokens_total, cost_total
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id ?? null,
      input.timestamp,
      input.traceId,
      "agent-a",
      "telegram",
      "chat_a",
      input.status,
      input.latencyMs,
      input.toolCalls ?? null,
      input.llmCalls ?? null,
      input.tokensTotal ?? 0,
      input.costTotal ?? 0,
    );
  }

  // -----------------------------------------------------------------------
  // Token usage CRUD
  // -----------------------------------------------------------------------

  // NOTE: describe("token usage") was removed in a prior port-trim cleanup
  // along with the ObservabilityStore.queryTokenUsage method. The
  // insertTokenUsage surface is still exercised via the prune/resetAll/
  // resetTable tests below (which insert rows and verify row counts via SQL
  // directly).

  // -----------------------------------------------------------------------
  // Aggregations
  // -----------------------------------------------------------------------

  describe("aggregateByProvider", () => {
    it("returns correct GROUP BY results for 2 providers", () => {
      const base = {
        timestamp: 1000,
        traceId: "t1",
        agentId: "a1",
        provider: "anthropic",
        model: "claude-sonnet",
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        costInput: 0.003,
        costOutput: 0.0015,
        costTotal: 0.005,
        costCacheRead: 0,
        costCacheWrite: 0,
        cacheSaved: 0,
        latencyMs: 500,
      };

      store.insertTokenUsage({ ...base, provider: "anthropic", model: "claude-sonnet", costTotal: 0.01, totalTokens: 100, cacheSaved: 0.003 });
      store.insertTokenUsage({ ...base, provider: "anthropic", model: "claude-sonnet", costTotal: 0.02, totalTokens: 200, cacheSaved: 0.005 });
      store.insertTokenUsage({ ...base, provider: "openai", model: "gpt-4o", costTotal: 0.05, totalTokens: 500, cacheSaved: 0.01 });

      const agg = store.aggregateByProvider();
      expect(agg).toHaveLength(2);

      const anthropic = agg.find((a) => a.provider === "anthropic")!;
      expect(anthropic.model).toBe("claude-sonnet");
      expect(anthropic.totalCost).toBeCloseTo(0.03);
      expect(anthropic.totalTokens).toBe(300);
      expect(anthropic.callCount).toBe(2);
      expect(anthropic.totalCacheSaved).toBeCloseTo(0.008);

      const openai = agg.find((a) => a.provider === "openai")!;
      expect(openai.model).toBe("gpt-4o");
      expect(openai.totalCost).toBeCloseTo(0.05);
      expect(openai.totalTokens).toBe(500);
      expect(openai.callCount).toBe(1);
      expect(openai.totalCacheSaved).toBeCloseTo(0.01);
    });

    it("respects sinceMs filter", () => {
      const base = {
        traceId: "t1",
        agentId: "a1",
        provider: "anthropic",
        model: "claude",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        costInput: 0.001,
        costOutput: 0.001,
        costTotal: 0.002,
        costCacheRead: 0,
        costCacheWrite: 0,
        cacheSaved: 0,
        latencyMs: 100,
      };

      store.insertTokenUsage({ ...base, timestamp: 1000, costTotal: 0.01 });
      store.insertTokenUsage({ ...base, timestamp: 5000, costTotal: 0.02 });

      const agg = store.aggregateByProvider(3000);
      expect(agg).toHaveLength(1);
      expect(agg[0]!.totalCost).toBeCloseTo(0.02);
      expect(agg[0]!.callCount).toBe(1);
    });
  });

  describe("aggregateByAgent", () => {
    it("returns correct GROUP BY results", () => {
      const base = {
        timestamp: 1000,
        traceId: "t1",
        provider: "anthropic",
        model: "claude",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 100,
        costInput: 0.001,
        costOutput: 0.001,
        costTotal: 0.01,
        costCacheRead: 0,
        costCacheWrite: 0,
        cacheSaved: 0,
        latencyMs: 100,
      };

      store.insertTokenUsage({ ...base, agentId: "agent-a", costTotal: 0.01, totalTokens: 100, cacheSaved: 0.004 });
      store.insertTokenUsage({ ...base, agentId: "agent-a", costTotal: 0.02, totalTokens: 200, cacheSaved: 0.006 });
      store.insertTokenUsage({ ...base, agentId: "agent-b", costTotal: 0.05, totalTokens: 500, cacheSaved: 0.015 });

      const agg = store.aggregateByAgent();
      expect(agg).toHaveLength(2);

      const agentA = agg.find((a) => a.agentId === "agent-a")!;
      expect(agentA.totalCost).toBeCloseTo(0.03);
      expect(agentA.totalTokens).toBe(300);
      expect(agentA.callCount).toBe(2);
      expect(agentA.totalCacheSaved).toBeCloseTo(0.01);

      const agentB = agg.find((a) => a.agentId === "agent-b")!;
      expect(agentB.totalCacheSaved).toBeCloseTo(0.015);
    });
  });

  describe("aggregateBySession", () => {
    it("returns correct results for a specific session", () => {
      const base = {
        timestamp: 1000,
        traceId: "t1",
        agentId: "a1",
        provider: "anthropic",
        model: "claude",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 100,
        costInput: 0.001,
        costOutput: 0.001,
        costTotal: 0.01,
        costCacheRead: 0,
        costCacheWrite: 0,
        cacheSaved: 0,
        latencyMs: 100,
      };

      store.insertTokenUsage({ ...base, sessionKey: "sess-1", costTotal: 0.01, totalTokens: 100, cacheSaved: 0.002 });
      store.insertTokenUsage({ ...base, sessionKey: "sess-1", costTotal: 0.02, totalTokens: 200, cacheSaved: 0.007 });
      store.insertTokenUsage({ ...base, sessionKey: "sess-2", costTotal: 0.05, totalTokens: 500, cacheSaved: 0.012 });

      const agg = store.aggregateBySession("sess-1");
      expect(agg.sessionKey).toBe("sess-1");
      expect(agg.totalCost).toBeCloseTo(0.03);
      expect(agg.totalTokens).toBe(300);
      expect(agg.callCount).toBe(2);
      expect(agg.totalCacheSaved).toBeCloseTo(0.009);
    });

    it("returns zeroes for non-existent session", () => {
      const agg = store.aggregateBySession("nonexistent");
      expect(agg.sessionKey).toBe("nonexistent");
      expect(agg.totalCost).toBe(0);
      expect(agg.totalTokens).toBe(0);
      expect(agg.callCount).toBe(0);
      expect(agg.totalCacheSaved).toBe(0);
    });
  });

  describe("aggregateHourly", () => {
    it("returns correct hourly buckets", () => {
      const base = {
        traceId: "t1",
        agentId: "a1",
        provider: "anthropic",
        model: "claude",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 100,
        costInput: 0.001,
        costOutput: 0.001,
        costTotal: 0.01,
        costCacheRead: 0,
        costCacheWrite: 0,
        cacheSaved: 0,
        latencyMs: 100,
      };

      const hour1 = 3600000; // 1 hour in ms
      const hour2 = 7200000; // 2 hours in ms

      // Two entries in hour 1
      store.insertTokenUsage({ ...base, timestamp: hour1 + 100, costTotal: 0.01, totalTokens: 100, cacheSaved: 0.003 });
      store.insertTokenUsage({ ...base, timestamp: hour1 + 200, costTotal: 0.02, totalTokens: 200, cacheSaved: 0.004 });
      // One entry in hour 2
      store.insertTokenUsage({ ...base, timestamp: hour2 + 100, costTotal: 0.05, totalTokens: 500, cacheSaved: 0.02 });

      const buckets = store.aggregateHourly();
      expect(buckets).toHaveLength(2);

      expect(buckets[0]!.hour).toBe(hour1);
      expect(buckets[0]!.totalCost).toBeCloseTo(0.03);
      expect(buckets[0]!.totalTokens).toBe(300);
      expect(buckets[0]!.callCount).toBe(2);
      expect(buckets[0]!.totalCacheSaved).toBeCloseTo(0.007);

      expect(buckets[1]!.hour).toBe(hour2);
      expect(buckets[1]!.totalCost).toBeCloseTo(0.05);
      expect(buckets[1]!.totalTokens).toBe(500);
      expect(buckets[1]!.callCount).toBe(1);
      expect(buckets[1]!.totalCacheSaved).toBeCloseTo(0.02);
    });
  });

  // -----------------------------------------------------------------------
  // Delivery CRUD
  // -----------------------------------------------------------------------

  describe("delivery", () => {
    const baseDelivery = {
      timestamp: 1710000000000,
      traceId: "trace-d1",
      agentId: "agent-a",
      channelType: "telegram",
      channelId: "tg-123",
      sessionKey: "sess-1",
      status: "success",
      latencyMs: 350,
      errorMessage: "",
      failureStage: null,
      errorKind: null,
      messagePreview: "Hello world",
      toolCalls: 2,
      llmCalls: 1,
      tokensTotal: 150,
      costTotal: 0.005,
    };

    it("inserts and queries a delivery row with all fields", () => {
      store.insertDelivery(baseDelivery);
      const rows = store.queryDelivery();
      expect(rows).toHaveLength(1);

      const row = rows[0]!;
      expect(row.traceId).toBe("trace-d1");
      expect(row.channelType).toBe("telegram");
      expect(row.status).toBe("success");
      expect(row.latencyMs).toBe(350);
      expect(row.toolCalls).toBe(2);
      expect(row.costTotal).toBeCloseTo(0.005);
      expect(row.failureStage).toBeNull();
      expect(row.errorKind).toBeNull();
    });

    it("persists unavailable delivery call counts as SQL NULL instead of fabricated zeroes", () => {
      store.insertDelivery({
        ...baseDelivery,
        toolCalls: undefined,
        llmCalls: undefined,
      });

      const raw = db
        .prepare("SELECT tool_calls, llm_calls FROM obs_delivery")
        .get() as { tool_calls: number | null; llm_calls: number | null };
      expect(raw.tool_calls).toBeNull();
      expect(raw.llm_calls).toBeNull();

      const row = store.queryDelivery()[0]!;
      expect(row.toolCalls).toBeNull();
      expect(row.llmCalls).toBeNull();
    });

    it("queries with channelType filter", () => {
      store.insertDelivery({ ...baseDelivery, channelType: "telegram" });
      store.insertDelivery({ ...baseDelivery, channelType: "discord" });

      const rows = store.queryDelivery({ channelType: "telegram" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.channelType).toBe("telegram");
    });

    it("queries with status filter", () => {
      store.insertDelivery({ ...baseDelivery, status: "success" });
      store.insertDelivery({ ...baseDelivery, status: "error" });
      store.insertDelivery({ ...baseDelivery, status: "timeout" });

      const rows = store.queryDelivery({ status: "error" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("error");
    });

    it("applies channel and exclusive beforeMs filters before the limit", () => {
      store.insertDelivery({ ...baseDelivery, timestamp: 100, channelId: "ch-a" });
      store.insertDelivery({ ...baseDelivery, timestamp: 200, channelId: "ch-a" });
      store.insertDelivery({ ...baseDelivery, timestamp: 300, channelId: "ch-b" });

      const rows = store.queryDelivery({ channelId: "ch-a", beforeMs: 250, limit: 1 });

      expect(rows).toHaveLength(1);
      expect(rows[0]!.timestamp).toBe(200);
      expect(rows[0]!.channelId).toBe("ch-a");
    });

    it("persists delivery failure stage and closed error kind", () => {
      store.insertDelivery({
        ...baseDelivery,
        status: "error",
        failureStage: "delivery",
        errorKind: "platform",
      });

      expect(store.queryDelivery()[0]).toMatchObject({
        status: "error",
        failureStage: "delivery",
        errorKind: "platform",
      });
    });

    it("queryDelivery retains valid rows when one persisted row is malformed", () => {
      insertRawDelivery({ timestamp: 300, traceId: "valid-newer", status: "success", latencyMs: 100 });
      insertRawDelivery({ timestamp: 200, traceId: "invalid-latency", status: "success", latencyMs: "not-a-number" });
      insertRawDelivery({ timestamp: 100, traceId: "valid-older", status: "error", latencyMs: 200 });

      const rows = store.queryDelivery();

      expect(rows.map((row) => row.traceId)).toEqual(["valid-newer", "valid-older"]);
      expect(rows.map((row) => row.status)).toEqual(["success", "error"]);
    });

    it("returns the newest valid row when malformed records fill the queryDelivery limit", () => {
      insertRawDelivery({ timestamp: 300, traceId: "invalid-newest", status: "success", latencyMs: "not-a-number" });
      insertRawDelivery({ timestamp: 200, traceId: "valid-newest", status: "success", latencyMs: 100 });
      insertRawDelivery({ timestamp: 100, traceId: "valid-older", status: "error", latencyMs: 200 });

      const rows = store.queryDelivery({ limit: 1 });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ traceId: "valid-newest", timestamp: 200 });
    });

    it("queryDelivery logs bounded metadata when persisted rows are malformed", () => {
      const warn = vi.fn();
      store = createObservabilityStore(db, { logger: { warn } });
      insertRawDelivery({ timestamp: 200, traceId: "invalid-latency", status: "success", latencyMs: "not-a-number" });
      insertRawDelivery({ timestamp: 100, traceId: "valid-row", status: "success", latencyMs: 100 });

      expect(store.queryDelivery()).toHaveLength(1);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        {
          invalidRows: 1,
          firstErrorPath: "latency_ms",
          hint: "Inspect obs_delivery integrity and restore or remove malformed rows",
          errorKind: "validation",
        },
        "Invalid delivery rows omitted from observability query",
      );
    });
  });

  describe("deliveryStats", () => {
    it("returns correct counts and avg latency", () => {
      const base = {
        timestamp: 1000,
        traceId: "t1",
        agentId: "a1",
        channelType: "telegram",
        channelId: "ch-1",
        latencyMs: 100,
      };

      store.insertDelivery({ ...base, status: "success", latencyMs: 100 });
      store.insertDelivery({ ...base, status: "success", latencyMs: 200 });
      store.insertDelivery({ ...base, status: "error", latencyMs: 50 });
      store.insertDelivery({ ...base, status: "timeout", latencyMs: 5000 });
      store.insertDelivery({ ...base, status: "filtered", latencyMs: 10 });
      store.insertDelivery({ ...base, status: "aborted", latencyMs: 20 });

      const stats = store.deliveryStats();
      expect(stats.total).toBe(6);
      expect(stats.success).toBe(2);
      expect(stats.error).toBe(1);
      expect(stats.timeout).toBe(1);
      expect(stats.filtered).toBe(1);
      expect(stats.aborted).toBe(1);
      expect(stats.attemptedLatencyMs).toBe(5350);
      expect(stats.avgLatencyMs).toBeCloseTo(1337.5); // attempted rows only: (100+200+50+5000)/4
    });

    it("applies the exclusive historical cutoff before aggregation", () => {
      const base = {
        traceId: "t1",
        agentId: "a1",
        channelType: "telegram",
        channelId: "ch-1",
        latencyMs: 100,
      };
      store.insertDelivery({ ...base, timestamp: 999, status: "success" });
      store.insertDelivery({ ...base, timestamp: 1000, status: "error" });

      const stats = store.deliveryStats({ beforeMs: 1000 });

      expect(stats.total).toBe(1);
      expect(stats.success).toBe(1);
      expect(stats.error).toBe(0);
    });

    it("returns zeroes when no data exists", () => {
      const stats = store.deliveryStats();
      expect(stats.total).toBe(0);
      expect(stats.success).toBe(0);
      expect(stats.avgLatencyMs).toBe(0);
    });

    it("deliveryStats excludes malformed statuses from the lifecycle total", () => {
      insertRawDelivery({ timestamp: 300, traceId: "valid-success", status: "success", latencyMs: 100 });
      insertRawDelivery({ timestamp: 200, traceId: "invalid-status", status: "corrupt", latencyMs: 999 });
      insertRawDelivery({ timestamp: 100, traceId: "valid-error", status: "error", latencyMs: 200 });

      expect(store.deliveryStats()).toEqual({
        total: 2,
        attempted: 2,
        success: 1,
        error: 1,
        timeout: 0,
        filtered: 0,
        aborted: 0,
        attemptedLatencyMs: 300,
        avgLatencyMs: 150,
      });
    });

    it("deliveryStats excludes malformed latencies from attempted aggregates", () => {
      insertRawDelivery({ timestamp: 300, traceId: "valid-success", status: "success", latencyMs: 100 });
      insertRawDelivery({ timestamp: 200, traceId: "invalid-latency", status: "success", latencyMs: "not-a-number" });
      insertRawDelivery({ timestamp: 100, traceId: "valid-error", status: "error", latencyMs: 200 });

      expect(store.deliveryStats()).toEqual({
        total: 2,
        attempted: 2,
        success: 1,
        error: 1,
        timeout: 0,
        filtered: 0,
        aborted: 0,
        attemptedLatencyMs: 300,
        avgLatencyMs: 150,
      });
    });

    it("counts every authoritative error kind as a valid delivery row", () => {
      store.insertDelivery({
        timestamp: 100,
        traceId: "sandbox-unavailable",
        agentId: "agent-a",
        channelType: "telegram",
        channelId: "chat_a",
        status: "error",
        latencyMs: 25,
        failureStage: "execution",
        errorKind: "sandbox_unavailable",
      });

      expect(store.deliveryStats()).toMatchObject({
        total: 1,
        attempted: 1,
        error: 1,
        attemptedLatencyMs: 25,
        avgLatencyMs: 25,
      });
    });

    it("warns and excludes infinite numeric values from delivery aggregates", () => {
      const warn = vi.fn();
      store = createObservabilityStore(db, { logger: { warn } });
      insertRawDelivery({
        timestamp: 100,
        traceId: "infinite-latency",
        status: "success",
        latencyMs: Number.POSITIVE_INFINITY,
      });

      expect(store.deliveryStats()).toMatchObject({
        total: 0,
        attempted: 0,
        success: 0,
        attemptedLatencyMs: 0,
        avgLatencyMs: 0,
      });
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ invalidRows: 1, errorKind: "validation" }),
        expect.stringContaining("delivery"),
      );
    });

    it("excludes unsafe finite latencies without erasing valid aggregate counts", () => {
      const warn = vi.fn();
      store = createObservabilityStore(db, { logger: { warn } });
      insertRawDelivery({
        timestamp: 300,
        traceId: "unsafe-latency-a",
        status: "success",
        latencyMs: Number.MAX_VALUE,
      });
      insertRawDelivery({
        timestamp: 200,
        traceId: "unsafe-latency-b",
        status: "error",
        latencyMs: Number.MAX_VALUE,
      });
      insertRawDelivery({
        timestamp: 100,
        traceId: "valid-latency",
        status: "success",
        latencyMs: 25,
      });

      expect(store.deliveryStats()).toEqual({
        total: 1,
        attempted: 1,
        success: 1,
        error: 0,
        timeout: 0,
        filtered: 0,
        aborted: 0,
        attemptedLatencyMs: 25,
        avgLatencyMs: 25,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ invalidRows: 2, errorKind: "validation" }),
        "Invalid delivery rows omitted from observability query",
      );
      expect(store.queryDelivery().map((row) => row.traceId)).toEqual(["valid-latency"]);
    });

    it("aggregates many individually valid latencies without SQLite integer overflow", () => {
      const rowCount = 1_025;
      for (let index = 0; index < rowCount; index += 1) {
        insertRawDelivery({
          timestamp: index + 1,
          traceId: `large-valid-latency-${index}`,
          status: "success",
          latencyMs: Number.MAX_SAFE_INTEGER,
        });
      }

      const stats = store.deliveryStats();

      expect(stats.total).toBe(rowCount);
      expect(stats.attempted).toBe(rowCount);
      expect(stats.success).toBe(rowCount);
      expect(Number.isFinite(stats.attemptedLatencyMs)).toBe(true);
      expect(stats.attemptedLatencyMs).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
      expect(stats.avgLatencyMs).toBeCloseTo(Number.MAX_SAFE_INTEGER, -1);
    });

    it("queryDelivery and deliveryStats exclude every malformed numeric semantic class", () => {
      insertRawDelivery({
        id: 100,
        timestamp: 1_000,
        traceId: "valid",
        status: "success",
        latencyMs: 125.5,
        toolCalls: 2,
        llmCalls: 1,
        tokensTotal: 50,
        costTotal: 0.25,
      });
      insertRawDelivery({ id: -1, timestamp: 990, traceId: "negative-id", status: "success", latencyMs: 1 });
      insertRawDelivery({ timestamp: -1, traceId: "negative-timestamp", status: "success", latencyMs: 1 });
      insertRawDelivery({ timestamp: 980.5, traceId: "fractional-timestamp", status: "success", latencyMs: 1 });
      insertRawDelivery({ timestamp: Number.POSITIVE_INFINITY, traceId: "infinite-timestamp", status: "success", latencyMs: 1 });
      insertRawDelivery({ timestamp: 970, traceId: "negative-latency", status: "success", latencyMs: -1 });
      insertRawDelivery({ timestamp: 965, traceId: "infinite-latency", status: "success", latencyMs: Number.POSITIVE_INFINITY });
      insertRawDelivery({ timestamp: 960, traceId: "negative-tools", status: "success", latencyMs: 1, toolCalls: -1 });
      insertRawDelivery({ timestamp: 955, traceId: "fractional-tools", status: "success", latencyMs: 1, toolCalls: 0.5 });
      insertRawDelivery({ timestamp: 950, traceId: "infinite-tools", status: "success", latencyMs: 1, toolCalls: Number.POSITIVE_INFINITY });
      insertRawDelivery({ timestamp: 945, traceId: "negative-llm", status: "success", latencyMs: 1, llmCalls: -1 });
      insertRawDelivery({ timestamp: 940, traceId: "fractional-llm", status: "success", latencyMs: 1, llmCalls: 1.5 });
      insertRawDelivery({ timestamp: 935, traceId: "infinite-llm", status: "success", latencyMs: 1, llmCalls: Number.POSITIVE_INFINITY });
      insertRawDelivery({ timestamp: 930, traceId: "negative-tokens", status: "success", latencyMs: 1, tokensTotal: -1 });
      insertRawDelivery({ timestamp: 925, traceId: "fractional-tokens", status: "success", latencyMs: 1, tokensTotal: 1.5 });
      insertRawDelivery({ timestamp: 920, traceId: "infinite-tokens", status: "success", latencyMs: 1, tokensTotal: Number.POSITIVE_INFINITY });
      insertRawDelivery({ timestamp: 915, traceId: "negative-cost", status: "success", latencyMs: 1, costTotal: -0.01 });
      insertRawDelivery({ timestamp: 910, traceId: "infinite-cost", status: "success", latencyMs: 1, costTotal: Number.POSITIVE_INFINITY });

      const queryWarn = vi.fn();
      const queryStore = createObservabilityStore(db, { logger: { warn: queryWarn } });
      expect(queryStore.queryDelivery().map((row) => row.traceId)).toEqual(["valid"]);
      expect(queryWarn).toHaveBeenCalledWith(
        expect.objectContaining({ invalidRows: 17, errorKind: "validation" }),
        "Invalid delivery rows omitted from observability query",
      );

      const statsWarn = vi.fn();
      const statsStore = createObservabilityStore(db, { logger: { warn: statsWarn } });
      expect(statsStore.deliveryStats()).toEqual({
        total: 1,
        attempted: 1,
        success: 1,
        error: 0,
        timeout: 0,
        filtered: 0,
        aborted: 0,
        attemptedLatencyMs: 125.5,
        avgLatencyMs: 125.5,
      });
      expect(statsWarn).toHaveBeenCalledWith(
        expect.objectContaining({ invalidRows: 17, errorKind: "validation" }),
        "Invalid delivery rows omitted from observability query",
      );
    });

    it("deliveryStats warns about malformed rows beyond the recent-query limit", () => {
      const warn = vi.fn();
      store = createObservabilityStore(db, { logger: { warn } });
      insertRawDelivery({ timestamp: 300, traceId: "valid-newest", status: "success", latencyMs: 100 });
      insertRawDelivery({ timestamp: 200, traceId: "invalid-status", status: "corrupt", latencyMs: 999 });

      expect(store.queryDelivery({ limit: 1 })).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();

      store.deliveryStats();

      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          invalidRows: 1,
          hint: expect.any(String),
          errorKind: "validation",
        }),
        expect.stringContaining("delivery"),
      );
    });

    it("warns once per store across repeated delivery query and stats polls", () => {
      const warn = vi.fn();
      store = createObservabilityStore(db, { logger: { warn } });
      insertRawDelivery({ timestamp: 200, traceId: "invalid-latency", status: "success", latencyMs: "not-a-number" });
      insertRawDelivery({ timestamp: 100, traceId: "valid-row", status: "success", latencyMs: 100 });

      store.queryDelivery();
      store.queryDelivery();
      store.deliveryStats();
      store.deliveryStats();

      expect(warn).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------------------------------
  // Diagnostics CRUD
  // -----------------------------------------------------------------------

  describe("diagnostics", () => {
    const baseDiag = {
      timestamp: 1710000000000,
      category: "llm_call",
      severity: "info",
      agentId: "agent-a",
      sessionKey: "sess-1",
      message: "LLM call completed",
      details: '{"model": "claude"}',
      traceId: "trace-d1",
    };

    it("inserts and queries a diagnostic row with all fields", () => {
      store.insertDiagnostic(baseDiag);
      const rows = store.queryDiagnostics();
      expect(rows).toHaveLength(1);

      const row = rows[0]!;
      expect(row.category).toBe("llm_call");
      expect(row.severity).toBe("info");
      expect(row.message).toBe("LLM call completed");
      expect(row.details).toBe('{"model": "claude"}');
    });

    it("queries with category filter", () => {
      store.insertDiagnostic({ ...baseDiag, category: "llm_call" });
      store.insertDiagnostic({ ...baseDiag, category: "error" });

      const rows = store.queryDiagnostics({ category: "error" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.category).toBe("error");
    });

    it("queries with severity filter", () => {
      store.insertDiagnostic({ ...baseDiag, severity: "info" });
      store.insertDiagnostic({ ...baseDiag, severity: "warn" });
      store.insertDiagnostic({ ...baseDiag, severity: "error" });

      const rows = store.queryDiagnostics({ severity: "warn" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.severity).toBe("warn");
    });
  });

  // -----------------------------------------------------------------------
  // Channel snapshots
  // -----------------------------------------------------------------------

  describe("channel snapshots", () => {
    it("inserts and returns latest snapshot per channel type", () => {
      store.insertChannelSnapshot({
        timestamp: 1000,
        channelType: "telegram",
        channelId: "tg-1",
        status: "connected",
        messagesSent: 10,
        messagesReceived: 20,
        uptimeMs: 60000,
      });
      store.insertChannelSnapshot({
        timestamp: 2000,
        channelType: "telegram",
        channelId: "tg-1",
        status: "connected",
        messagesSent: 15,
        messagesReceived: 25,
        uptimeMs: 120000,
      });
      store.insertChannelSnapshot({
        timestamp: 1500,
        channelType: "discord",
        channelId: "dc-1",
        status: "connected",
        messagesSent: 5,
        messagesReceived: 8,
        uptimeMs: 30000,
      });

      const snapshots = store.latestChannelSnapshots();
      expect(snapshots).toHaveLength(2);

      const tg = snapshots.find((s) => s.channelType === "telegram")!;
      expect(tg.timestamp).toBe(2000);
      expect(tg.messagesSent).toBe(15);

      const dc = snapshots.find((s) => s.channelType === "discord")!;
      expect(dc.timestamp).toBe(1500);
      expect(dc.messagesSent).toBe(5);
    });

    it("returns the latest snapshot for every channel type and channel id identity", () => {
      store.insertChannelSnapshot({
        timestamp: 1000,
        channelType: "telegram",
        channelId: "shared",
        status: "active",
        messagesSent: 1,
        messagesReceived: 1,
        uptimeMs: 1000,
      });
      store.insertChannelSnapshot({
        timestamp: 2000,
        channelType: "telegram",
        channelId: "telegram-other",
        status: "active",
        messagesSent: 2,
        messagesReceived: 2,
        uptimeMs: 2000,
      });
      store.insertChannelSnapshot({
        timestamp: 1500,
        channelType: "slack",
        channelId: "shared",
        status: "active",
        messagesSent: 3,
        messagesReceived: 3,
        uptimeMs: 1500,
      });
      store.insertChannelSnapshot({
        timestamp: 3000,
        channelType: "telegram",
        channelId: "shared",
        status: "active",
        messagesSent: 4,
        messagesReceived: 4,
        uptimeMs: 3000,
      });

      const snapshots = store.latestChannelSnapshots();

      expect(snapshots).toHaveLength(3);
      expect(snapshots).toEqual(expect.arrayContaining([
        expect.objectContaining({
          channelType: "telegram",
          channelId: "shared",
          timestamp: 3000,
          messagesSent: 4,
        }),
        expect.objectContaining({
          channelType: "telegram",
          channelId: "telegram-other",
          timestamp: 2000,
          messagesSent: 2,
        }),
        expect.objectContaining({
          channelType: "slack",
          channelId: "shared",
          timestamp: 1500,
          messagesSent: 3,
        }),
      ]));
    });

    it("breaks equal snapshot timestamps by the latest inserted compound identity row", () => {
      store.insertChannelSnapshot({
        timestamp: 1000,
        channelType: "telegram",
        channelId: "shared",
        status: "active",
        messagesSent: 1,
        messagesReceived: 1,
        uptimeMs: 1000,
      });
      store.insertChannelSnapshot({
        timestamp: 1000,
        channelType: "telegram",
        channelId: "shared",
        status: "stale",
        messagesSent: 2,
        messagesReceived: 3,
        uptimeMs: 2000,
      });

      expect(store.latestChannelSnapshots()).toEqual([
        expect.objectContaining({
          channelType: "telegram",
          channelId: "shared",
          status: "stale",
          messagesSent: 2,
          messagesReceived: 3,
        }),
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // Prune
  // -----------------------------------------------------------------------

  describe("prune", () => {
    it("deletes old rows and preserves recent ones", () => {
      const now = Date.now();
      const oldTs = now - 2 * 86400000; // 2 days ago
      const recentTs = now - 100; // 100ms ago

      const tokenBase = {
        traceId: "t1",
        agentId: "a1",
        provider: "anthropic",
        model: "claude",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        costInput: 0.001,
        costOutput: 0.001,
        costTotal: 0.002,
        costCacheRead: 0,
        costCacheWrite: 0,
        cacheSaved: 0,
        latencyMs: 100,
      };

      // Insert old and recent rows in all tables
      store.insertTokenUsage({ ...tokenBase, timestamp: oldTs });
      store.insertTokenUsage({ ...tokenBase, timestamp: recentTs });

      store.insertDelivery({
        timestamp: oldTs,
        traceId: "t1",
        agentId: "a1",
        channelType: "telegram",
        channelId: "ch-1",
        status: "success",
        latencyMs: 100,
      });
      store.insertDelivery({
        timestamp: recentTs,
        traceId: "t1",
        agentId: "a1",
        channelType: "telegram",
        channelId: "ch-1",
        status: "success",
        latencyMs: 100,
      });

      store.insertDiagnostic({ timestamp: oldTs, category: "error", severity: "warn", message: "old" });
      store.insertDiagnostic({ timestamp: recentTs, category: "error", severity: "warn", message: "recent" });

      store.insertChannelSnapshot({ timestamp: oldTs, channelType: "telegram", channelId: "telegram-main", status: "connected" });
      store.insertChannelSnapshot({ timestamp: recentTs, channelType: "telegram", channelId: "telegram-main", status: "connected" });

      // Prune with 1 day retention
      const result = store.prune(1);
      expect(result.tokenUsage).toBe(1);
      expect(result.delivery).toBe(1);
      expect(result.diagnostics).toBe(1);
      expect(result.channels).toBe(1);

      // Verify recent rows survive (direct SQL read; queryTokenUsage was removed
      // in a prior port-trim cleanup)
      const tokenRow = db.prepare("SELECT COUNT(*) as count FROM obs_token_usage").get() as { count: number };
      expect(tokenRow.count).toBe(1);
      expect(store.queryDelivery()).toHaveLength(1);
      expect(store.queryDiagnostics()).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------

  describe("resetAll", () => {
    it("deletes all rows from all tables and returns counts", () => {
      const tokenBase = {
        timestamp: 1000,
        traceId: "t1",
        agentId: "a1",
        provider: "anthropic",
        model: "claude",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        costInput: 0.001,
        costOutput: 0.001,
        costTotal: 0.002,
        costCacheRead: 0,
        costCacheWrite: 0,
        cacheSaved: 0,
        latencyMs: 100,
      };

      store.insertTokenUsage(tokenBase);
      store.insertTokenUsage({ ...tokenBase, timestamp: 2000 });
      store.insertDelivery({
        timestamp: 1000,
        traceId: "t1",
        agentId: "a1",
        channelType: "telegram",
        channelId: "ch-1",
        status: "success",
        latencyMs: 100,
      });
      store.insertDiagnostic({ timestamp: 1000, category: "error", severity: "warn", message: "test" });
      store.insertChannelSnapshot({ timestamp: 1000, channelType: "telegram", channelId: "telegram-main", status: "connected" });

      const result = store.resetAll();
      expect(result.tokenUsage).toBe(2);
      expect(result.delivery).toBe(1);
      expect(result.diagnostics).toBe(1);
      expect(result.channels).toBe(1);

      // All tables should be empty (direct SQL read; queryTokenUsage was removed
      // in a prior port-trim cleanup)
      const tokenRow = db.prepare("SELECT COUNT(*) as count FROM obs_token_usage").get() as { count: number };
      expect(tokenRow.count).toBe(0);
      expect(store.queryDelivery()).toHaveLength(0);
      expect(store.queryDiagnostics()).toHaveLength(0);
      expect(store.latestChannelSnapshots()).toHaveLength(0);
    });
  });

  describe("resetTable", () => {
    it("deletes from specific table only", () => {
      const tokenBase = {
        timestamp: 1000,
        traceId: "t1",
        agentId: "a1",
        provider: "anthropic",
        model: "claude",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        costInput: 0.001,
        costOutput: 0.001,
        costTotal: 0.002,
        costCacheRead: 0,
        costCacheWrite: 0,
        cacheSaved: 0,
        latencyMs: 100,
      };

      store.insertTokenUsage(tokenBase);
      store.insertDelivery({
        timestamp: 1000,
        traceId: "t1",
        agentId: "a1",
        channelType: "telegram",
        channelId: "ch-1",
        status: "success",
        latencyMs: 100,
      });
      store.insertDiagnostic({ timestamp: 1000, category: "error", severity: "warn", message: "test" });
      store.insertChannelSnapshot({ timestamp: 1000, channelType: "telegram", channelId: "telegram-main", status: "connected" });

      const count = store.resetTable("token_usage");
      expect(count).toBe(1);

      // Only token_usage should be empty (direct SQL read; queryTokenUsage was
      // removed in a prior port-trim cleanup)
      const tokenRow = db.prepare("SELECT COUNT(*) as count FROM obs_token_usage").get() as { count: number };
      expect(tokenRow.count).toBe(0);
      // Other tables should still have data
      expect(store.queryDelivery()).toHaveLength(1);
      expect(store.queryDiagnostics()).toHaveLength(1);
      expect(store.latestChannelSnapshots()).toHaveLength(1);
    });

    it("supports all table names", () => {
      store.insertDelivery({
        timestamp: 1000,
        traceId: "t1",
        agentId: "a1",
        channelType: "telegram",
        channelId: "ch-1",
        status: "success",
        latencyMs: 100,
      });
      expect(store.resetTable("delivery")).toBe(1);

      store.insertDiagnostic({ timestamp: 1000, category: "error", severity: "warn", message: "test" });
      expect(store.resetTable("diagnostics")).toBe(1);

      store.insertChannelSnapshot({ timestamp: 1000, channelType: "telegram", channelId: "telegram-main", status: "connected" });
      expect(store.resetTable("channels")).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Schema idempotency
  // -----------------------------------------------------------------------

  describe("schema idempotency", () => {
    it("calling initSchema twice does not error", () => {
      // First call was in beforeEach; call again
      expect(() => initSchema(db, 768)).not.toThrow();

      // Store should still work
      store.insertTokenUsage({
        timestamp: 1000,
        traceId: "t1",
        agentId: "a1",
        provider: "anthropic",
        model: "claude",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        costInput: 0.001,
        costOutput: 0.001,
        costTotal: 0.002,
        costCacheRead: 0,
        costCacheWrite: 0,
        cacheSaved: 0,
        latencyMs: 100,
      });
      // Direct SQL read; queryTokenUsage was removed in a prior port-trim cleanup
      const tokenRow = db.prepare("SELECT COUNT(*) as count FROM obs_token_usage").get() as { count: number };
      expect(tokenRow.count).toBe(1);
    });
  });

});
