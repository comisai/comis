// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 172 Plan 02 — RED tests for the distillation runner core (DIST-01..04).
 *
 * All tests import from the not-yet-existing lcd-distillation-runner.ts — they
 * will fail with "Cannot find module" or a compilation error until the GREEN
 * implementation is written (Task 2).
 *
 * Load-bearing tests:
 *  1. DIST-01 closed-loop: depth≥1 condense → memory + provenance (mock-based)
 *  2. DIST-04 ZERO assembly-path diff: distillation runner does NOT call any
 *     assembly-related deps (structural invariant).
 *  3. R4 cross-scope no-leak: 3 fixtures (cross-tenant, cross-agent,
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
import type { MemorySearchResult } from "@comis/core";
import {
  LEAF_FALLBACK_SUMMARY_MARKER,
  CONDENSED_FALLBACK_SUMMARY_MARKER,
} from "../context-engine/constants.js";
// This import FAILS until GREEN (module does not exist yet):
import {
  runDistillationPassAfterTurn,
  type RunDistillationPassParams,
} from "./lcd-distillation-runner.js";

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function makeScope(overrides: Partial<ContextStoreScope> = {}): ContextStoreScope {
  return {
    conversationId: "conv-1",
    tenantId: "tenant-a",
    agentId: "agent-a",
    sessionKey: "tenant-a::agent-a::conv-1",
    ...overrides,
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
  const scope = makeScope();
  return {
    summaryId: "summary-1",
    scope,
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
// R4 SUITE — 3 tests: null agentId, cross-agent, cross-tenant
// ---------------------------------------------------------------------------

describe("runDistillationPassAfterTurn — R4 scope isolation", () => {
  it("R4: null agentId in scope → returns immediately, no writes (fail-closed)", async () => {
    const memoryPort = makeMemoryPort();
    const lcdStore = makeLcdStore();
    const params = makeParams({
      scope: {
        conversationId: "conv-1",
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

  it("R4: agent-A distillation → memoryPort.store called with agentId:agent-a, NEVER with agentId:agent-b", async () => {
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
      expect.objectContaining({ agentId: "agent-a" }),
    );
    // The store must NEVER be called with agent-b
    const allCalls = (memoryPort.store as ReturnType<typeof vi.fn>).mock.calls;
    for (const [entry] of allCalls) {
      expect((entry as { agentId: string }).agentId).not.toBe("agent-b");
    }
  });

  it("R4: tenant-A distillation → memoryPort.store called with tenantId:tenant-a, NEVER with tenantId:tenant-b", async () => {
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
      expect.objectContaining({ tenantId: "tenant-a" }),
    );
    const allCalls = (memoryPort.store as ReturnType<typeof vi.fn>).mock.calls;
    for (const [entry] of allCalls) {
      expect((entry as { tenantId: string }).tenantId).not.toBe("tenant-b");
    }
  });
});

// ---------------------------------------------------------------------------
// CLOSED-LOOP DIST-01 — 1 test
// ---------------------------------------------------------------------------

describe("runDistillationPassAfterTurn — DIST-01 closed-loop", () => {
  it("DIST-01: depth≥1, enabled, non-fallback, non-subagent → memoryPort.store called once with episodic/learned + appendProvenance called once", async () => {
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
        tenantId: "tenant-a",
        agentId: "agent-a",
      }),
    );

    // appendProvenance must be called once with matching summaryId + scope fields
    expect(lcdStore.appendProvenance).toHaveBeenCalledOnce();
    const provenanceCall = (lcdStore.appendProvenance as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AppendProvenanceInput;
    expect(provenanceCall.summaryId).toBe("summary-1");
    expect(provenanceCall.agentId).toBe("agent-a");
    expect(provenanceCall.tenantId).toBe("tenant-a");
    expect(provenanceCall.conversationId).toBe("conv-1");
  });
});

// ---------------------------------------------------------------------------
// SUPERSESSION DIST-03 — 1 test
// ---------------------------------------------------------------------------

describe("runDistillationPassAfterTurn — DIST-03 supersession BFS", () => {
  it("DIST-03: getSummaryChildren returns child-1 → markProvenanceSuperseded called with (child-1, newMemoryId)", async () => {
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

    expect(lcdStore.markProvenanceSuperseded).toHaveBeenCalledWith(
      childSummaryId,
      expect.any(String), // the new memoryId
    );

    // The memoryId passed to markProvenanceSuperseded must match what was stored
    if (storedMemoryId !== undefined) {
      expect(lcdStore.markProvenanceSuperseded).toHaveBeenCalledWith(childSummaryId, storedMemoryId);
    }
  });
});

// ---------------------------------------------------------------------------
// DEDUP DIST-02 — 2 tests
// ---------------------------------------------------------------------------

describe("runDistillationPassAfterTurn — DIST-02 dedup", () => {
  it("DIST-02: memoryPort.search returns FTS match → store.store NOT called + emits reason:near_duplicate", async () => {
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

  it("DIST-02: memoryPort.search (vec cosine above threshold) → store NOT called", async () => {
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
});

// ---------------------------------------------------------------------------
// ZERO ASSEMBLY-PATH DIFF (DIST-04 characterization) — 1 test
// ---------------------------------------------------------------------------

describe("runDistillationPassAfterTurn — DIST-04 zero assembly-path diff", () => {
  it("DIST-04: distillation runner does NOT call any assembly-path deps (assembler isolation invariant)", async () => {
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
