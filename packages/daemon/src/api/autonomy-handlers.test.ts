// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first contract for the autonomy RPC handlers (Phase 213-06, REVOKE-01/03):
 * `lease.revoke` (cooperative stop) + `run.kill` (hard stop).
 *
 * Tests 1-4 drive the handlers in isolation against a mock LeaseManager + runner:
 *   - lease.revoke by leaseId → leaseManager.revoke + { revoked: 1 },
 *   - lease.revoke by rootRunId → leaseManager.revokeByRootRun + its count,
 *   - lease.revoke with neither → the bespoke pre-Zod "Missing required parameter",
 *   - run.kill → subAgentRunner.killByRootRun AND leaseManager.revokeByRootRun
 *     (hard stop = kill the runs AND revoke the leases) + { killed: n }.
 *
 * Test 5 is the LOAD-BEARING security test: deny-by-origin is AUTOMATIC (no
 * manual `_agentId` check in the handler). The methods are `scopes:["admin"]`
 * (Plan 03) → derived `ADMIN_METHODS` → the dispatch chokepoint's
 * `assertNotAgentOrigin` denies any `_agentId`-bearing call BEFORE the handler
 * runs. We assert this on the REAL dispatch path (the in-process leg the agent
 * actually traverses), and that an operator-origin call (no `_agentId`) reaches
 * the handler.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createAutonomyHandlers,
  type AutonomyHandlerDeps,
} from "./autonomy-handlers.js";

// ---------------------------------------------------------------------------
// Mock helpers (Tests 1-4: handlers in isolation)
// ---------------------------------------------------------------------------

function createMockDeps(over: Partial<AutonomyHandlerDeps> = {}): AutonomyHandlerDeps {
  return {
    leaseManager: {
      mintLease: vi.fn(),
      validate: vi.fn(),
      renew: vi.fn(),
      revoke: vi.fn(),
      cascadeRevoke: vi.fn(),
      revokeByRootRun: vi.fn().mockReturnValue({ revoked: 0 }),
    },
    subAgentRunner: {
      killByRootRun: vi.fn().mockReturnValue({ killed: 0 }),
    },
    // Phase 216 DUR-03: a durable store stub whose invalidateForRevoke is observable.
    durableRuns: {
      invalidateForRevoke: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    },
    // Phase 217-04 EVICT-01: a stub evicted-set whose mark/isEvicted/clear are
    // observable. The OPTIONAL dep — present here so the default deps register the
    // autonomy.evict handler; the gating test below omits it to prove the handler
    // is then absent (HIGH-1).
    evictRegistry: {
      mark: vi.fn(() => ({ newlyEvicted: true })),
      isEvicted: vi.fn(() => false),
      clear: vi.fn(),
    },
    logger: { info: vi.fn(), warn: vi.fn() },
    ...over,
  } as unknown as AutonomyHandlerDeps;
}

// ---------------------------------------------------------------------------
// FLEET-03 (Phase 220-01): the handlers emit a content-free typed event BESIDE
// the existing INFO line — autonomy:revoked on a rootRunId revoke,
// autonomy:killed on a run.kill. A spy eventBus + a deterministic `now` seam are
// passed on deps; the emit carries ONLY {rootRunId, count, timestamp} (T-220-02).
// ---------------------------------------------------------------------------

interface EmittedEvent {
  event: string;
  payload: Record<string, unknown>;
}
function createEmittingDeps(over: Partial<AutonomyHandlerDeps> = {}): {
  deps: AutonomyHandlerDeps;
  emitted: EmittedEvent[];
} {
  const emitted: EmittedEvent[] = [];
  const deps = createMockDeps({
    eventBus: {
      emit: (event: string, payload: Record<string, unknown>) => {
        emitted.push({ event, payload });
      },
    },
    now: () => 1_700_000_000_123,
    ...over,
  } as Partial<AutonomyHandlerDeps>);
  return { deps, emitted };
}

describe("createAutonomyHandlers — FLEET-03 typed event emission (content-free)", () => {
  it("lease.revoke by rootRunId emits autonomy:revoked { rootRunId, revoked, timestamp } with the COUNT", async () => {
    const { deps, emitted } = createEmittingDeps();
    vi.mocked(deps.leaseManager.revokeByRootRun).mockReturnValue({ revoked: 5 });
    const handlers = createAutonomyHandlers(deps);

    await handlers["lease.revoke"]!({ rootRunId: "root-R" });

    const ev = emitted.find((e) => e.event === "autonomy:revoked");
    expect(ev).toBeDefined();
    expect(ev!.payload.rootRunId).toBe("root-R");
    expect(ev!.payload.revoked).toBe(5);
    expect(ev!.payload.timestamp).toBe(1_700_000_000_123);
    // Content-free (T-220-02): the key-set is EXACTLY {rootRunId, revoked, timestamp}
    // — no lease bearer / selector / body field.
    expect(Object.keys(ev!.payload).sort()).toEqual(["revoked", "rootRunId", "timestamp"]);
  });

  it("run.kill emits autonomy:killed { rootRunId, killed, timestamp } with the COUNT (separable from revoke)", async () => {
    const { deps, emitted } = createEmittingDeps();
    vi.mocked(deps.subAgentRunner.killByRootRun).mockReturnValue({ killed: 3 });
    const handlers = createAutonomyHandlers(deps);

    await handlers["run.kill"]!({ rootRunId: "root-K" });

    const ev = emitted.find((e) => e.event === "autonomy:killed");
    expect(ev).toBeDefined();
    expect(ev!.payload.rootRunId).toBe("root-K");
    expect(ev!.payload.killed).toBe(3);
    expect(ev!.payload.timestamp).toBe(1_700_000_000_123);
    expect(Object.keys(ev!.payload).sort()).toEqual(["killed", "rootRunId", "timestamp"]);
    // A kill does NOT also emit autonomy:revoked (the EVENT is the only separator
    // between killed and revoked counts — RESEARCH OQ1).
    expect(emitted.some((e) => e.event === "autonomy:revoked")).toBe(false);
  });

  it("lease.revoke by leaseId (no rootRunId) does NOT emit autonomy:revoked (a by-leaseId revoke has no rootRunId)", async () => {
    const { deps, emitted } = createEmittingDeps();
    const handlers = createAutonomyHandlers(deps);

    await handlers["lease.revoke"]!({ leaseId: "L1" });

    expect(emitted.some((e) => e.event === "autonomy:revoked")).toBe(false);
  });

  it("absent eventBus ⇒ no emit, byte-identical pre-220 behavior (the revoke/kill still succeed)", async () => {
    // The default createMockDeps has NO eventBus — the handlers must not throw and
    // must still return the count (an absent optional dep gates the emit only).
    const deps = createMockDeps();
    vi.mocked(deps.leaseManager.revokeByRootRun).mockReturnValue({ revoked: 2 });
    const handlers = createAutonomyHandlers(deps);
    await expect(handlers["lease.revoke"]!({ rootRunId: "R1" })).resolves.toEqual({ revoked: 2 });
    await expect(handlers["run.kill"]!({ rootRunId: "R1" })).resolves.toEqual({ killed: 0 });
  });
});

describe("createAutonomyHandlers — lease.revoke + run.kill (REVOKE-01/03)", () => {
  let deps: AutonomyHandlerDeps;
  let handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>>;

  beforeEach(() => {
    deps = createMockDeps();
    handlers = createAutonomyHandlers(deps);
  });

  // -------------------------------------------------------------------------
  // Test 1: lease.revoke by leaseId
  // -------------------------------------------------------------------------
  it("lease.revoke by leaseId calls leaseManager.revoke and returns { revoked: 1 }", async () => {
    const result = await handlers["lease.revoke"]!({ leaseId: "L1" });

    expect(deps.leaseManager.revoke).toHaveBeenCalledWith("L1");
    expect(deps.leaseManager.revokeByRootRun).not.toHaveBeenCalled();
    expect(result).toEqual({ revoked: 1 });
  });

  // -------------------------------------------------------------------------
  // Test 2: lease.revoke by rootRunId
  // -------------------------------------------------------------------------
  it("lease.revoke by rootRunId calls leaseManager.revokeByRootRun and returns its count", async () => {
    vi.mocked(deps.leaseManager.revokeByRootRun).mockReturnValue({ revoked: 3 });

    const result = await handlers["lease.revoke"]!({ rootRunId: "R1" });

    expect(deps.leaseManager.revokeByRootRun).toHaveBeenCalledWith("R1");
    expect(deps.leaseManager.revoke).not.toHaveBeenCalled();
    expect(result).toEqual({ revoked: 3 });
  });

  // -------------------------------------------------------------------------
  // Test 3: lease.revoke with neither selector → throws
  // -------------------------------------------------------------------------
  it("lease.revoke with neither leaseId nor rootRunId throws Missing required parameter", async () => {
    await expect(handlers["lease.revoke"]!({})).rejects.toThrow(
      "Missing required parameter: leaseId or rootRunId",
    );
    expect(deps.leaseManager.revoke).not.toHaveBeenCalled();
    expect(deps.leaseManager.revokeByRootRun).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 4: run.kill kills the tree AND revokes its leases
  // -------------------------------------------------------------------------
  it("run.kill kills the whole tree by rootRunId AND revokes its leases (hard stop), returning { killed: n }", async () => {
    vi.mocked(deps.subAgentRunner.killByRootRun).mockReturnValue({ killed: 4 });

    const result = await handlers["run.kill"]!({ rootRunId: "R1" });

    // Hard stop = kill every run of the tree AND revoke every lease (so a
    // survivor child cannot keep operating).
    expect(deps.subAgentRunner.killByRootRun).toHaveBeenCalledWith("R1");
    expect(deps.leaseManager.revokeByRootRun).toHaveBeenCalledWith("R1");
    expect(result).toEqual({ killed: 4 });
  });

  it("run.kill with no rootRunId throws Missing required parameter", async () => {
    await expect(handlers["run.kill"]!({})).rejects.toThrow(
      "Missing required parameter: rootRunId",
    );
    expect(deps.subAgentRunner.killByRootRun).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Phase 216 DUR-03: a revoke ALSO invalidates the persisted run record so a
  // restart can never re-mint the pre-revoke caps (the resurrection-window close).
  // -------------------------------------------------------------------------
  it("DUR-03: lease.revoke by rootRunId ALSO calls durableRuns.invalidateForRevoke(rootRunId)", async () => {
    await handlers["lease.revoke"]!({ rootRunId: "R1" });
    expect(deps.durableRuns!.invalidateForRevoke).toHaveBeenCalledWith("R1");
  });

  it("DUR-03: run.kill ALSO calls durableRuns.invalidateForRevoke(rootRunId)", async () => {
    await handlers["run.kill"]!({ rootRunId: "R1" });
    expect(deps.durableRuns!.invalidateForRevoke).toHaveBeenCalledWith("R1");
  });

  it("DUR-03: lease.revoke by leaseId (no rootRunId) does NOT invalidate a persisted record", async () => {
    await handlers["lease.revoke"]!({ leaseId: "L1" });
    expect(deps.durableRuns!.invalidateForRevoke).not.toHaveBeenCalled();
  });

  it("DUR-03: an invalidate error is WARN-logged but does NOT fail the revoke RPC", async () => {
    vi.mocked(deps.durableRuns!.invalidateForRevoke).mockResolvedValue({ ok: false, error: new Error("db down") });
    vi.mocked(deps.leaseManager.revokeByRootRun).mockReturnValue({ revoked: 2 });
    // The revoke still succeeds (the lease is revoked regardless of the durable write).
    await expect(handlers["lease.revoke"]!({ rootRunId: "R1" })).resolves.toEqual({ revoked: 2 });
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it("DUR-03: inert when no durableRuns store is wired (durability off) — revoke still succeeds", async () => {
    const noStoreDeps = createMockDeps({ durableRuns: undefined });
    const h = createAutonomyHandlers(noStoreDeps);
    await expect(h["lease.revoke"]!({ rootRunId: "R1" })).resolves.toEqual({ revoked: 0 });
    await expect(h["run.kill"]!({ rootRunId: "R1" })).resolves.toEqual({ killed: 0 });
  });
});

// ---------------------------------------------------------------------------
// Phase 217-04 EVICT-01: the autonomy.evict handler (DEMOTE-to-default).
//
// evict MARKS the rootRunId in the OPTIONAL evictRegistry (the chokepoint reads
// it at the next gate decision, EVICT-03) — it does NOT abort. The handler is
// registered ONLY when evictRegistry is present (HIGH-1 — mirrors the
// leaseManager/boundedAutonomy family gating), so the Wave-1 dispatch call site
// (which does not yet supply evictRegistry) keeps building green.
// ---------------------------------------------------------------------------

describe("createAutonomyHandlers — autonomy.evict (EVICT-01, demote to default)", () => {
  let deps: AutonomyHandlerDeps;
  let handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>>;

  beforeEach(() => {
    deps = createMockDeps();
    handlers = createAutonomyHandlers(deps);
  });

  it("marks the rootRunId in the evictRegistry and returns { evicted: true }", async () => {
    const result = await handlers["autonomy.evict"]!({ rootRunId: "root-A" });
    expect(deps.evictRegistry!.mark).toHaveBeenCalledWith("root-A");
    expect(result).toEqual({ evicted: true });
  });

  it("with no rootRunId throws the bespoke pre-Zod Missing required parameter", async () => {
    await expect(handlers["autonomy.evict"]!({})).rejects.toThrow(
      "Missing required parameter: rootRunId",
    );
    expect(deps.evictRegistry!.mark).not.toHaveBeenCalled();
  });

  it("a SECOND evict of the same rootRunId still returns { evicted: true } (idempotent — already-evicted is still evicted)", async () => {
    // The registry reports newlyEvicted:false on the second mark; the handler's
    // response is { evicted: true } regardless (the run IS demoted either way).
    vi.mocked(deps.evictRegistry!.mark)
      .mockReturnValueOnce({ newlyEvicted: true })
      .mockReturnValueOnce({ newlyEvicted: false });
    await expect(handlers["autonomy.evict"]!({ rootRunId: "root-A" })).resolves.toEqual({ evicted: true });
    await expect(handlers["autonomy.evict"]!({ rootRunId: "root-A" })).resolves.toEqual({ evicted: true });
  });

  it("logs content-free — method + a boolean/id only, never a param body (§2.7)", async () => {
    await handlers["autonomy.evict"]!({ rootRunId: "root-A" });
    expect(deps.logger.info).toHaveBeenCalled();
    for (const [payload] of vi.mocked(deps.logger.info).mock.calls) {
      const fields = payload as Record<string, unknown>;
      expect(fields).not.toHaveProperty("body");
      expect(fields).not.toHaveProperty("params");
      expect(fields).not.toHaveProperty("rootRunId");
    }
  });

  // HIGH-1: the handler is registered ONLY when evictRegistry is present.
  it("HIGH-1: registers the autonomy.evict key ONLY when evictRegistry is present", () => {
    const withRegistry = createAutonomyHandlers(createMockDeps());
    expect(Object.keys(withRegistry)).toContain("autonomy.evict");

    const withoutRegistry = createAutonomyHandlers(createMockDeps({ evictRegistry: undefined }));
    expect(Object.keys(withoutRegistry)).not.toContain("autonomy.evict");
    // lease.revoke / run.kill stay registered regardless (they gate on leaseManager).
    expect(Object.keys(withoutRegistry)).toContain("lease.revoke");
    expect(Object.keys(withoutRegistry)).toContain("run.kill");
  });
});

// ---------------------------------------------------------------------------
// Test 5: deny-by-origin on the REAL dispatch path (the load-bearing security
// test). The methods are scopes:["admin"] → ADMIN_METHODS → assertNotAgentOrigin
// denies an _agentId-bearing call BEFORE the handler runs. We mock every handler
// factory so createRpcDispatch can be constructed without the full deps bag, then
// dispatch lease.revoke / run.kill / autonomy.evict with _agentId and assert the
// deny; an operator-origin call (no _agentId) reaches the (mocked) handler.
// ---------------------------------------------------------------------------

vi.mock("./cron-handlers.js", () => ({ createCronHandlers: vi.fn(() => ({})) }));
vi.mock("./memory-handlers.js", () => ({ createMemoryHandlers: vi.fn(() => ({})) }));
vi.mock("./memory-ask-handlers.js", () => ({ bindMemoryAskHandler: vi.fn(() => ({})) }));
vi.mock("./context-handlers.js", () => ({ createContextHandlers: vi.fn(() => ({})) }));
vi.mock("./memory-portability-handlers.js", () => ({ createMemoryPortabilityHandlers: vi.fn(() => ({})) }));
vi.mock("./memory-pinning-handlers.js", () => ({ createMemoryPinningHandlers: vi.fn(() => ({})) }));
vi.mock("./session-handlers/index.js", () => ({ createSessionHandlers: vi.fn(() => ({})) }));
vi.mock("./message-handlers.js", () => ({ createMessageHandlers: vi.fn(() => ({})) }));
vi.mock("./media-handlers.js", () => ({ createMediaHandlers: vi.fn(() => ({})) }));
vi.mock("./config-handlers/index.js", () => ({ createConfigHandlers: vi.fn(() => ({})) }));
vi.mock("./env-handlers.js", () => ({ createEnvHandlers: vi.fn(() => ({})) }));
vi.mock("./secrets-handlers.js", () => ({ createSecretsHandlers: vi.fn(() => ({})) }));
vi.mock("./auth-handlers.js", () => ({ createAuthHandlers: vi.fn(() => ({})) }));
vi.mock("./browser-handlers.js", () => ({ createBrowserHandlers: vi.fn(() => ({})) }));
vi.mock("./subagent-handlers.js", () => ({ createSubagentHandlers: vi.fn(() => ({})) }));
vi.mock("./approval-handlers.js", () => ({ createApprovalHandlers: vi.fn(() => ({})) }));
vi.mock("./agent-handlers.js", () => ({ createAgentHandlers: vi.fn(() => ({})) }));
vi.mock("./obs-handlers/index.js", () => ({ createObsHandlers: vi.fn(() => ({})) }));
vi.mock("./cache-handlers.js", () => ({ createCacheHandlers: vi.fn(() => ({})) }));
vi.mock("./model-handlers.js", () => ({ createModelHandlers: vi.fn(() => ({})) }));
vi.mock("./channel-handlers.js", () => ({ createChannelHandlers: vi.fn(() => ({})) }));
vi.mock("./token-handlers.js", () => ({ createTokenHandlers: vi.fn(() => ({})) }));
vi.mock("./daemon-handlers.js", () => ({ createDaemonHandlers: vi.fn(() => ({})) }));
vi.mock("./mcp-handlers.js", () => ({ createMcpHandlers: vi.fn(() => ({})) }));
vi.mock("./mcp-oauth-handlers.js", () => ({ createMcpOauthHandlers: vi.fn(() => ({})) }));
vi.mock("./graph-handlers/index.js", () => ({ createGraphHandlers: vi.fn(() => ({})) }));
vi.mock("./workspace-handlers.js", () => ({ createWorkspaceHandlers: vi.fn(() => ({})) }));
vi.mock("./heartbeat-handlers.js", () => ({ createHeartbeatHandlers: vi.fn(() => ({})) }));
vi.mock("./skill-handlers.js", () => ({ createSkillHandlers: vi.fn(() => ({})) }));
vi.mock("./notification-handlers.js", () => ({ createNotificationHandlers: vi.fn(() => ({})) }));
vi.mock("./image-handlers.js", () => ({ createImageHandlers: vi.fn(() => ({})) }));
vi.mock("./video-handlers.js", () => ({ createVideoHandlers: vi.fn(() => ({})) }));
vi.mock("./video-status-handlers.js", () => ({ createVideoStatusHandlers: vi.fn(() => ({})) }));
vi.mock("./provider-handlers.js", () => ({ createProviderHandlers: vi.fn(() => ({})) }));

describe("autonomy handlers — deny-by-origin on the dispatch path (REVOKE-01, T-213-06-01)", () => {
  const mockLogger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  };

  // The deny-by-origin chokepoint reads container.eventBus.emit + container.config.
  const mockDeps = {
    logger: mockLogger,
    container: { eventBus: { emit: vi.fn(), on: vi.fn() }, config: { providers: { entries: {} } } },
    // The real autonomy handlers are spread into the dispatcher; provide the
    // leaseManager + runner so they construct (the operator-origin call reaches them).
    leaseManager: {
      mintLease: vi.fn(), validate: vi.fn(), renew: vi.fn(), revoke: vi.fn(),
      cascadeRevoke: vi.fn(), revokeByRootRun: vi.fn().mockReturnValue({ revoked: 2 }),
    },
    subAgentRunner: { killByRootRun: vi.fn().mockReturnValue({ killed: 1 }) },
    // 217-04: the evictRegistry so the autonomy.evict handler registers (the
    // operator-origin call reaches it; an agent-origin call is denied at the
    // chokepoint BEFORE the handler regardless).
    evictRegistry: {
      mark: vi.fn(() => ({ newlyEvicted: true })), isEvicted: vi.fn(() => false), clear: vi.fn(),
    },
  } as never;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Pull only the captured `audit:event` payloads off the mock eventBus. */
  function capturedAudits(): Array<Record<string, unknown>> {
    const emit = (mockDeps as unknown as { container: { eventBus: { emit: ReturnType<typeof vi.fn> } } })
      .container.eventBus.emit;
    return emit.mock.calls
      .filter((c: unknown[]) => c[0] === "audit:event")
      .map((c: unknown[]) => c[1] as Record<string, unknown>);
  }

  /** Pull the captured payload for a specific event name off the container bus. */
  function capturedEvent(name: string): Record<string, unknown> | undefined {
    const emit = (mockDeps as unknown as { container: { eventBus: { emit: ReturnType<typeof vi.fn> } } })
      .container.eventBus.emit;
    const call = emit.mock.calls.find((c: unknown[]) => c[0] === name);
    return call ? (call[1] as Record<string, unknown>) : undefined;
  }

  async function getDispatch() {
    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    return createRpcDispatch(mockDeps);
  }

  it("denies an _agentId-bearing lease.revoke / run.kill / autonomy.evict on the in-process dispatch path (admin-derived, no manual check)", async () => {
    // T-217-12: autonomy.evict joins the deny set — an agent cannot self-un-evict
    // (or evict a sibling). The deny fires at the chokepoint BEFORE the handler.
    for (const method of ["lease.revoke", "run.kill", "autonomy.evict"]) {
      vi.clearAllMocks();
      const dispatch = await getDispatch();
      await expect(
        dispatch(method, { _agentId: "forged", _trustLevel: "admin", rootRunId: "R1" }),
      ).rejects.toThrow(/not reachable from an agent origin/i);

      const audits = capturedAudits();
      expect(audits, `audit for ${method}`).toHaveLength(1);
      expect(audits[0]!.actionType).toBe(method);
      expect(audits[0]!.outcome).toBe("denied");
      expect(audits[0]!.kind).toBe("capability_denied");
    }
  });

  it("an operator-origin lease.revoke (no _agentId) PASSES the chokepoint and reaches the handler", async () => {
    const dispatch = await getDispatch();
    const result = await dispatch("lease.revoke", { rootRunId: "R1" });
    expect(result).toEqual({ revoked: 2 });
    // No deny-by-origin audit fired for the operator-origin call.
    const denials = capturedAudits().filter((a) => a.kind === "capability_denied");
    expect(denials).toHaveLength(0);
  });

  it("an operator-origin run.kill (no _agentId) PASSES the chokepoint and reaches the handler", async () => {
    const dispatch = await getDispatch();
    const result = await dispatch("run.kill", { rootRunId: "R1" });
    expect(result).toEqual({ killed: 1 });
  });

  it("an operator-origin autonomy.evict (no _agentId) PASSES the chokepoint and reaches the handler", async () => {
    const dispatch = await getDispatch();
    const result = await dispatch("autonomy.evict", { rootRunId: "R1" });
    expect(result).toEqual({ evicted: true });
  });

  // -------------------------------------------------------------------------
  // FLEET-03 (Phase 220-01) PRODUCTION WIRING: the LIVE createRpcDispatch
  // construction site MUST thread deps.container.eventBus into
  // createAutonomyHandlers — otherwise the optional eventBus? is absent in prod,
  // the handler emits NOTHING, and Plan 03's autonomy_revoked/killed counts are
  // silently ZERO. We assert the emit lands on the CONTAINER bus (the real
  // construction path), NOT a harness-injected `...over` spy.
  // -------------------------------------------------------------------------
  it("PRODUCTION WIRING: an operator-origin lease.revoke emits autonomy:revoked on the container bus (the live daemon emits, not just the harness)", async () => {
    const dispatch = await getDispatch();
    await dispatch("lease.revoke", { rootRunId: "R1" });
    const ev = capturedEvent("autonomy:revoked");
    expect(ev, "the live construction site must supply eventBus to createAutonomyHandlers").toBeDefined();
    expect(ev!.rootRunId).toBe("R1");
    expect(ev!.revoked).toBe(2); // the mock revokeByRootRun returns { revoked: 2 }
    expect(typeof ev!.timestamp).toBe("number");
  });

  it("PRODUCTION WIRING: an operator-origin run.kill emits autonomy:killed on the container bus", async () => {
    const dispatch = await getDispatch();
    await dispatch("run.kill", { rootRunId: "R1" });
    const ev = capturedEvent("autonomy:killed");
    expect(ev).toBeDefined();
    expect(ev!.rootRunId).toBe("R1");
    expect(ev!.killed).toBe(1); // the mock killByRootRun returns { killed: 1 }
    expect(typeof ev!.timestamp).toBe("number");
  });
});
