// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FileLockPort, LockError } from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
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

  it("rejects invalid options lock outcomes and operations before initialization", async () => {
    const relative = await fixture({ logPath: "relative.jsonl" });
    expect(await relative.tracker.initialize()).toMatchObject({ ok: false, error: { code: "invalid_path" } });
    const bytes = await fixture({ maxLogBytes: 0 });
    expect(await bytes.tracker.initialize()).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    const retention = await fixture({ retainedExecutions: 0 });
    expect(await retention.tracker.initialize()).toMatchObject({ ok: false, error: { code: "invalid_state" } });

    const pending = await fixture();
    expect(await pending.tracker.appendStart(start("execution-a"))).toMatchObject({ ok: false, error: { code: "not_initialized" } });
    expect(await pending.tracker.readExecution("execution-a")).toMatchObject({ ok: false, error: { code: "not_initialized" } });

    for (const [kind, expected] of [["locked", "lock_contended"], ["error", "lock_failed"]] as const) {
      const fileLock: FileLockPort = {
        ...lock(),
        withLock: async <T>(): Promise<Result<T, LockError>> => err({ kind, message: "expected lock failure" }),
      };
      const data = await fixture({ fileLock });
      expect(await data.tracker.initialize()).toMatchObject({ ok: false, error: { code: expected } });
    }
  });

  it("rejects invalid start terminal and recovered-pair inputs before mutation", async () => {
    const { tracker } = await fixture();
    await tracker.initialize();
    expect(await tracker.appendStart(start(""))).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(await tracker.appendTerminal(terminal(""))).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(await tracker.appendRecoveredExecution(start("execution-a"), terminal("execution-b")))
      .toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(await tracker.appendRecoveredExecution(start(""), terminal("")))
      .toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(await tracker.appendRecoveredExecution(start("execution-a"), terminal("execution-a"))).toEqual(ok(undefined));
    expect(await tracker.appendRecoveredExecution(start("execution-a"), terminal("execution-a")))
      .toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("validates execution and history query identifiers and limits", async () => {
    const { tracker } = await fixture();
    await tracker.initialize();
    expect(await tracker.readExecution("")).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(await tracker.listHistory({ limit: 0 })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(await tracker.listHistory({ jobId: "", limit: 1 })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("filters sorts clones and lists ownership groups from canonical ledger state", async () => {
    const { tracker } = await fixture({ retainedExecutions: 5 });
    await tracker.initialize();
    await tracker.appendStart(start("execution-a", { jobId: "job-shared", startedAtMs: 10 }));
    await tracker.appendTerminal(terminal("execution-a", { jobId: "job-shared", terminalAtMs: 20, durationMs: 10 }));
    await tracker.appendStart(start("execution-b", { jobId: "job-other", startedAtMs: 30 }));
    const filtered = await tracker.listHistory({ jobId: "job-shared", limit: 10 });
    expect(filtered).toMatchObject({ ok: true, value: [{ start: { executionId: "execution-a" } }] });
    if (!filtered.ok) return;
    filtered.value[0]!.start.jobId = "mutated";
    expect(await tracker.readExecution("execution-a")).toMatchObject({
      ok: true,
      value: { start: { jobId: "job-shared" } },
    });
    expect(await tracker.listOwnershipGroups()).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({ start: expect.objectContaining({ executionId: "execution-a" }) }),
        expect.objectContaining({ start: expect.objectContaining({ executionId: "execution-b" }) }),
      ]),
    });
    expect(await tracker.readExecution("missing")).toEqual(ok(undefined));
  });

  it("detects newline empty JSON ordering duplicate and root corruption variants", async () => {
    const cases: string[] = [
      JSON.stringify(start("execution-a")),
      `${JSON.stringify(start("execution-a"))}\n\n`,
      `{invalid}\n`,
      `${JSON.stringify(terminal("execution-a"))}\n`,
      `${JSON.stringify(start("execution-a"))}\n${JSON.stringify(start("execution-a"))}\n`,
      `${JSON.stringify(start("execution-a"))}\n${JSON.stringify(terminal("execution-a"))}\n${JSON.stringify(terminal("execution-a"))}\n`,
      `${JSON.stringify(start("execution-a"))}\n${JSON.stringify(terminal("execution-a", {
        outcome: {
          kind: "unsettled",
          reason: "owner_lost_after_start",
          rootRunId: "root-cron-other",
          errorKind: "internal",
        },
      }))}\n`,
    ];
    for (const bytes of cases) {
      const data = await fixture();
      await writeFile(data.logPath, bytes, { mode: 0o600 });
      expect(await data.tracker.initialize()).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    }
  });

  it("detects oversized physical ledgers and unmatched reservation overflow", async () => {
    const physical = await fixture({ maxLogBytes: 100 });
    await writeFile(physical.logPath, Buffer.alloc(101, 0x20), { mode: 0o600 });
    expect(await physical.tracker.initialize()).toMatchObject({ ok: false, error: { code: "invalid_state" } });

    const reserved = await fixture({ maxLogBytes: 65_000 });
    await writeFile(reserved.logPath, `${JSON.stringify(start("execution-a"))}\n`, { mode: 0o600 });
    expect(await reserved.tracker.initialize()).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("returns read errors after initialized authority disappears", async () => {
    const data = await fixture();
    await data.tracker.initialize();
    await unlink(data.logPath);
    expect(await data.tracker.readExecution("execution-a")).toMatchObject({ ok: false, error: { code: "io" } });
    expect(await data.tracker.appendStart(start("execution-a"))).toMatchObject({ ok: false, error: { code: "io" } });
  });

  it("maps invalid temporary tokens and filesystem creation failures", async () => {
    const invalidToken = await fixture({ idFactory: () => "../escape" });
    expect(await invalidToken.tracker.initialize()).toMatchObject({ ok: false, error: { code: "invalid_state" } });

    const blocked = await fixture();
    await writeFile(blocked.logPath, "block", { mode: 0o600 });
    const tracker = createExecutionTracker({
      logPath: join(blocked.logPath, "execution.jsonl"),
      lockPath: join(blocked.logPath, "execution.lock"),
      fileLock: lock(),
      idFactory: () => "opaque-a",
    });
    expect(await tracker.initialize()).toMatchObject({ ok: false, error: { code: "io" } });
  });

  it("prunes idempotently when retained rows already satisfy limits", async () => {
    const data = await fixture({ retainedExecutions: 5 });
    await data.tracker.initialize();
    await data.tracker.appendStart(start("execution-a"));
    await data.tracker.appendTerminal(terminal("execution-a"));
    const before = await readFile(data.logPath);
    expect(await data.tracker.prune()).toEqual(ok(undefined));
    expect(await readFile(data.logPath)).toEqual(before);
  });

  it("rewrites pre-existing retained history only when explicit pruning changes rows", async () => {
    const data = await fixture({ retainedExecutions: 1 });
    const rows = [
      start("execution-a"),
      terminal("execution-a", { terminalAtMs: 20_000 }),
      start("execution-b"),
      terminal("execution-b", { terminalAtMs: 30_000 }),
    ];
    await writeFile(data.logPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
    await data.tracker.initialize();

    expect(await data.tracker.prune()).toEqual(ok(undefined));
    expect(await data.tracker.readExecution("execution-a")).toEqual(ok(undefined));
    expect(await data.tracker.readExecution("execution-b")).toMatchObject({ ok: true, value: { terminal: {} } });
  });

  it("fails closed when protected recovered history exceeds available ledger capacity", async () => {
    const protectedData = await fixture({ maxLogBytes: 500 });
    await protectedData.tracker.initialize();
    expect(await protectedData.tracker.appendRecoveredExecution(
      start("execution-protected"),
      terminal("execution-protected"),
      ["execution-protected"],
    )).toMatchObject({ ok: false, error: { code: "capacity", errorKind: "resource" } });

    const prunableData = await fixture({ maxLogBytes: 500 });
    await prunableData.tracker.initialize();
    expect(await prunableData.tracker.appendRecoveredExecution(
      start("execution-prunable"),
      terminal("execution-prunable"),
    )).toEqual(ok(undefined));
    expect(await prunableData.tracker.readExecution("execution-prunable")).toEqual(ok(undefined));
  });

  it("continues serialized access after a lock adapter rejects outside its result contract", async () => {
    let calls = 0;
    const fileLock: FileLockPort = {
      ...lock(),
      withLock: async <T>(_path: string, fn: () => Promise<T>): Promise<Result<T, LockError>> => {
        calls += 1;
        if (calls === 2) throw new Error("lock adapter rejected");
        return ok(await fn());
      },
    };
    const data = await fixture({ fileLock });
    await data.tracker.initialize();
    await expect(data.tracker.appendStart(start("execution-a"))).rejects.toThrow("lock adapter rejected");
    await expect(data.tracker.readExecution("execution-a")).resolves.toEqual(ok(undefined));
  });
});
