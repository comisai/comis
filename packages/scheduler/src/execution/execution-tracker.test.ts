// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FileLockPort, LockError } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import {
  createExecutionTracker,
  type ExecutionTracker,
} from "./execution-tracker.js";
import type {
  CronExecutionStartedRow,
  CronExecutionTerminalRow,
} from "./cron-execution-record.js";

const dirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function lock(): FileLockPort {
  return {
    acquire: async () => ok(async () => undefined),
    release: async () => ok(undefined),
    withLock: async <T>(_path: string, fn: () => Promise<T>): Promise<Result<T, LockError>> => ok(await fn()),
    isLocked: async () => false,
    cleanupStaleLocks: async () => 0,
  };
}

async function fixture(overrides: Partial<Parameters<typeof createExecutionTracker>[0]> = {}): Promise<{
  tracker: ExecutionTracker;
  logPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "comis-execution-ledger-"));
  dirs.push(dir);
  const logPath = join(dir, "execution.jsonl");
  let id = 0;
  return {
    tracker: createExecutionTracker({
      logPath,
      lockPath: join(dir, "execution.lock"),
      fileLock: lock(),
      idFactory: () => `opaque-${++id}`,
      maxLogBytes: 1_000_000,
      retainedExecutions: 2,
      ...overrides,
    }),
    logPath,
  };
}

function start(executionId: string, overrides: Partial<CronExecutionStartedRow> = {}): CronExecutionStartedRow {
  return {
    executionId,
    bootId: "boot_a",
    jobId: `job-${executionId}`,
    agentId: "agent_a",
    scheduledForMs: 10_000,
    trigger: "scheduled",
    recordType: "started",
    workKind: "agent_turn",
    rootRunId: `root-cron-${executionId}`,
    startedAtMs: 10_010,
    ...overrides,
  };
}

function terminal(
  executionId: string,
  overrides: Partial<CronExecutionTerminalRow> = {},
): CronExecutionTerminalRow {
  return {
    executionId,
    bootId: "boot_a",
    jobId: `job-${executionId}`,
    agentId: "agent_a",
    scheduledForMs: 10_000,
    trigger: "scheduled",
    recordType: "terminal",
    workKind: "agent_turn",
    terminalAtMs: 10_030,
    durationMs: 20,
    outcome: {
      kind: "pre_dispatch_failure",
      stage: "root_registration",
      errorKind: "internal",
    },
    ...overrides,
  };
}

describe("strict cron execution tracker", () => {
  it("initializes an empty secure ledger and returns its digest", async () => {
    const { tracker, logPath } = await fixture();
    const initialized = await tracker.initialize();

    expect(initialized).toMatchObject({ ok: true, value: { executions: 0 } });
    expect(initialized.ok && initialized.value.fileDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(logPath, "utf8")).toBe("");
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
  });

  it("conditionally appends one start and one immutable terminal", async () => {
    const { tracker, logPath } = await fixture();
    expect((await tracker.initialize()).ok).toBe(true);
    expect((await tracker.appendStart(start("execution_a"))).ok).toBe(true);
    expect((await tracker.appendTerminal(terminal("execution_a"))).ok).toBe(true);

    const read = await tracker.readExecution("execution_a");
    expect(read).toMatchObject({
      ok: true,
      value: {
        start: { executionId: "execution_a", recordType: "started" },
        terminal: { executionId: "execution_a", recordType: "terminal" },
      },
    });
    expect((await readFile(logPath, "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("durably appends a recovered start and terminal as one complete group", async () => {
    const { tracker, logPath } = await fixture();
    expect((await tracker.initialize()).ok).toBe(true);

    expect(await tracker.appendRecoveredExecution(
      start("execution_recovered"),
      terminal("execution_recovered", {
        outcome: {
          kind: "pre_dispatch_failure",
          stage: "start_record_recovery",
          errorKind: "internal",
        },
      }),
      ["execution_recovered"],
    )).toEqual(ok(undefined));

    expect(await tracker.readExecution("execution_recovered")).toMatchObject({
      ok: true,
      value: {
        start: { executionId: "execution_recovered" },
        terminal: {
          executionId: "execution_recovered",
          outcome: { kind: "pre_dispatch_failure", stage: "start_record_recovery" },
        },
      },
    });
    expect((await readFile(logPath, "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("rejects duplicate starts, duplicate terminals, and terminal-without-start", async () => {
    const { tracker } = await fixture();
    expect((await tracker.initialize()).ok).toBe(true);
    expect((await tracker.appendTerminal(terminal("missing")))).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect((await tracker.appendStart(start("execution_a"))).ok).toBe(true);
    expect((await tracker.appendStart(start("execution_a")))).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect((await tracker.appendTerminal(terminal("execution_a"))).ok).toBe(true);
    expect((await tracker.appendTerminal(terminal("execution_a")))).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("preserves malformed existing bytes and blocks every append", async () => {
    const { tracker, logPath } = await fixture();
    const invalid = '{"recordType":"started","executionId":"broken"}\n';
    await writeFile(logPath, invalid, { mode: 0o600 });

    expect(await tracker.initialize()).toMatchObject({
      ok: false,
      error: { code: "invalid_state", errorKind: "validation", line: 1 },
    });
    expect(await tracker.appendStart(start("execution_a"))).toMatchObject({
      ok: false,
      error: { code: "not_initialized" },
    });
    expect(await readFile(logPath, "utf8")).toBe(invalid);
  });

  it("detects identity mismatches while scanning the entire ledger", async () => {
    const { tracker, logPath } = await fixture();
    const mismatched = terminal("execution_a", { jobId: "different-job" });
    await writeFile(logPath, `${JSON.stringify(start("execution_a"))}\n${JSON.stringify(mismatched)}\n`, { mode: 0o600 });

    expect(await tracker.initialize()).toMatchObject({
      ok: false,
      error: { code: "invalid_state", errorKind: "validation", line: 2 },
    });
  });

  it("prunes only complete oldest groups and never splits an unmatched start", async () => {
    const { tracker } = await fixture({ retainedExecutions: 2 });
    expect((await tracker.initialize()).ok).toBe(true);
    for (const id of ["execution_a", "execution_b", "execution_c"]) {
      expect((await tracker.appendStart(start(id))).ok).toBe(true);
      expect((await tracker.appendTerminal(terminal(id, {
        terminalAtMs: id === "execution_a" ? 20_000 : id === "execution_b" ? 30_000 : 40_000,
      }))).ok).toBe(true);
    }
    expect((await tracker.appendStart(start("execution_pending"))).ok).toBe(true);

    const history = await tracker.listHistory({ limit: 10 });
    expect(history.ok && history.value.map((group) => group.start.executionId).sort()).toEqual([
      "execution_b",
      "execution_c",
      "execution_pending",
    ]);
    expect(history.ok && history.value.find((group) => group.start.executionId === "execution_pending")?.terminal).toBeUndefined();
  });

  it("retains a complete group named by an active claim during explicit pruning", async () => {
    const { tracker } = await fixture({ retainedExecutions: 1 });
    expect((await tracker.initialize()).ok).toBe(true);
    for (const id of ["execution_a", "execution_b"]) {
      expect((await tracker.appendStart(start(id))).ok).toBe(true);
      expect((await tracker.appendTerminal(terminal(id), ["execution_a"])).ok).toBe(true);
    }
    expect((await tracker.prune(["execution_a"])).ok).toBe(true);

    const first = await tracker.readExecution("execution_a");
    expect(first.ok && first.value?.terminal).toBeDefined();
  });

  it("reserves terminal capacity before dispatch and refuses unsafe starts", async () => {
    const { tracker } = await fixture({
      maxLogBytes: 500,
    });
    expect((await tracker.initialize()).ok).toBe(true);

    expect(await tracker.appendStart(start("execution_a"))).toMatchObject({
      ok: false,
      error: { code: "capacity", errorKind: "resource" },
    });
  });
});
