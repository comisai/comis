// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the operator deterministic-replay path (REPLAY-02):
 *   - `runOrchestrateReplaySession` (the socket + pinned-byte re-spawn glue):
 *     validates the runId against a real durable orchestrate row, mints an
 *     ephemeral bearer + OutputGuard-registers it BEFORE use, starts the
 *     SEPARATE replay socket, re-spawns the pinned bytes with `COMIS_ORCH_SOCKET`
 *     pointed at the replay socket (never the production endpoint — INV-1),
 *     collects the stdout, and tears the socket down in a `finally`.
 *   - `buildReplayChildEnv` — the INV-1 keystone: the re-spawn env's
 *     `COMIS_ORCH_SOCKET` is the replay socket path + `COMIS_CAP_LEASE` is the
 *     ephemeral bearer.
 *   - Deny-by-origin on the REAL dispatch path: `orchestrate.replay` is
 *     `scopes:["admin"]` → derived `ADMIN_METHODS` → the chokepoint's
 *     `assertNotAgentOrigin` rejects a non-admin `_agentId`-bearing call BEFORE
 *     the handler runs (INV-3); an operator origin (no `_agentId`) reaches it.
 *
 * The real jailed byte-identical-stdout round-trip (bwrap) is VPS-gated + covered
 * by a later `.linux` drive; this file proves the RPC/deny-by-origin/socket-glue/
 * re-spawn-target LOGIC on macOS against injected seams + a real durable-row shape.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DurableRunRecord } from "@comis/core";
import { OrchestrateReplayContract } from "@comis/core";
import {
  runOrchestrateReplaySession,
  buildReplayChildEnv,
  resolveReplaySocketPathIn,
  type OrchestrateReplaySessionDeps,
  type OrchestrateReplayRespawnInput,
} from "./setup-orchestrate-replay.js";

// ---------------------------------------------------------------------------
// Fixtures + seam fakes
// ---------------------------------------------------------------------------

const RUN_ID = "root-abc";
const SOCKET_PATH = "/tmp/comis-replay-abc.sock";
const BEARER = "replay-bearer-xyz";
const WORKSPACE = "/ws/root-abc";

/** A real-shaped resumable durable row carrying a pinned scriptRef. */
function durableRow(over: Partial<DurableRunRecord> = {}): DurableRunRecord {
  return {
    rootRunId: RUN_ID,
    spawnTree: [],
    caps: [],
    leaseIds: [],
    budgetConsumed: 0,
    cronOrigin: null,
    stepIndex: -1,
    status: "running",
    lastHeartbeatAt: 0,
    scriptRef: "root-abc.ts",
    ...over,
  };
}

const fakeLogger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
} as never;

interface Harness {
  deps: OrchestrateReplaySessionDeps;
  getByRootRun: ReturnType<typeof vi.fn>;
  registerSecret: ReturnType<typeof vi.fn>;
  respawn: ReturnType<typeof vi.fn>;
  socketStart: ReturnType<typeof vi.fn>;
  socketClose: ReturnType<typeof vi.fn>;
  callOrder: string[];
}

function makeHarness(
  over: {
    row?: DurableRunRecord | undefined;
    getByRootRunResult?: { ok: true; value: DurableRunRecord | undefined } | { ok: false; error: Error };
    respawnImpl?: (input: OrchestrateReplayRespawnInput) => Promise<{ stdout: string; diverged?: boolean }>;
    // The sticky divergence the replay SOCKET reports (the production respawn cannot
    // observe a child-side socket divergence, so the session reads it off the socket).
    socketDiverged?: boolean;
  } = {},
): Harness {
  const callOrder: string[] = [];
  const getByRootRun = vi.fn().mockResolvedValue(
    over.getByRootRunResult ??
      { ok: true, value: over.row !== undefined ? over.row : durableRow() },
  );
  const registerSecret = vi.fn(() => callOrder.push("registerSecret"));
  const respawn = vi.fn(
    over.respawnImpl ??
      (async (input: OrchestrateReplayRespawnInput) => {
        callOrder.push("respawn");
        void input;
        return { stdout: "RECORDED-STDOUT" };
      }),
  );
  const socketStart = vi.fn(async () => {
    callOrder.push("socket.start");
  });
  const socketClose = vi.fn(async () => {
    callOrder.push("socket.close");
  });
  const deps: OrchestrateReplaySessionDeps = {
    durableRuns: { getByRootRun },
    resolveWorkspace: () => WORKSPACE,
    createReplaySocket: () => ({
      start: socketStart,
      close: socketClose,
      diverged: () => over.socketDiverged ?? false,
    }),
    respawn: respawn as unknown as OrchestrateReplaySessionDeps["respawn"],
    outputGuard: { registerSecret },
    mintBearer: () => BEARER,
    resolveReplaySocketPath: () => SOCKET_PATH,
    logger: fakeLogger,
  };
  return { deps, getByRootRun, registerSecret, respawn, socketStart, socketClose, callOrder };
}

// ---------------------------------------------------------------------------
// buildReplayChildEnv — INV-1 keystone
// ---------------------------------------------------------------------------

describe("buildReplayChildEnv — COMIS_ORCH_SOCKET points at the replay socket (INV-1)", () => {
  it("sets COMIS_ORCH_SOCKET to the replay socket path and COMIS_CAP_LEASE to the ephemeral bearer", () => {
    const env = buildReplayChildEnv(SOCKET_PATH, BEARER);
    expect(env.COMIS_ORCH_SOCKET).toBe(SOCKET_PATH);
    expect(env.COMIS_CAP_LEASE).toBe(BEARER);
  });

  it("merges a base env but the two replay keys always win (never the production endpoint)", () => {
    const env = buildReplayChildEnv(SOCKET_PATH, BEARER, {
      PATH: "/usr/bin",
      COMIS_ORCH_SOCKET: "/run/comis/PRODUCTION-cap.sock",
      COMIS_CAP_LEASE: "prod-bearer",
    });
    expect(env.PATH).toBe("/usr/bin");
    // The replay socket + ephemeral bearer OVERRIDE any inherited production values.
    expect(env.COMIS_ORCH_SOCKET).toBe(SOCKET_PATH);
    expect(env.COMIS_CAP_LEASE).toBe(BEARER);
    expect(env.COMIS_ORCH_SOCKET).not.toContain("PRODUCTION");
  });
});

// ---------------------------------------------------------------------------
// resolveReplaySocketPathIn — bound under the unix sun_path limit (LR-02)
// ---------------------------------------------------------------------------

describe("resolveReplaySocketPathIn — stays under the unix sun_path limit", () => {
  it("keeps the socket path under ~104 bytes even under a long TMPDIR (a long macOS /var/folders/... base)", () => {
    // On macOS tmpdir() is a long /var/folders/xx/…/T path that, combined with the
    // basename, can exceed the ~104-byte sun_path limit → listen() fails ENAMETOOLONG.
    const longTmp = "/var/folders/" + "a".repeat(140) + "/T";
    const p = resolveReplaySocketPathIn(longTmp, "root-abc");
    expect(Buffer.byteLength(p, "utf8")).toBeLessThanOrEqual(104);
    expect(p.endsWith(".sock")).toBe(true);
  });

  it("uses the provided temp-dir base as-is when the full path is short enough", () => {
    const p = resolveReplaySocketPathIn("/tmp", "root-abc");
    expect(p.startsWith("/tmp/comis-rpl-")).toBe(true);
    expect(p.endsWith(".sock")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runOrchestrateReplaySession — the socket + re-spawn glue
// ---------------------------------------------------------------------------

describe("runOrchestrateReplaySession — happy path", () => {
  it("validates the runId, mints+registers a bearer, starts the socket, re-spawns the pinned bytes at the replay socket, and returns the recorded stdout", async () => {
    const h = makeHarness();
    const result = await runOrchestrateReplaySession(h.deps, RUN_ID);

    expect(h.getByRootRun).toHaveBeenCalledWith(RUN_ID);
    expect(h.registerSecret).toHaveBeenCalledWith(BEARER);
    expect(h.socketStart).toHaveBeenCalledWith(SOCKET_PATH);

    // INV-1: the re-spawn childEnv points COMIS_ORCH_SOCKET at the REPLAY socket
    // path (never the production endpoint), authed by the ephemeral bearer.
    const respawnInput = h.respawn.mock.calls[0]![0] as OrchestrateReplayRespawnInput;
    expect(respawnInput.socketPath).toBe(SOCKET_PATH);
    expect(respawnInput.bearer).toBe(BEARER);
    expect(respawnInput.childEnv.COMIS_ORCH_SOCKET).toBe(SOCKET_PATH);
    expect(respawnInput.workspacePath).toBe(WORKSPACE);
    expect(respawnInput.rootRunId).toBe(RUN_ID);

    expect(h.socketClose).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ stdout: "RECORDED-STDOUT" });
  });

  it("registers the ephemeral bearer in OutputGuard BEFORE the re-spawn uses it (Pitfall 6)", async () => {
    const h = makeHarness();
    await runOrchestrateReplaySession(h.deps, RUN_ID);
    // registerSecret must precede respawn (a bearer that leaves the mint closure
    // un-registered can leak via a log/model echo).
    expect(h.callOrder.indexOf("registerSecret")).toBeLessThan(h.callOrder.indexOf("respawn"));
  });

  it("propagates a `diverged` flag from the re-spawn result", async () => {
    const h = makeHarness({
      respawnImpl: async () => ({ stdout: "PARTIAL", diverged: true }),
    });
    const result = await runOrchestrateReplaySession(h.deps, RUN_ID);
    expect(result.diverged).toBe(true);
    expect(result.stdout).toBe("PARTIAL");
  });

  it("surfaces divergence reported by the replay SOCKET even when the respawn returns clean stdout", async () => {
    // The production respawn only captures stdout — it cannot see that a child-side
    // cap call got {error} from the replay socket. The session must read the socket's
    // sticky diverged() after the re-spawn so a diverged replay is not a silent success.
    const h = makeHarness({ socketDiverged: true });
    const result = await runOrchestrateReplaySession(h.deps, RUN_ID);
    expect(result.diverged).toBe(true);
    expect(result.stdout).toBe("RECORDED-STDOUT");
  });
});

describe("runOrchestrateReplaySession — runId validation (T-233-14)", () => {
  it("throws a content-free error and does NOT start a socket or re-spawn when the run is unknown", async () => {
    const h = makeHarness({ getByRootRunResult: { ok: true, value: undefined } });
    await expect(runOrchestrateReplaySession(h.deps, "root-missing")).rejects.toThrow();
    expect(h.socketStart).not.toHaveBeenCalled();
    expect(h.respawn).not.toHaveBeenCalled();
    expect(h.registerSecret).not.toHaveBeenCalled();
  });

  it("throws when the durable row has no pinned scriptRef (not a resumable orchestrate run) — no re-spawn", async () => {
    const h = makeHarness({ row: durableRow({ scriptRef: null }) });
    await expect(runOrchestrateReplaySession(h.deps, RUN_ID)).rejects.toThrow();
    expect(h.socketStart).not.toHaveBeenCalled();
    expect(h.respawn).not.toHaveBeenCalled();
  });

  it("throws when the durable-run lookup itself fails — no re-spawn", async () => {
    const h = makeHarness({ getByRootRunResult: { ok: false, error: new Error("db down") } });
    await expect(runOrchestrateReplaySession(h.deps, RUN_ID)).rejects.toThrow();
    expect(h.respawn).not.toHaveBeenCalled();
  });

  it("the thrown error is content-free (does not echo the runId)", async () => {
    const h = makeHarness({ getByRootRunResult: { ok: true, value: undefined } });
    await expect(runOrchestrateReplaySession(h.deps, "SECRET-RUN-ID")).rejects.toThrow(
      /^(?!.*SECRET-RUN-ID).*$/,
    );
  });
});

describe("runOrchestrateReplaySession — teardown in a finally (T-233-13)", () => {
  it("closes the replay socket even when the re-spawn throws", async () => {
    const h = makeHarness({
      respawnImpl: async () => {
        throw new Error("jail spawn failed");
      },
    });
    await expect(runOrchestrateReplaySession(h.deps, RUN_ID)).rejects.toThrow("jail spawn failed");
    // The socket was started, then torn down in the finally despite the throw.
    expect(h.socketStart).toHaveBeenCalledTimes(1);
    expect(h.socketClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Deny-by-origin on the REAL dispatch path (INV-3). The method is
// scopes:["admin"] → derived ADMIN_METHODS → the chokepoint's
// assertNotAgentOrigin denies an _agentId-bearing (non-admin) call BEFORE the
// handler runs. We mock every handler factory so createRpcDispatch constructs
// without the full deps bag, provide the orchestrate-replay wiring so the real
// handler registers, then dispatch with/without _agentId.
// ---------------------------------------------------------------------------

vi.mock("../api/cron-handlers.js", () => ({ createCronHandlers: vi.fn(() => ({})) }));
vi.mock("../api/memory-handlers.js", () => ({ createMemoryHandlers: vi.fn(() => ({})) }));
vi.mock("../api/memory-ask-handlers.js", () => ({ bindMemoryAskHandler: vi.fn(() => ({})) }));
vi.mock("../api/context-handlers.js", () => ({ createContextHandlers: vi.fn(() => ({})) }));
vi.mock("../api/memory-portability-handlers.js", () => ({ createMemoryPortabilityHandlers: vi.fn(() => ({})) }));
vi.mock("../api/memory-pinning-handlers.js", () => ({ createMemoryPinningHandlers: vi.fn(() => ({})) }));
vi.mock("../api/session-handlers/index.js", () => ({ createSessionHandlers: vi.fn(() => ({})) }));
vi.mock("../api/message-handlers.js", () => ({ createMessageHandlers: vi.fn(() => ({})) }));
vi.mock("../api/media-handlers.js", () => ({ createMediaHandlers: vi.fn(() => ({})) }));
vi.mock("../api/config-handlers/index.js", () => ({ createConfigHandlers: vi.fn(() => ({})) }));
vi.mock("../api/env-handlers.js", () => ({ createEnvHandlers: vi.fn(() => ({})) }));
vi.mock("../api/secrets-handlers.js", () => ({ createSecretsHandlers: vi.fn(() => ({})) }));
vi.mock("../api/auth-handlers.js", () => ({ createAuthHandlers: vi.fn(() => ({})) }));
vi.mock("../api/browser-handlers.js", () => ({ createBrowserHandlers: vi.fn(() => ({})) }));
vi.mock("../api/subagent-handlers.js", () => ({ createSubagentHandlers: vi.fn(() => ({})) }));
vi.mock("../api/approval-handlers.js", () => ({ createApprovalHandlers: vi.fn(() => ({})) }));
vi.mock("../api/agent-handlers.js", () => ({ createAgentHandlers: vi.fn(() => ({})) }));
vi.mock("../api/obs-handlers/index.js", () => ({ createObsHandlers: vi.fn(() => ({})) }));
vi.mock("../api/cache-handlers.js", () => ({ createCacheHandlers: vi.fn(() => ({})) }));
vi.mock("../api/model-handlers.js", () => ({ createModelHandlers: vi.fn(() => ({})) }));
vi.mock("../api/channel-handlers.js", () => ({ createChannelHandlers: vi.fn(() => ({})) }));
vi.mock("../api/token-handlers.js", () => ({ createTokenHandlers: vi.fn(() => ({})) }));
vi.mock("../api/daemon-handlers.js", () => ({ createDaemonHandlers: vi.fn(() => ({})) }));
vi.mock("../api/mcp-handlers.js", () => ({ createMcpHandlers: vi.fn(() => ({})) }));
vi.mock("../api/mcp-oauth-handlers.js", () => ({ createMcpOauthHandlers: vi.fn(() => ({})) }));
vi.mock("../api/graph-handlers/index.js", () => ({ createGraphHandlers: vi.fn(() => ({})) }));
vi.mock("../api/workspace-handlers.js", () => ({ createWorkspaceHandlers: vi.fn(() => ({})) }));
vi.mock("../api/heartbeat-handlers.js", () => ({ createHeartbeatHandlers: vi.fn(() => ({})) }));
vi.mock("../api/skill-handlers.js", () => ({ createSkillHandlers: vi.fn(() => ({})) }));
vi.mock("../api/notification-handlers.js", () => ({ createNotificationHandlers: vi.fn(() => ({})) }));
vi.mock("../api/image-handlers.js", () => ({ createImageHandlers: vi.fn(() => ({})) }));
vi.mock("../api/video-handlers.js", () => ({ createVideoHandlers: vi.fn(() => ({})) }));
vi.mock("../api/video-status-handlers.js", () => ({ createVideoStatusHandlers: vi.fn(() => ({})) }));
vi.mock("../api/provider-handlers.js", () => ({ createProviderHandlers: vi.fn(() => ({})) }));

describe("orchestrate.replay — deny-by-origin on the dispatch path (INV-3)", () => {
  const mockLogger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  };

  // The orchestrate-replay wiring the real handler needs (so it REGISTERS the
  // method). Injected fakes: an OutputGuard, a replay-socket factory, and a
  // re-spawn seam returning canned stdout. durableRuns validates the runId.
  const socketStart = vi.fn(async () => undefined);
  const socketClose = vi.fn(async () => undefined);
  const mockDeps = {
    logger: mockLogger,
    container: { eventBus: { emit: vi.fn(), on: vi.fn() }, config: { tenantId: "default", providers: { entries: {} } } },
    defaultWorkspaceDir: WORKSPACE,
    durableRuns: {
      getByRootRun: vi.fn().mockResolvedValue({ ok: true, value: durableRow() }),
    },
    orchestrateReplay: {
      outputGuard: { registerSecret: vi.fn() },
      respawn: vi.fn(async () => ({ stdout: "RECORDED-STDOUT" })),
      createReplaySocket: () => ({ start: socketStart, close: socketClose, diverged: () => false }),
    },
  } as never;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function capturedAudits(): Array<Record<string, unknown>> {
    const emit = (mockDeps as unknown as { container: { eventBus: { emit: ReturnType<typeof vi.fn> } } })
      .container.eventBus.emit;
    return emit.mock.calls
      .filter((c: unknown[]) => c[0] === "audit:event")
      .map((c: unknown[]) => c[1] as Record<string, unknown>);
  }

  async function getDispatch() {
    const { createRpcDispatch } = await import("../api/rpc-dispatch.js");
    return createRpcDispatch(mockDeps);
  }

  it("orchestrate.replay is scopes:['admin'] (so it lands in the derived deny-by-origin set)", () => {
    expect(OrchestrateReplayContract.scopes).toContain("admin");
  });

  it("denies a NON-admin _agentId-bearing orchestrate.replay on the in-process dispatch path (admin-derived, no manual check)", async () => {
    const dispatch = await getDispatch();
    await expect(
      dispatch("orchestrate.replay", { _agentId: "forged", _trustLevel: "user", runId: RUN_ID }),
    ).rejects.toThrow(/not reachable from a non-admin agent origin/i);

    const audits = capturedAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actionType).toBe("orchestrate.replay");
    expect(audits[0]!.outcome).toBe("denied");
    expect(audits[0]!.kind).toBe("capability_denied");
  });

  it("an operator-origin orchestrate.replay (no _agentId) PASSES the chokepoint and reaches the handler", async () => {
    const dispatch = await getDispatch();
    const result = await dispatch("orchestrate.replay", { runId: RUN_ID });
    expect(result).toEqual({ stdout: "RECORDED-STDOUT" });
    // No deny-by-origin audit fired for the operator-origin call.
    expect(capturedAudits().filter((a) => a.kind === "capability_denied")).toHaveLength(0);
  });
});
