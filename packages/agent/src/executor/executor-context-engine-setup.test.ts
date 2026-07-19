// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for setupContextEngine — context engine creation and wiring.
 *
 * setupContextEngine runs once per execute() to:
 *   - Merge per-agent context-engine config and call createContextEngine() with
 *     a closure-laden deps object.
 *   - Seed contextEngine.lastBreakpointIndex from a per-session bounded map so
 *     the cache fence survives across execute() invocations.
 *   - Wrap contextEngine.transformContext with a duration-tracking shim that
 *     accumulates per-execute() ms into a closure counter.
 *   - Accumulate signature-replay scrub counters that the
 *     "Execution complete" INFO log later rolls up.
 *
 * Strategy: mock `../context-engine/index.js` so the test sees the deps
 * object that setupContextEngine builds (callbacks, getters, etc.) and can
 * invoke them directly. createContextEngine itself is unit-tested elsewhere
 * (context-engine.test.ts); this file focuses on the orchestrator wiring.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.mock the context-engine module BEFORE importing the SUT.
// We capture every createContextEngine call so tests can read the deps object.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- captured deps object is structurally diverse
type CapturedCall = { config: any; deps: any; engineHandle: any };

const captured: { calls: CapturedCall[] } = { calls: [] };

vi.mock("../context-engine/index.js", () => ({
  createContextEngine: vi.fn(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocking SDK shape
    (config: any, deps: any) => {
      // Default returned engine: a no-op transformContext + mutable fields.
      const handle = {
        transformContext: vi.fn(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vitest mock signature
          async (messages: any) => messages,
        ),
        lastBreakpointIndex: undefined as number | undefined,
        lastTrimOffset: 0,
      };
      captured.calls.push({ config, deps, engineHandle: handle });
      return handle;
    },
  ),
}));

// ---------------------------------------------------------------------------
// Now import the SUT. Order matters: vi.mock above hoists to before this.
// ---------------------------------------------------------------------------

import { setupContextEngine } from "./executor-context-engine-setup.js";
import {
  setBreakpointIndex,
  deleteBreakpointIndex,
  getOrCreateSessionLatches,
  clearSessionLatches,
  setSessionStateClock,
} from "./executor-session-state.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createConversationRef, TypedEventBus } from "@comis/core";
import type { ContextEngineSetupParams, ContextEngineSetupDeps } from "./executor-context-engine-setup.js";
import { SummarizerDegradeError, type SummarizerSpendBreaker } from "../safety/summarizer-spend-breaker.js";
import type { LeafSummarizer } from "../context-engine/lcd-leaf-summarizer.js";

// Module-level clock for executor-session-state bounded maps.
setSessionStateClock({ now: () => Date.now(), nowDate: () => new Date() });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<ContextEngineSetupDeps>): ContextEngineSetupDeps {
  return {
    logger: createMockLogger(),
    eventBus: new TypedEventBus(),
    agentId: "agent-1",
    contextStore: {} as never,
    workspaceDir: "/tmp/workspace",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AuthStorage is SDK type
    authStorage: { getApiKey: vi.fn().mockResolvedValue("test-key") } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ModelRegistry SDK type
    modelRegistry: { find: vi.fn().mockReturnValue(undefined) } as any,
    clock: createFakeClock(1_700_000_000_000),
    ...overrides,
  };
}

function makeParams(overrides?: Partial<ContextEngineSetupParams>): ContextEngineSetupParams {
  const deps = overrides?.deps ?? makeDeps();
  const conversationRef = createConversationRef({
    tenantId: "tenant-a",
    agentId: deps.agentId,
    partition: { kind: "agent" },
  });
  if (!conversationRef.ok) throw conversationRef.error;
  return {
    config: {
      name: "test-agent",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      contextEngine: { enabled: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PerAgentConfig has many fields not exercised here
    } as any,
    deps,
    formattedKey: "tenant-a:user_a:chan-a",
    sessionKey: "tenant-a:user_a:chan-a",
    conversationRef: conversationRef.value,
    agentId: deps.agentId,
    msg: { channelType: "test", channelId: "chan-a" },
    sm: { fileEntries: [] },
    session: {
      agent: {
        state: {
          model: {
            reasoning: false,
            contextWindow: 128_000,
            maxTokens: 8192,
            id: "claude-sonnet-4-5-20250929",
            provider: "anthropic",
            api: "anthropic",
          },
        },
      },
      abortCompaction: vi.fn(),
    },
    resolvedModel: { id: "claude-sonnet-4-5-20250929", provider: "anthropic" },
    cacheBreakDetector: { notifyContentModification: vi.fn() },
    contextEngineRef: { current: undefined },
    getCachedSystemTokensEstimate: () => 4_000,
    getCachedFreshTailPreambleTokens: () => 0,
    getTokenAnchor: () => null,
    onAnchorReset: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset captured calls + session state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  captured.calls = [];
  // Clean per-session state from prior tests.
  deleteBreakpointIndex("tenant-a:user_a:chan-a");
  clearSessionLatches("tenant-a:user_a:chan-a");
});

// ---------------------------------------------------------------------------
// createContextEngine wiring
// ---------------------------------------------------------------------------

describe("setupContextEngine — createContextEngine() dependency wiring", () => {
  it("invokes createContextEngine() exactly once per setupContextEngine call (no extra invocations)", () => {
    setupContextEngine(makeParams());
    expect(captured.calls.length).toBe(1);
  });

  it("forwards the agentId from deps into the createContextEngine deps wiring object", () => {
    setupContextEngine(makeParams({ deps: makeDeps({ agentId: "agent-xyz" }) }));
    expect(captured.calls[0].deps.agentId).toBe("agent-xyz");
  });

  it("uses the executor-bound agent authority for the context-engine read scope", () => {
    setupContextEngine(makeParams({ agentId: "agent-authority" }));
    expect(captured.calls[0].deps.agentId).toBe("agent-authority");
  });

  it("forwards the formattedKey (sessionKey string) into the createContextEngine deps wiring object", () => {
    setupContextEngine(makeParams({ formattedKey: "tenant-a:user-b:chan-c" }));
    expect(captured.calls[0].deps.sessionKey).toBe("tenant-a:user-b:chan-c");
  });

  it("assigns the created ContextEngine onto the mutable contextEngineRef.current pointer for downstream callbacks", () => {
    const ref: { current?: unknown } = { current: undefined };
    const params = makeParams({ contextEngineRef: ref as ContextEngineSetupParams["contextEngineRef"] });
    setupContextEngine(params);
    expect(ref.current).toBe(captured.calls[0].engineHandle);
  });

  it("threads getCachedFreshTailPreambleTokens into the engine deps as getFreshTailPreambleTokensEstimate (separate from getSystemTokensEstimate)", () => {
    setupContextEngine(makeParams({ getCachedFreshTailPreambleTokens: () => 321 }));
    const deps = captured.calls[0].deps;
    // The fresh-tail preamble estimate is wired as its OWN lazy getter (the budget
    // subtrahend), distinct from the system-tokens getter.
    expect(typeof deps.getFreshTailPreambleTokensEstimate).toBe("function");
    expect(deps.getFreshTailPreambleTokensEstimate!()).toBe(321);
  });

  // The second computeTokenBudgetForProfile call site lives
  // in lcd-assembler, which reads ContextEngineDeps.windowProvenance. Without
  // this params→deps hop the seam stays permanently undefined —
  // "built-but-not-wired".
  it("threads params.windowProvenance verbatim onto the createContextEngine deps (the lcd-assembler budget seam)", () => {
    const windowProvenance = {
      configuredWindow: 131_072,
      served: 8_192,
      reconcileSource: "served" as const,
    };
    setupContextEngine(makeParams({ windowProvenance }));
    // Without the params→deps hop, the constructed deps would carry undefined
    // and the assembler's budget stays provenance-blind.
    expect(captured.calls[0].deps.windowProvenance).toEqual(windowProvenance);
  });
});

// ---------------------------------------------------------------------------
// Breakpoint index seeding
// ---------------------------------------------------------------------------

describe("setupContextEngine — breakpoint index seeding from session-scoped map", () => {
  it("leaves contextEngine.lastBreakpointIndex undefined when no persisted breakpoint exists for the session", () => {
    const result = setupContextEngine(makeParams({ formattedKey: "fresh-session-no-breakpoint" }));
    expect(result.contextEngine.lastBreakpointIndex).toBeUndefined();
  });

  it("seeds contextEngine.lastBreakpointIndex from the persisted breakpoint map when one exists for the session", () => {
    const key = "tenant-a:user_a:chan-with-seeded-breakpoint";
    setBreakpointIndex(key, 7);
    try {
      const result = setupContextEngine(makeParams({ formattedKey: key, sessionKey: key }));
      expect(result.contextEngine.lastBreakpointIndex).toBe(7);
    } finally {
      deleteBreakpointIndex(key);
    }
  });

  it("emits a DEBUG log naming the seeded persistedBreakpointIdx so operators can trace cache-fence reuse", () => {
    const key = "tenant-a:user_a:chan-debug-log-breakpoint";
    setBreakpointIndex(key, 11);
    const logger = createMockLogger();
    try {
      setupContextEngine(makeParams({
        formattedKey: key,
        sessionKey: key,
        deps: makeDeps({ logger }),
      }));
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          formattedKey: key,
          persistedBreakpointIdx: 11,
        }),
        "Breakpoint index seeded from session map",
      );
    } finally {
      deleteBreakpointIndex(key);
    }
  });
});

// ---------------------------------------------------------------------------
// transformContext duration tracking wrapper
// ---------------------------------------------------------------------------

describe("setupContextEngine — transformContext duration-tracking wrapper", () => {
  it("returns getContextEngineDurationMs() === 0 before any transformContext() invocation has run", () => {
    const result = setupContextEngine(makeParams());
    expect(result.getContextEngineDurationMs()).toBe(0);
  });

  it("accumulates non-negative milliseconds into the duration counter across multiple transformContext() invocations", async () => {
    const result = setupContextEngine(makeParams());
    // The mocked transformContext is async () => messages, so invocation
    // overhead is the only contribution. Just verify monotone non-negative.
    await result.contextEngine.transformContext([]);
    const after1 = result.getContextEngineDurationMs();
    expect(after1).toBeGreaterThanOrEqual(0);
    await result.contextEngine.transformContext([]);
    const after2 = result.getContextEngineDurationMs();
    expect(after2).toBeGreaterThanOrEqual(after1);
  });

  it("forwards the underlying transformContext() return value through the duration-tracking wrapper unchanged", async () => {
    // setupContextEngine captures contextEngine.transformContext at creation
    // time into the wrapper's closure. To inject a sentinel return value, we
    // intercept the mock implementation BEFORE setupContextEngine runs.
    const { createContextEngine } = await import("../context-engine/index.js");
    const sentinel = [{ sentinel: "passthrough-token" }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock typing
    (createContextEngine as any).mockImplementationOnce((_config: any, _deps: any) => {
      const handle = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock typing
        transformContext: async (_messages: any) => sentinel,
        lastBreakpointIndex: undefined as number | undefined,
        lastTrimOffset: 0,
      };
      captured.calls.push({ config: _config, deps: _deps, engineHandle: handle });
      return handle;
    });
    const result = setupContextEngine(makeParams());
    const out = await result.contextEngine.transformContext([]);
    expect(out).toBe(sentinel);
  });
});

// ---------------------------------------------------------------------------
// onSignatureReplayScrubbed callback wiring
// ---------------------------------------------------------------------------

describe("setupContextEngine — signature-replay scrub counter accumulation", () => {
  it("starts getSignatureScrubCounters() at zero before any scrub callback fires", () => {
    const result = setupContextEngine(makeParams());
    expect(result.getSignatureScrubCounters()).toEqual({
      signatureScrubs: 0,
      signatureScrubsToolCallsAffected: 0,
    });
  });

  it("does NOT bump signatureScrubs when the scrub callback reports scrubbedAssistantMessages === 0 (zero-touch turn)", () => {
    const result = setupContextEngine(makeParams());
    const callback = captured.calls[0].deps.onSignatureReplayScrubbed;
    callback({ scrubbedAssistantMessages: 0, blocksAffected: 5, toolCallsAffected: 3, latestAssistantIdx: 1 });
    expect(result.getSignatureScrubCounters()).toEqual({
      signatureScrubs: 0,
      signatureScrubsToolCallsAffected: 0,
    });
  });

  it("bumps signatureScrubs once per non-zero scrub event and sums toolCallsAffected across events", () => {
    const result = setupContextEngine(makeParams());
    const callback = captured.calls[0].deps.onSignatureReplayScrubbed;
    callback({ scrubbedAssistantMessages: 2, blocksAffected: 4, toolCallsAffected: 7, latestAssistantIdx: 1 });
    callback({ scrubbedAssistantMessages: 1, blocksAffected: 1, toolCallsAffected: 3, latestAssistantIdx: 2 });
    expect(result.getSignatureScrubCounters()).toEqual({
      signatureScrubs: 2,
      signatureScrubsToolCallsAffected: 10,
    });
  });
});

// ---------------------------------------------------------------------------
// getThinkingKeepTurnsOverride — idle latch path
// ---------------------------------------------------------------------------

describe("setupContextEngine — getThinkingKeepTurnsOverride dynamic resolution", () => {
  it("returns undefined when no idle-thinking latch is set and no replay drift is detected (default keepTurns)", () => {
    setupContextEngine(makeParams({ formattedKey: "session-with-no-overrides" }));
    const override = captured.calls[0].deps.getThinkingKeepTurnsOverride();
    expect(override).toBeUndefined();
  });

  it("returns 0 when the per-session idleThinkingClear latch is set (strip ALL thinking blocks)", () => {
    const key = "session-with-idle-latch-set";
    getOrCreateSessionLatches(key).idleThinkingClear.setOnce(true);
    try {
      setupContextEngine(makeParams({ formattedKey: key, sessionKey: key }));
      const override = captured.calls[0].deps.getThinkingKeepTurnsOverride();
      expect(override).toBe(0);
    } finally {
      clearSessionLatches(key);
    }
  });
});

// ---------------------------------------------------------------------------
// getModel lazy lookup
// ---------------------------------------------------------------------------

describe("setupContextEngine — lazy getModel() forwarding to session.agent.state.model", () => {
  it("reads model identity from session.agent.state.model EVERY call (handles cycleModel mid-execute)", () => {
    const session = {
      agent: {
        state: {
          model: {
            reasoning: false,
            contextWindow: 200_000,
            maxTokens: 8192,
            id: "first-model",
            provider: "anthropic",
            api: "anthropic",
          },
        },
      },
      abortCompaction: vi.fn(),
    };
    setupContextEngine(makeParams({ session }));
    const getModel = captured.calls[0].deps.getModel;
    expect(getModel().id).toBe("first-model");
    // Cycle model mid-execute -- mutate session state in place.
    session.agent.state.model = {
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 16_384,
      id: "second-model",
      provider: "openai",
      api: "openai",
    };
    expect(getModel().id).toBe("second-model");
    expect(getModel().reasoning).toBe(true);
  });

  it("falls back to safe defaults when session.agent.state.model is undefined (defensive)", () => {
    const session = {
      agent: { state: { model: undefined } },
      abortCompaction: vi.fn(),
    };
    setupContextEngine(makeParams({ session }));
    const model = captured.calls[0].deps.getModel();
    expect(model.reasoning).toBe(false);
    expect(model.contextWindow).toBe(128_000);
    expect(model.maxTokens).toBe(8192);
  });
});

// ---------------------------------------------------------------------------
// onContentModified callback wiring
// ---------------------------------------------------------------------------

describe("setupContextEngine — observation-masker -> cacheBreakDetector wiring", () => {
  it("invokes cacheBreakDetector.notifyContentModification(formattedKey) when onContentModified fires", () => {
    const notify = vi.fn();
    setupContextEngine(makeParams({
      formattedKey: "session-with-modified-content",
      cacheBreakDetector: { notifyContentModification: notify },
    }));
    captured.calls[0].deps.onContentModified();
    expect(notify).toHaveBeenCalledWith("session-with-modified-content");
  });
});

// ---------------------------------------------------------------------------
// getSummarizerDeps wraps the leaf summarizer with the injected
// per-tenant spend+breaker gate keyed on the live tenantId.
// ---------------------------------------------------------------------------

describe("setupContextEngine — getSummarizerDeps per-tenant spend+breaker wiring", () => {
  /** A stub gate that records the tenantId it was keyed on and returns a sentinel. */
  function makeRecordingBreaker(): {
    breaker: SummarizerSpendBreaker;
    seenTenantIds: string[];
    sentinel: LeafSummarizer;
  } {
    const seenTenantIds: string[] = [];
    const sentinel: LeafSummarizer = vi.fn(async () => "SENTINEL-GATED-SUMMARY");
    const breaker: SummarizerSpendBreaker = {
      gate: vi.fn((tenantId: string, _inner: LeafSummarizer): LeafSummarizer => {
        seenTenantIds.push(tenantId);
        return sentinel;
      }),
    };
    return { breaker, seenTenantIds, sentinel };
  }

  it("wraps the summarizer with the injected per-tenant gate keyed on the live tenantId", async () => {
    const { breaker, seenTenantIds, sentinel } = makeRecordingBreaker();
    const result = setupContextEngine(
      makeParams({
        tenantId: "tenant-x",
        deps: makeDeps({ summarizerSpendBreaker: breaker }),
      }),
    );
    const summarizerDeps = result.getSummarizerDeps();
    // The gate was keyed on the live tenantId threaded through the params.
    expect(breaker.gate).toHaveBeenCalledTimes(1);
    expect(seenTenantIds).toContain("tenant-x");
    // The returned summarizer delegates to the gate's sentinel — the seam IS
    // wrapped (a successful call flows through the gate, not the raw seam).
    const out = await summarizerDeps.summarize(
      [] as unknown as Parameters<LeafSummarizer>[0],
      { reserveTokens: 100 },
    );
    expect(out).toBe("SENTINEL-GATED-SUMMARY");
    expect(sentinel).toHaveBeenCalledTimes(1);
  });

  it("returns the raw summarizer when no breaker is injected (optional/daemon-owned)", () => {
    const result = setupContextEngine(
      makeParams({ deps: makeDeps({ summarizerSpendBreaker: undefined }) }),
    );
    const summarizerDeps = result.getSummarizerDeps();
    // Absent breaker ⇒ a real (unwrapped) summarizer function, no crash.
    expect(typeof summarizerDeps.summarize).toBe("function");
  });

  it("emits a content-free context:dag_degraded (reason spend_cap) + re-throws when the gate degrades over-cap", async () => {
    const eventBus = new TypedEventBus();
    const events: Array<Record<string, unknown>> = [];
    eventBus.on("context:dag_degraded", (e) => events.push(e as unknown as Record<string, unknown>));
    // A gate whose returned summarizer throws the over-cap degrade signal.
    const breaker: SummarizerSpendBreaker = {
      gate: vi.fn((): LeafSummarizer => async () => {
        throw new SummarizerDegradeError("spend_cap");
      }),
    };
    const result = setupContextEngine(
      makeParams({
        tenantId: "tenant-cap",
        formattedKey: "tenant-cap:user_a:chan-a",
        sessionKey: "tenant-cap:user_a:chan-a",
        deps: makeDeps({ summarizerSpendBreaker: breaker, eventBus }),
      }),
    );
    // The degrade must RE-THROW so the leaf/condense ladder floors to truncation-only.
    await expect(
      result.getSummarizerDeps().summarize(
        [] as unknown as Parameters<LeafSummarizer>[0],
        { reserveTokens: 100 },
      ),
    ).rejects.toBeInstanceOf(SummarizerDegradeError);
    // The event is emitted exactly once with the closed reason — and is content-free.
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("spend_cap");
    expect(events[0].conversationId).toMatch(/^cv_/);
    expect(typeof events[0].durationMs).toBe("number");
    // No summary/message content on the payload (ids/reason/durationMs only).
    expect(JSON.stringify(events[0])).not.toContain("content");
  });

  it("emits reason breaker_open when the gate degrades on an open breaker", async () => {
    const eventBus = new TypedEventBus();
    const events: Array<Record<string, unknown>> = [];
    eventBus.on("context:dag_degraded", (e) => events.push(e as unknown as Record<string, unknown>));
    const breaker: SummarizerSpendBreaker = {
      gate: vi.fn((): LeafSummarizer => async () => {
        throw new SummarizerDegradeError("breaker_open");
      }),
    };
    const result = setupContextEngine(
      makeParams({ deps: makeDeps({ summarizerSpendBreaker: breaker, eventBus }) }),
    );
    await expect(
      result.getSummarizerDeps().summarize(
        [] as unknown as Parameters<LeafSummarizer>[0],
        { reserveTokens: 100 },
      ),
    ).rejects.toBeInstanceOf(SummarizerDegradeError);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("breaker_open");
  });
});
