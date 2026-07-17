// SPDX-License-Identifier: Apache-2.0
/**
 * obs.systemPromptReport.{latest, list} handler tests.
 *
 * Mirrors the `obs-handlers.test.ts` `makeDeps()` factory pattern; only
 * the SystemPromptReport-relevant fields are stubbed.
 */
import { describe, it, expect, vi } from "vitest";
import { bindObsSystemPromptReportHandlers } from "./obs-system-prompt-report.js";
import type { ObsHandlerDeps } from "./obs-helpers.js";
import type { SystemPromptReportRow } from "@comis/memory";

function makeReportRow(overrides: Partial<SystemPromptReportRow> = {}): SystemPromptReportRow {
  return {
    agentId: "agent-1",
    tenantId: null,
    sessionId: "session-1",
    runId: null,
    generatedAt: 1_700_000_000_000,
    provider: "anthropic",
    model: "claude-3-opus",
    systemChars: 100,
    systemSha256: "deadbeef",
    reportJson:
      '{"traceSchema":"comis-system-prompt-report","schemaVersion":1,"source":"run","agentId":"agent-1","sessionId":"session-1","systemPrompt":{"sha256":"deadbeef","chars":100,"projectContextChars":40,"nonProjectContextChars":60},"injectedWorkspaceFiles":[],"skills":{"entries":[],"promptChars":0},"tools":{"entries":[],"totalSchemaChars":0},"generatedAt":1700000000000}',
    ...overrides,
  };
}

function makeObsStore(overrides: Record<string, unknown> = {}) {
  return {
    queryDiagnostics: vi.fn().mockReturnValue([]),
    aggregateByProvider: vi.fn().mockReturnValue([]),
    aggregateByAgent: vi.fn().mockReturnValue([]),
    aggregateBySession: vi.fn().mockReturnValue({ sessionKey: "", totalCost: 0, totalTokens: 0, callCount: 0 }),
    aggregateHourly: vi.fn().mockReturnValue([]),
    queryDelivery: vi.fn().mockReturnValue([]),
    deliveryStats: vi.fn().mockReturnValue({ total: 0, attempted: 0, success: 0, error: 0, timeout: 0, filtered: 0, aborted: 0, attemptedLatencyMs: 0, avgLatencyMs: 0 }),
    latestChannelSnapshots: vi.fn().mockReturnValue([]),
    resetAll: vi.fn().mockReturnValue({ tokenUsage: 0, delivery: 0, diagnostics: 0, channels: 0 }),
    resetTable: vi.fn().mockReturnValue(0),
    insertTokenUsage: vi.fn(),
    insertDelivery: vi.fn(),
    insertDiagnostic: vi.fn(),
    insertChannelSnapshot: vi.fn(),
    prune: vi.fn().mockReturnValue({ tokenUsage: 0, delivery: 0, diagnostics: 0, channels: 0 }),
    latestSystemPromptReport: vi.fn().mockReturnValue(undefined),
    listSystemPromptReports: vi.fn().mockReturnValue([]),
    insertSystemPromptReport: vi.fn(),
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<ObsHandlerDeps>): ObsHandlerDeps {
  return {
    diagnosticCollector: {
      getRecent: vi.fn().mockReturnValue([]),
      getCounts: vi.fn().mockReturnValue({ usage: 0, webhook: 0, message: 0, session: 0 }),
      reset: vi.fn(),
      prune: vi.fn().mockReturnValue(0),
      dispose: vi.fn(),
    },
    billingEstimator: {
      byProvider: vi.fn().mockReturnValue([]),
      byAgent: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
      bySession: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
      total: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
      usage24h: vi.fn().mockReturnValue(Array.from({ length: 24 }, (_, i) => ({ hour: i, tokens: 0 }))),
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
      getStats: vi.fn().mockReturnValue({ total: 0, attempted: 0, successes: 0, failures: 0, timeouts: 0, filtered: 0, aborted: 0, attemptedLatencyMs: 0, avgLatencyMs: 0 }),
      reset: vi.fn(),
      dispose: vi.fn(),
    },
    ...overrides,
  };
}

describe("obs.systemPromptReport.latest handler", () => {
  it("latest_returns_report_when_admin", async () => {
    const reportRow = makeReportRow();
    const obsStore = makeObsStore({
      latestSystemPromptReport: vi.fn().mockReturnValue(reportRow),
    });
    const handlers = bindObsSystemPromptReportHandlers(
      makeDeps({ obsStore: obsStore as any }),
    );
    const result = await handlers["obs.systemPromptReport.latest"]!({
      _trustLevel: "admin",
      agentId: "agent-1",
      sessionId: "session-1",
    }) as { report: Record<string, unknown> | null };
    expect(result.report).not.toBeNull();
    expect(result.report!.traceSchema).toBe("comis-system-prompt-report");
    expect(result.report!.agentId).toBe("agent-1");
  });

  it("latest_returns_null_when_no_report", async () => {
    const obsStore = makeObsStore({
      latestSystemPromptReport: vi.fn().mockReturnValue(undefined),
    });
    const handlers = bindObsSystemPromptReportHandlers(
      makeDeps({ obsStore: obsStore as any }),
    );
    const result = await handlers["obs.systemPromptReport.latest"]!({
      _trustLevel: "admin",
      agentId: "agent-1",
      sessionId: "session-1",
    }) as { report: Record<string, unknown> | null };
    expect(result.report).toBeNull();
  });

  it("latest_rejects_non_admin_with_admin_trust_required_error", async () => {
    const handlers = bindObsSystemPromptReportHandlers(makeDeps());
    await expect(
      handlers["obs.systemPromptReport.latest"]!({
        agentId: "agent-1",
        sessionId: "session-1",
      }),
    ).rejects.toThrow("Admin trust level required");
  });

  it("latest_returns_null_when_runId_does_not_match", async () => {
    // The store does the narrowing in the WHERE clause, so the mock
    // simulates a non-match by returning undefined when the runId
    // argument doesn't match the stored row.
    const reportRow = makeReportRow({ runId: "run-a" });
    const obsStore = makeObsStore({
      latestSystemPromptReport: vi.fn().mockImplementation(
        (agentId: string, sessionId: string, runId?: string) =>
          runId === undefined || runId === "run-a" ? reportRow : undefined,
      ),
    });
    const handlers = bindObsSystemPromptReportHandlers(
      makeDeps({ obsStore: obsStore as any }),
    );
    const result = await handlers["obs.systemPromptReport.latest"]!({
      _trustLevel: "admin",
      agentId: "agent-1",
      sessionId: "session-1",
      runId: "run-different",
    }) as { report: Record<string, unknown> | null };
    expect(result.report).toBeNull();
  });

  it("latest narrows by runId via SQL not post-filter", async () => {
    // The handler must thread the runId param into the store call
    // rather than fetching the latest-by-generatedAt row and
    // post-filtering. Spy on the store to assert the call signature.
    const reportRow = makeReportRow({ runId: "run-a", reportJson: '{"runId":"run-a"}' });
    const latestSpy = vi.fn().mockImplementation(
      (agentId: string, sessionId: string, runId?: string) =>
        runId === "run-a" ? reportRow : undefined,
    );
    const obsStore = makeObsStore({ latestSystemPromptReport: latestSpy });
    const handlers = bindObsSystemPromptReportHandlers(
      makeDeps({ obsStore: obsStore as any }),
    );
    const result = await handlers["obs.systemPromptReport.latest"]!({
      _trustLevel: "admin",
      agentId: "a",
      sessionId: "s",
      runId: "run-a",
    }) as { report: Record<string, unknown> | null };
    expect(latestSpy).toHaveBeenCalledWith("a", "s", "run-a");
    expect(result.report).not.toBeNull();
    expect((result.report as { runId?: unknown }).runId).toBe("run-a");
  });

  it("latest_returns_null_when_obsStore_is_absent", async () => {
    const handlers = bindObsSystemPromptReportHandlers(makeDeps());
    const result = await handlers["obs.systemPromptReport.latest"]!({
      _trustLevel: "admin",
      agentId: "agent-1",
      sessionId: "session-1",
    }) as { report: Record<string, unknown> | null };
    expect(result.report).toBeNull();
  });
});

describe("obs.systemPromptReport.list handler", () => {
  it("list_returns_array_with_default_limit", async () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => makeReportRow({ generatedAt: 1_000 + i }));
    const obsStore = makeObsStore({
      listSystemPromptReports: vi.fn().mockReturnValue(fifteen.slice(0, 10)),
    });
    const handlers = bindObsSystemPromptReportHandlers(
      makeDeps({ obsStore: obsStore as any }),
    );
    const result = await handlers["obs.systemPromptReport.list"]!({
      _trustLevel: "admin",
      sessionId: "session-1",
    }) as { reports: Record<string, unknown>[] };
    expect(result.reports).toHaveLength(10);
    // The handler called listSystemPromptReports with the default limit.
    expect(obsStore.listSystemPromptReports).toHaveBeenCalledWith("session-1", 10);
  });

  it("list_caps_limit_at_max_100", async () => {
    const obsStore = makeObsStore({
      listSystemPromptReports: vi.fn().mockReturnValue([]),
    });
    const handlers = bindObsSystemPromptReportHandlers(
      makeDeps({ obsStore: obsStore as any }),
    );
    await handlers["obs.systemPromptReport.list"]!({
      _trustLevel: "admin",
      sessionId: "session-1",
      limit: 100,
    });
    expect(obsStore.listSystemPromptReports).toHaveBeenCalledWith("session-1", 100);
  });

  it("list_param_validation_rejects_negative_limit", async () => {
    const handlers = bindObsSystemPromptReportHandlers(makeDeps());
    await expect(
      handlers["obs.systemPromptReport.list"]!({
        _trustLevel: "admin",
        sessionId: "session-1",
        limit: -1,
      }),
    ).rejects.toThrow();
  });

  it("list_rejects_non_admin", async () => {
    const handlers = bindObsSystemPromptReportHandlers(makeDeps());
    await expect(
      handlers["obs.systemPromptReport.list"]!({
        sessionId: "session-1",
      }),
    ).rejects.toThrow("Admin trust level required");
  });

  it("list_returns_empty_array_when_obsStore_is_absent", async () => {
    const handlers = bindObsSystemPromptReportHandlers(makeDeps());
    const result = await handlers["obs.systemPromptReport.list"]!({
      _trustLevel: "admin",
      sessionId: "session-1",
    }) as { reports: Record<string, unknown>[] };
    expect(result.reports).toEqual([]);
  });
});
