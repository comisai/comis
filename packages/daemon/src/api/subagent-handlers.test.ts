// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSubagentHandlers, type SubagentHandlerDeps } from "./subagent-handlers.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockDeps(): SubagentHandlerDeps {
  return {
    subAgentRunner: {
      spawn: vi.fn().mockReturnValue("new-run-id"),
      getRunStatus: vi.fn().mockReturnValue({
        runId: "run-1",
        status: "failed",
        agentId: "researcher",
        task: "old task",
        sessionKey: "default:sub-agent-run-1:sub-agent:run-1",
        startedAt: Date.now() - 10_000,
        completedAt: Date.now(),
        error: "Killed by parent agent",
      }),
      listRuns: vi.fn().mockReturnValue([
        {
          runId: "run-1",
          status: "running",
          agentId: "researcher",
          task: "research AI",
          sessionKey: "default:sub-agent-run-1:sub-agent:run-1",
          startedAt: Date.now() - 5_000,
        },
        {
          runId: "run-2",
          status: "completed",
          agentId: "coder",
          task: "write tests",
          sessionKey: "default:sub-agent-run-2:sub-agent:run-2",
          startedAt: Date.now() - 60_000,
          completedAt: Date.now() - 30_000,
        },
      ]),
      killRun: vi.fn().mockReturnValue({ killed: true }),
      steerRun: vi.fn().mockResolvedValue({ steered: true, mode: "steer" }),
      shutdown: vi.fn(),
    },
    defaultAgentId: "default",
    tenantId: "default",
    // STEER-01: securityConfig.agentToAgent.steerInject gates the steer handler
    // (flag-on inject / flag-off byte-identical kill+respawn). Default the flag
    // OFF here — individual tests flip it on.
    securityConfig: { agentToAgent: { waitTimeoutMs: 30_000, steerInject: false } },
    eventBus: { emit: vi.fn() },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSubagentHandlers", () => {
  let deps: SubagentHandlerDeps;
  let handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>>;

  beforeEach(() => {
    deps = createMockDeps();
    handlers = createSubagentHandlers(deps);
  });

  // -------------------------------------------------------------------------
  // subagent.list
  // -------------------------------------------------------------------------

  it("subagent.list returns runs from listRuns with recentMinutes param", async () => {
    const result = await handlers["subagent.list"]!({ recentMinutes: 60 });

    expect(deps.subAgentRunner.listRuns).toHaveBeenCalledWith(60);
    const r = result as { runs: unknown[]; total: number };
    expect(r.runs).toHaveLength(2);
    expect(r.total).toBe(2);
  });

  it("subagent.list defaults recentMinutes to 30", async () => {
    await handlers["subagent.list"]!({});

    expect(deps.subAgentRunner.listRuns).toHaveBeenCalledWith(30);
  });

  // -------------------------------------------------------------------------
  // subagent.kill
  // -------------------------------------------------------------------------

  it("subagent.kill calls killRun and returns success", async () => {
    const result = await handlers["subagent.kill"]!({ target: "run-1" });

    expect(deps.subAgentRunner.killRun).toHaveBeenCalledWith("run-1");
    const r = result as { killed: boolean; runId: string };
    expect(r.killed).toBe(true);
    expect(r.runId).toBe("run-1");
  });

  it("subagent.kill throws when run not found", async () => {
    vi.mocked(deps.subAgentRunner.killRun).mockReturnValue({
      killed: false,
      error: "Unknown run ID: bad-id",
    });

    await expect(
      handlers["subagent.kill"]!({ target: "bad-id" }),
    ).rejects.toThrow("Unknown run ID: bad-id");
  });

  it("subagent.kill throws when target missing", async () => {
    await expect(
      handlers["subagent.kill"]!({}),
    ).rejects.toThrow("Missing required parameter: target");
  });

  // -------------------------------------------------------------------------
  // subagent.steer
  // -------------------------------------------------------------------------

  it("subagent.steer kills then respawns with new task", async () => {
    const result = await handlers["subagent.steer"]!({
      target: "run-1",
      message: "new task description",
      _callerSessionKey: "default:user1:channel1",
      _agentId: "parent-agent",
    });

    expect(deps.subAgentRunner.killRun).toHaveBeenCalledWith("run-1");
    expect(deps.subAgentRunner.getRunStatus).toHaveBeenCalledWith("run-1");
    expect(deps.subAgentRunner.spawn).toHaveBeenCalledWith({
      task: "new task description",
      agentId: "researcher",
      callerSessionKey: "default:user1:channel1",
      callerAgentId: "parent-agent",
    });

    const r = result as { status: string; oldRunId: string; newRunId: string };
    expect(r.status).toBe("steered");
    expect(r.oldRunId).toBe("run-1");
    expect(r.newRunId).toBe("new-run-id");
  });

  it("subagent.steer rate limits at 2s per target", async () => {
    // First steer should succeed
    await handlers["subagent.steer"]!({
      target: "run-rate-test",
      message: "task 1",
    });

    // Second immediate steer to same target should be rate limited
    // Need fresh killRun mock for the second call
    vi.mocked(deps.subAgentRunner.killRun).mockReturnValue({ killed: true });

    await expect(
      handlers["subagent.steer"]!({
        target: "run-rate-test",
        message: "task 2",
      }),
    ).rejects.toThrow("Rate limited: wait 2s between steers to same target");
  });

  it("subagent.steer throws when kill fails", async () => {
    vi.mocked(deps.subAgentRunner.killRun).mockReturnValue({
      killed: false,
      error: "Run steer-fail is not running (status: completed)",
    });

    await expect(
      handlers["subagent.steer"]!({
        target: "steer-fail",
        message: "new task",
      }),
    ).rejects.toThrow("Run steer-fail is not running (status: completed)");
  });

  it("subagent.steer throws when target missing", async () => {
    await expect(
      handlers["subagent.steer"]!({ message: "new task" }),
    ).rejects.toThrow("Missing required parameter: target");
  });

  it("subagent.steer throws when message missing", async () => {
    await expect(
      handlers["subagent.steer"]!({ target: "run-1" }),
    ).rejects.toThrow("Missing required parameter: message");
  });

  // -------------------------------------------------------------------------
  // STEER-01: flag-gated inject branch (security.agentToAgent.steerInject)
  // -------------------------------------------------------------------------

  // NOTE: the 2s rate-limit map (`steerTimestamps`) is module-level and SHARED
  // across every handler instance + test in this file, so each steer test below
  // uses a DISTINCT target id (mirroring the existing "run-rate-test" pattern)
  // to avoid cross-test rate-limit collisions.

  describe("STEER-01 — flag-OFF is byte-identical kill+respawn (the load-bearing golden)", () => {
    it("with steerInject:false, subagent.steer kills+respawns and returns {status:'steered', oldRunId, newRunId} EXACTLY as today", async () => {
      deps.securityConfig = { agentToAgent: { waitTimeoutMs: 30_000, steerInject: false } };
      vi.mocked(deps.subAgentRunner.getRunStatus).mockReturnValue({
        runId: "run-off",
        status: "failed",
        agentId: "researcher",
        task: "old task",
        sessionKey: "default:sub-agent-run-off:sub-agent:run-off",
        startedAt: Date.now() - 10_000,
        completedAt: Date.now(),
        error: "Killed by parent agent",
      } as ReturnType<typeof deps.subAgentRunner.getRunStatus>);
      handlers = createSubagentHandlers(deps);

      const result = await handlers["subagent.steer"]!({
        target: "run-off",
        message: "new task description",
        _callerSessionKey: "default:user1:channel1",
        _agentId: "parent-agent",
      });

      // Byte-identical to the existing :120 golden: killRun → getRunStatus → spawn.
      expect(deps.subAgentRunner.killRun).toHaveBeenCalledWith("run-off");
      expect(deps.subAgentRunner.getRunStatus).toHaveBeenCalledWith("run-off");
      expect(deps.subAgentRunner.spawn).toHaveBeenCalledWith({
        task: "new task description",
        agentId: "researcher",
        callerSessionKey: "default:user1:channel1",
        callerAgentId: "parent-agent",
      });
      // steerRun (the inject mechanism) must NOT run on the flag-off path.
      expect(deps.subAgentRunner.steerRun).not.toHaveBeenCalled();
      // Same log line as today.
      expect(deps.logger!.info).toHaveBeenCalledWith(
        { oldRunId: "run-off", newRunId: "new-run-id", agentId: "researcher" },
        "Sub-agent steered to new task",
      );
      // EXACT response shape.
      expect(result).toEqual({ status: "steered", oldRunId: "run-off", newRunId: "new-run-id" });
    });
  });

  describe("STEER-01 — flag-ON injects into the live child", () => {
    /** A RUNNING run for the inject path (it is NOT killed). */
    function mockRunningRun(runId: string): void {
      vi.mocked(deps.subAgentRunner.getRunStatus).mockReturnValue({
        runId,
        status: "running",
        agentId: "researcher",
        task: "research AI",
        sessionKey: `default:sub-agent-${runId}:sub-agent:${runId}`,
        startedAt: Date.now() - 5_000,
      } as ReturnType<typeof deps.subAgentRunner.getRunStatus>);
    }

    beforeEach(() => {
      deps.securityConfig = { agentToAgent: { waitTimeoutMs: 30_000, steerInject: true } };
      handlers = createSubagentHandlers(deps);
    });

    it("calls getRunStatus + steerRun (NOT killRun/spawn), emits subagent:steered, returns {status:'steered_inject', runId}", async () => {
      mockRunningRun("run-inj");
      vi.mocked(deps.subAgentRunner.steerRun).mockResolvedValue({ steered: true, mode: "steer" });

      const result = await handlers["subagent.steer"]!({
        target: "run-inj",
        message: "adjust the approach",
      });

      expect(deps.subAgentRunner.getRunStatus).toHaveBeenCalledWith("run-inj");
      expect(deps.subAgentRunner.steerRun).toHaveBeenCalledWith("run-inj", "adjust the approach");
      // NO kill, NO respawn on the inject path.
      expect(deps.subAgentRunner.killRun).not.toHaveBeenCalled();
      expect(deps.subAgentRunner.spawn).not.toHaveBeenCalled();
      expect(result).toEqual({ status: "steered_inject", runId: "run-inj" });

      // Emits subagent:steered with runId/agentId/mode/timestamp — and NO message body.
      expect(deps.eventBus!.emit).toHaveBeenCalledTimes(1);
      const [eventName, payload] = vi.mocked(deps.eventBus!.emit).mock.calls[0]!;
      expect(eventName).toBe("subagent:steered");
      expect(payload).toMatchObject({ runId: "run-inj", agentId: "researcher", mode: "steer" });
      expect(typeof (payload as { timestamp: unknown }).timestamp).toBe("number");
      // No leak of the steer message body.
      expect(payload).not.toHaveProperty("message");
      expect(payload).not.toHaveProperty("text");
      expect(JSON.stringify(payload)).not.toContain("adjust the approach");
    });

    it("when steerRun returns {steered:false, error}, the handler throws the error and does NOT fall back to kill/respawn", async () => {
      mockRunningRun("run-nohandle");
      vi.mocked(deps.subAgentRunner.steerRun).mockResolvedValue({
        steered: false,
        error: "No live session for run run-nohandle — cannot inject (use kill, or the run is not running).",
      });

      await expect(
        handlers["subagent.steer"]!({ target: "run-nohandle", message: "adjust" }),
      ).rejects.toThrow("No live session for run run-nohandle");

      // kill is a distinct explicit action — the inject branch never respawns.
      expect(deps.subAgentRunner.killRun).not.toHaveBeenCalled();
      expect(deps.subAgentRunner.spawn).not.toHaveBeenCalled();
      expect(deps.eventBus!.emit).not.toHaveBeenCalled();
    });

    it("throws 'Unknown run ID' when getRunStatus returns undefined (flag-on)", async () => {
      vi.mocked(deps.subAgentRunner.getRunStatus).mockReturnValue(undefined);

      await expect(
        handlers["subagent.steer"]!({ target: "run-ghost", message: "adjust" }),
      ).rejects.toThrow("Unknown run ID: run-ghost");
      expect(deps.subAgentRunner.steerRun).not.toHaveBeenCalled();
    });
  });

  describe("STEER-01 — the 2s rate limit is shared across both flag settings", () => {
    it("rate-limits a second steer to the same target within 2s regardless of the flag (flag ON)", async () => {
      deps.securityConfig = { agentToAgent: { waitTimeoutMs: 30_000, steerInject: true } };
      vi.mocked(deps.subAgentRunner.getRunStatus).mockReturnValue({
        runId: "run-rl",
        status: "running",
        agentId: "researcher",
        task: "t",
        sessionKey: "default:sub-agent-run-rl:sub-agent:run-rl",
        startedAt: Date.now(),
      } as ReturnType<typeof deps.subAgentRunner.getRunStatus>);
      vi.mocked(deps.subAgentRunner.steerRun).mockResolvedValue({ steered: true, mode: "steer" });
      handlers = createSubagentHandlers(deps);

      await handlers["subagent.steer"]!({ target: "run-rl", message: "first" });

      await expect(
        handlers["subagent.steer"]!({ target: "run-rl", message: "second" }),
      ).rejects.toThrow("Rate limited: wait 2s between steers to same target");
    });
  });

  describe("STEER-01 — kill ≠ steer: subagent.kill is unchanged on both flag settings", () => {
    it("subagent.kill calls killRun and returns {killed, runId} with steerInject:false", async () => {
      deps.securityConfig = { agentToAgent: { waitTimeoutMs: 30_000, steerInject: false } };
      handlers = createSubagentHandlers(deps);

      const result = await handlers["subagent.kill"]!({ target: "run-1" });

      expect(deps.subAgentRunner.killRun).toHaveBeenCalledWith("run-1");
      expect(deps.subAgentRunner.steerRun).not.toHaveBeenCalled();
      expect(result).toEqual({ killed: true, runId: "run-1" });
    });

    it("subagent.kill calls killRun and returns {killed, runId} with steerInject:true", async () => {
      deps.securityConfig = { agentToAgent: { waitTimeoutMs: 30_000, steerInject: true } };
      handlers = createSubagentHandlers(deps);

      const result = await handlers["subagent.kill"]!({ target: "run-1" });

      expect(deps.subAgentRunner.killRun).toHaveBeenCalledWith("run-1");
      expect(deps.subAgentRunner.steerRun).not.toHaveBeenCalled();
      expect(result).toEqual({ killed: true, runId: "run-1" });
    });
  });
});
