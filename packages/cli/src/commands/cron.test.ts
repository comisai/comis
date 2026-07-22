// SPDX-License-Identifier: Apache-2.0
/** Behavior tests for the strict RPC-backed `comis cron` operator commands. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CronListContract,
  CronRunContract,
  CronRunsContract,
  CronResetContract,
  CronStatusContract,
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

const { registerCronCommand } = await import("./cron.js");
const { withClient } = await import("../client/rpc-client.js");

const scheduledJob = {
  id: "job-a",
  name: "Daily status",
  agentId: "agent-a",
  source: "authored" as const,
  schedule: { kind: "cron" as const, expr: "0 8 * * *", tz: "UTC" },
  lifecycle: {
    status: "scheduled" as const,
    nextRunAtMs: 1_800_000_000_000,
    consecutiveDependencyErrors: 0,
  },
  payload: { kind: "agent_turn", message: "PRIVATE-PAYLOAD-MARKER" },
  sessionPolicy: { strategy: "fresh" as const },
  continuationMode: "none" as const,
};

function makeClient(
  responseFor: (method: string, params: unknown) => unknown,
): { client: RpcClient; calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client: RpcClient = {
    async call(method, params): Promise<unknown> {
      calls.push({ method, params });
      return responseFor(method, params);
    },
    close(): void {},
    onNotification(): void {},
  };
  return { client, calls };
}

describe("comis cron strict operator commands", () => {
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
    registerCronCommand(program);
    await program.parseAsync(["node", "comis", "cron", ...args]);
  }

  it("registers list, run, runs, status, and guarded reset with operator options", () => {
    const program = createTestProgram();
    registerCronCommand(program);
    const cron = program.commands.find((command) => command.name() === "cron");

    expect(cron?.commands.map((command) => command.name())).toEqual([
      "list",
      "run",
      "runs",
      "status",
      "reset",
    ]);
    expect(cron?.commands.find((command) => command.name() === "list")?.options.map((option) => option.long))
      .toEqual(expect.arrayContaining(["--agent", "--all", "--format"]));
    for (const name of ["run", "runs", "status"]) {
      expect(cron?.commands.find((command) => command.name() === name)?.options.map((option) => option.long))
        .toEqual(expect.arrayContaining(["--agent", "--format"]));
    }
    expect(cron?.commands.find((command) => command.name() === "reset")?.options.map((option) => option.long))
      .toEqual(expect.arrayContaining([
        "--agent",
        "--target",
        "--store-digest",
        "--ledger-digest",
        "--confirm",
        "--format",
      ]));
  });

  it("lists one selected agent through cron.list and emits the typed JSON response", async () => {
    const { client, calls } = makeClient(() => ({ jobs: [scheduledJob] }));
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    await run(["list", "--agent", "agent-a", "--format", "json"]);

    expect(calls).toEqual([{ method: CronListContract.method, params: { agentId: "agent-a" } }]);
    expect(JSON.parse(getSpyOutput(consoleSpy.log))).toEqual({ jobs: [scheduledJob] });
  });

  it("uses the admin all-agent selector and keeps payload text out of the table", async () => {
    const { client, calls } = makeClient(() => ({ jobs: [scheduledJob] }));
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    await run(["list", "--all"]);

    expect(calls).toEqual([{ method: CronListContract.method, params: { agentId: "*" } }]);
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Daily status");
    expect(output).toContain("agent-a");
    expect(output).toContain("0 8 * * * (UTC)");
    expect(output).not.toContain("PRIVATE-PAYLOAD-MARKER");
  });

  it("forces one named job through cron.run for the selected agent", async () => {
    const response = {
      triggered: true,
      mode: "force" as const,
      jobName: "Daily status",
      resolvedAgentId: "agent-a",
      executionId: "execution-a",
    };
    const { client, calls } = makeClient(() => response);
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    await run(["run", "Daily status", "--agent", "agent-a", "--format", "json"]);

    expect(calls).toEqual([{
      method: CronRunContract.method,
      params: { jobName: "Daily status", mode: "force", agentId: "agent-a" },
    }]);
    expect(JSON.parse(getSpyOutput(consoleSpy.log))).toEqual(response);
  });

  it("renders bounded immutable run history from cron.runs", async () => {
    const response = {
      runs: [{
        executionId: "execution-a",
        jobId: "job-a",
        agentId: "agent-a",
        scheduledForMs: 1_799_999_990_000,
        trigger: "manual" as const,
        workKind: "agent_turn" as const,
        rootRunId: "root-a",
        startedAtMs: 1_800_000_000_000,
        terminalAtMs: 1_800_000_001_250,
        durationMs: 1_250,
        status: "completed" as const,
        deliveryStatus: "accepted" as const,
      }],
    };
    const { client, calls } = makeClient(() => response);
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    await run(["runs", "Daily status", "--agent", "agent-a", "--limit", "7"]);

    expect(calls).toEqual([{
      method: CronRunsContract.method,
      params: { jobName: "Daily status", limit: 7, agentId: "agent-a" },
    }]);
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("execution-a");
    expect(output).toContain("completed");
    expect(output).toContain("accepted");
  });

  it("renders scheduler status for one selected agent", async () => {
    const response = {
      state: "active" as const,
      configuredEnabled: true,
      running: true,
      strictAuthoritiesValid: true,
      ownershipReconciled: true,
      jobCount: 3,
      activeClaimCount: 0,
      resolvedAgentId: "agent-a",
      store: { exists: true, bytes: 10, digest: "a".repeat(64) },
      ledger: { exists: true, bytes: 20, digest: "b".repeat(64) },
      intent: { status: "none" as const },
    };
    const { client, calls } = makeClient(() => response);
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    await run(["status", "--agent", "agent-a"]);

    expect(calls).toEqual([{ method: CronStatusContract.method, params: { agentId: "agent-a" } }]);
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("agent-a");
    expect(output).toContain("active");
    expect(output).toContain("3");
    expect(output).toContain("a".repeat(64));
    expect(output).toContain("b".repeat(64));
  });

  it("sends an explicit confirmed all-authority reset through the admin contract", async () => {
    const response = {
      operationId: "operation-a",
      target: "all" as const,
      resolvedAgentId: "agent-a",
      beforeDigests: { store: "a".repeat(64), ledger: "b".repeat(64) },
      afterDigests: { store: "c".repeat(64), ledger: "d".repeat(64) },
      state: "active" as const,
      reactivated: true,
    };
    const { client, calls } = makeClient(() => response);
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    await run([
      "reset",
      "--agent", "agent-a",
      "--target", "all",
      "--store-digest", "a".repeat(64),
      "--ledger-digest", "b".repeat(64),
      "--confirm",
      "--format", "json",
    ]);

    expect(calls).toEqual([{
      method: CronResetContract.method,
      params: {
        agentId: "agent-a",
        target: "all",
        expectedDigests: { store: "a".repeat(64), ledger: "b".repeat(64) },
        confirmed: true,
      },
    }]);
    expect(JSON.parse(getSpyOutput(consoleSpy.log))).toEqual(response);
  });

  it("requires confirmation and every selected digest before opening an RPC client", async () => {
    await expect(run([
      "reset",
      "--target", "store",
      "--store-digest", "missing",
    ])).rejects.toThrow("process.exit called");
    expect(withClient).not.toHaveBeenCalled();
    expect(getSpyOutput(consoleSpy.error)).toContain("--confirm");

    vi.mocked(withClient).mockClear();
    await expect(run([
      "reset",
      "--target", "all",
      "--store-digest", "a".repeat(64),
      "--confirm",
    ])).rejects.toThrow("process.exit called");
    expect(withClient).not.toHaveBeenCalled();
    expect(getSpyOutput(consoleSpy.error)).toContain("--ledger-digest");
  });

  it("rejects an oversized history limit before opening an RPC client", async () => {
    await expect(run(["runs", "Daily status", "--limit", "10001"])).rejects.toThrow(
      "process.exit called",
    );

    expect(withClient).not.toHaveBeenCalled();
    expect(getSpyOutput(consoleSpy.error)).toContain("--limit");
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
  });

  it("reports a daemon-offline error and exits nonzero", async () => {
    vi.mocked(withClient).mockRejectedValue(new Error("Unable to connect to Comis daemon"));

    await expect(run(["status"])).rejects.toThrow("process.exit called");

    expect(getSpyOutput(consoleSpy.error)).toContain(
      "Cron status failed: Unable to connect to Comis daemon",
    );
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
  });
});
