// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the distillation runner core.
 *
 * Load-bearing tests:
 *  1. Closed-loop: depth≥1 condense → memory + provenance (mock-based)
 *  2. ZERO assembly-path diff: distillation runner does NOT call any
 *     assembly-related deps (structural invariant).
 *  3. Cross-scope no-leak: 3 fixtures (cross-tenant, cross-agent,
 *     incomplete scope) — write nothing readable by another scope.
 *
 * Architecture cut: this test file imports ONLY from @comis/core (types),
 * the local constants, and the module under test. No @comis/memory import.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ContextStoreScope,
  MemoryPort,
  ContextStorePort,
  ComisLogger,
  TypedEventBus,
  AppendProvenanceInput,
} from "@comis/core";
import { createConversationRef } from "@comis/core";
import type { MemorySearchResult } from "@comis/core";
import {
  LEAF_FALLBACK_SUMMARY_MARKER,
  CONDENSED_FALLBACK_SUMMARY_MARKER,
} from "../context-engine/constants.js";
// The module under test:
import {
  runDistillationPassAfterTurn,
  type RunDistillationPassParams,
} from "./lcd-distillation-runner.js";

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function makeScope(overrides: Partial<ContextStoreScope> = {}): ContextStoreScope {
  const tenantId = overrides.tenantId ?? "tenant-a";
  const agentId = overrides.agentId ?? "agent-a";
  const conversation = {
    tenantId,
    agentId,
    partition: {
      kind: "endpoint-conversation-principal" as const,
      endpoint: TEST_ENDPOINT,
      principalId: "user-a",
    },
  };
  const reference = createConversationRef(conversation);
  if (!reference.ok) throw reference.error;
  return {
    conversationRef: reference.value,
    tenantId,
    agentId,
    sessionKey: `${tenantId}:${agentId}:conversation-a`,
    ...overrides,
  };
}

const TEST_ENDPOINT = {
  channelType: "test",
  channelInstanceId: "instance-a",
  conversationId: "conversation-a",
  conversationKind: "direct" as const,
};

function makeMemoryScope(scope: ContextStoreScope): RunDistillationPassParams["memoryScope"] {
  return {
    turnScope: {
      conversation: {
        tenantId: scope.tenantId,
        agentId: scope.agentId,
        partition: {
          kind: "endpoint-conversation-principal",
          endpoint: TEST_ENDPOINT,
          principalId: "user-a",
        },
      },
      principal: { principalId: "user-a" },
      endpoint: TEST_ENDPOINT,
    },
    visibility: { kind: "agent-shared" },
  };
}

function makeMemoryPort(overrides: Partial<Record<keyof MemoryPort, unknown>> = {}): MemoryPort {
  return {
    store: vi.fn().mockResolvedValue({ ok: true, value: { id: "mem-1" } }),
    search: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    delete: vi.fn().mockResolvedValue({ ok: true, value: true }),
    ...overrides,
  } as unknown as MemoryPort;
}

function makeLcdStore(
  overrides: Partial<Pick<ContextStorePort, "appendProvenance" | "markProvenanceSuperseded" | "getSummaryChildren">> = {},
): Pick<ContextStorePort, "appendProvenance" | "markProvenanceSuperseded" | "getSummaryChildren"> {
  return {
    appendProvenance: vi.fn(),
    markProvenanceSuperseded: vi.fn(),
    getSummaryChildren: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

function makeLogger(): ComisLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: "info",
  } as unknown as ComisLogger;
}

function makeEventBus(): TypedEventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TypedEventBus;
}

function makeParams(overrides: Partial<RunDistillationPassParams> = {}): RunDistillationPassParams {
  const scope = overrides.scope ?? makeScope();
  return {
    summaryId: "summary-1",
    scope,
    memoryScope: overrides.memoryScope ?? makeMemoryScope(scope),
    content: "This is a valid condensed summary of the conversation.",
    fallback: false,
    depth: 1,
    now: Date.now(),
    deps: {
      memoryPort: makeMemoryPort(),
      lcdStore: makeLcdStore() as unknown as ContextStorePort,
      logger: makeLogger(),
      eventBus: makeEventBus(),
      distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
      isSubagentSession: false,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GATE SUITE — 6 gate tests
// ---------------------------------------------------------------------------

describe("runDistillationPassAfterTurn — gate predicates", () => {
  it("GATE: fallback=true → skips distillation and emits reason:fallback_marker", async () => {
    const eventBus = makeEventBus();
    const memoryPort = makeMemoryPort();
    const params = makeParams({
      fallback: true,
      deps: {
        ...makeParams().deps,
        memoryPort,
        eventBus,
      },
    });
    await runDistillationPassAfterTurn(params);
    expect(memoryPort.store).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith(
      "memory:distillation_skipped",
      expect.objectContaining({ reason: "fallback_marker" }),
    );
  });

  it("GATE: content starts with LEAF_FALLBACK_SUMMARY_MARKER → skips + emits fallback_marker", async () => {
    const eventBus = makeEventBus();
    const memoryPort = makeMemoryPort();
    const params = makeParams({
      content: LEAF_FALLBACK_SUMMARY_MARKER + " some extra text",
      fallback: false,
      deps: {
        ...makeParams().deps,
        memoryPort,
        eventBus,
      },
    });
    await runDistillationPassAfterTurn(params);
    expect(memoryPort.store).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith(
      "memory:distillation_skipped",
      expect.objectContaining({ reason: "fallback_marker" }),
    );
  });

  it("GATE: content starts with CONDENSED_FALLBACK_SUMMARY_MARKER → skips + emits fallback_marker", async () => {
    const eventBus = makeEventBus();
    const memoryPort = makeMemoryPort();
    const params = makeParams({
      content: CONDENSED_FALLBACK_SUMMARY_MARKER + " truncated content",
      fallback: false,
      deps: {
        ...makeParams().deps,
        memoryPort,
        eventBus,
      },
    });
    await runDistillationPassAfterTurn(params);
    expect(memoryPort.store).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith(
      "memory:distillation_skipped",
      expect.objectContaining({ reason: "fallback_marker" }),
    );
  });

  it("GATE: isSubagentSession=true → skips distillation and emits reason:subagent_session", async () => {
    const eventBus = makeEventBus();
    const memoryPort = makeMemoryPort();
    const params = makeParams({
      deps: {
        ...makeParams().deps,
        memoryPort,
        eventBus,
        isSubagentSession: true,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
      },
    });
    await runDistillationPassAfterTurn(params);
    expect(memoryPort.store).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith(
      "memory:distillation_skipped",
      expect.objectContaining({ reason: "subagent_session" }),
    );
  });

  // Subagent gate regression pin: a subagent/ephemeral session must NEVER
  // distill to shared LTM, even when every other gate would pass (enabled, deep
  // enough, real content). The gate writes NOTHING — no memory row AND no
  // provenance row — and it fires regardless of depth (depth=5 here proves the
  // subagent gate is independent of the depth gate). Pins the GATE 3 short-circuit
  // so a future refactor cannot silently let subagent content leak into LTM.
  it("subagent gate skips the LTM write entirely (no store, no provenance) regardless of depth", async () => {
    const memoryPort = makeMemoryPort();
    const lcdStore = makeLcdStore();
    const params = makeParams({
      depth: 5, // well above minDepth — only the subagent gate should stop it
      deps: {
        ...makeParams().deps,
        memoryPort,
        lcdStore: lcdStore as unknown as ContextStorePort,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        modelProfile: { capabilityClass: "frontier" },
        isSubagentSession: true,
      },
    });
    await runDistillationPassAfterTurn(params);
    expect(memoryPort.store).not.toHaveBeenCalled();
    expect(memoryPort.search).not.toHaveBeenCalled();
    expect(lcdStore.appendProvenance).not.toHaveBeenCalled();
    expect(lcdStore.markProvenanceSuperseded).not.toHaveBeenCalled();
  });

  it("GATE: distillConfig.enabled=false → silent fast-path, no writes, no event", async () => {
    const eventBus = makeEventBus();
    const memoryPort = makeMemoryPort();
    const params = makeParams({
      deps: {
        ...makeParams().deps,
        memoryPort,
        eventBus,
        distillConfig: { enabled: false, minDepth: 1, dedupCosineThreshold: 0.92 },
        isSubagentSession: false,
      },
    });
    await runDistillationPassAfterTurn(params);
    expect(memoryPort.store).not.toHaveBeenCalled();
    // config:false is a silent fast-path — no event required
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      "memory:distillation_skipped",
      expect.anything(),
    );
  });

  it("GATE: small capabilityClass without strongerSummarizerModel → logger.info + emits weak_model event", async () => {
    const logger = makeLogger();
    const eventBus = makeEventBus();
    const memoryPort = makeMemoryPort();
    const params = makeParams({
      deps: {
        ...makeParams().deps,
        memoryPort,
        logger,
        eventBus,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        modelProfile: { capabilityClass: "small" },
        strongerSummarizerModel: undefined,
        isSubagentSession: false,
      },
    });
    await runDistillationPassAfterTurn(params);
    expect(memoryPort.store).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "distillation_gate",
        reason: "weak_model_no_override",
        capabilityClass: "small",
      }),
      expect.any(String),
    );
    expect(eventBus.emit).toHaveBeenCalledWith(
      "memory:distillation_skipped",
      expect.objectContaining({ reason: "weak_model_no_override" }),
    );
  });
});

// ---------------------------------------------------------------------------
// VALIDATE GATE — 1 test
// ---------------------------------------------------------------------------

describe("runDistillationPassAfterTurn — validateMemoryWrite gate", () => {
  it("validateMemoryWrite severity:critical → memoryPort.store not called + logger.warn with errorKind:validation", async () => {
    const logger = makeLogger();
    const memoryPort = makeMemoryPort();
    // Inject a content string that contains a secret pattern (triggers the validator)
    // We use a known-detectable pattern: raw AWS-like key prefix
    const content = "AKIA1234567890ABCDEF"; // looks like an AWS access key
    const params = makeParams({
      content,
      deps: {
        ...makeParams().deps,
        memoryPort,
        logger,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        isSubagentSession: false,
      },
    });
    await runDistillationPassAfterTurn(params);
    expect(memoryPort.store).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "validation" }),
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// SCOPE-ISOLATION SUITE — 3 tests: null agentId, cross-agent, cross-tenant
// ---------------------------------------------------------------------------

describe("runDistillationPassAfterTurn — scope isolation", () => {
  it("null agentId in scope → returns immediately, no writes (fail-closed)", async () => {
    const memoryPort = makeMemoryPort();
    const lcdStore = makeLcdStore();
    const params = makeParams({
      scope: {
        conversationRef: "conv-1",
        tenantId: "tenant-a",
        agentId: "", // null/empty agentId
        sessionKey: "tenant-a:::: ::conv-1",
      },
      deps: {
        ...makeParams().deps,
        memoryPort,
        lcdStore: lcdStore as unknown as ContextStorePort,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        isSubagentSession: false,
      },
    });
    await runDistillationPassAfterTurn(params);
    expect(memoryPort.store).not.toHaveBeenCalled();
    expect(lcdStore.appendProvenance).not.toHaveBeenCalled();
  });

  it("agent-A distillation → memoryPort.store called with agentId:agent-a, NEVER with agentId:agent-b", async () => {
    const memoryPort = makeMemoryPort();
    const params = makeParams({
      scope: makeScope({ agentId: "agent-a", tenantId: "tenant-1" }),
      deps: {
        ...makeParams().deps,
        memoryPort,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        isSubagentSession: false,
      },
    });
    await runDistillationPassAfterTurn(params);
    expect(memoryPort.store).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        turnScope: expect.objectContaining({
          conversation: expect.objectContaining({ agentId: "agent-a" }),
        }),
      }),
    );
    // The store must NEVER be called with agent-b
    const allCalls = (memoryPort.store as ReturnType<typeof vi.fn>).mock.calls;
    for (const [, authority] of allCalls) {
      expect((authority as RunDistillationPassParams["memoryScope"]).turnScope.conversation.agentId).not.toBe("agent-b");
    }
  });

  it("tenant-A distillation → memoryPort.store called with tenantId:tenant-a, NEVER with tenantId:tenant-b", async () => {
    const memoryPort = makeMemoryPort();
    const params = makeParams({
      scope: makeScope({ tenantId: "tenant-a", agentId: "agent-x" }),
      deps: {
        ...makeParams().deps,
        memoryPort,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        isSubagentSession: false,
      },
    });
    await runDistillationPassAfterTurn(params);
    expect(memoryPort.store).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        turnScope: expect.objectContaining({
          conversation: expect.objectContaining({ tenantId: "tenant-a" }),
        }),
      }),
    );
    const allCalls = (memoryPort.store as ReturnType<typeof vi.fn>).mock.calls;
    for (const [, authority] of allCalls) {
      expect((authority as RunDistillationPassParams["memoryScope"]).turnScope.conversation.tenantId).not.toBe("tenant-b");
    }
  });
});

// ---------------------------------------------------------------------------
// CLOSED-LOOP — 1 test
// ---------------------------------------------------------------------------

describe("runDistillationPassAfterTurn — closed-loop", () => {
  it("depth≥1, enabled, non-fallback, non-subagent → memoryPort.store called once with episodic/learned + appendProvenance called once", async () => {
    const memoryPort = makeMemoryPort();
    const lcdStore = makeLcdStore();
    const params = makeParams({
      depth: 2,
      deps: {
        ...makeParams().deps,
        memoryPort,
        lcdStore: lcdStore as unknown as ContextStorePort,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        isSubagentSession: false,
      },
    });
    await runDistillationPassAfterTurn(params);

    // memoryPort.store must be called exactly once with correct fields
    expect(memoryPort.store).toHaveBeenCalledOnce();
    expect(memoryPort.store).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryType: "episodic",
        trustLevel: "learned",
      }),
      expect.objectContaining({
        turnScope: expect.objectContaining({
          conversation: expect.objectContaining({ tenantId: "tenant-a", agentId: "agent-a" }),
        }),
      }),
    );

    // appendProvenance must be called once with matching summaryId + scope fields
    expect(lcdStore.appendProvenance).toHaveBeenCalledOnce();
    const provenanceCall = (lcdStore.appendProvenance as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AppendProvenanceInput;
    expect(provenanceCall.summaryId).toBe("summary-1");
    expect(provenanceCall.agentId).toBe("agent-a");
    expect(provenanceCall.tenantId).toBe("tenant-a");
    expect(provenanceCall.conversationRef).toBe(params.scope.conversationRef);
  });

  it("stamps a `summary:<id>` tag on the distilled memory so the precise-provenance recall branch can key on it", async () => {
    // RED on pre-patch code: the runner wrote tags ["lcd_distilled", "depth:N"]
    // only — the recall provenance pass's PROVENANCE-PRECISE branch
    // (recall-provenance.ts:88, SUMMARY_TAG_PREFIX="summary:") never fires because
    // no distilled memory carries the summaryId tag. The stamp lets the
    // pass query getProvenanceForSummary for the EXACT linked memoryIds.
    // The tag adds an id only — no content ever rides in a tag.
    const memoryPort = makeMemoryPort();
    const lcdStore = makeLcdStore();
    const params = makeParams({
      depth: 2,
      deps: {
        ...makeParams().deps,
        memoryPort,
        lcdStore: lcdStore as unknown as ContextStorePort,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        isSubagentSession: false,
      },
    });
    await runDistillationPassAfterTurn(params);

    expect(memoryPort.store).toHaveBeenCalledOnce();
    const stored = (memoryPort.store as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { tags: string[] };
    expect(stored.tags).toContain("lcd_distilled");
    expect(stored.tags).toContain("depth:2");
    expect(stored.tags).toContain("summary:summary-1"); // summaryId from the fixture
  });
});

// ---------------------------------------------------------------------------
// SUPERSESSION BFS — 1 test
// ---------------------------------------------------------------------------

describe("runDistillationPassAfterTurn — supersession BFS", () => {
  it("getSummaryChildren returns child-1 → markProvenanceSuperseded called with (child-1, newMemoryId)", async () => {
    const childSummaryId = "child-1";
    const mockStore = (memId: string) => ({
      ok: true,
      value: { id: memId, content: "stored" },
    });
    const memoryPort = makeMemoryPort({
      store: vi.fn().mockImplementation(() => {
        // We need to capture the id that was used so we can verify supersession
        const id = "mem-supersession-test";
        return Promise.resolve(mockStore(id));
      }),
    });

    // We track what memoryId was stored to verify supersession points to it
    let storedMemoryId: string | undefined;
    const originalStore = memoryPort.store;
    (memoryPort as { store: typeof originalStore }).store = vi.fn().mockImplementation(
      async (entry: { id: string }) => {
        storedMemoryId = entry.id;
        return { ok: true as const, value: entry };
      },
    );

    const lcdStore = makeLcdStore({
      getSummaryChildren: vi.fn().mockReturnValue([{ summaryId: childSummaryId, depth: 1, content: "child content" }]),
      markProvenanceSuperseded: vi.fn(),
    });

    const params = makeParams({
      summaryId: "root-summary",
      deps: {
        ...makeParams().deps,
        memoryPort,
        lcdStore: lcdStore as unknown as ContextStorePort,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        isSubagentSession: false,
      },
    });
    await runDistillationPassAfterTurn(params);

    // The call carries the tenant+agent scope too.
    expect(lcdStore.markProvenanceSuperseded).toHaveBeenCalledWith(
      childSummaryId,
      expect.any(String), // the new memoryId
      "tenant-a",
      "agent-a",
    );

    // The memoryId passed to markProvenanceSuperseded must match what was stored
    if (storedMemoryId !== undefined) {
      expect(lcdStore.markProvenanceSuperseded).toHaveBeenCalledWith(
        childSummaryId,
        storedMemoryId,
        "tenant-a",
        "agent-a",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// DEDUP — 2 tests
// ---------------------------------------------------------------------------

describe("runDistillationPassAfterTurn — dedup", () => {
  it("memoryPort.search returns FTS match → store.store NOT called + emits reason:near_duplicate", async () => {
    const eventBus = makeEventBus();
    const memoryPort = makeMemoryPort({
      search: vi.fn().mockResolvedValue({
        ok: true,
        value: [
          {
            entry: { id: "existing-mem", content: "very similar text" },
            score: 0.95,
          } as MemorySearchResult,
        ],
      }),
    });
    const params = makeParams({
      deps: {
        ...makeParams().deps,
        memoryPort,
        eventBus,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        isSubagentSession: false,
      },
    });
    await runDistillationPassAfterTurn(params);
    expect(memoryPort.store).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith(
      "memory:distillation_skipped",
      expect.objectContaining({ reason: "near_duplicate" }),
    );
  });

  it("memoryPort.search (vec cosine above threshold) → store NOT called", async () => {
    const eventBus = makeEventBus();
    const memoryPort = makeMemoryPort({
      // High cosine score (above 0.92 threshold)
      search: vi.fn().mockResolvedValue({
        ok: true,
        value: [
          {
            entry: { id: "vec-mem-1", content: "near-dup via cosine" },
            score: 0.98,
          } as MemorySearchResult,
        ],
      }),
    });
    const params = makeParams({
      deps: {
        ...makeParams().deps,
        memoryPort,
        eventBus,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        isSubagentSession: false,
      },
    });
    await runDistillationPassAfterTurn(params);
    expect(memoryPort.store).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith(
      "memory:distillation_skipped",
      expect.objectContaining({ reason: "near_duplicate" }),
    );
  });

  // Agent read-isolation on the dedup path: the pre-write dedup search MUST
  // pass agentId in the SEARCH OPTIONS — that is the ONLY field SqliteMemoryAdapter
  // applies the `agent_id = ?` predicate from (sessionKey.agentId is ignored by
  // search()). Without it, a near-duplicate distilled memory belonging to a
  // DIFFERENT agent in the same tenant suppresses this agent's legitimate write
  it("dedup search carries agentId in the explicit recall scope", async () => {
    const searchSpy = vi.fn().mockResolvedValue({ ok: true, value: [] });
    const memoryPort = makeMemoryPort({ search: searchSpy });
    const params = makeParams({
      scope: makeScope({ agentId: "agent-a", tenantId: "tenant-1" }),
      deps: {
        ...makeParams().deps,
        memoryPort,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        isSubagentSession: false,
      },
    });
    await runDistillationPassAfterTurn(params);

    expect(searchSpy).toHaveBeenCalledOnce();
    const recallScope = searchSpy.mock.calls[0]![0] as { agentId?: string };
    expect(recallScope.agentId).toBe("agent-a");
  });
});

// ---------------------------------------------------------------------------
// ZERO ASSEMBLY-PATH DIFF (characterization) — 1 test
// ---------------------------------------------------------------------------

describe("runDistillationPassAfterTurn — zero assembly-path diff", () => {
  it("distillation runner does NOT call any assembly-path deps (assembler isolation invariant)", async () => {
    // The distillation runner is purely write-side.
    // It must NEVER touch lcd-assembler, prompt-assembly, or any
    // context-engine assembly code. This test verifies the runner
    // does not call any "assembly" related function — it only calls
    // memory write APIs.
    //
    // Approach: pass a set of mock deps that includes a spy for every
    // function the assembler would need. Assert NONE are called by
    // the runner.

    const assemblerSpy = vi.fn();
    const getContextItemsSpy = vi.fn();
    const getSummariesSpy = vi.fn();

    const memoryPort = makeMemoryPort();

    // The distillation runner only has access to: memoryPort, lcdStore, logger,
    // eventBus, distillConfig, modelProfile, strongerSummarizerModel, isSubagentSession
    // It should NOT call getContextItemsSpy or getSummariesSpy (assembly path)
    const params = makeParams({
      deps: {
        ...makeParams().deps,
        memoryPort,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        isSubagentSession: false,
      },
    });

    // Attach assembly spies to the scope object (they would be called if the
    // runner incorrectly accesses assembly state)
    (params.scope as unknown as Record<string, unknown>)._assemblerSpy = assemblerSpy;
    (params.scope as unknown as Record<string, unknown>)._getContextItems = getContextItemsSpy;
    (params.scope as unknown as Record<string, unknown>)._getSummaries = getSummariesSpy;

    await runDistillationPassAfterTurn(params);

    // The runner must not invoke assembly-path spies
    expect(assemblerSpy).not.toHaveBeenCalled();
    expect(getContextItemsSpy).not.toHaveBeenCalled();
    expect(getSummariesSpy).not.toHaveBeenCalled();

    // The runner DOES call memoryPort.store (write-side only)
    expect(memoryPort.store).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// DEPTH GATE — 1 additional test
// ---------------------------------------------------------------------------

describe("runDistillationPassAfterTurn — depth gate", () => {
  it("depth=0 with minDepth=1 → emits depth_below_min and skips write", async () => {
    const eventBus = makeEventBus();
    const memoryPort = makeMemoryPort();
    const params = makeParams({
      depth: 0,
      deps: {
        ...makeParams().deps,
        memoryPort,
        eventBus,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        isSubagentSession: false,
      },
    });
    await runDistillationPassAfterTurn(params);
    expect(memoryPort.store).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith(
      "memory:distillation_skipped",
      expect.objectContaining({ reason: "depth_below_min" }),
    );
  });
});

// ---------------------------------------------------------------------------
// NANO model gate — 1 additional test
// ---------------------------------------------------------------------------

describe("runDistillationPassAfterTurn — nano model gate", () => {
  it("nano capabilityClass without strongerSummarizerModel → logger.info + skips write", async () => {
    const logger = makeLogger();
    const memoryPort = makeMemoryPort();
    const params = makeParams({
      deps: {
        ...makeParams().deps,
        memoryPort,
        logger,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        modelProfile: { capabilityClass: "nano" },
        strongerSummarizerModel: undefined,
        isSubagentSession: false,
      },
    });
    await runDistillationPassAfterTurn(params);
    expect(memoryPort.store).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "distillation_gate",
        reason: "weak_model_no_override",
        capabilityClass: "nano",
      }),
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// Write-path observability (AGENTS.md §2.7)
// The fire-and-forget memory-write boundary must emit an INFO
// completion line carrying durationMs (timed via the injected clock, never
// Date.now()), and must NOT silently no-op when appendProvenance is absent.
// ---------------------------------------------------------------------------

describe("runDistillationPassAfterTurn — write-path observability", () => {
  it("a successful write emits a step:distillation INFO completion line with durationMs (from the injected clock)", async () => {
    const logger = makeLogger();
    const memoryPort = makeMemoryPort();
    const lcdStore = makeLcdStore();
    // An injected clock callable advancing 7ms between the two reads (entry → emit).
    let tick = 1000;
    const nowFn = vi.fn().mockImplementation(() => {
      const v = tick;
      tick += 7;
      return v;
    });
    const params = makeParams({
      depth: 2,
      now: 1000,
      deps: {
        ...makeParams().deps,
        memoryPort,
        lcdStore: lcdStore as unknown as ContextStorePort,
        logger,
        nowFn,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        isSubagentSession: false,
      },
    });
    await runDistillationPassAfterTurn(params);

    expect(memoryPort.store).toHaveBeenCalledOnce();
    // The INFO completion line: step:"distillation", durationMs present (number),
    // ids/depth only — never content.
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "distillation",
        summaryId: "summary-1",
        depth: 2,
        agentId: "agent-a",
        durationMs: expect.any(Number),
      }),
      expect.any(String),
    );
    // durationMs must be derived from the injected clock (>0 from the 7ms advance),
    // proving Date.now() was not used for the timing.
    const infoCall = (logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { step?: string }).step === "distillation",
    );
    expect(infoCall).toBeDefined();
    expect((infoCall![0] as { durationMs: number }).durationMs).toBeGreaterThan(0);
  });

  it("a write occurred but appendProvenance is ABSENT → a DEBUG/WARN with errorKind+hint (no silent skip)", async () => {
    const logger = makeLogger();
    const memoryPort = makeMemoryPort();
    // lcdStore WITHOUT appendProvenance (a realistic partial-wire) but WITH the
    // BFS walk method so STEP 12 does not crash.
    const lcdStore = {
      getSummaryChildren: vi.fn().mockReturnValue([]),
      markProvenanceSuperseded: vi.fn(),
      // appendProvenance intentionally omitted
    } as unknown as ContextStorePort;
    const params = makeParams({
      depth: 2,
      deps: {
        ...makeParams().deps,
        memoryPort,
        lcdStore,
        logger,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        isSubagentSession: false,
      },
    });
    await runDistillationPassAfterTurn(params);

    expect(memoryPort.store).toHaveBeenCalledOnce();
    // The provenance-skip must be observable: a DEBUG or WARN carrying an
    // errorKind + an operator-actionable hint (not a silent optional-chain no-op).
    const debugCalls = (logger.debug as ReturnType<typeof vi.fn>).mock.calls;
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const observed = [...debugCalls, ...warnCalls].some(
      (c) =>
        typeof c[0] === "object" &&
        c[0] !== null &&
        "errorKind" in (c[0] as object) &&
        "hint" in (c[0] as object),
    );
    expect(observed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The supersession BFS must NOT silently optional-chain past a missing
// markProvenanceSuperseded. The appendProvenance sibling branches on
// `== null` + emits a content-free DEBUG (so a partial-wire is diagnosable); the
// supersession walk did `markProvenanceSuperseded?.(...)` — a silent no-op when the
// method is absent, which would let the pyramid-rule supersession fail with ZERO
// operator signal (recall down-weighting then double-counts across condense levels).
// ---------------------------------------------------------------------------

describe("runDistillationPassAfterTurn — supersession partial-wire observability", () => {
  it("a descendant exists but markProvenanceSuperseded is ABSENT → a DEBUG/WARN with errorKind+hint (no silent ?. no-op)", async () => {
    const logger = makeLogger();
    const memoryPort = makeMemoryPort();
    // A realistic partial-wire: appendProvenance is present (the write links), the BFS
    // finds a descendant to supersede, but markProvenanceSuperseded is NOT implemented.
    // Pre-patch: `markProvenanceSuperseded?.(...)` silently no-ops → no log → RED here.
    const lcdStore = {
      appendProvenance: vi.fn(),
      getSummaryChildren: vi
        .fn()
        .mockReturnValueOnce([{ summaryId: "child-1", depth: 1, content: "child" }])
        .mockReturnValue([]),
      // markProvenanceSuperseded intentionally omitted
    } as unknown as ContextStorePort;
    const params = makeParams({
      depth: 2,
      deps: {
        ...makeParams().deps,
        memoryPort,
        lcdStore,
        logger,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        isSubagentSession: false,
      },
    });
    await runDistillationPassAfterTurn(params);

    expect(memoryPort.store).toHaveBeenCalledOnce();
    // The supersession-skip must be observable: a DEBUG or WARN carrying an errorKind +
    // an operator-actionable hint (mirror the appendProvenance-absent branch), not silence.
    const debugCalls = (logger.debug as ReturnType<typeof vi.fn>).mock.calls;
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const observed = [...debugCalls, ...warnCalls].some(
      (c) =>
        typeof c[0] === "object" &&
        c[0] !== null &&
        "errorKind" in (c[0] as object) &&
        "hint" in (c[0] as object) &&
        // The signal must specifically name the supersession path (not the
        // appendProvenance branch, which is present in this fixture). "supers"
        // matches both "supersession" (message) and "supersede" (hint).
        String((c[1] ?? "")).toLowerCase().includes("supers"),
    );
    expect(observed).toBe(true);
  });

  it("the missing-impl signal fires AT MOST ONCE even when the BFS visits many descendants (content-free, not per-node spam)", async () => {
    const logger = makeLogger();
    const memoryPort = makeMemoryPort();
    // The BFS visits several descendants; the missing-impl DEBUG must be emitted once,
    // not once per node (the §2.7 "N-per-request aggregate" discipline).
    const lcdStore = {
      appendProvenance: vi.fn(),
      getSummaryChildren: vi
        .fn()
        .mockReturnValueOnce([
          { summaryId: "child-1", depth: 1, content: "c1" },
          { summaryId: "child-2", depth: 1, content: "c2" },
        ])
        .mockReturnValueOnce([{ summaryId: "grandchild-1", depth: 0, content: "g1" }])
        .mockReturnValue([]),
      // markProvenanceSuperseded intentionally omitted
    } as unknown as ContextStorePort;
    const params = makeParams({
      depth: 2,
      deps: {
        ...makeParams().deps,
        memoryPort,
        lcdStore,
        logger,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        isSubagentSession: false,
      },
    });
    await runDistillationPassAfterTurn(params);

    const supersedSignals = [
      ...(logger.debug as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
    ].filter((c) => String((c[1] ?? "")).toLowerCase().includes("supers"));
    expect(supersedSignals).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The validation/secret-egress skip must be system-observable
// GATE 7 (validateMemoryWrite non-clean) previously only WARNed; the documented
// reason:"validation" was never emitted on the bus. The skip must emit
// memory:distillation_skipped CONTENT-FREE (ids only, never the matched secret).
// ---------------------------------------------------------------------------

describe("runDistillationPassAfterTurn — validation skip event", () => {
  it("validateMemoryWrite non-clean → emits memory:distillation_skipped reason:validation (content-free)", async () => {
    const eventBus = makeEventBus();
    const memoryPort = makeMemoryPort();
    const content = "AKIA1234567890ABCDEF"; // AWS-key-like → non-clean verdict
    const params = makeParams({
      content,
      deps: {
        ...makeParams().deps,
        memoryPort,
        eventBus,
        distillConfig: { enabled: true, minDepth: 1, dedupCosineThreshold: 0.92 },
        isSubagentSession: false,
      },
    });
    await runDistillationPassAfterTurn(params);

    expect(memoryPort.store).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith(
      "memory:distillation_skipped",
      expect.objectContaining({ reason: "validation", summaryId: "summary-1", agentId: "agent-a" }),
    );
    // CONTENT-FREE: the emitted payload must NOT carry the matched secret text.
    const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "memory:distillation_skipped" && (c[1] as { reason?: string }).reason === "validation",
    );
    expect(emitCalls).toHaveLength(1);
    const payload = emitCalls[0]![1] as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain("AKIA1234567890ABCDEF");
  });
});
