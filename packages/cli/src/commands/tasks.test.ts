// SPDX-License-Identifier: Apache-2.0
/** Behavior tests for strict RPC-backed follow-up task operator commands. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TasksCancelContract,
  TasksListContract,
  TasksResetContract,
  TasksStatusContract,
} from "@comis/core";
import type { RpcClient } from "../client/rpc-client.js";
import {
  createConsoleSpy,
  createProcessExitSpy,
  createTestProgram,
  getSpyOutput,
} from "../test-helpers.js";

vi.mock("../client/rpc-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/rpc-client.js")>();
  return { ...actual, withClient: vi.fn() };
});
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

const { registerTasksCommand } = await import("./tasks.js");
const { withClient } = await import("../client/rpc-client.js");

function makeClient(response: unknown) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client: RpcClient = {
    async call(method, params) {
      calls.push({ method, params });
      return response;
    },
    close() {},
    onNotification() {},
  };
  return { client, calls };
}

describe("comis tasks strict operator commands", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });
  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  async function run(args: string[]): Promise<void> {
    const program = createTestProgram();
    registerTasksCommand(program);
    await program.parseAsync(["node", "comis", "tasks", ...args]);
  }

  it("registers status list and guarded cancellation over typed RPC only", () => {
    const program = createTestProgram();
    registerTasksCommand(program);
    const tasks = program.commands.find((command) => command.name() === "tasks");
    expect(tasks?.commands.map((command) => command.name())).toEqual(["status", "list", "cancel", "reset"]);
    expect(tasks?.commands.find((command) => command.name() === "cancel")?.options.map((option) => option.long))
      .toEqual(expect.arrayContaining(["--agent", "--all-pending", "--confirm", "--format"]));
  });

  it("renders content-free status from tasks.status", async () => {
    const response = {
      resolvedAgentId: "agent-a",
      configuredEnabled: false,
      state: "disabled" as const,
      strictAuthorityValid: true,
      ownershipReconciled: true,
      store: { exists: true, bytes: 66, digest: "a".repeat(64) },
      intent: { status: "none" as const },
      counts: { total: 0, pending: 0, active: 0, terminal: 0 },
    };
    const data = makeClient(response);
    vi.mocked(withClient).mockImplementation(async (fn) => fn(data.client));

    await run(["status", "--agent", "agent-a"]);

    expect(data.calls).toEqual([{ method: TasksStatusContract.method, params: { agentId: "agent-a" } }]);
    expect(getSpyOutput(consoleSpy.log)).toContain("disabled");
    expect(getSpyOutput(consoleSpy.log)).toContain("a".repeat(64));
  });

  it("lists bounded content-free task projections through tasks.list", async () => {
    const response = {
      resolvedAgentId: "agent-a",
      fileDigest: "b".repeat(64),
      tasks: [{
        id: "task-a",
        agentId: "agent-a",
        status: "pending" as const,
        dueEarliestMs: 1_000,
        dueLatestMs: 2_000,
        expiresAtMs: 3_000,
        attemptCount: 0,
        preAcceptanceFailureCount: 0,
        sourceExecutionId: "execution-a",
        sourceOccurrenceCount: 1,
        conversationRef: `cv_${"c".repeat(43)}`,
      }],
    };
    const data = makeClient(response);
    vi.mocked(withClient).mockImplementation(async (fn) => fn(data.client));

    await run(["list", "--agent", "agent-a", "--status", "pending", "--limit", "10"]);

    expect(data.calls).toEqual([{
      method: TasksListContract.method,
      params: { agentId: "agent-a", status: "pending", limit: 10 },
    }]);
    expect(getSpyOutput(consoleSpy.log)).toContain("task-a");
    expect(getSpyOutput(consoleSpy.log)).not.toContain("task text");
  });

  it("requires explicit confirmation before cancelling all pending tasks", async () => {
    const response = {
      outcome: { status: "cancelled" as const, taskIds: ["task-a"], activeTaskIds: [] },
      scheduleRescan: "not_required" as const,
    };
    const data = makeClient(response);
    vi.mocked(withClient).mockImplementation(async (fn) => fn(data.client));

    await expect(run(["cancel", "--all-pending", "--agent", "agent-a"])).rejects.toThrow("process.exit called");
    expect(data.calls).toEqual([]);

    await run(["cancel", "--all-pending", "--confirm", "--agent", "agent-a", "--format", "json"]);
    expect(data.calls).toEqual([{
      method: TasksCancelContract.method,
      params: { allPending: true, agentId: "agent-a" },
    }]);
    expect(JSON.parse(getSpyOutput(consoleSpy.log))).toEqual(response);
  });

  it("requires explicit confirmation and expected raw digest for task reset", async () => {
    const response = {
      resolvedAgentId: "agent-a",
      operationId: "reset-a",
      beforeDigest: "a".repeat(64),
      afterDigest: "b".repeat(64),
      state: "disabled" as const,
      reinitialized: true as const,
    };
    const data = makeClient(response);
    vi.mocked(withClient).mockImplementation(async (fn) => fn(data.client));

    await expect(run(["reset", "--expected-digest", "a".repeat(64), "--agent", "agent-a"]))
      .rejects.toThrow("process.exit called");
    expect(data.calls).toEqual([]);

    await run([
      "reset", "--expected-digest", "a".repeat(64), "--confirm", "--agent", "agent-a", "--format", "json",
    ]);
    expect(data.calls).toEqual([{
      method: TasksResetContract.method,
      params: { expectedDigest: "a".repeat(64), confirmed: true, agentId: "agent-a" },
    }]);
    expect(JSON.parse(getSpyOutput(consoleSpy.log))).toEqual(response);
  });
});
