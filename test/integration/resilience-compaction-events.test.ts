/**
 * Integration test: Compaction lifecycle events (TEST-04)
 *
 * Proves that auto-compaction events emit with correct fields and log levels
 * through the built dist output. Uses a real TypedEventBus instance from
 * @comis/core wired to createPiEventBridge from @comis/agent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TypedEventBus } from "@comis/core";
import { createPiEventBridge } from "@comis/agent";
import type { PiEventBridgeDeps } from "@comis/agent";

// ---------------------------------------------------------------------------
// Mock deps factory (similar to unit test but with real TypedEventBus)
// ---------------------------------------------------------------------------

function createMockDeps(overrides?: Partial<PiEventBridgeDeps>): PiEventBridgeDeps {
  return {
    eventBus: new TypedEventBus(),
    budgetGuard: {
      recordUsage: vi.fn(),
      checkBudget: vi.fn().mockReturnValue({ ok: true, value: undefined }),
      estimateCost: vi.fn(),
      resetExecution: vi.fn(),
    } as any,
    costTracker: {
      record: vi.fn(),
      getByAgent: vi.fn(),
      getByChannel: vi.fn(),
      getByExecution: vi.fn(),
      getBySession: vi.fn(),
      getByProvider: vi.fn(),
      getAll: vi.fn(),
      prune: vi.fn(),
    } as any,
    stepCounter: {
      increment: vi.fn().mockReturnValue(1),
      shouldHalt: vi.fn().mockReturnValue(false),
      reset: vi.fn(),
      getCount: vi.fn().mockReturnValue(0),
    } as any,
    circuitBreaker: {
      isOpen: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      getState: vi.fn(),
      reset: vi.fn(),
    } as any,
    sessionKey: { tenantId: "t1", channelId: "c1", userId: "u1" },
    agentId: "test-agent",
    channelId: "test-channel",
    executionId: "exec-001",
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as any,
    onDelta: vi.fn(),
    onAbort: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Event constructors
// ---------------------------------------------------------------------------

function makeAutoCompactionStartEvent() {
  return {
    type: "compaction_start" as const,
    reason: "threshold" as const,
  };
}

function makeAutoCompactionEndEvent(opts: {
  result?: { summary: string; firstKeptEntryId: string; tokensBefore: number };
  aborted: boolean;
  willRetry: boolean;
  errorMessage?: string;
}) {
  return {
    type: "compaction_end" as const,
    result: opts.result,
    aborted: opts.aborted,
    willRetry: opts.willRetry,
    ...(opts.errorMessage !== undefined && { errorMessage: opts.errorMessage }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resilience-compaction-events integration (TEST-04)", () => {
  let deps: PiEventBridgeDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it("emits compaction:started event with agentId, sessionKey, and timestamp", { timeout: 10_000 }, () => {
    const received: any[] = [];
    deps.eventBus.on("compaction:started", (payload) => received.push(payload));

    const { listener } = createPiEventBridge(deps);
    listener(makeAutoCompactionStartEvent() as any);

    expect(received).toHaveLength(1);
    expect(received[0].agentId).toBe("test-agent");
    expect(received[0].sessionKey).toEqual({ tenantId: "t1", channelId: "c1", userId: "u1" });
    expect(received[0].timestamp).toBeGreaterThan(0);
    expect(typeof received[0].timestamp).toBe("number");

    // Logger.info should be called with "Auto-compaction started"
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "test-agent",
        sessionKey: "t1:u1:c1",
      }),
      "Auto-compaction started",
    );
  });

  it("emits compaction:flush and INFO log on successful compaction_end", { timeout: 10_000 }, () => {
    const mockMemoryPort = {
      store: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    } as any;
    deps = createMockDeps({ memoryPort: mockMemoryPort });

    const flushEvents: any[] = [];
    deps.eventBus.on("compaction:flush", (payload) => flushEvents.push(payload));

    const { listener } = createPiEventBridge(deps);

    // Send start then end (success)
    listener(makeAutoCompactionStartEvent() as any);
    listener(makeAutoCompactionEndEvent({
      result: { summary: "test summary", firstKeptEntryId: "e1", tokensBefore: 1000 },
      aborted: false,
      willRetry: false,
    }) as any);

    // compaction:flush event
    expect(flushEvents).toHaveLength(1);
    expect(flushEvents[0].success).toBe(true);
    expect(flushEvents[0].memoriesWritten).toBe(1);
    expect(flushEvents[0].trigger).toBe("soft");

    // INFO log for successful completion
    const infoCalls = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const completedCall = infoCalls.find((c: any[]) => c[1] === "Auto-compaction completed");
    expect(completedCall).toBeDefined();
    expect(completedCall![0].agentId).toBe("test-agent");
    expect(typeof completedCall![0].durationMs).toBe("number");
    expect(completedCall![0].durationMs).toBeGreaterThanOrEqual(0);
    expect(completedCall![0].aborted).toBe(false);
    expect(completedCall![0].hasSummary).toBe(true);
    expect(typeof completedCall![0].memoriesWritten).toBe("number");

    // Logger.warn should NOT have been called for successful compaction
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it("emits WARN log on aborted compaction_end", { timeout: 10_000 }, () => {
    const { listener } = createPiEventBridge(deps);

    listener(makeAutoCompactionStartEvent() as any);
    listener(makeAutoCompactionEndEvent({
      aborted: true,
      willRetry: false,
    }) as any);

    // Logger.warn should be called with "Auto-compaction failed"
    expect(deps.logger.warn).toHaveBeenCalled();
    const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const failedCall = warnCalls.find((c: any[]) => c[1] === "Auto-compaction failed");
    expect(failedCall).toBeDefined();

    const fields = failedCall![0];
    expect(fields.aborted).toBe(true);
    expect(fields.hasSummary).toBe(false);
    expect(typeof fields.hint).toBe("string");
    expect(fields.hint).toContain("aborted");
    expect(fields.errorKind).toBe("internal");
  });

  it("emits WARN log on error compaction_end with retry hint", { timeout: 10_000 }, () => {
    const { listener } = createPiEventBridge(deps);

    listener(makeAutoCompactionStartEvent() as any);
    listener(makeAutoCompactionEndEvent({
      aborted: false,
      willRetry: true,
      errorMessage: "Token limit exceeded",
    }) as any);

    // Logger.warn should be called with "Auto-compaction failed"
    expect(deps.logger.warn).toHaveBeenCalled();
    const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const failedCall = warnCalls.find((c: any[]) => c[1] === "Auto-compaction failed");
    expect(failedCall).toBeDefined();

    const fields = failedCall![0];
    expect(typeof fields.hint).toBe("string");
    expect(fields.hint).toContain("retry");
    expect(fields.errorKind).toBe("internal");
    expect(fields.err).toBe("Token limit exceeded");
  });

  it("computes durationMs between start and end events", { timeout: 10_000 }, async () => {
    const { listener } = createPiEventBridge(deps);

    listener(makeAutoCompactionStartEvent() as any);

    // Wait ~50ms to create a measurable duration
    await new Promise((resolve) => setTimeout(resolve, 50));

    listener(makeAutoCompactionEndEvent({
      result: { summary: "compacted", firstKeptEntryId: "e1", tokensBefore: 1000 },
      aborted: false,
      willRetry: false,
    }) as any);

    // Find the INFO call for "Auto-compaction completed"
    const infoCalls = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const completedCall = infoCalls.find((c: any[]) => c[1] === "Auto-compaction completed");
    expect(completedCall).toBeDefined();
    expect(completedCall![0].durationMs).toBeGreaterThanOrEqual(40);
  });
});
