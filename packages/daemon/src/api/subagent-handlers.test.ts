// SPDX-License-Identifier: Apache-2.0
import { createConversationRef, type ConversationLocator } from "@comis/core";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSubagentHandlers, type SubagentHandlerDeps } from "./subagent-handlers.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const CALLER_SCOPE = {
  tenantId: "default",
  agentId: "parent-agent",
  partition: { kind: "principal" as const, principalId: "user1" },
};

function makeCallerConversation(
  overrides: Partial<typeof CALLER_SCOPE> = {},
): ConversationLocator {
  const conversationScope = { ...CALLER_SCOPE, ...overrides };
  const reference = createConversationRef(conversationScope);
  if (!reference.ok) throw reference.error;
  return { conversationScope, conversationRef: reference.value };
}

function createMockDeps(): SubagentHandlerDeps {
  const callerConversation = makeCallerConversation();
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
        callerAgentId: "parent-agent",
        callerConversation,
      }),
      listRuns: vi.fn().mockReturnValue([
        {
          runId: "run-1",
          status: "running",
          agentId: "researcher",
          task: "research AI",
          sessionKey: "default:sub-agent-run-1:sub-agent:run-1",
          startedAt: Date.now() - 5_000,
          callerAgentId: "parent-agent",
          callerConversation,
        },
        {
          runId: "run-2",
          status: "completed",
          agentId: "coder",
          task: "write tests",
          sessionKey: "default:sub-agent-run-2:sub-agent:run-2",
          startedAt: Date.now() - 60_000,
          completedAt: Date.now() - 30_000,
          callerAgentId: "other-agent",
        },
        {
          runId: "run-3",
          status: "running",
          agentId: "researcher",
          task: "same agent, different conversation",
          sessionKey: "default:sub-agent-run-3:sub-agent:run-3",
          startedAt: Date.now() - 1_000,
          callerAgentId: "parent-agent",
          callerConversation: makeCallerConversation({
            partition: { kind: "principal", principalId: "user2" },
          } as never),
        },
      ]),
      waitForCompletions: vi.fn().mockResolvedValue([]),
      killRun: vi.fn().mockReturnValue({ killed: true }),
      steerRun: vi.fn().mockResolvedValue({ steered: true, mode: "steer" }),
      pauseSpawns: vi.fn().mockReturnValue({
        paused: true, acceptingSpawns: true, changed: true, resetsOnRestart: true,
      }),
      resumeSpawns: vi.fn().mockReturnValue({
        paused: false, acceptingSpawns: true, changed: true, resetsOnRestart: true,
      }),
      spawnAdmissionStatus: vi.fn().mockReturnValue({
        paused: false, acceptingSpawns: true, resetsOnRestart: true,
      }),
      shutdown: vi.fn(),
    },
    defaultAgentId: "default",
    tenantId: "default",
    // securityConfig.agentToAgent.steerInject gates the steer handler
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

function createAdminHandlers(
  deps: SubagentHandlerDeps,
): Record<string, (params: Record<string, unknown>) => Promise<unknown>> {
  const rawHandlers = createSubagentHandlers(deps);
  return Object.fromEntries(Object.entries(rawHandlers).map(([method, handler]) => [
    method,
    (params: Record<string, unknown>) => handler({ _trustLevel: "admin", ...params }),
  ]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSubagentHandlers", () => {
  let deps: SubagentHandlerDeps;
  let handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>>;

  beforeEach(() => {
    deps = createMockDeps();
    handlers = createAdminHandlers(deps);
  });

  it("agent controllers list only exact direct children through a content-free projection", async () => {
    const result = await handlers["subagent.list"]!({
      _agentId: "parent-agent",
      _callerConversationScope: {
        tenantId: "default",
        agentId: "parent-agent",
        partition: { kind: "principal", principalId: "user1" },
      },
    }) as { runs: Array<Record<string, unknown>>; total: number };

    expect(result.total).toBe(1);
    expect(result.runs[0]).toMatchObject({ runId: "run-1", agentId: "researcher", status: "running" });
    expect(result.runs[0]).not.toHaveProperty("task");
    expect(result.runs[0]).not.toHaveProperty("result");
    expect(result.runs[0]).not.toHaveProperty("error");
  });

  it("agent controllers cannot distinguish a foreign target from an unknown target", async () => {
    vi.mocked(deps.subAgentRunner.getRunStatus).mockImplementation((runId) => runId === "foreign"
      ? ({
          runId,
          status: "running",
          agentId: "researcher",
          callerAgentId: "other-agent",
          task: "private task",
        } as never)
      : undefined);
    const authority = {
      _agentId: "parent-agent",
      _callerConversationScope: {
        tenantId: "default",
        agentId: "parent-agent",
        partition: { kind: "principal", principalId: "user1" },
      },
    };

    await expect(handlers["subagent.kill"]!({ ...authority, target: "foreign" }))
      .rejects.toThrow("Sub-agent target is unavailable");
    await expect(handlers["subagent.kill"]!({ ...authority, target: "missing" }))
      .rejects.toThrow("Sub-agent target is unavailable");
    expect(deps.subAgentRunner.killRun).not.toHaveBeenCalled();
  });

  it("agent wait defaults to active exact direct children", async () => {
    vi.mocked(deps.subAgentRunner.waitForCompletions).mockResolvedValue([{
      runId: "run-1",
      status: "completed",
      completion: { endReason: "completed", completedAtMs: 123, summary: "done" },
    }]);

    const result = await handlers["subagent.wait"]!({
      _agentId: "parent-agent",
      _callerConversationScope: CALLER_SCOPE,
    });

    expect(deps.subAgentRunner.waitForCompletions).toHaveBeenCalledWith(
      ["run-1"],
      30_000,
      undefined,
    );
    expect(result).toEqual({
      results: [{
        runId: "run-1",
        status: "completed",
        completion: { endReason: "completed", completedAtMs: 123, summary: "done" },
      }],
    });
  });

  it("agent wait returns indistinguishable denied outcomes without waiting on foreign or missing ids", async () => {
    const callerConversation = makeCallerConversation();
    vi.mocked(deps.subAgentRunner.getRunStatus).mockImplementation((runId) => {
      if (runId === "owned") {
        return {
          runId,
          status: "running",
          agentId: "researcher",
          callerAgentId: "parent-agent",
          callerConversation,
        } as never;
      }
      if (runId === "foreign") {
        return {
          runId,
          status: "running",
          agentId: "researcher",
          callerAgentId: "other-agent",
        } as never;
      }
      return undefined;
    });
    vi.mocked(deps.subAgentRunner.waitForCompletions).mockResolvedValue([{
      runId: "owned",
      status: "timeout",
    }]);

    const result = await handlers["subagent.wait"]!({
      _agentId: "parent-agent",
      _callerConversationScope: CALLER_SCOPE,
      runIds: ["owned", "foreign", "missing"],
      timeoutMs: 25,
    });

    expect(deps.subAgentRunner.waitForCompletions).toHaveBeenCalledWith(
      ["owned"],
      25,
      undefined,
    );
    expect(result).toEqual({
      results: [
        { runId: "owned", status: "timeout" },
        { runId: "foreign", status: "denied_unknown" },
        { runId: "missing", status: "denied_unknown" },
      ],
    });
  });

  it("wait forwards the trusted in-process cancellation signal", async () => {
    const controller = new AbortController();
    vi.mocked(deps.subAgentRunner.waitForCompletions).mockResolvedValue([{
      runId: "run-1",
      status: "cancelled",
    }]);

    await handlers["subagent.wait"]!({
      _agentId: "parent-agent",
      _callerConversationScope: CALLER_SCOPE,
      runIds: ["run-1"],
      _abortSignal: controller.signal,
    });

    expect(deps.subAgentRunner.waitForCompletions).toHaveBeenCalledWith(
      ["run-1"],
      30_000,
      controller.signal,
    );
  });

  it("invalid agent-origin authority never falls back to an injected admin trust value", async () => {
    await expect(handlers["subagent.list"]!({
      _agentId: "parent-agent",
      _callerConversationScope: { forged: true },
      _trustLevel: "admin",
    })).rejects.toThrow("Sub-agent controller authority is invalid");
    expect(deps.subAgentRunner.listRuns).not.toHaveBeenCalled();
  });

  it("partial agent-origin correlation fields never fall back to operator authority", async () => {
    await expect(handlers["subagent.list"]!({
      _rootRunId: "root-run-1",
      _trustLevel: "admin",
    })).rejects.toThrow("Sub-agent controller authority is invalid");
    expect(deps.subAgentRunner.listRuns).not.toHaveBeenCalled();
  });

  it("operator list selectors filter by exact agent and spawn tree", async () => {
    vi.mocked(deps.subAgentRunner.listRuns).mockReturnValue([
      { runId: "run-a", agentId: "researcher", rootRunId: "root-a", status: "running" },
      { runId: "run-b", agentId: "researcher", rootRunId: "root-b", status: "running" },
      { runId: "run-c", agentId: "coder", rootRunId: "root-a", status: "running" },
    ] as never);

    const result = await handlers["subagent.list"]!({
      agentId: "researcher",
      rootRunId: "root-a",
    }) as { runs: Array<{ runId: string }>; total: number };

    expect(result).toEqual({
      runs: [expect.objectContaining({ runId: "run-a" })],
      total: 1,
    });
  });

  it("admin callers pause, inspect, and resume the process-lifetime spawn gate", async () => {
    await expect(handlers["subagent.pause"]!({})).resolves.toMatchObject({ paused: true, changed: true });
    await expect(handlers["subagent.status"]!({})).resolves.toEqual({
      paused: false,
      acceptingSpawns: true,
      resetsOnRestart: true,
    });
    await expect(handlers["subagent.resume"]!({})).resolves.toMatchObject({ paused: false, changed: true });
    expect(deps.subAgentRunner.pauseSpawns).toHaveBeenCalledOnce();
    expect(deps.subAgentRunner.spawnAdmissionStatus).toHaveBeenCalledOnce();
    expect(deps.subAgentRunner.resumeSpawns).toHaveBeenCalledOnce();
  });

  it("agent-origin callers cannot operate the global spawn gate even with admin trust", async () => {
    const rawHandlers = createSubagentHandlers(deps);
    await expect(rawHandlers["subagent.pause"]!({
      _agentId: "parent-agent",
      _callerConversationScope: CALLER_SCOPE,
      _trustLevel: "admin",
    })).rejects.toThrow("Sub-agent spawn admission control requires operator authority");
    expect(deps.subAgentRunner.pauseSpawns).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // subagent.list
  // -------------------------------------------------------------------------

  it("subagent.list returns runs from listRuns with recentMinutes param", async () => {
    const result = await handlers["subagent.list"]!({ recentMinutes: 60 });

    expect(deps.subAgentRunner.listRuns).toHaveBeenCalledWith(60);
    const r = result as { runs: unknown[]; total: number };
    expect(r.runs).toHaveLength(3);
    expect(r.total).toBe(3);
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
      _callerConversationScope: CALLER_SCOPE,
    });

    expect(deps.subAgentRunner.killRun).toHaveBeenCalledWith("run-1");
    expect(deps.subAgentRunner.getRunStatus).toHaveBeenCalledWith("run-1");
    expect(deps.subAgentRunner.spawn).toHaveBeenCalledWith({
      task: expect.stringMatching(/new task description/),
      agentId: "researcher",
      callerType: "agent",
      callerSessionKey: "default:user1:channel1",
      callerAgentId: "parent-agent",
      callerConversation: makeCallerConversation(),
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
  // Flag-gated inject branch (security.agentToAgent.steerInject)
  // -------------------------------------------------------------------------

  // NOTE: the 2s rate-limit map (`steerTimestamps`) is module-level and SHARED
  // across every handler instance + test in this file, so each steer test below
  // uses a DISTINCT target id (mirroring the existing "run-rate-test" pattern)
  // to avoid cross-test rate-limit collisions.

  describe("steer flag-OFF is byte-identical kill+respawn (the load-bearing golden)", () => {
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
        callerAgentId: "parent-agent",
        callerConversation: makeCallerConversation(),
      } as ReturnType<typeof deps.subAgentRunner.getRunStatus>);
      handlers = createAdminHandlers(deps);

      const result = await handlers["subagent.steer"]!({
        target: "run-off",
        message: "new task description",
        _callerSessionKey: "default:user1:channel1",
        _agentId: "parent-agent",
        _callerConversationScope: CALLER_SCOPE,
      });

      // Byte-identical to the existing :120 golden: killRun → getRunStatus → spawn.
      expect(deps.subAgentRunner.killRun).toHaveBeenCalledWith("run-off");
      expect(deps.subAgentRunner.getRunStatus).toHaveBeenCalledWith("run-off");
      expect(deps.subAgentRunner.spawn).toHaveBeenCalledWith({
        task: expect.stringMatching(/new task description/),
        agentId: "researcher",
        callerType: "agent",
        callerSessionKey: "default:user1:channel1",
        callerAgentId: "parent-agent",
        callerConversation: makeCallerConversation(),
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

  describe("steer flag-ON injects into the live child", () => {
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
      handlers = createAdminHandlers(deps);
    });

    it("calls getRunStatus + steerRun (NOT killRun/spawn), emits subagent:steered, returns {status:'steered_inject', runId}", async () => {
      mockRunningRun("run-inj");
      vi.mocked(deps.subAgentRunner.steerRun).mockResolvedValue({ steered: true, mode: "steer" });

      const result = await handlers["subagent.steer"]!({
        target: "run-inj",
        message: "adjust the approach",
      });

      expect(deps.subAgentRunner.getRunStatus).toHaveBeenCalledWith("run-inj");
      expect(deps.subAgentRunner.steerRun).toHaveBeenCalledWith(
        "run-inj",
        expect.stringMatching(/adjust the approach/),
      );
      const framedMessage = vi.mocked(deps.subAgentRunner.steerRun).mock.calls[0]![1];
      expect(framedMessage).not.toBe("adjust the approach");
      expect(framedMessage).toMatch(/<<<UNTRUSTED_/);
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

    // The inject-failure branch is a path an operator
    // must diagnose, so before the throw it must log a WARN carrying an
    // operator-actionable hint + errorKind (the success branch already logs INFO
    // + emits an event; failure had only the raw thrown string).
    it("on steerRun failure, logs a WARN with an actionable hint + errorKind before throwing (does NOT leak the message body)", async () => {
      mockRunningRun("run-warn");
      vi.mocked(deps.subAgentRunner.steerRun).mockResolvedValue({
        steered: false,
        error: "No live session for run run-warn — cannot inject (use kill, or the run is not running).",
      });

      await expect(
        handlers["subagent.steer"]!({ target: "run-warn", message: "secret steer body" }),
      ).rejects.toThrow("No live session for run run-warn");

      expect(deps.logger!.warn).toHaveBeenCalledTimes(1);
      const [obj, msg] = vi.mocked(deps.logger!.warn).mock.calls[0]!;
      expect(obj).toMatchObject({
        runId: "run-warn",
        agentId: "researcher",
        errorKind: "precondition",
      });
      expect((obj as { hint?: unknown }).hint).toEqual(expect.stringMatching(/subagent\.list|kill\+respawn|live/i));
      expect(typeof msg).toBe("string");
      // No leak of the steer message body into the WARN.
      expect(JSON.stringify({ obj, msg })).not.toContain("secret steer body");
    });

    it("throws 'Unknown run ID' when getRunStatus returns undefined (flag-on)", async () => {
      vi.mocked(deps.subAgentRunner.getRunStatus).mockReturnValue(undefined);

      await expect(
        handlers["subagent.steer"]!({ target: "run-ghost", message: "adjust" }),
      ).rejects.toThrow("Unknown run ID: run-ghost");
      expect(deps.subAgentRunner.steerRun).not.toHaveBeenCalled();
    });

    // The inject path must mirror killRun's status guard.
    // getRunStatus returns a run for ANY status inside the retention window, so a
    // completed/failed/queued target would otherwise proceed to steerRun, find no
    // live handle, and throw the generic "No live session" — a worse, less
    // actionable error than kill's "is not running (status: X)".
    it.each(["completed", "failed", "queued"] as const)(
      "throws an actionable status error (not the generic 'No live session') for a %s run, and does NOT call steerRun",
      async (status) => {
        vi.mocked(deps.subAgentRunner.getRunStatus).mockReturnValue({
          runId: `run-${status}`,
          status,
          agentId: "researcher",
          task: "t",
          sessionKey: `default:sub-agent-run-${status}:sub-agent:run-${status}`,
          startedAt: Date.now() - 5_000,
          ...(status === "completed" || status === "failed"
            ? { completedAt: Date.now() }
            : {}),
        } as ReturnType<typeof deps.subAgentRunner.getRunStatus>);

        await expect(
          handlers["subagent.steer"]!({ target: `run-${status}`, message: "adjust" }),
        ).rejects.toThrow(
          `Run run-${status} is not running (status: ${status}) — cannot steer; use kill+respawn instead.`,
        );

        // The inject mechanism must NOT run for a non-running target.
        expect(deps.subAgentRunner.steerRun).not.toHaveBeenCalled();
        expect(deps.subAgentRunner.killRun).not.toHaveBeenCalled();
        expect(deps.subAgentRunner.spawn).not.toHaveBeenCalled();
        expect(deps.eventBus!.emit).not.toHaveBeenCalled();
      },
    );
  });

  describe("the steer 2s rate limit is shared across both flag settings", () => {
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
      handlers = createAdminHandlers(deps);

      await handlers["subagent.steer"]!({ target: "run-rl", message: "first" });

      await expect(
        handlers["subagent.steer"]!({ target: "run-rl", message: "second" }),
      ).rejects.toThrow("Rate limited: wait 2s between steers to same target");
    });

    it("keys the limit by controller and target so operator activity cannot throttle the owner", async () => {
      deps.securityConfig = { agentToAgent: { waitTimeoutMs: 30_000, steerInject: true } };
      vi.mocked(deps.subAgentRunner.getRunStatus).mockReturnValue({
        runId: "run-controller-key",
        status: "running",
        agentId: "researcher",
        task: "t",
        sessionKey: "default:sub-agent-run-controller-key:sub-agent:run-controller-key",
        startedAt: Date.now(),
        callerAgentId: "parent-agent",
        callerConversation: makeCallerConversation(),
      } as ReturnType<typeof deps.subAgentRunner.getRunStatus>);
      vi.mocked(deps.subAgentRunner.steerRun).mockResolvedValue({ steered: true, mode: "steer" });
      const rawHandlers = createSubagentHandlers(deps);

      await rawHandlers["subagent.steer"]!({
        _trustLevel: "admin",
        target: "run-controller-key",
        message: "operator steer",
      });
      await rawHandlers["subagent.steer"]!({
        _agentId: "parent-agent",
        _callerConversationScope: CALLER_SCOPE,
        target: "run-controller-key",
        message: "owner steer",
      });

      expect(deps.subAgentRunner.steerRun).toHaveBeenCalledTimes(2);
    });
  });

  describe("kill ≠ steer: subagent.kill is unchanged on both flag settings", () => {
    it("subagent.kill calls killRun and returns {killed, runId} with steerInject:false", async () => {
      deps.securityConfig = { agentToAgent: { waitTimeoutMs: 30_000, steerInject: false } };
      handlers = createAdminHandlers(deps);

      const result = await handlers["subagent.kill"]!({ target: "run-1" });

      expect(deps.subAgentRunner.killRun).toHaveBeenCalledWith("run-1");
      expect(deps.subAgentRunner.steerRun).not.toHaveBeenCalled();
      expect(result).toEqual({ killed: true, runId: "run-1" });
    });

    it("subagent.kill calls killRun and returns {killed, runId} with steerInject:true", async () => {
      deps.securityConfig = { agentToAgent: { waitTimeoutMs: 30_000, steerInject: true } };
      handlers = createAdminHandlers(deps);

      const result = await handlers["subagent.kill"]!({ target: "run-1" });

      expect(deps.subAgentRunner.killRun).toHaveBeenCalledWith("run-1");
      expect(deps.subAgentRunner.steerRun).not.toHaveBeenCalled();
      expect(result).toEqual({ killed: true, runId: "run-1" });
    });
  });
});
