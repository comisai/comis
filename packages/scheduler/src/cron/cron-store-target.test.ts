// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ok, type Result } from "@comis/shared";
import type { FileLockPort, LockError } from "@comis/core";
import {
  createCronStore,
  CronStoreRootSchema,
  type CronJob,
  type CronStore,
} from "./index.js";

const NOW_MS = 1_800_000_000_000;
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

async function fixture(overrides: Partial<Parameters<typeof createCronStore>[0]> = {}): Promise<{
  store: CronStore;
  filePath: string;
  lockPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "comis-cron-store-target-"));
  dirs.push(dir);
  const filePath = join(dir, "cron-store.json");
  const lockPath = join(dir, "cron-store.lock");
  let id = 0;
  const store = createCronStore({
    filePath,
    lockPath,
    fileLock: lock(),
    clock: { now: () => NOW_MS, nowDate: () => new Date(NOW_MS) },
    idFactory: () => `opaque-${++id}`,
    maxAuthoredJobs: 2,
    ...overrides,
  });
  return { store, filePath, lockPath };
}

function recurringJob(id = "job-a", source: "authored" | "built_in" = "authored"): CronJob {
  const common = {
    id,
    name: id,
    agentId: "agent-a",
    schedule: { kind: "every" as const, everyMs: 60_000, anchorMs: NOW_MS },
    lifecycle: {
      status: "scheduled" as const,
      nextRunAtMs: NOW_MS + 60_000,
      consecutiveDependencyErrors: 0,
    },
  };
  return source === "built_in"
    ? { ...common, source, payload: { kind: "internal_action", action: "memory_lifecycle" } }
    : {
      ...common,
      source,
      payload: { kind: "agent_turn", message: "inspect health" },
      sessionPolicy: { strategy: "fresh" },
      continuationMode: "none",
    };
}

function oneShotJob(id = "once-a"): CronJob {
  return {
    id,
    name: id,
    agentId: "agent-a",
    schedule: { kind: "at", atMs: NOW_MS + 60_000 },
    lifecycle: {
      status: "scheduled",
      nextRunAtMs: NOW_MS + 60_000,
      consecutiveDependencyErrors: 0,
    },
    source: "authored",
    payload: { kind: "agent_turn", message: "inspect once" },
    sessionPolicy: { strategy: "fresh" },
    continuationMode: "none",
  };
}

describe("strict cron store root", () => {
  it("creates a versioned seed-owning root even when it has no jobs", async () => {
    const { store, filePath } = await fixture();
    const initialized = await store.initialize();

    expect(initialized).toMatchObject({
      ok: true,
      value: { formatVersion: 1, agentSchedulerSeed: "opaque-1", jobs: [], activeClaims: [] },
    });
    expect(await readFile(filePath, "utf8")).toBe(
      '{"formatVersion":1,"agentSchedulerSeed":"opaque-1","jobs":[],"activeClaims":[]}\n',
    );
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("preserves and rejects an existing old or malformed root instead of treating it as empty", async () => {
    const { store, filePath } = await fixture();
    const oldBytes = '[{"id":"old-job"}]\n';
    await writeFile(filePath, oldBytes, { mode: 0o600 });

    const initialized = await store.initialize();

    expect(initialized).toMatchObject({ ok: false, error: { code: "invalid_state", errorKind: "validation" } });
    expect(await readFile(filePath, "utf8")).toBe(oldBytes);
  });

  it("enforces authored quota while excluding built-ins and retained terminal one-shots", async () => {
    const { store } = await fixture();
    expect((await store.initialize()).ok).toBe(true);
    expect((await store.addJob(recurringJob("built-in", "built_in"))).ok).toBe(true);
    expect((await store.addJob(recurringJob("job-a"))).ok).toBe(true);
    expect((await store.addJob({
      ...oneShotJob("terminal"),
      lifecycle: { status: "one_shot_terminal", terminalExecutionId: "exec-old", terminalAtMs: NOW_MS },
    })).ok).toBe(true);
    expect((await store.addJob(recurringJob("job-b"))).ok).toBe(true);

    expect(await store.addJob(recurringJob("job-c"))).toMatchObject({
      ok: false,
      error: { code: "capacity", errorKind: "resource" },
    });
  });

  it("preserves independent store mutations and active claims from canonical locked state", async () => {
    const sharedLock = lock();
    const fakeClock = { now: () => NOW_MS, nowDate: () => new Date(NOW_MS) };
    const { store: storeA, filePath, lockPath } = await fixture({
      fileLock: sharedLock,
      clock: fakeClock,
      idFactory: () => "seed-a",
      maxAuthoredJobs: 4,
    });
    const storeB = createCronStore({
      filePath,
      lockPath,
      fileLock: sharedLock,
      clock: fakeClock,
      idFactory: () => "seed-b",
      maxAuthoredJobs: 4,
    });
    expect((await storeA.initialize()).ok).toBe(true);
    expect((await storeB.initialize()).ok).toBe(true);

    expect((await storeA.addJob(recurringJob("job-a"))).ok).toBe(true);
    expect((await storeB.addJob(recurringJob("job-b"))).ok).toBe(true);
    expect((await storeA.claim({
      jobId: "job-a",
      executionId: "exec-a",
      bootId: "boot-a",
      rootRunId: "root-cron-exec-a",
      trigger: "scheduled",
      scheduledForMs: NOW_MS + 60_000,
      claimedAtMs: NOW_MS + 60_000,
    })).ok).toBe(true);
    expect((await storeB.addJob(recurringJob("job-c"))).ok).toBe(true);

    const persisted = CronStoreRootSchema.safeParse(JSON.parse(await readFile(filePath, "utf8")));
    expect(persisted.success).toBe(true);
    if (!persisted.success) return;
    expect(persisted.data.jobs.map((entry) => entry.id).sort()).toEqual([
      "job-a",
      "job-b",
      "job-c",
    ]);
    expect(persisted.data.activeClaims).toEqual([
      expect.objectContaining({ executionId: "exec-a", jobId: "job-a" }),
    ]);
  });
});

describe("cron occurrence claims", () => {
  it("claims and advances one recurring nominal occurrence before dispatch", async () => {
    const { store } = await fixture();
    await store.initialize();
    await store.addJob(recurringJob());

    const claimed = await store.claim({
      jobId: "job-a",
      executionId: "exec-a",
      bootId: "boot-a",
      rootRunId: "root-cron-exec-a",
      trigger: "scheduled",
      scheduledForMs: NOW_MS + 60_000,
      claimedAtMs: NOW_MS + 190_000,
    });

    expect(claimed).toMatchObject({
      ok: true,
      value: {
        claim: { executionId: "exec-a", workKind: "agent_turn", scheduledForMs: NOW_MS + 60_000 },
        job: { id: "job-a", lifecycle: { status: "scheduled", nextRunAtMs: NOW_MS + 240_000 } },
      },
    });
    expect(await store.claim({
      jobId: "job-a",
      executionId: "exec-b",
      bootId: "boot-a",
      rootRunId: "root-cron-exec-b",
      trigger: "catchup",
      scheduledForMs: NOW_MS + 240_000,
      claimedAtMs: NOW_MS + 240_000,
    })).toMatchObject({ ok: false, error: { code: "already_running" } });
  });

  it("consumes every scheduled one-shot outcome but leaves manual lifecycle byte-identical", async () => {
    const { store } = await fixture();
    await store.initialize();
    await store.addJob(oneShotJob());
    const scheduled = await store.claim({
      jobId: "once-a",
      executionId: "exec-once",
      bootId: "boot-a",
      rootRunId: "root-cron-once",
      trigger: "scheduled",
      scheduledForMs: NOW_MS + 60_000,
      claimedAtMs: NOW_MS + 60_000,
    });
    expect(scheduled).toMatchObject({ ok: true, value: { job: { lifecycle: { status: "one_shot_claimed" } } } });
    expect(await store.settleClaim({
      executionId: "exec-once",
      terminalAtMs: NOW_MS + 70_000,
      dependencyOutcome: "dependency_error",
    })).toMatchObject({ ok: true, value: "settled" });
    expect(store.getSnapshot()).toMatchObject({
      ok: true,
      value: { jobs: [{ lifecycle: { status: "one_shot_terminal", terminalExecutionId: "exec-once" } }] },
    });

    const beforeManual = JSON.stringify(store.getSnapshot().ok ? store.getSnapshot().value.jobs[0]!.lifecycle : null);
    expect((await store.claim({
      jobId: "once-a",
      executionId: "exec-manual",
      bootId: "boot-a",
      rootRunId: "root-cron-manual",
      trigger: "manual",
      claimedAtMs: NOW_MS + 80_000,
    })).ok).toBe(true);
    await store.settleClaim({
      executionId: "exec-manual",
      terminalAtMs: NOW_MS + 90_000,
      dependencyOutcome: "success",
    });
    const afterManual = JSON.stringify(store.getSnapshot().ok ? store.getSnapshot().value.jobs[0]!.lifecycle : null);
    expect(afterManual).toBe(beforeManual);
  });

  it("fails root legality and exact scheduled compare-and-set before mutation", async () => {
    const { store } = await fixture();
    await store.initialize();
    await store.addJob(recurringJob());
    expect(await store.claim({
      jobId: "job-a", executionId: "exec-a", bootId: "boot-a", rootRunId: null,
      trigger: "scheduled", scheduledForMs: NOW_MS + 60_000, claimedAtMs: NOW_MS + 60_000,
    })).toMatchObject({ ok: false, error: { code: "invalid_claim" } });
    expect(await store.claim({
      jobId: "job-a", executionId: "exec-b", bootId: "boot-a", rootRunId: "root-b",
      trigger: "scheduled", scheduledForMs: NOW_MS + 59_999, claimedAtMs: NOW_MS + 60_000,
    })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(store.getSnapshot()).toMatchObject({ ok: true, value: { activeClaims: [] } });
  });

  it("updates only dependency-classified breaker state and suspends at the configured threshold", async () => {
    const { store } = await fixture();
    await store.initialize();
    await store.addJob({ ...recurringJob(), maxConsecutiveDependencyErrors: 1 });
    await store.claim({
      jobId: "job-a", executionId: "exec-a", bootId: "boot-a", rootRunId: "root-a",
      trigger: "scheduled", scheduledForMs: NOW_MS + 60_000, claimedAtMs: NOW_MS + 60_000,
    });
    await store.settleClaim({
      executionId: "exec-a", terminalAtMs: NOW_MS + 70_000, dependencyOutcome: "dependency_error",
    });
    expect(store.getSnapshot()).toMatchObject({
      ok: true,
      value: { jobs: [{ lifecycle: { status: "paused", reason: "dependency_errors", consecutiveDependencyErrors: 1 } }] },
    });
  });
});

describe("cron store mutation authority", () => {
  it("rejects config-owned and actively claimed mutation", async () => {
    const { store } = await fixture();
    await store.initialize();
    await store.addJob(recurringJob("built-in", "built_in"));
    await store.addJob(recurringJob("job-a"));
    expect(await store.removeJob("built-in")).toMatchObject({ ok: false, error: { code: "config_owned" } });
    await store.claim({
      jobId: "job-a", executionId: "exec-a", bootId: "boot-a", rootRunId: "root-a",
      trigger: "scheduled", scheduledForMs: NOW_MS + 60_000, claimedAtMs: NOW_MS + 60_000,
    });
    expect(await store.removeJob("job-a")).toMatchObject({ ok: false, error: { code: "active_claim" } });
  });
});
