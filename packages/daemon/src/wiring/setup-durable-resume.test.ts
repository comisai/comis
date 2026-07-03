// SPDX-License-Identifier: Apache-2.0
/**
 * The durable-resume subsystem wiring.
 *
 * These cases assert the two-phase STRUCTURE mirrored from
 * setup-delivery.ts:
 *   (a) disabled ⇒ resumeAndStart is a no-op + NO watchdog interval is registered
 *       + no stores constructed (the byte-identical default install);
 *   (b) enabled  ⇒ resumeAndStart runs the boot recovery (engine.resumeAll —
 *       proven by resuming a seeded `running` checkpoint) + registers exactly ONE
 *       daemon-wide watchdog interval;
 *   (c) shutdown ⇒ the watchdog interval is cancelled (no leaked timer — asserted
 *       via the fake-timers handle's `cancelled` flag).
 *
 * The real SQLite stores (frozen Result-returning ports) are exercised against an
 * in-memory db; the boot recovery is proven via the INJECTED resumeRun spy (the
 * frozen store cannot be vi.spyOn'd), seeding a `running` checkpoint through the
 * store's own upsertCheckpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  ChannelPort,
  ClockPort,
  TimerPort,
  TimerHandle,
  DurableRunRecord,
  OutwardSendRecord,
  DurableRunPort,
} from "@comis/core";
import { ok } from "@comis/shared";
import type { ComisLogger, LeaseManager } from "@comis/infra";
import { setupDurableResume, buildDurableResume, type SetupDurableResumeDeps } from "./setup-durable-resume.js";
import type { DurableRunRecord as DRR } from "@comis/core";

// ---------------------------------------------------------------------------
// Port wrappers + handle registry so the test can assert interval
// registration + cancellation. Each created TimerHandle is recorded.
// ---------------------------------------------------------------------------

const createdHandles: TimerHandle[] = [];

function wrapTimerHandle(t: NodeJS.Timeout): TimerHandle {
  let cancelled = false;
  const handle: TimerHandle = {
    get cancelled() { return cancelled; },
    cancel() { if (cancelled) return; cancelled = true; clearInterval(t); },
    unref() { if (!cancelled) t.unref(); },
  };
  createdHandles.push(handle);
  return handle;
}

const testClock: ClockPort = { now: () => Date.now(), nowDate: () => new Date() };
const testTimers: TimerPort = {
  setTimeout: (cb, ms) => wrapTimerHandle(setTimeout(cb, ms)),
  setInterval: (cb, ms) => wrapTimerHandle(setInterval(cb, ms)),
};

const silentLogger: ComisLogger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
  child: vi.fn(() => silentLogger),
} as unknown as ComisLogger;

async function makeDb(): Promise<unknown> {
  const memoryActual = await vi.importActual<typeof import("@comis/memory")>("@comis/memory");
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(":memory:");
  memoryActual.initSchema(db, 768);
  return db;
}

/** Seed a resumable `running` checkpoint through the store's own upsert. */
async function seedRunningRun(store: DurableRunPort, rootRunId: string): Promise<void> {
  const r = await store.upsertCheckpoint({
    rootRunId,
    spawnTree: [rootRunId],
    caps: ["orch:read"],
    leaseIds: ["lease-x"],
    budgetConsumed: 0,
    cronOrigin: null,
    stepIndex: -1,
    status: "running",
    lastHeartbeatAt: testClock.now(),
  });
  if (!r.ok) throw r.error;
}

function baseDeps(db: unknown, over: Partial<SetupDurableResumeDeps> = {}): SetupDurableResumeDeps {
  return {
    db,
    config: { enabled: true, staleHeartbeatMs: 1_000, recoveryBudgetMs: 5_000 },
    eventBus: { emit: vi.fn() },
    logger: silentLogger,
    channelAdapters: (_t: string): ChannelPort | undefined => undefined,
    remintLease: vi.fn(() => ({ leaseId: "lease-1", bearer: "bearer-1" })),
    resumeRun: vi.fn(async (_record: DurableRunRecord, _leaseId: string) => ok(undefined)),
    replaySend: vi.fn(async (_row: OutwardSendRecord) => ok({ platformMessageId: "pm-1" })),
    notify: vi.fn(),
    clock: testClock,
    timers: testTimers,
    ...over,
  };
}

describe("setupDurableResume (stores + resume engine + watchdog)", () => {
  beforeEach(() => { createdHandles.length = 0; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("disabled ⇒ resumeAndStart is a no-op, no watchdog interval, no stores", async () => {
    const db = await makeDb();
    const result = setupDurableResume(baseDeps(db, { config: { enabled: false, staleHeartbeatMs: 1_000, recoveryBudgetMs: 5_000 } }));

    expect(result.durableRunStore).toBeUndefined();
    expect(result.outwardLedger).toBeUndefined();

    await result.resumeAndStart();
    // No interval was registered (disabled path constructs no timer).
    expect(createdHandles.length).toBe(0);

    // shutdown is a safe no-op.
    expect(() => result.shutdown()).not.toThrow();
  });

  it("enabled ⇒ constructs the stores, resumes a seeded running run, and registers ONE watchdog interval", async () => {
    const db = await makeDb();
    const deps = baseDeps(db);
    const result = setupDurableResume(deps);

    expect(result.durableRunStore).toBeDefined();
    expect(result.outwardLedger).toBeDefined();

    // Seed a resumable run so engine.resumeAll has work — proving the boot
    // recovery ran end-to-end via the injected resumeRun spy (the frozen store
    // cannot be vi.spyOn'd).
    await seedRunningRun(result.durableRunStore!, "root-boot");

    await result.resumeAndStart();

    // The engine re-minted a lease + resumed the seeded run.
    expect(deps.remintLease).toHaveBeenCalledTimes(1);
    expect(deps.resumeRun).toHaveBeenCalledTimes(1);
    expect((deps.resumeRun as ReturnType<typeof vi.fn>).mock.calls[0][0].rootRunId).toBe("root-boot");
    // Exactly ONE daemon-wide watchdog interval was registered (not per-run).
    expect(createdHandles.length).toBe(1);
    expect(createdHandles[0]!.cancelled).toBe(false);
  });

  it("the watchdog interval fires at the stale-threshold cadence and sweeps a lapsed-heartbeat run", async () => {
    const db = await makeDb();
    const deps = baseDeps(db, { config: { enabled: true, staleHeartbeatMs: 1_000, recoveryBudgetMs: 5_000 } });
    const result = setupDurableResume(deps);

    // A run whose heartbeat is already far in the past — the watchdog must detect
    // it as stale and feed the engine (which resumes it).
    await result.durableRunStore!.upsertCheckpoint({
      rootRunId: "root-stale",
      spawnTree: ["root-stale"],
      caps: ["orch:read"],
      leaseIds: ["lease-y"],
      budgetConsumed: 0,
      cronOrigin: null,
      stepIndex: -1,
      status: "running",
      lastHeartbeatAt: testClock.now() - 10_000, // 10s ago, well past the 1s threshold
    });

    await result.resumeAndStart();
    const afterBoot = (deps.resumeRun as ReturnType<typeof vi.fn>).mock.calls.length;

    // Advance past a watchdog interval — the tick detects the stale run + resumes.
    await vi.advanceTimersByTimeAsync(1_100);
    expect((deps.resumeRun as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(afterBoot);

    result.shutdown();
  });

  it("shutdown cancels the watchdog interval (no leaked timer)", async () => {
    const db = await makeDb();
    const deps = baseDeps(db);
    const result = setupDurableResume(deps);
    await result.resumeAndStart();
    expect(createdHandles.length).toBe(1);
    expect(createdHandles[0]!.cancelled).toBe(false);

    result.shutdown();

    // The interval handle is cancelled — the leaked-timer guard.
    expect(createdHandles[0]!.cancelled).toBe(true);

    // After shutdown, advancing the clock fires no further resume work.
    const before = (deps.resumeRun as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect((deps.resumeRun as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// buildDurableResume wires the
// resumeGraph closure into the resume engine's resumeRun dispatch. A DAG-shaped
// run record (spawn_tree entries are OBJECTS with a `status` field) must route to
// coordinator.resumeGraph (node re-entry); a FLAT run record (string[] spawn_tree)
// must take the existing flat re-anchor (BoundedAutonomy.registerRoot) and can
// NEVER mis-route to resumeGraph.
// ---------------------------------------------------------------------------

describe("buildDurableResume resumeGraph dispatch", () => {
  beforeEach(() => { vi.useRealTimers(); });

  /** Seed a resumable `running` checkpoint with the given spawnTree shape. */
  async function seed(store: DurableRunPort, rootRunId: string, spawnTree: DRR["spawnTree"]): Promise<void> {
    const r = await store.upsertCheckpoint({
      rootRunId,
      spawnTree,
      caps: ["orch:read"],
      leaseIds: [`lease-${rootRunId}`],
      budgetConsumed: 0,
      cronOrigin: null,
      stepIndex: -1,
      status: "running",
      lastHeartbeatAt: testClock.now(),
    });
    if (!r.ok) throw r.error;
  }

  function makeBoundedAutonomy() {
    return {
      registerRoot: vi.fn(),
      leaseIdsForRoot: vi.fn(() => new Set<string>()),
    };
  }

  function makeLeaseManager(): LeaseManager {
    return {
      mintLease: vi.fn(() => ({ leaseId: "lease-x", bearer: "bearer-x" })),
    } as unknown as LeaseManager;
  }

  it("routes a DAG record (spawn_tree objects with `status`) to resumeGraph, NOT the flat re-anchor", async () => {
    const db = await makeDb();
    const boundedAutonomy = makeBoundedAutonomy();
    const resumeGraph = vi.fn(async (_record: DRR) => ok(undefined));
    const wiring = buildDurableResume({
      db,
      durabilityCfg: { enabled: true, staleHeartbeatMs: 1_000, keepAliveMs: 250, recoveryBudgetMs: 5_000 },
      boundedAutonomy: boundedAutonomy as never,
      sharedLeaseManager: makeLeaseManager(),
      channelAdaptersRef: new Map(),
      eventBus: { emit: vi.fn() } as never,
      logger: silentLogger,
      clock: testClock,
      timers: testTimers,
      resumeGraph,
    });

    // A DAG record: spawn_tree entries are {nodeId,status} objects with one
    // incomplete (running) node ⇒ the DAG discriminator is true.
    await seed(wiring.durableResume.durableRunStore!, "root-dag", [
      { nodeId: "A", status: "completed" },
      { nodeId: "B", status: "running", runId: "rb" },
    ]);

    await wiring.startAndResumeDurable();
    wiring.durableResume.shutdown();

    // The DAG record routed to resumeGraph; the flat re-anchor was NOT used for it.
    expect(resumeGraph).toHaveBeenCalledTimes(1);
    expect(resumeGraph.mock.calls[0]![0].rootRunId).toBe("root-dag");
    expect(boundedAutonomy.registerRoot).not.toHaveBeenCalled();
  });

  it("routes a FLAT record (string[] spawn_tree) to the flat re-anchor, NEVER to resumeGraph (no mis-route)", async () => {
    const db = await makeDb();
    const boundedAutonomy = makeBoundedAutonomy();
    const resumeGraph = vi.fn(async (_record: DRR) => ok(undefined));
    const wiring = buildDurableResume({
      db,
      durabilityCfg: { enabled: true, staleHeartbeatMs: 1_000, keepAliveMs: 250, recoveryBudgetMs: 5_000 },
      boundedAutonomy: boundedAutonomy as never,
      sharedLeaseManager: makeLeaseManager(),
      channelAdaptersRef: new Map(),
      eventBus: { emit: vi.fn() } as never,
      logger: silentLogger,
      clock: testClock,
      timers: testTimers,
      resumeGraph,
    });

    // A FLAT record: spawn_tree is a plain string[] of node/lease ids.
    await seed(wiring.durableResume.durableRunStore!, "root-flat", ["lease-a", "lease-b"]);

    await wiring.startAndResumeDurable();
    wiring.durableResume.shutdown();

    // The flat record took the flat re-anchor; resumeGraph was NEVER consulted.
    expect(boundedAutonomy.registerRoot).toHaveBeenCalledTimes(1);
    expect(boundedAutonomy.registerRoot.mock.calls[0]![0]).toBe("root-flat");
    expect(resumeGraph).not.toHaveBeenCalled();
  });
});
