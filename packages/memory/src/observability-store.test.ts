import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "./schema.js";
import { createObservabilityStore } from "./observability-store.js";
import type { ObservabilityStore } from "./observability-store.js";

describe("ObservabilityStore", () => {
  let db: Database.Database;
  let store: ObservabilityStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 768);
    store = createObservabilityStore(db);
  });

  // -----------------------------------------------------------------------
  // Token usage CRUD
  // -----------------------------------------------------------------------

  describe("token usage", () => {
    const baseEntry = {
      timestamp: 1710000000000,
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
    };

    it("inserts and queries a single row with all fields round-tripping", () => {
      store.insertTokenUsage(baseEntry);
      const rows = store.queryTokenUsage();
      expect(rows).toHaveLength(1);

      const row = rows[0]!;
      expect(row.id).toBeDefined();
      expect(row.timestamp).toBe(baseEntry.timestamp);
      expect(row.traceId).toBe("trace-1");
      expect(row.agentId).toBe("agent-a");
      expect(row.channelId).toBe("ch-1");
      expect(row.executionId).toBe("exec-1");
      expect(row.sessionKey).toBe("sess-1");
      expect(row.provider).toBe("anthropic");
      expect(row.model).toBe("claude-sonnet-4-20250514");
      expect(row.promptTokens).toBe(100);
      expect(row.completionTokens).toBe(50);
      expect(row.totalTokens).toBe(150);
      expect(row.cacheReadTokens).toBe(10);
      expect(row.cacheWriteTokens).toBe(5);
      expect(row.costInput).toBeCloseTo(0.003);
      expect(row.costOutput).toBeCloseTo(0.0015);
      expect(row.costTotal).toBeCloseTo(0.0045);
      expect(row.costCacheRead).toBeCloseTo(0.001);
      expect(row.costCacheWrite).toBeCloseTo(0.002);
      expect(row.cacheSaved).toBeCloseTo(0.005);
      expect(row.latencyMs).toBe(1200);
    });

    it("round-trips cache cost fields", () => {
      store.insertTokenUsage({
        ...baseEntry,
        costCacheRead: 0.0012,
        costCacheWrite: 0.0024,
        cacheSaved: 0.008,
      });
      const rows = store.queryTokenUsage();
      expect(rows[0]!.costCacheRead).toBeCloseTo(0.0012);
      expect(rows[0]!.costCacheWrite).toBeCloseTo(0.0024);
      expect(rows[0]!.cacheSaved).toBeCloseTo(0.008);
    });

    it("queries with sinceMs filter", () => {
      store.insertTokenUsage({ ...baseEntry, timestamp: 1000 });
      store.insertTokenUsage({ ...baseEntry, timestamp: 2000 });
      store.insertTokenUsage({ ...baseEntry, timestamp: 3000 });

      const rows = store.queryTokenUsage({ sinceMs: 2000 });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.timestamp >= 2000)).toBe(true);
    });

    it("queries with agentId filter", () => {
      store.insertTokenUsage({ ...baseEntry, agentId: "agent-a" });
      store.insertTokenUsage({ ...baseEntry, agentId: "agent-b" });

      const rows = store.queryTokenUsage({ agentId: "agent-a" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.agentId).toBe("agent-a");
    });

    it("queries with provider filter", () => {
      store.insertTokenUsage({ ...baseEntry, provider: "anthropic" });
      store.insertTokenUsage({ ...baseEntry, provider: "openai" });

      const rows = store.queryTokenUsage({ provider: "openai" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.provider).toBe("openai");
    });

    it("queries with sessionKey filter", () => {
      store.insertTokenUsage({ ...baseEntry, sessionKey: "sess-1" });
      store.insertTokenUsage({ ...baseEntry, sessionKey: "sess-2" });

      const rows = store.queryTokenUsage({ sessionKey: "sess-2" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sessionKey).toBe("sess-2");
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        store.insertTokenUsage({ ...baseEntry, timestamp: baseEntry.timestamp + i });
      }

      const rows = store.queryTokenUsage({ limit: 3 });
      expect(rows).toHaveLength(3);
    });

    it("orders results by timestamp DESC", () => {
      store.insertTokenUsage({ ...baseEntry, timestamp: 1000 });
      store.insertTokenUsage({ ...baseEntry, timestamp: 3000 });
      store.insertTokenUsage({ ...baseEntry, timestamp: 2000 });

      const rows = store.queryTokenUsage();
      expect(rows[0]!.timestamp).toBe(3000);
      expect(rows[1]!.timestamp).toBe(2000);
      expect(rows[2]!.timestamp).toBe(1000);
    });
  });

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

      const stats = store.deliveryStats();
      expect(stats.total).toBe(5);
      expect(stats.success).toBe(2);
      expect(stats.error).toBe(1);
      expect(stats.timeout).toBe(1);
      expect(stats.filtered).toBe(1);
      expect(stats.avgLatencyMs).toBeCloseTo(1072); // (100+200+50+5000+10)/5
    });

    it("returns zeroes when no data exists", () => {
      const stats = store.deliveryStats();
      expect(stats.total).toBe(0);
      expect(stats.success).toBe(0);
      expect(stats.avgLatencyMs).toBe(0);
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

      store.insertChannelSnapshot({ timestamp: oldTs, channelType: "telegram", status: "connected" });
      store.insertChannelSnapshot({ timestamp: recentTs, channelType: "telegram", status: "connected" });

      // Prune with 1 day retention
      const result = store.prune(1);
      expect(result.tokenUsage).toBe(1);
      expect(result.delivery).toBe(1);
      expect(result.diagnostics).toBe(1);
      expect(result.channels).toBe(1);

      // Verify recent rows survive
      expect(store.queryTokenUsage()).toHaveLength(1);
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
      store.insertChannelSnapshot({ timestamp: 1000, channelType: "telegram", status: "connected" });

      const result = store.resetAll();
      expect(result.tokenUsage).toBe(2);
      expect(result.delivery).toBe(1);
      expect(result.diagnostics).toBe(1);
      expect(result.channels).toBe(1);

      // All tables should be empty
      expect(store.queryTokenUsage()).toHaveLength(0);
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
      store.insertChannelSnapshot({ timestamp: 1000, channelType: "telegram", status: "connected" });

      const count = store.resetTable("token_usage");
      expect(count).toBe(1);

      // Only token_usage should be empty
      expect(store.queryTokenUsage()).toHaveLength(0);
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

      store.insertChannelSnapshot({ timestamp: 1000, channelType: "telegram", status: "connected" });
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
      expect(store.queryTokenUsage()).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // DDL migration (17 -> 20 columns)
  // -----------------------------------------------------------------------

  describe("DDL migration", () => {
    it("migrates existing 17-column schema to 20 columns", () => {
      const freshDb = new Database(":memory:");
      // Create the OLD schema (17 columns, no cache cost columns)
      freshDb.exec(`
        CREATE TABLE IF NOT EXISTS obs_token_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          trace_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          channel_id TEXT DEFAULT '',
          execution_id TEXT DEFAULT '',
          session_key TEXT DEFAULT '',
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          prompt_tokens INTEGER NOT NULL,
          completion_tokens INTEGER NOT NULL,
          total_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER DEFAULT 0,
          cache_write_tokens INTEGER DEFAULT 0,
          cost_input REAL NOT NULL,
          cost_output REAL NOT NULL,
          cost_total REAL NOT NULL,
          latency_ms INTEGER NOT NULL
        );
      `);
      // Run initSchema -- should add 3 columns via ALTER TABLE without crashing
      initSchema(freshDb, 768);
      // Verify columns exist
      const columns = freshDb.prepare("PRAGMA table_info(obs_token_usage)").all() as Array<{ name: string }>;
      const colNames = columns.map((c) => c.name);
      expect(colNames).toContain("cost_cache_read");
      expect(colNames).toContain("cost_cache_write");
      expect(colNames).toContain("cache_saved");
      // Verify can insert with new store and round-trip
      const migratedStore = createObservabilityStore(freshDb);
      migratedStore.insertTokenUsage({
        timestamp: 1000, traceId: "t1", agentId: "a1", provider: "anthropic",
        model: "claude", promptTokens: 100, completionTokens: 50, totalTokens: 150,
        costInput: 0.003, costOutput: 0.0015, costTotal: 0.0045,
        costCacheRead: 0.001, costCacheWrite: 0.002, cacheSaved: 0.005,
        latencyMs: 1200,
      });
      const rows = migratedStore.queryTokenUsage();
      expect(rows[0]!.costCacheRead).toBeCloseTo(0.001);
      expect(rows[0]!.costCacheWrite).toBeCloseTo(0.002);
      expect(rows[0]!.cacheSaved).toBeCloseTo(0.005);
      freshDb.close();
    });
  });
});
