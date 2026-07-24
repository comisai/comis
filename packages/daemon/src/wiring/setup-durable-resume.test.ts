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
import {
  TypedEventBus,
  createConversationRef,
  tryGetContext,
  type ClockPort,
  type TimerPort,
  type TimerHandle,
  type DurableRunRecord,
  type DurableRunPort,
  type WorkspacePolicySnapshot,
} from "@comis/core";
import { ok, type Result } from "@comis/shared";
import type { ComisLogger, LeaseManager } from "@comis/infra";
import { safeResultRunId } from "@comis/skills/tools";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setupDurableResume,
  buildDurableResume,
  buildOrchestrateResumeWiring,
  verifyOrchestrateResumable,
  type SetupDurableResumeDeps,
} from "./setup-durable-resume.js";

const DURABLE_ENDPOINT = {
  channelType: "telegram",
  channelInstanceId: "telegram-main",
  conversationId: "chat-a",
  conversationKind: "direct" as const,
};
const DURABLE_SCOPE = {
  tenantId: "tenant-a",
  agentId: "agent-a",
  partition: {
    kind: "endpoint-conversation-principal" as const,
    endpoint: DURABLE_ENDPOINT,
    principalId: "user-a",
  },
};
const durableConversationReference = createConversationRef(DURABLE_SCOPE);
if (!durableConversationReference.ok) throw durableConversationReference.error;
const DURABLE_AUTHORITY = {
  tenantId: "tenant-a",
  agentId: "agent-a",
  conversationRef: durableConversationReference.value,
  conversationScope: DURABLE_SCOPE,
  principalId: "user-a",
};
function durableAuthority(agentId: string): Pick<DurableRunRecord, "tenantId" | "agentId" | "conversationRef" | "conversationScope" | "principalId"> {
  const conversationScope = { ...DURABLE_SCOPE, agentId };
  const reference = createConversationRef(conversationScope);
  if (!reference.ok) throw reference.error;
  return {
    tenantId: "tenant-a",
    agentId,
    conversationRef: reference.value,
    conversationScope,
    principalId: "user-a",
  };
}
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
async function seedRunningRun(
  store: DurableRunPort,
  rootRunId: string,
  lastHeartbeatAt = testClock.now(),
): Promise<void> {
  const r = await store.upsertCheckpoint({
    checkpointId: `checkpoint-${rootRunId}`,
    rootRunId,
    ...DURABLE_AUTHORITY,
    deliveryOrigin: null,
    spawnTree: [rootRunId],
    caps: ["orch:read"],
    leaseIds: ["lease-x"],
    budgetConsumed: 0,
    rootBudget: { startedAtMs: lastHeartbeatAt, tokensConsumed: 0, usdConsumed: 0 },
    cronOrigin: null,
    trustLevel: "user",
    status: "running",
    lastHeartbeatAt,
    scriptRef: null,
    checkpointRef: null,
  });
  if (!r.ok) throw r.error;
}

function baseDeps(db: unknown, over: Partial<SetupDurableResumeDeps> = {}): SetupDurableResumeDeps {
  return {
    db,
    config: { enabled: true, staleHeartbeatMs: 1_000, recoveryBudgetMs: 5_000 },
    eventBus: new TypedEventBus(),
    logger: silentLogger,
    remintLease: vi.fn(() => ({ leaseId: "lease-1", bearer: "bearer-1" })),
    resumeRun: vi.fn(async (_record: DurableRunRecord, _lease: { leaseId: string; bearer: string }) => ok(undefined)),
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
      checkpointId: "checkpoint-root-stale",
      rootRunId: "root-stale",
      ...DURABLE_AUTHORITY,
      deliveryOrigin: null,
      spawnTree: ["root-stale"],
      caps: ["orch:read"],
      leaseIds: ["lease-y"],
      budgetConsumed: 0,
      rootBudget: {
        startedAtMs: testClock.now() - 10_000,
        tokensConsumed: 0,
        usdConsumed: 0,
      },
      cronOrigin: null,
      trustLevel: "user",
      status: "running",
      lastHeartbeatAt: testClock.now() - 10_000, // 10s ago, well past the 1s threshold
      scriptRef: null,
      checkpointRef: null,
    });

    await result.resumeAndStart();
    const afterBoot = (deps.resumeRun as ReturnType<typeof vi.fn>).mock.calls.length;

    // Advance past a watchdog interval — the tick detects the stale run + resumes.
    // The first tick lands exactly on the strict stale boundary and must not
    // duplicate recovery. The second tick is the first one past the boundary.
    await vi.advanceTimersByTimeAsync(2_100);
    expect((deps.resumeRun as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(afterBoot);

    result.shutdown();
  });

  it("the watchdog claims only the stale checkpoint and leaves a fresh sibling running", async () => {
    const db = await makeDb();
    const deps = baseDeps(db, {
      config: { enabled: true, staleHeartbeatMs: 1_000, recoveryBudgetMs: 5_000 },
    });
    const result = setupDurableResume(deps);
    await result.resumeAndStart();

    const now = testClock.now();
    await seedRunningRun(result.durableRunStore!, "root-watchdog-stale", now - 10_000);
    await seedRunningRun(result.durableRunStore!, "root-watchdog-fresh", now);

    await vi.advanceTimersByTimeAsync(1_000);

    const resumedRoots = (deps.resumeRun as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as DurableRunRecord).rootRunId,
    );
    expect(resumedRoots).toEqual(["root-watchdog-stale"]);
    const fresh = await result.durableRunStore!.getByCheckpoint("checkpoint-root-watchdog-fresh");
    expect(fresh.ok && fresh.value?.status).toBe("running");
    result.shutdown();
  });

  it("the watchdog parks outward uncertainty even when the durable run backlog is empty", async () => {
    const db = await makeDb();
    const result = setupDurableResume(baseDeps(db));
    await result.resumeAndStart();

    expect(await result.outwardLedger!.begin({
      rootRunId: "root-outward-only",
      stepIndex: 0,
      agentId: "agent-a",
      channelType: "telegram",
      channelId: "chat-a",
      operationKind: "message_send",
      operationFingerprint: "b".repeat(64),
      contentDigest: "a".repeat(64),
    })).toEqual({ ok: true, value: undefined });

    await vi.advanceTimersByTimeAsync(1_100);

    const parked = await result.outwardLedger!.lookup("root-outward-only", 0);
    expect(parked.ok && parked.value?.state).toBe("unresolved");
    result.shutdown();
  });

  it("overlapping watchdog ticks share one in-flight recovery pass", async () => {
    const db = await makeDb();
    let finishResume: ((result: Result<void, Error>) => void) | undefined;
    const resumeRun = vi.fn(() => new Promise<Result<void, Error>>(
      (resolve) => { finishResume = resolve; },
    ));
    const deps = baseDeps(db, { resumeRun });
    const result = setupDurableResume(deps);
    await result.resumeAndStart();
    await seedRunningRun(
      result.durableRunStore!,
      "root-overlap",
      testClock.now() - 10_000,
    );

    await vi.advanceTimersByTimeAsync(3_100);

    expect(resumeRun).toHaveBeenCalledTimes(1);
    finishResume?.(ok(undefined));
    await vi.advanceTimersByTimeAsync(0);
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
      checkpointId: `checkpoint-${rootRunId}`,
      rootRunId,
      ...DURABLE_AUTHORITY,
      deliveryOrigin: null,
      spawnTree,
      caps: ["orch:read"],
      leaseIds: [`lease-${rootRunId}`],
      budgetConsumed: 0,
      rootBudget: { startedAtMs: testClock.now(), tokensConsumed: 0, usdConsumed: 0 },
      cronOrigin: null,
      trustLevel: "user",
      status: "running",
      lastHeartbeatAt: testClock.now(),
      scriptRef: null,
      checkpointRef: spawnTree.length > 0 && typeof spawnTree[0] === "object"
        ? `graph-runs/${rootRunId}/durable-checkpoint.json`
        : null,
      resumeDescriptorHash: "a".repeat(64),
      workspacePolicyHash: "b".repeat(64),
    });
    if (!r.ok) throw r.error;
  }

  function makeBoundedAutonomy() {
    return {
      registerRoot: vi.fn(),
      leaseIdsForRoot: vi.fn(() => new Set<string>()),
      rehydrateBudget: vi.fn(),
      evictRootIfIdle: vi.fn(),
      exportBudgetState: vi.fn(() => ({
        startedAtMs: testClock.now(),
        tokensConsumed: 0,
        usdConsumed: 0,
      })),
    };
  }

  function makeLeaseManager(): LeaseManager {
    return {
      mintLease: vi.fn(() => ({ leaseId: "lease-x", bearer: "bearer-x" })),
      revoke: vi.fn(() => ({ revoked: 1 })),
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
      eventBus: new TypedEventBus(),
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

  it("runs recovered work under an explicit durable-resume endpoint and principal", async () => {
    const db = await makeDb();
    const observed: unknown[] = [];
    const wiring = buildDurableResume({
      db,
      durabilityCfg: { enabled: true, staleHeartbeatMs: 1_000, keepAliveMs: 250, recoveryBudgetMs: 5_000 },
      boundedAutonomy: makeBoundedAutonomy() as never,
      sharedLeaseManager: makeLeaseManager(),
      eventBus: new TypedEventBus(),
      logger: silentLogger,
      clock: testClock,
      timers: testTimers,
      resumeGraph: vi.fn(async () => {
        observed.push(tryGetContext());
        return ok(undefined);
      }),
    });
    await seed(wiring.durableResume.durableRunStore!, "root-internal-resume", [
      { nodeId: "A", status: "running", runId: "run-a" },
    ]);

    await wiring.startAndResumeDurable();
    wiring.durableResume.shutdown();

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      agentId: "agent-a",
      tenantId: "tenant-a",
      channelType: "durable-resume",
      turnScope: {
        principal: { principalId: expect.stringMatching(/^durable-resume-/) },
        endpoint: {
          channelType: "durable-resume",
          channelInstanceId: "daemon",
        },
      },
    });
  });

  it("routes a FLAT record (string[] spawn_tree) to the flat re-anchor, NEVER to resumeGraph (no mis-route)", async () => {
    const db = await makeDb();
    const boundedAutonomy = makeBoundedAutonomy();
    const resumeGraph = vi.fn(async (_record: DRR) => ok(undefined));
    const policySnapshot: WorkspacePolicySnapshot = {
      agentId: "agent-a",
      sections: [],
      combinedHash: "b".repeat(64),
    };
    const resumePlain = vi.fn(async (_record: DRR) => ok(undefined));
    const wiring = buildDurableResume({
      db,
      durabilityCfg: { enabled: true, staleHeartbeatMs: 1_000, keepAliveMs: 250, recoveryBudgetMs: 5_000 },
      boundedAutonomy: boundedAutonomy as never,
      sharedLeaseManager: makeLeaseManager(),
      eventBus: new TypedEventBus(),
      logger: silentLogger,
      clock: testClock,
      timers: testTimers,
      resumeGraph,
      resumePlain,
      resolveWorkspacePolicy: async () => ok(policySnapshot),
    });

    // A FLAT record: spawn_tree is a plain string[] of node/lease ids.
    await seed(wiring.durableResume.durableRunStore!, "root-flat", ["lease-a", "lease-b"]);

    await wiring.startAndResumeDurable();
    wiring.durableResume.shutdown();

    // The flat record took the flat re-anchor; resumeGraph was NEVER consulted.
    expect(boundedAutonomy.registerRoot).toHaveBeenCalledTimes(1);
    expect(boundedAutonomy.registerRoot.mock.calls[0]![0]).toBe("root-flat");
    expect(resumeGraph).not.toHaveBeenCalled();
    expect(resumePlain).toHaveBeenCalledOnce();
    expect(resumePlain.mock.calls[0]![2]).toBe(policySnapshot);
  });

  it("orphans a DAG checkpoint when graph recovery is not wired", async () => {
    const db = await makeDb();
    const boundedAutonomy = makeBoundedAutonomy();
    const leaseManager = makeLeaseManager();
    const wiring = buildDurableResume({
      db,
      durabilityCfg: { enabled: true, staleHeartbeatMs: 1_000, keepAliveMs: 250, recoveryBudgetMs: 5_000 },
      boundedAutonomy: boundedAutonomy as never,
      sharedLeaseManager: leaseManager,
      eventBus: new TypedEventBus(),
      logger: silentLogger,
      clock: testClock,
      timers: testTimers,
    });

    await seed(wiring.durableResume.durableRunStore!, "root-dag-unwired", [
      { nodeId: "A", status: "running", runId: "run-a" },
    ]);
    await wiring.startAndResumeDurable();
    wiring.durableResume.shutdown();

    expect(boundedAutonomy.registerRoot).not.toHaveBeenCalled();
    expect(boundedAutonomy.evictRootIfIdle).toHaveBeenCalledWith("root-dag-unwired");
    expect(leaseManager.revoke).toHaveBeenCalledWith("lease-x");
    const resumable = await wiring.durableResume.durableRunStore!.listResumable();
    expect(resumable.ok && resumable.value.records).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildOrchestrateResumeWiring — the production OrchestrateResumeWiring cluster
// the composition root threads into buildDurableResume so the boot-sweep arm
// VERIFIES a resumable orchestrate row's pinned script + checkpoint on disk and
// the orphan path RECLAIMS a dead run's artifacts. The seams are real fs ops
// exercised against a temporary workspace.
// ---------------------------------------------------------------------------
describe("buildOrchestrateResumeWiring (the composition-root cluster)", () => {
  function makeWiringLogger(): ComisLogger {
    const noop = () => {};
    const l = { debug: noop, info: noop, warn: noop, error: noop } as unknown as ComisLogger;
    (l as unknown as { child: () => ComisLogger }).child = () => l;
    return l;
  }

  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "comis-orwiring-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves workspaceFor by the durable record's persisted agentId", () => {
    const wiring = buildOrchestrateResumeWiring({
      workspaceDirs: new Map([["agent-a", tmp]]),
      logger: makeWiringLogger(),
    });
    const record = { agentId: "agent-a", rootRunId: "orch-x", scriptRef: "orch-x.ts" } as unknown as DurableRunRecord;
    expect(wiring.workspaceFor(record)).toBe(tmp);
  });

  it("verifies a recovered record only in the workspace persisted for its agentId", () => {
    const defaultWorkspace = join(tmp, "workspace");
    const researcherWorkspace = join(tmp, "workspace-researcher");
    mkdirSync(defaultWorkspace, { recursive: true });
    mkdirSync(researcherWorkspace, { recursive: true });
    writeFileSync(join(researcherWorkspace, "orch-research.ts"), "console.log('research');");
    const wiring = buildOrchestrateResumeWiring({
      workspaceDirs: new Map([
        ["default", defaultWorkspace],
        ["researcher", researcherWorkspace],
      ]),
      logger: makeWiringLogger(),
    });
    const record = {
      checkpointId: "checkpoint-research",
      rootRunId: "root-research",
      ...durableAuthority("researcher"),
      deliveryOrigin: {
        tenantId: "tenant-a",
        userId: "user-a",
        channelType: "telegram",
        channelId: "chat-a",
      },
      spawnTree: [],
      caps: [],
      leaseIds: [],
      budgetConsumed: 0,
      rootBudget: { startedAtMs: 1, tokensConsumed: 0, usdConsumed: 0 },
      cronOrigin: null,
      trustLevel: "user",
      status: "running",
      lastHeartbeatAt: 1,
      scriptRef: "orch-research.ts",
      checkpointRef: null,
    } satisfies DurableRunRecord;

    expect(wiring.workspaceFor(record)).toBe(researcherWorkspace);
    expect(verifyOrchestrateResumable(record, wiring)).toEqual({ ok: true, value: undefined });
  });

  it("fileExists reflects the real existsSync (present → true, absent → false)", () => {
    const wiring = buildOrchestrateResumeWiring({ workspaceDirs: new Map([["agent-a", tmp]]), logger: makeWiringLogger() });
    const present = join(tmp, "orch-x.ts");
    writeFileSync(present, "console.log(1)");
    expect(wiring.fileExists(present)).toBe(true);
    expect(wiring.fileExists(join(tmp, "gone.ts"))).toBe(false);
  });

  it("cleanupResults deletes only the selected run's isolated results directory", async () => {
    const wiring = buildOrchestrateResumeWiring({ workspaceDirs: new Map([["agent-a", tmp]]), logger: makeWiringLogger() });
    const resultsRoot = join(tmp, "results");
    const resultsDir = join(resultsRoot, safeResultRunId("orch-x"));
    const siblingDir = join(resultsRoot, safeResultRunId("orch-y"));
    mkdirSync(resultsDir, { recursive: true });
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(join(resultsDir, "checkpoint.json"), "{}");
    writeFileSync(join(siblingDir, "checkpoint.json"), "{}");
    await wiring.cleanupResults(tmp, "orch-x");
    expect(existsSync(resultsDir)).toBe(false);
    expect(existsSync(siblingDir)).toBe(true);
  });

  it("removePinnedScript deletes the workspace-root pinned script and is idempotent", () => {
    const wiring = buildOrchestrateResumeWiring({ workspaceDirs: new Map([["agent-a", tmp]]), logger: makeWiringLogger() });
    const pinned = join(tmp, "orch-x.ts");
    writeFileSync(pinned, "console.log(1)");
    wiring.removePinnedScript(tmp, "orch-x.ts");
    expect(existsSync(pinned)).toBe(false);
    // A second reclaim finds it already gone — no throw (idempotent).
    expect(() => wiring.removePinnedScript(tmp, "orch-x.ts")).not.toThrow();
  });

  it("removePinnedScript refuses a traversal scriptRef — never deletes outside the workspace", () => {
    const wiring = buildOrchestrateResumeWiring({ workspaceDirs: new Map([["agent-a", tmp]]), logger: makeWiringLogger() });
    // A sibling file OUTSIDE the workspace that a `../` scriptRef would target.
    const outsideDir = mkdtempSync(join(tmpdir(), "comis-outside-"));
    const victim = join(outsideDir, "victim.ts");
    writeFileSync(victim, "secret");
    // A traversal ref must be refused by safePath (no throw escapes, no delete).
    expect(() => wiring.removePinnedScript(tmp, "../" + join("..", outsideDir.split("/").pop()!, "victim.ts"))).not.toThrow();
    expect(existsSync(victim)).toBe(true);
    rmSync(outsideDir, { recursive: true, force: true });
  });
});
