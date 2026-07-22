// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { err, ok, type Result } from "@comis/shared";
import type { FileLockPort, LockError } from "@comis/core";
import {
  createCronStore,
  encodeCronStoreRoot,
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

function failingLock(kind: LockError["kind"]): FileLockPort {
  return {
    ...lock(),
    withLock: async <T>(): Promise<Result<T, LockError>> => err({ kind, message: `expected ${kind}` }),
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

  it("rejects duplicate root identities and inconsistent active-claim graphs", () => {
    const job = recurringJob();
    const claim = {
      executionId: "exec-a",
      bootId: "boot-a",
      jobId: "job-a",
      agentId: "agent-a",
      rootRunId: "root-a",
      scheduledForMs: NOW_MS + 60_000,
      claimedAtMs: NOW_MS + 60_000,
      trigger: "manual" as const,
      workKind: "agent_turn" as const,
    };
    const root = { formatVersion: 1 as const, agentSchedulerSeed: "seed-a", jobs: [job], activeClaims: [claim] };
    expect(CronStoreRootSchema.safeParse({ ...root, jobs: [job, job] }).success).toBe(false);
    expect(CronStoreRootSchema.safeParse({
      ...root,
      jobs: [job, { ...recurringJob("job-b"), name: job.name }],
    }).success).toBe(false);
    expect(CronStoreRootSchema.safeParse({ ...root, activeClaims: [claim, { ...claim, jobId: "job-b" }] }).success).toBe(false);
    expect(CronStoreRootSchema.safeParse({ ...root, activeClaims: [claim, { ...claim, executionId: "exec-b" }] }).success).toBe(false);
    expect(CronStoreRootSchema.safeParse({ ...root, activeClaims: [{ ...claim, jobId: "missing" }] }).success).toBe(false);
    expect(CronStoreRootSchema.safeParse({ ...root, activeClaims: [{ ...claim, agentId: "agent-b" }] }).success).toBe(false);
    expect(CronStoreRootSchema.safeParse({ ...root, activeClaims: [{ ...claim, rootRunId: null }] }).success).toBe(false);
  });

  it("rejects one-shot lifecycle state that disagrees with its scheduled claim", () => {
    const job = oneShotJob();
    const claim = {
      executionId: "exec-a",
      bootId: "boot-a",
      jobId: job.id,
      agentId: job.agentId,
      rootRunId: "root-a",
      scheduledForMs: NOW_MS + 60_000,
      claimedAtMs: NOW_MS + 60_000,
      trigger: "scheduled" as const,
      workKind: "agent_turn" as const,
    };
    expect(CronStoreRootSchema.safeParse({
      formatVersion: 1,
      agentSchedulerSeed: "seed-a",
      jobs: [job],
      activeClaims: [claim],
    }).success).toBe(false);
  });

  it("returns precondition errors before initialization and snapshots by value", async () => {
    const { store } = await fixture();
    expect(store.getSnapshot()).toMatchObject({ ok: false, error: { code: "not_initialized" } });
    expect(store.listJobs()).toMatchObject({ ok: false, error: { code: "not_initialized" } });
    expect(await store.addJob(recurringJob())).toMatchObject({ ok: false, error: { code: "not_initialized" } });
    await store.initialize();
    await store.addJob(recurringJob());
    const first = store.getSnapshot();
    if (!first.ok) throw first.error;
    first.value.jobs.splice(0, 1);
    expect(store.listJobs()).toMatchObject({ ok: true, value: [{ id: "job-a" }] });
  });

  it("rejects invalid paths capacities and opaque identifiers before authority creation", async () => {
    const relative = await fixture({ filePath: "relative.json" });
    expect(await relative.store.initialize()).toMatchObject({ ok: false, error: { code: "invalid_path" } });
    const quota = await fixture({ maxAuthoredJobs: 0 });
    expect(await quota.store.initialize()).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    const bytes = await fixture({ maxStoreBytes: 0 });
    expect(await bytes.store.initialize()).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    const seed = await fixture({ idFactory: () => "" });
    expect(await seed.store.initialize()).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("maps lock contention and lock failures to distinct initialization errors", async () => {
    const contended = await fixture({ fileLock: failingLock("locked") });
    expect(await contended.store.initialize()).toMatchObject({ ok: false, error: { code: "lock_contended" } });
    const failed = await fixture({ fileLock: failingLock("error") });
    expect(await failed.store.initialize()).toMatchObject({ ok: false, error: { code: "lock_failed" } });
  });

  it("rejects invalid JSON oversized roots and filesystem read failures without replacement", async () => {
    const malformed = await fixture();
    await writeFile(malformed.filePath, "{invalid", { mode: 0o600 });
    expect(await malformed.store.initialize()).toMatchObject({ ok: false, error: { code: "invalid_state" } });

    const oversized = await fixture({ maxStoreBytes: 16 });
    await writeFile(oversized.filePath, "x".repeat(17), { mode: 0o600 });
    expect(await oversized.store.initialize()).toMatchObject({ ok: false, error: { code: "invalid_state" } });

    const unreadable = await fixture();
    await mkdir(unreadable.filePath);
    expect(await unreadable.store.initialize()).toMatchObject({ ok: false, error: { code: "io" } });
  });

  it("rejects invalid roots and byte-capacity overflow during canonical encoding", async () => {
    expect(encodeCronStoreRoot({
      formatVersion: 1,
      agentSchedulerSeed: "",
      jobs: [],
      activeClaims: [],
    })).toMatchObject({ ok: false, error: { code: "invalid_state" } });

    const data = await fixture({ maxStoreBytes: 180 });
    expect(await data.store.initialize()).toMatchObject({ ok: true });
    expect(await data.store.addJob(recurringJob())).toMatchObject({ ok: false, error: { code: "capacity" } });
  });

  it("reports invalid temporary tokens and missing initialized authority writes", async () => {
    let call = 0;
    const invalidToken = await fixture({ idFactory: () => ++call === 1 ? "seed-a" : "../escape" });
    expect(await invalidToken.store.initialize()).toMatchObject({ ok: false, error: { code: "invalid_state" } });

    const missing = await fixture();
    expect((await missing.store.initialize()).ok).toBe(true);
    await unlink(missing.filePath);
    expect(await missing.store.addJob(recurringJob())).toMatchObject({ ok: false, error: { code: "io" } });
  });

  it("prunes expired terminal one-shots while retaining recent authority", async () => {
    const data = await fixture({ terminalRetentionMs: 1_000 });
    await writeFile(data.filePath, `${JSON.stringify({
      formatVersion: 1,
      agentSchedulerSeed: "seed-a",
      jobs: [
        { ...oneShotJob("expired"), lifecycle: { status: "one_shot_terminal", terminalExecutionId: "exec-a", terminalAtMs: NOW_MS - 1_000 } },
        { ...oneShotJob("recent"), lifecycle: { status: "one_shot_terminal", terminalExecutionId: "exec-b", terminalAtMs: NOW_MS - 999 } },
      ],
      activeClaims: [],
    })}\n`, { mode: 0o600 });
    expect(await data.store.initialize()).toMatchObject({ ok: true, value: { jobs: [{ id: "recent" }] } });
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

  it("rejects missing duplicate and malformed claim identities without mutation", async () => {
    const { store } = await fixture({ maxAuthoredJobs: 4 });
    await store.initialize();
    await store.addJob(recurringJob("job-a"));
    await store.addJob(recurringJob("job-b"));
    expect(await store.claim({
      jobId: "missing", executionId: "exec-a", bootId: "boot-a", rootRunId: "root-a",
      trigger: "manual", claimedAtMs: NOW_MS,
    })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await store.claim({
      jobId: "job-a", executionId: "", bootId: "boot-a", rootRunId: "root-a",
      trigger: "manual", claimedAtMs: NOW_MS,
    })).toMatchObject({ ok: false, error: { code: "invalid_claim" } });
    expect(await store.claim({
      jobId: "job-a", executionId: "exec-a", bootId: "boot-a", rootRunId: "root-a",
      trigger: "manual", claimedAtMs: NOW_MS,
    })).toMatchObject({ ok: true });
    expect(await store.claim({
      jobId: "job-b", executionId: "exec-a", bootId: "boot-b", rootRunId: "root-b",
      trigger: "manual", claimedAtMs: NOW_MS,
    })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("enforces root legality for non-governed work and validates root identifiers", async () => {
    const { store } = await fixture({ maxAuthoredJobs: 4 });
    await store.initialize();
    const { sessionPolicy: _sessionPolicy, continuationMode: _continuationMode, ...heartbeatBase } = recurringJob("heartbeat");
    await store.addJob({
      ...heartbeatBase,
      payload: { kind: "heartbeat_event", text: "inspect", wakeMode: "now" },
    });
    expect(await store.claim({
      jobId: "heartbeat", executionId: "exec-a", bootId: "boot-a", rootRunId: "root-a",
      trigger: "manual", claimedAtMs: NOW_MS,
    })).toMatchObject({ ok: false, error: { code: "invalid_claim" } });
    await store.addJob(recurringJob("job-a"));
    expect(await store.claim({
      jobId: "job-a", executionId: "exec-b", bootId: "boot-b", rootRunId: "",
      trigger: "manual", claimedAtMs: NOW_MS,
    })).toMatchObject({ ok: false, error: { code: "invalid_claim" } });
  });

  it("rejects unsafe recurring advancement instead of persisting an unusable occurrence", async () => {
    const { store } = await fixture();
    await store.initialize();
    await store.addJob({
      ...recurringJob(),
      schedule: { kind: "every", everyMs: Number.MAX_SAFE_INTEGER, anchorMs: 0 },
      lifecycle: { status: "scheduled", nextRunAtMs: Number.MAX_SAFE_INTEGER, consecutiveDependencyErrors: 0 },
    });
    expect(await store.claim({
      jobId: "job-a",
      executionId: "exec-a",
      bootId: "boot-a",
      rootRunId: "root-a",
      trigger: "scheduled",
      scheduledForMs: Number.MAX_SAFE_INTEGER,
      claimedAtMs: Number.MAX_SAFE_INTEGER,
    })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("settles missing claims idempotently and rejects unsafe terminal timestamps", async () => {
    const { store } = await fixture();
    await store.initialize();
    expect(await store.settleClaim({
      executionId: "missing", terminalAtMs: NOW_MS, dependencyOutcome: "neutral",
    })).toEqual({ ok: true, value: "already_settled" });
    await store.addJob(recurringJob());
    await store.claim({
      jobId: "job-a", executionId: "exec-a", bootId: "boot-a", rootRunId: "root-a",
      trigger: "manual", claimedAtMs: NOW_MS,
    });
    expect(await store.settleClaim({
      executionId: "exec-a", terminalAtMs: -1, dependencyOutcome: "neutral",
    })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("resets dependency errors on success and preserves them for neutral outcomes", async () => {
    const { store } = await fixture({ maxAuthoredJobs: 4 });
    await store.initialize();
    for (const [id, outcome] of [["success", "success"], ["neutral", "neutral"]] as const) {
      await store.addJob({
        ...recurringJob(id),
        lifecycle: { status: "scheduled", nextRunAtMs: NOW_MS + 60_000, consecutiveDependencyErrors: 2 },
      });
      await store.claim({
        jobId: id, executionId: `exec-${id}`, bootId: "boot-a", rootRunId: `root-${id}`,
        trigger: "scheduled", scheduledForMs: NOW_MS + 60_000, claimedAtMs: NOW_MS + 60_000,
      });
      await store.settleClaim({
        executionId: `exec-${id}`, terminalAtMs: NOW_MS + 70_000, dependencyOutcome: outcome,
      });
    }
    expect(store.listJobs()).toMatchObject({
      ok: true,
      value: [
        { id: "success", lifecycle: { consecutiveDependencyErrors: 0 } },
        { id: "neutral", lifecycle: { consecutiveDependencyErrors: 2 } },
      ],
    });
  });

  it("rejects dependency error counter overflow without dropping the active claim", async () => {
    const { store } = await fixture();
    await store.initialize();
    await store.addJob({
      ...recurringJob(),
      lifecycle: {
        status: "scheduled",
        nextRunAtMs: NOW_MS + 60_000,
        consecutiveDependencyErrors: Number.MAX_SAFE_INTEGER,
      },
    });
    await store.claim({
      jobId: "job-a", executionId: "exec-a", bootId: "boot-a", rootRunId: "root-a",
      trigger: "scheduled", scheduledForMs: NOW_MS + 60_000, claimedAtMs: NOW_MS + 60_000,
    });
    expect(await store.settleClaim({
      executionId: "exec-a", terminalAtMs: NOW_MS + 70_000, dependencyOutcome: "dependency_error",
    })).toMatchObject({ ok: false, error: { code: "capacity" } });
    expect(store.getSnapshot()).toMatchObject({ ok: true, value: { activeClaims: [{ executionId: "exec-a" }] } });
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

  it("validates additions conflicts replacements and absent removals", async () => {
    const { store } = await fixture({ maxAuthoredJobs: 4 });
    await store.initialize();
    expect(await store.addJob({ id: "bad" } as CronJob)).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    await store.addJob(recurringJob("job-a"));
    expect(await store.addJob({ ...recurringJob("job-b"), name: "job-a" })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(await store.replaceAuthoredJob("missing", recurringJob("missing"))).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await store.replaceAuthoredJob("job-a", recurringJob("different"))).toMatchObject({
      ok: false,
      error: { code: "invalid_state" },
    });
    expect(await store.removeJob("missing")).toEqual({ ok: true, value: false });
    expect(await store.removeJob("job-a")).toEqual({ ok: true, value: true });
  });

  it("replaces authored jobs while rejecting built-in active and duplicate-name targets", async () => {
    const { store } = await fixture({ maxAuthoredJobs: 6 });
    await store.initialize();
    await store.addJob(recurringJob("built-in", "built_in"));
    await store.addJob(recurringJob("job-a"));
    await store.addJob(recurringJob("job-b"));
    expect(await store.replaceAuthoredJob("built-in", { ...recurringJob("built-in"), source: "authored" })).toMatchObject({
      ok: false,
      error: { code: "config_owned" },
    });
    expect(await store.replaceAuthoredJob("job-a", { ...recurringJob("job-a"), name: "job-b" })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    await store.claim({
      jobId: "job-a", executionId: "exec-a", bootId: "boot-a", rootRunId: "root-a",
      trigger: "manual", claimedAtMs: NOW_MS,
    });
    expect(await store.replaceAuthoredJob("job-a", recurringJob("job-a"))).toMatchObject({
      ok: false,
      error: { code: "active_claim" },
    });
    await store.settleClaim({ executionId: "exec-a", terminalAtMs: NOW_MS, dependencyOutcome: "neutral" });
    expect(await store.replaceAuthoredJob("job-a", {
      ...recurringJob("job-a"),
      payload: { kind: "agent_turn", message: "updated" },
    })).toEqual({ ok: true, value: undefined });
  });

  it("reconciles built-ins by adding replacing removing and retaining actively claimed jobs", async () => {
    const { store } = await fixture({ maxAuthoredJobs: 6 });
    await store.initialize();
    await store.addJob(recurringJob("authored"));
    await store.reconcileBuiltIns([recurringJob("built-a", "built_in"), recurringJob("built-old", "built_in")]);
    await store.claim({
      jobId: "built-old", executionId: "exec-old", bootId: "boot-a", rootRunId: "root-old",
      trigger: "manual", claimedAtMs: NOW_MS,
    });
    expect(await store.reconcileBuiltIns([
      { ...recurringJob("built-a", "built_in"), name: "built-a-updated" },
      recurringJob("built-new", "built_in"),
    ])).toEqual({ ok: true, value: undefined });
    const listed = store.listJobs();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "authored" }),
      expect.objectContaining({ id: "built-a", name: "built-a-updated" }),
      expect.objectContaining({ id: "built-old" }),
      expect.objectContaining({ id: "built-new" }),
    ]));
    expect(await store.reconcileBuiltIns([recurringJob("bad")])).toMatchObject({
      ok: false,
      error: { code: "invalid_state" },
    });
  });

  it("maps mutation lock failures without changing the in-memory snapshot", async () => {
    let fail = false;
    const conditionalLock: FileLockPort = {
      ...lock(),
      withLock: async <T>(_path: string, fn: () => Promise<T>): Promise<Result<T, LockError>> => (
        fail ? err({ kind: "locked", message: "expected contention" }) : ok(await fn())
      ),
    };
    const { store } = await fixture({ fileLock: conditionalLock });
    await store.initialize();
    fail = true;
    expect(await store.addJob(recurringJob())).toMatchObject({ ok: false, error: { code: "lock_contended" } });
    expect(store.listJobs()).toEqual({ ok: true, value: [] });
  });
});
