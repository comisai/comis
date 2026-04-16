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
      shutdown: vi.fn(),
    },
    defaultAgentId: "default",
    tenantId: "default",
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
});
