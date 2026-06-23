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

function createMockDeps(): AutonomyHandlerDeps {
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
    logger: { info: vi.fn(), warn: vi.fn() },
  } as unknown as AutonomyHandlerDeps;
}

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
});

// ---------------------------------------------------------------------------
// Test 5: deny-by-origin on the REAL dispatch path (the load-bearing security
// test). The methods are scopes:["admin"] → ADMIN_METHODS → assertNotAgentOrigin
// denies an _agentId-bearing call BEFORE the handler runs. We mock every handler
// factory so createRpcDispatch can be constructed without the full deps bag, then
// dispatch lease.revoke / run.kill with _agentId and assert the deny; an
// operator-origin call (no _agentId) reaches the (mocked) handler.
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

  async function getDispatch() {
    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    return createRpcDispatch(mockDeps);
  }

  it("denies an _agentId-bearing lease.revoke / run.kill on the in-process dispatch path (admin-derived, no manual check)", async () => {
    for (const method of ["lease.revoke", "run.kill"]) {
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
});
