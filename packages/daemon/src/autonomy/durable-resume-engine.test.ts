// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the durable resume engine, covering both units:
 *   - `reconcileLedgerRow` — atomic uncertainty parking and escalation without
 *     a channel-history query or replay.
 *   - `createDurableResumeEngine` — resume-or-orphan + cap rehydrate + bounded
 *     recovery.
 *
 * The stubs (a recording ledger, notify spy, and fake clock) keep the engine
 * exhaustively unit-testable with no real I/O — it
 * is bound to the real stores / LeaseManager / channel adapters by the wiring.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { ok, err, type Result } from "@comis/shared";
import {
  TypedEventBus,
  type OutwardSendLedgerPort,
  type OutwardSendRecord,
  type OutwardSendState,
  type DurableRunRecord,
  type DurableRunPort,
  type InvalidDurableRunCheckpoint,
  type ClockPort,
  type TimerPort,
  type TimerHandle,
} from "@comis/core";
import type { ComisLogger, LeaseManager } from "@comis/infra";
import {
  reconcileLedgerRow,
  createDurableResumeEngine,
  orphanReasonToEnum,
  reclaimOrphanedOrchestrateRun,
  type ReconcileLedgerDeps,
  type DurableResumeEngineDeps,
  type OrchestrateReclaimSeams,
} from "./durable-resume-engine.js";
import {
  verifyOrchestrateResumable,
  buildDurableResume,
  type OrchestrateResumeSeams,
  type OrchestrateResumeWiring,
} from "../wiring/setup-durable-resume.js";
import { createResultRefStore, safeResultRunId } from "@comis/skills/tools";
import {
  createSqliteDurableRunStore,
  createSqliteOutwardSendLedger,
  ensureDurableRunTable,
  ensureOutwardLedgerTable,
} from "@comis/memory";

// ─── test logger (records nothing; the engine never inspects it) ──────────────
function makeLogger() {
  const calls: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const method =
    (level: string) =>
    (obj: Record<string, unknown>, msg: string): void => {
      calls.push({ level, obj, msg });
    };
  return {
    calls,
    level: "info",
    trace: method("trace"),
    debug: method("debug"),
    info: method("info"),
    warn: method("warn"),
    error: method("error"),
    fatal: method("fatal"),
    audit: method("audit"),
    child(): ReturnType<typeof makeLogger> {
      return makeLogger();
    },
  };
}

// ─── content-free eventBus spy (the engine emits transition events) ───────────
function makeEventBus() {
  const events: { event: string; payload: Record<string, unknown> }[] = [];
  const eventBus = new TypedEventBus();
  eventBus.on("delivery:outward_ledger_transition", (payload) => {
    events.push({ event: "delivery:outward_ledger_transition", payload });
  });
  eventBus.on("durable:orphaned", (payload) => {
    events.push({ event: "durable:orphaned", payload });
  });
  eventBus.on("durable:resumed", (payload) => {
    events.push({ event: "durable:resumed", payload });
  });
  return Object.assign(eventBus, { events });
}

// ─── a recording ledger stub: tracks every method call, returns ok by default ─
interface LedgerCall {
  method: string;
  args: unknown[];
}
function makeLedger(opts?: {
  unreconciled?: OutwardSendRecord[];
  lookupRow?: OutwardSendRecord;
  uncertaintyRoots?: readonly string[];
  uncertaintyResult?: Result<boolean, Error>;
  parkResult?: Result<boolean, Error>;
}): OutwardSendLedgerPort & { calls: LedgerCall[] } {
  const calls: LedgerCall[] = [];
  const uncertainRoots = new Set(opts?.uncertaintyRoots ?? []);
  let pending = [...(opts?.unreconciled ?? [])];
  const record = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args });
  };
  return {
    calls,
    allocateStep: async (rootRunId, operationId) => {
      record("allocateStep", rootRunId, operationId);
      return ok(0);
    },
    lookup: async (rootRunId, stepIndex) => {
      record("lookup", rootRunId, stepIndex);
      return ok(opts?.lookupRow);
    },
    begin: async (input) => {
      record("begin", input);
      return ok(undefined);
    },
    markUnknown: async (rootRunId, stepIndex) => {
      record("markUnknown", rootRunId, stepIndex);
      return ok(undefined);
    },
    commit: async (rootRunId, stepIndex, platformMessageId) => {
      record("commit", rootRunId, stepIndex, platformMessageId);
      return ok(undefined);
    },
    markFailed: async (rootRunId, stepIndex, errorKind) => {
      record("markFailed", rootRunId, stepIndex, errorKind);
      return ok(undefined);
    },
    parkUncertain: async (rootRunId, stepIndex) => {
      record("parkUncertain", rootRunId, stepIndex);
      const result = opts?.parkResult ?? ok(true);
      if (result.ok && result.value) {
        uncertainRoots.add(rootRunId);
        pending = pending.filter(
          (row) => row.rootRunId !== rootRunId || row.stepIndex !== stepIndex,
        );
      }
      return result;
    },
    hasUncertainty: async (rootRunId) => {
      record("hasUncertainty", rootRunId);
      return opts?.uncertaintyResult ?? ok(uncertainRoots.has(rootRunId));
    },
    listUnreconciled: async (limit) => {
      record("listUnreconciled", limit);
      return ok(pending.slice(0, limit));
    },
  };
}

// ─── a single unknown_after_send ledger row ──────────────────────────────────
function ledgerRow(overrides?: Partial<OutwardSendRecord>): OutwardSendRecord {
  return {
    id: "root-1:0",
    rootRunId: "root-1",
    stepIndex: 0,
    agentId: "agent-a",
    channelType: "echo",
    channelId: "chan-1",
    state: "unknown_after_send" as OutwardSendState,
    operationKind: "message_send",
    operationFingerprint: "b".repeat(64),
    contentDigest: "a".repeat(64),
    attemptCount: 1,
    attemptedAtMs: 100_000,
    ...overrides,
  };
}

function makeReconcileDeps(
  overrides: Partial<ReconcileLedgerDeps>,
): ReconcileLedgerDeps {
  return {
    ledger: makeLedger(),
    notify: vi.fn(),
    nowMs: () => 1_000_000,
    logger: makeLogger(),
    eventBus: makeEventBus(),
    ...overrides,
  };
}

describe("reconcileLedgerRow conservative recovery parking", () => {
  it("atomically parks an uncertain row and only records the parking transition", async () => {
    const ledger = makeLedger();
    const notify = vi.fn();
    const deps = makeReconcileDeps({ ledger, notify });

    const r = await reconcileLedgerRow(ledgerRow(), deps);

    expect(r).toEqual({ ok: true, value: "parked" });
    expect(ledger.calls.map((call) => call.method)).toEqual(["parkUncertain"]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does not notify when another recovery worker already won the park", async () => {
    const ledger = makeLedger({ parkResult: ok(false) });
    const notify = vi.fn();
    const deps = makeReconcileDeps({ ledger, notify });

    const r = await reconcileLedgerRow(ledgerRow(), deps);

    expect(r).toEqual({ ok: true, value: "parked" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("fails closed when the atomic park write fails", async () => {
    const ledger = makeLedger({ parkResult: err(new Error("Bearer secret-value")) });
    const logger = makeLogger();
    const notify = vi.fn();
    const deps = makeReconcileDeps({
      ledger,
      logger,
      notify,
    });

    const result = await reconcileLedgerRow(ledgerRow(), deps);

    expect(result.ok).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.calls)).not.toContain("secret-value");
  });

  it("emits one content-free parked transition for the atomic winner", async () => {
    const ledger = makeLedger();
    const notify = vi.fn();
    const eventBus = makeEventBus();
    const deps = makeReconcileDeps({
      ledger,
      notify,
      eventBus,
    });

    const result = await reconcileLedgerRow(ledgerRow(), deps);

    expect(result.ok).toBe(true);
    expect(ledger.calls.some((call) => call.method === "commit")).toBe(false);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "send_unresolved" }));
    expect(eventBus.events).toContainEqual({
      event: "delivery:outward_ledger_transition",
      payload: expect.objectContaining({ transition: "park", outcome: "parked" }),
    });
  });

  it("two SQLite connections atomically park once and only the winner notifies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-outward-park-"));
    const dbPath = join(dir, "memory.db");
    const dbA = new Database(dbPath);
    const dbB = new Database(dbPath);
    try {
      ensureOutwardLedgerTable(dbA);
      ensureOutwardLedgerTable(dbB);
      const ledgerA = createSqliteOutwardSendLedger(dbA, () => 250_000);
      const ledgerB = createSqliteOutwardSendLedger(dbB, () => 250_000);
      expect(await ledgerA.begin({
        rootRunId: "root-concurrent",
        stepIndex: 0,
        agentId: "agent-a",
        channelType: "echo",
        channelId: "chan-a",
        operationKind: "message_send",
        operationFingerprint: "c".repeat(64),
        contentDigest: "b".repeat(64),
      })).toEqual({ ok: true, value: undefined });
      expect(await ledgerA.markUnknown("root-concurrent", 0))
        .toEqual({ ok: true, value: undefined });
      const rowA = await ledgerA.lookup("root-concurrent", 0);
      const rowB = await ledgerB.lookup("root-concurrent", 0);
      if (!rowA.ok || rowA.value === undefined || !rowB.ok || rowB.value === undefined) {
        throw new Error("test ledger row unavailable");
      }
      const notifyA = vi.fn();
      const notifyB = vi.fn();

      const [first, second] = await Promise.all([
        reconcileLedgerRow(rowA.value, makeReconcileDeps({ ledger: ledgerA, notify: notifyA })),
        reconcileLedgerRow(rowB.value, makeReconcileDeps({ ledger: ledgerB, notify: notifyB })),
      ]);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(notifyA.mock.calls.length + notifyB.mock.calls.length).toBe(1);
      const final = await ledgerA.lookup("root-concurrent", 0);
      expect(final.ok && final.value?.state).toBe("unresolved");
    } finally {
      dbB.close();
      dbA.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parks send_attempt_started rows that crashed before the live send returned", async () => {
    const ledger = makeLedger();
    const notify = vi.fn();
    const deps = makeReconcileDeps({ ledger, notify });

    const r = await reconcileLedgerRow(ledgerRow({ state: "send_attempt_started" }), deps);

    expect(r.ok).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(ledger.calls.find((c) => c.method === "parkUncertain")).toBeDefined();
    expect(ledger.calls.find((c) => c.method === "commit")).toBeUndefined();
  });

  it("keeps recovery notification and events content-free", async () => {
    const ledger = makeLedger();
    const notify = vi.fn();
    const eventBus = makeEventBus();
    const deps = makeReconcileDeps({ ledger, notify, eventBus });

    const r = await reconcileLedgerRow(ledgerRow(), deps);

    expect(r.ok).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(notify.mock.calls)).not.toContain("a".repeat(64));
    expect(JSON.stringify(eventBus.events)).not.toContain("a".repeat(64));
  });

  it("parks safely when no event emitter is configured", async () => {
    const ledger = makeLedger();
    const notify = vi.fn();
    const deps = makeReconcileDeps({ ledger, notify, eventBus: undefined });

    const r = await reconcileLedgerRow(ledgerRow(), deps);

    expect(r.ok).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("parks reaction uncertainty without fabricating a platform message id", async () => {
    const ledger = makeLedger();
    const deps = makeReconcileDeps({ ledger });

    const r = await reconcileLedgerRow(
      ledgerRow({ operationKind: "message_react" }),
      deps,
    );

    expect(r.ok).toBe(true);
    expect(ledger.calls.find((c) => c.method === "markFailed")).toBeUndefined();
    expect(ledger.calls.find((c) => c.method === "commit")).toBeUndefined();
  });

  it("never mutates a row beyond the single atomic park operation", async () => {
    const ledger = makeLedger();
    const deps = makeReconcileDeps({ ledger });

    const r = await reconcileLedgerRow(ledgerRow(), deps);

    expect(r.ok).toBe(true);
    expect(ledger.calls).toEqual([
      { method: "parkUncertain", args: ["root-1", 0] },
    ]);
  });

  it("an already-committed row is a pure no-op", async () => {
    const ledger = makeLedger();
    const notify = vi.fn();
    const deps = makeReconcileDeps({ ledger, notify });

    const r = await reconcileLedgerRow(ledgerRow({ state: "committed" }), deps);

    expect(r.ok).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    expect(ledger.calls).toHaveLength(0); // pure no-op
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 3: createDurableResumeEngine
// ─────────────────────────────────────────────────────────────────────────────

const VALID_CAPS: DurableRunRecord["caps"] = ["orch:read", "orch:message"];

function durableRecord(overrides?: Partial<DurableRunRecord>): DurableRunRecord {
  const rootRunId = overrides?.rootRunId ?? "root-1";
  return {
    checkpointId: overrides?.checkpointId ?? `checkpoint-${rootRunId}`,
    rootRunId,
    agentId: "agent-a",
    sessionKey: "tenant-a:user-a:chat-a",
    ownerTenantId: "tenant-a",
    ownerUserId: "user-a",
    deliveryOrigin: null,
    spawnTree: ["lease-1"],
    caps: VALID_CAPS,
    leaseIds: ["lease-1"],
    budgetConsumed: 0,
    rootBudget: { startedAtMs: 400_000, tokensConsumed: 0, usdConsumed: 0 },
    cronOrigin: null,
    trustLevel: "user",
    status: "running",
    lastHeartbeatAt: 500_000,
    scriptRef: null,
    checkpointRef: null,
    ...overrides,
  };
}

interface DurableCall {
  method: string;
  args: unknown[];
}
function makeDurableRuns(opts?: {
  resumable?: DurableRunRecord[];
  invalid?: InvalidDurableRunCheckpoint[];
  byCheckpoint?: Map<string, DurableRunRecord>;
}): DurableRunPort & { calls: DurableCall[] } {
  const calls: DurableCall[] = [];
  const rec = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args });
  };
  return {
    calls,
    upsertCheckpoint: async (r) => {
      rec("upsertCheckpoint", r);
      return ok(undefined);
    },
    listResumable: async () => {
      rec("listResumable");
      return ok({ records: opts?.resumable ?? [], invalid: opts?.invalid ?? [] });
    },
    getByCheckpoint: async (checkpointId) => {
      rec("getByCheckpoint", checkpointId);
      const found = opts?.byCheckpoint?.get(checkpointId)
        ?? [...(opts?.byCheckpoint?.values() ?? [])]
          .find((record) => record.checkpointId === checkpointId);
      // default: echo a running record so the re-read passes unless overridden
      return ok(found ?? opts?.resumable?.find((r) => r.checkpointId === checkpointId));
    },
    claimForResume: async (claim) => {
      rec("claimForResume", claim);
      const found = opts?.byCheckpoint?.get(claim.checkpointId)
        ?? opts?.resumable?.find((record) => record.checkpointId === claim.checkpointId);
      return found === undefined
        ? ok({ kind: "not_found" as const })
        : ok({ kind: "claimed" as const, record: found });
    },
    markOrphaned: async (rootRunId, reason) => {
      rec("markOrphaned", rootRunId, reason);
      return ok(undefined);
    },
    markCompleted: async (rootRunId) => {
      rec("markCompleted", rootRunId);
      return ok(undefined);
    },
    touchHeartbeat: async (rootRunId, atMs) => {
      rec("touchHeartbeat", rootRunId, atMs);
      return ok(undefined);
    },
    invalidateForRevoke: async (rootRunId) => {
      rec("invalidateForRevoke", rootRunId);
      return ok(undefined);
    },
    countByStatus: async () => ok({ orphaned: 0, revoked: 0, running: 0, completed: 0 }),
  };
}

function makeEngineDeps(overrides: Partial<DurableResumeEngineDeps>): DurableResumeEngineDeps {
  return {
    durableRuns: makeDurableRuns(),
    ledger: makeLedger(),
    remintLease: vi.fn((input) => ({ leaseId: `lease-for-${input.rootRunId}`, bearer: "bearer-x" })),
    resumeRun: vi.fn(async () => ok(undefined)),
    notify: vi.fn(),
    nowMs: () => 1_000_000,
    recoveryBudgetMs: 60_000,
    logger: makeLogger(),
    eventBus: makeEventBus(),
    ...overrides,
  };
}

describe("createDurableResumeEngine resume-or-orphan and bounded recovery", () => {
  it("two engines racing the same SQLite source mint and resume exactly one replacement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-resume-engine-race-"));
    const dbPath = join(dir, "memory.db");
    const dbA = new Database(dbPath);
    const dbB = new Database(dbPath);
    try {
      ensureDurableRunTable(dbA);
      ensureOutwardLedgerTable(dbA);
      ensureDurableRunTable(dbB);
      ensureOutwardLedgerTable(dbB);
      const storeA = createSqliteDurableRunStore(dbA, () => 2_000);
      const storeB = createSqliteDurableRunStore(dbB, () => 2_000);
      const source = durableRecord({
        checkpointId: "checkpoint-race-source",
        rootRunId: "root-race-source",
        rootBudget: { startedAtMs: 500, tokensConsumed: 0, usdConsumed: 0 },
        lastHeartbeatAt: 1_000,
      });
      expect(await storeA.upsertCheckpoint(source)).toEqual({ ok: true, value: undefined });

      let claimArrivals = 0;
      let releaseClaims: (() => void) | undefined;
      const bothAtClaim = new Promise<void>((resolve) => { releaseClaims = resolve; });
      const observedSources: string[][] = [];
      const withClaimBarrier = (store: DurableRunPort): DurableRunPort => ({
        ...store,
        listResumable: async () => {
          const result = await store.listResumable();
          if (result.ok) observedSources.push(result.value.records.map((record) => record.checkpointId));
          return result;
        },
        claimForResume: async (claim) => {
          claimArrivals++;
          if (claimArrivals === 2) releaseClaims?.();
          await bothAtClaim;
          return store.claimForResume(claim);
        },
      });
      const mintA = vi.fn(() => ({ leaseId: "lease-a", bearer: "bearer-a" }));
      const mintB = vi.fn(() => ({ leaseId: "lease-b", bearer: "bearer-b" }));
      const resumeA = vi.fn(async () => ok(undefined));
      const resumeB = vi.fn(async () => ok(undefined));
      const notifyA = vi.fn();
      const notifyB = vi.fn();
      const eventA = makeEventBus();
      const eventB = makeEventBus();
      const engineA = createDurableResumeEngine(makeEngineDeps({
        durableRuns: withClaimBarrier(storeA),
        ledger: createSqliteOutwardSendLedger(dbA, () => 2_000),
        remintLease: mintA,
        resumeRun: resumeA,
        notify: notifyA,
        eventBus: eventA,
        nowMs: () => 2_000,
      }));
      const engineB = createDurableResumeEngine(makeEngineDeps({
        durableRuns: withClaimBarrier(storeB),
        ledger: createSqliteOutwardSendLedger(dbB, () => 2_000),
        remintLease: mintB,
        resumeRun: resumeB,
        notify: notifyB,
        eventBus: eventB,
        nowMs: () => 2_000,
      }));

      const outcomes = await Promise.all([engineA.resumeAll(), engineB.resumeAll()]);

      expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
      expect(claimArrivals).toBe(2);
      expect(observedSources).toEqual([
        [source.checkpointId],
        [source.checkpointId],
      ]);
      expect(mintA.mock.calls.length + mintB.mock.calls.length).toBe(1);
      expect(resumeA.mock.calls.length + resumeB.mock.calls.length).toBe(1);
      expect([resumeA.mock.calls.length, resumeB.mock.calls.length].sort()).toEqual([0, 1]);
      expect(notifyA).not.toHaveBeenCalled();
      expect(notifyB).not.toHaveBeenCalled();
      expect(
        eventA.events.filter((event) => event.event === "durable:resumed").length
        + eventB.events.filter((event) => event.event === "durable:resumed").length,
      ).toBe(1);
    } finally {
      dbB.close();
      dbA.close();
    }

    const verifyDb = new Database(dbPath);
    try {
      const verifyStore = createSqliteDurableRunStore(verifyDb, () => 3_000);
      const sourceAfterRace = await verifyStore.getByCheckpoint("checkpoint-race-source");
      expect(sourceAfterRace.ok && sourceAfterRace.value?.status).toBe("completed");
      const scan = await verifyStore.listResumable();
      expect(scan.ok && scan.value.records).toHaveLength(1);
      if (scan.ok) {
        expect(scan.value.records[0]?.checkpointId).toMatch(/^resume-/);
        expect(scan.value.records[0]?.status).toBe("running");
      }
    } finally {
      verifyDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves recovery authority when an observational resumed subscriber throws", async () => {
    const db = new Database(":memory:");
    try {
      ensureDurableRunTable(db);
      ensureOutwardLedgerTable(db);
      const store = createSqliteDurableRunStore(db, () => 2_000);
      const source = durableRecord({
        checkpointId: "checkpoint-observer-failure",
        rootRunId: "root-observer-failure",
        rootBudget: { startedAtMs: 500, tokensConsumed: 0, usdConsumed: 0 },
        lastHeartbeatAt: 1_000,
      });
      expect(await store.upsertCheckpoint(source)).toEqual({ ok: true, value: undefined });
      const eventBus = new TypedEventBus();
      eventBus.on("durable:resumed", () => {
        throw new Error("subscriber failure with untrusted details");
      });
      const laterSubscriber = vi.fn();
      eventBus.on("durable:resumed", laterSubscriber);
      const logger = makeLogger();

      const result = await createDurableResumeEngine(makeEngineDeps({
        durableRuns: store,
        ledger: createSqliteOutwardSendLedger(db, () => 2_000),
        eventBus,
        logger,
        nowMs: () => 2_000,
      })).resumeAll();

      expect(result).toEqual({ ok: true, value: { resumed: 1, orphaned: 0, deferred: 0 } });
      expect(laterSubscriber).toHaveBeenCalledTimes(1);
      const sourceAfter = await store.getByCheckpoint(source.checkpointId);
      expect(sourceAfter.ok && sourceAfter.value?.status).toBe("completed");
      const resumableAfter = await store.listResumable();
      expect(resumableAfter.ok && resumableAfter.value.records).toHaveLength(1);
      if (resumableAfter.ok) {
        expect(resumableAfter.value.records[0]?.checkpointId).toMatch(/^resume-/);
      }
      expect(logger.calls.some((call) =>
        call.level === "warn"
        && call.obj.eventName === "durable:resumed"
        && call.obj.subscriberFailureCount === 1
      )).toBe(true);
      expect(JSON.stringify(logger.calls)).not.toContain("untrusted details");
    } finally {
      db.close();
    }
  });

  it("parks a running DAG replacement when a Telegram outward effect remains crash-uncertain", async () => {
    const graph = durableRecord({
      checkpointId: "checkpoint-graph-uncertain",
      rootRunId: "root-graph-uncertain",
      spawnTree: [{ nodeId: "publish", status: "running", runId: "old-run" }],
      checkpointRef: "graph-runs/checkpoint-graph-uncertain/durable-checkpoint.json",
    });
    const durableRuns = makeDurableRuns({ resumable: [graph] });
    const ledger = makeLedger({
      unreconciled: [ledgerRow({
        rootRunId: graph.rootRunId,
        channelType: "telegram",
      })],
    });
    const remintLease = vi.fn(() => ({ leaseId: "must-not-mint", bearer: "must-not-mint" }));
    const resumeRun = vi.fn(async () => ok(undefined));

    const result = await createDurableResumeEngine(makeEngineDeps({
      durableRuns,
      ledger,
      remintLease,
      resumeRun,
    })).resumeAll();

    expect(result).toEqual({ ok: true, value: { resumed: 0, orphaned: 1, deferred: 0 } });
    expect(remintLease).not.toHaveBeenCalled();
    expect(resumeRun).not.toHaveBeenCalled();
    expect(durableRuns.calls.some((call) =>
      call.method === "markOrphaned" && String(call.args[0]).startsWith("resume-")
    )).toBe(true);
  });

  it("preserves checkpoint and replay evidence when outward delivery remains uncertain", async () => {
    const record = durableRecord({
      checkpointId: "checkpoint-preserve-uncertain",
      rootRunId: "root-preserve-uncertain",
      scriptRef: "orchestrate.py",
      checkpointRef: "results/checkpoint.json",
    });
    const reclaimOrchestrateRun = vi.fn(async () => {});

    const result = await createDurableResumeEngine(makeEngineDeps({
      durableRuns: makeDurableRuns({ resumable: [record] }),
      ledger: makeLedger({ uncertaintyRoots: [record.rootRunId] }),
      reclaimOrchestrateRun,
    })).resumeAll();

    expect(result).toEqual({ ok: true, value: { resumed: 0, orphaned: 1, deferred: 0 } });
    expect(reclaimOrchestrateRun).not.toHaveBeenCalled();
  });

  it("preserves checkpoint and replay evidence when the outward uncertainty query fails", async () => {
    const record = durableRecord({
      checkpointId: "checkpoint-preserve-query-failure",
      rootRunId: "root-preserve-query-failure",
      scriptRef: "orchestrate.py",
      checkpointRef: "results/checkpoint.json",
    });
    const reclaimOrchestrateRun = vi.fn(async () => {});
    const queryFailure = new Error("outward store unavailable");

    const result = await createDurableResumeEngine(makeEngineDeps({
      durableRuns: makeDurableRuns({ resumable: [record] }),
      ledger: makeLedger({ uncertaintyResult: err(queryFailure) }),
      reclaimOrchestrateRun,
    })).resumeAll();

    expect(result).toEqual({ ok: false, error: queryFailure });
    expect(reclaimOrchestrateRun).not.toHaveBeenCalled();
  });

  it("orphans an invalid persisted principal while resuming unrelated valid checkpoints", async () => {
    const valid = durableRecord({ rootRunId: "root-valid" });
    const invalid: InvalidDurableRunCheckpoint = {
      checkpointId: "checkpoint-invalid",
      rootRunId: "root-invalid",
      reason: "record_validation_failed",
    };
    const durableRuns = makeDurableRuns({ resumable: [valid], invalid: [invalid] });
    const remintLease = vi.fn((input) => ({
      leaseId: `lease-for-${input.rootRunId}`,
      bearer: "bearer",
    }));
    const notify = vi.fn();

    const result = await createDurableResumeEngine(
      makeEngineDeps({ durableRuns, remintLease, notify }),
    ).resumeAll();

    expect(result).toEqual({ ok: true, value: { resumed: 1, orphaned: 1, deferred: 0 } });
    expect(remintLease).toHaveBeenCalledTimes(1);
    expect(remintLease.mock.calls[0]?.[0].rootRunId).toBe("root-valid");
    expect(
      durableRuns.calls.some(
        (call) => call.method === "markOrphaned" && call.args[0] === "checkpoint-invalid",
      ),
    ).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ rootRunId: "root-invalid" }),
    );
  });

  it("resume happy path re-mints the exact persisted identity and capabilities", async () => {
    const record = durableRecord({ caps: VALID_CAPS, trustLevel: "admin" });
    const remintLease = vi.fn((input) => ({ leaseId: "lease-x", bearer: "b" }));
    const resumeRun = vi.fn(async () => ok(undefined));
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({ resumable: [record] }),
      remintLease,
      resumeRun,
    });

    const r = await createDurableResumeEngine(deps).resumeAll();

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.resumed).toBe(1);
    expect(remintLease).toHaveBeenCalledTimes(1);
    // caps deep-equal the persisted set — NOT a re-attenuated subset
    const mintInput = remintLease.mock.calls[0][0];
    expect(mintInput.caps).toEqual(VALID_CAPS);
    expect(mintInput.trustLevel).toBe("admin");
    expect(mintInput).toEqual(expect.objectContaining({
      agentId: record.agentId,
      sessionKey: record.sessionKey,
      rootRunId: record.rootRunId,
      checkpointId: expect.stringMatching(/^resume-/),
    }));
    expect(resumeRun).toHaveBeenCalledTimes(1);
    expect(resumeRun.mock.calls[0][0].checkpointId).toEqual(expect.stringMatching(/^resume-/));
    expect(resumeRun.mock.calls[0][1]).toEqual({ leaseId: "lease-x", bearer: "b" });
  });

  it("revoked-record-not-reminted: a status='revoked' re-read → markOrphaned + notify, remintLease NEVER called", async () => {
    // listResumable returns a running record, but the belt re-read shows revoked
    const running = durableRecord({ rootRunId: "root-rev", status: "running" });
    const revoked = durableRecord({ rootRunId: "root-rev", status: "revoked" });
    const remintLease = vi.fn(() => ({ leaseId: "x", bearer: "b" }));
    const notify = vi.fn();
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({
        resumable: [running],
        byCheckpoint: new Map([[running.checkpointId, revoked]]),
      }),
      remintLease,
      notify,
    });

    const r = await createDurableResumeEngine(deps).resumeAll();

    expect(r.ok).toBe(true);
    expect(remintLease).not.toHaveBeenCalled();
    const dr = deps.durableRuns as ReturnType<typeof makeDurableRuns>;
    expect(dr.calls.some((c) => c.method === "markOrphaned" && c.args[0] === running.checkpointId)).toBe(true);
    expect(notify).toHaveBeenCalled();
    if (r.ok) expect(r.value.orphaned).toBe(1);
  });

  it("cap-tamper-orphan: a record whose caps fail parseDurableRunRecord (a tampered superset) → orphaned, NOT re-minted", async () => {
    // a foreign cap that is not in AGENT_CAPABILITIES — parseDurableRunRecord rejects it
    const tampered = {
      ...durableRecord({ rootRunId: "root-tamper" }),
      caps: ["orch:read", "admin:all"],
    } as unknown as DurableRunRecord;
    const remintLease = vi.fn(() => ({ leaseId: "x", bearer: "b" }));
    const notify = vi.fn();
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({
        resumable: [tampered],
        byCheckpoint: new Map([[tampered.checkpointId, tampered]]),
      }),
      remintLease,
      notify,
    });

    const r = await createDurableResumeEngine(deps).resumeAll();

    expect(r.ok).toBe(true);
    expect(remintLease).not.toHaveBeenCalled();
    const dr = deps.durableRuns as ReturnType<typeof makeDurableRuns>;
    const orphan = dr.calls.find((c) => c.method === "markOrphaned" && c.args[0] === tampered.checkpointId);
    expect(orphan).toBeDefined();
    expect(String(orphan?.args[1])).toMatch(/cap/i); // reason mentions caps
    expect(notify).toHaveBeenCalled();
  });

  it("caps no-progress re-anchors — a stale run whose heartbeat never advances is orphaned after MAX_REANCHOR_ATTEMPTS, then never re-anchored again", async () => {
    // A surface-only re-anchor never advances the heartbeat, so a dead run (process gone,
    // never explicitly resumed) would loop forever. The engine must re-anchor a bounded
    // number of times, then orphan it. MAX_REANCHOR_ATTEMPTS = 3 → passes 1..3 resume, pass 4 orphans.
    const record = durableRecord({ rootRunId: "root-stuck", lastHeartbeatAt: 500_000 });
    const durableRuns = makeDurableRuns({ resumable: [record] });
    const resumeRun = vi.fn(async () => ok(undefined));
    const engine = createDurableResumeEngine(makeEngineDeps({ durableRuns, resumeRun }));
    for (let i = 0; i < 4; i++) await engine.resumeAll(); // ONE engine instance — the ledger persists across passes
    expect(resumeRun).toHaveBeenCalledTimes(3); // re-anchored 3×, then stopped (not re-anchored on pass 4)
    const orphans = durableRuns.calls.filter((c) => c.method === "markOrphaned" && c.args[0] === record.checkpointId);
    expect(orphans).toHaveLength(1); // orphaned exactly once, on the 4th (over-cap) pass
    expect(String(orphans[0]!.args[1])).toMatch(/no-progress re-anchor/); // reason names the cap
  });

  it("hits the no-progress cap across repeated real SQLite replacement claims", async () => {
    const db = new Database(":memory:");
    try {
      ensureDurableRunTable(db);
      ensureOutwardLedgerTable(db);
      let currentNow = 1_000_000;
      const durableRuns = createSqliteDurableRunStore(db, { nowMs: () => currentNow });
      const ledger = createSqliteOutwardSendLedger(db, () => currentNow);
      const source = durableRecord({
        checkpointId: "checkpoint-real-no-progress",
        rootRunId: "root-real-no-progress",
        lastHeartbeatAt: 500_000,
        rootBudget: { startedAtMs: 400_000, tokensConsumed: 0, usdConsumed: 0 },
      });
      expect(await durableRuns.upsertCheckpoint(source)).toEqual({ ok: true, value: undefined });
      const resumeRun = vi.fn(async () => ok(undefined));
      const engine = createDurableResumeEngine(makeEngineDeps({
        durableRuns,
        ledger,
        resumeRun,
        nowMs: () => currentNow,
      }));

      for (let pass = 0; pass < 4; pass++) {
        expect((await engine.resumeAll()).ok).toBe(true);
        currentNow += 10_000;
      }

      expect(resumeRun).toHaveBeenCalledTimes(3);
      const scan = await durableRuns.listResumable();
      expect(scan.ok && scan.value.records).toHaveLength(0);
      const statusCounts = await durableRuns.countByStatus(0);
      expect(statusCounts.ok && statusCounts.value.orphaned).toBe(1);
    } finally {
      db.close();
    }
  });

  it("tracks no-progress replacement lineages independently for sibling checkpoints under one root", async () => {
    const db = new Database(":memory:");
    try {
      ensureDurableRunTable(db);
      ensureOutwardLedgerTable(db);
      let currentNow = 1_000_000;
      const durableRuns = createSqliteDurableRunStore(db, { nowMs: () => currentNow });
      const ledger = createSqliteOutwardSendLedger(db, () => currentNow);
      const first = durableRecord({
        checkpointId: "checkpoint-sibling-a",
        rootRunId: "root-shared-lineage",
        lastHeartbeatAt: 500_000,
        rootBudget: { startedAtMs: 400_000, tokensConsumed: 0, usdConsumed: 0 },
      });
      const second = durableRecord({
        checkpointId: "checkpoint-sibling-b",
        rootRunId: "root-shared-lineage",
        lastHeartbeatAt: 600_000,
        rootBudget: { startedAtMs: 400_000, tokensConsumed: 0, usdConsumed: 0 },
      });
      expect(await durableRuns.upsertCheckpoint(first)).toEqual({ ok: true, value: undefined });
      expect(await durableRuns.upsertCheckpoint(second)).toEqual({ ok: true, value: undefined });
      const resumeRun = vi.fn(async () => ok(undefined));
      const engine = createDurableResumeEngine(makeEngineDeps({
        durableRuns,
        ledger,
        resumeRun,
        nowMs: () => currentNow,
      }));

      for (let pass = 0; pass < 4; pass++) {
        expect((await engine.resumeAll()).ok).toBe(true);
        currentNow += 10_000;
      }

      expect(resumeRun).toHaveBeenCalledTimes(6);
      const statusCounts = await durableRuns.countByStatus(0);
      expect(statusCounts.ok && statusCounts.value.orphaned).toBe(2);
    } finally {
      db.close();
    }
  });

  it("applies the no-progress cap uniformly to an execution with no outward sends", async () => {
    const record = durableRecord({ rootRunId: "root-no-outward", lastHeartbeatAt: 500_000 });
    const durableRuns = makeDurableRuns({
      resumable: [record],
      byCheckpoint: new Map([[record.checkpointId, record]]),
    });
    const resumeRun = vi.fn(async () => ok(undefined));
    const engine = createDurableResumeEngine(makeEngineDeps({ durableRuns, resumeRun }));
    for (let i = 0; i < 4; i++) await engine.resumeAll();
    expect(durableRuns.calls.filter(
      (c) => c.method === "markOrphaned" && c.args[0] === record.checkpointId,
    )).toHaveLength(1);
  });

  it("a heartbeat advance (progress) resets the re-anchor counter — a live run is never false-orphaned", async () => {
    const record = durableRecord({ rootRunId: "root-live", lastHeartbeatAt: 500_000 });
    const durableRuns = makeDurableRuns({ resumable: [record] });
    const engine = createDurableResumeEngine(makeEngineDeps({ durableRuns }));
    // Drive many more passes than the cap, advancing the heartbeat each pass (a live run that
    // checkpoints). The counter must reset on each advance ⇒ it never reaches the cap.
    for (let i = 0; i < 10; i++) {
      record.lastHeartbeatAt = 500_000 + (i + 1) * 1000; // progress every pass
      await engine.resumeAll();
    }
    expect(durableRuns.calls.filter((c) => c.method === "markOrphaned")).toHaveLength(0);
  });

  it("a running execution checkpoint resumes without depending on outward-send state", async () => {
    const neverSent = durableRecord({ rootRunId: "root-neversent" });
    const remintLease = vi.fn(() => ({ leaseId: "lease-ns", bearer: "b" }));
    const resumeRun = vi.fn(async () => ok(undefined));
    const notify = vi.fn();
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({
        resumable: [neverSent],
        byCheckpoint: new Map([[neverSent.checkpointId, neverSent]]),
      }),
      remintLease,
      resumeRun,
      notify,
    });

    const r = await createDurableResumeEngine(deps).resumeAll();

    expect(r.ok).toBe(true);
    expect(remintLease).toHaveBeenCalledTimes(1);
    expect(resumeRun).toHaveBeenCalledTimes(1);
    const dr = deps.durableRuns as ReturnType<typeof makeDurableRuns>;
    expect(dr.calls.some((c) => c.method === "markOrphaned")).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    if (r.ok) expect(r.value.resumed).toBe(1);
  });

  it("budget-deferred-backlog: a backlog of N with a fake clock past budget after K → exactly K processed, N-K deferred (no thundering herd)", async () => {
    const N = 5;
    const backlog = Array.from({ length: N }, (_, i) =>
      durableRecord({ rootRunId: `root-${i}` }),
    );
    const byCheckpoint = new Map(backlog.map((r) => [r.checkpointId, r]));

    // fake clock: start at 0, each resumeRun advances time by 30_000ms; budget 60_000
    // deadline = 0 + 60_000. We check nowMs() > deadline BEFORE each item.
    // After K=2 resumes time = 60_000 (not > 60_000), the 3rd check: advance once
    // more to exceed. Model: time increments on each resumeRun call.
    let clock = 0;
    const nowMs = () => clock;
    const resumeRun = vi.fn(async () => {
      clock += 25_000; // each resume costs 25s
      return ok(undefined);
    });
    const remintLease = vi.fn(() => ({ leaseId: "x", bearer: "b" }));
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({ resumable: backlog, byCheckpoint }),
      remintLease,
      resumeRun,
      nowMs,
      recoveryBudgetMs: 60_000,
    });

    const r = await createDurableResumeEngine(deps).resumeAll();

    expect(r.ok).toBe(true);
    if (r.ok) {
      // deadline 60_000: item0 (t=0) ok→25k, item1 (t=25k) ok→50k, item2 (t=50k) ok→75k,
      // item3 (t=75k>60k) → defer. So K=3 processed, N-K=2 deferred.
      expect(r.value.resumed).toBe(3);
      expect(r.value.deferred).toBe(2);
    }
    expect(resumeRun).toHaveBeenCalledTimes(3);
    // an INFO line logged the budget exhaustion with attempted + remaining
    const logger = deps.logger as ReturnType<typeof makeLogger>;
    const budgetLine = logger.calls.find(
      (c) => c.level === "info" && /budget/i.test(c.msg) && "remaining" in c.obj,
    );
    expect(budgetLine).toBeDefined();
    expect(budgetLine?.obj.attempted).toBe(3);
    expect(budgetLine?.obj.remaining).toBe(2);
  });

  it("orphan path: resumeRun returns err → markOrphaned(reason) + notify, never silently dropped", async () => {
    const record = durableRecord({ rootRunId: "root-fail" });
    const credential = `xoxb-${"s".repeat(32)}`;
    const resumeRun = vi.fn(async () => err(new Error(`no live channel ${credential}`)));
    const notify = vi.fn();
    const revokeLease = vi.fn();
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({
        resumable: [record],
        byCheckpoint: new Map([[record.checkpointId, record]]),
      }),
      resumeRun,
      notify,
      revokeLease,
    });

    const r = await createDurableResumeEngine(deps).resumeAll();

    expect(r.ok).toBe(true);
    const dr = deps.durableRuns as ReturnType<typeof makeDurableRuns>;
    expect(dr.calls.some((c) => c.method === "markOrphaned" && String(c.args[0]).startsWith("resume-"))).toBe(true);
    expect(notify).toHaveBeenCalled();
    expect(revokeLease).toHaveBeenCalledWith("lease-for-root-fail");
    if (r.ok) expect(r.value.orphaned).toBe(1);
    // an eventBus durable:orphaned event fired
    const bus = deps.eventBus as ReturnType<typeof makeEventBus>;
    expect(bus.events.some((e) => e.event === "durable:orphaned")).toBe(true);
    const logger = deps.logger as ReturnType<typeof makeLogger>;
    const failureLog = logger.calls.find((call) =>
      call.level === "warn" && call.msg === "Durable resume: resumeRun failed → orphaned"
    );
    expect(typeof failureLog?.obj.err).toBe("string");
    expect(String(failureLog?.obj.err)).not.toContain(credential);
    expect(String(failureLog?.obj.err)).not.toContain("at ");
  });

  it("parks outward uncertainty even when there is no durable run backlog", async () => {
    const row = ledgerRow({ rootRunId: "root-without-run", state: "unknown_after_send" });
    const ledger = makeLedger({ unreconciled: [row] });
    const resumeRun = vi.fn(async () => ok(undefined));
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns(),
      ledger,
      resumeRun,
    });

    const r = await createDurableResumeEngine(deps).resumeAll();

    expect(r).toEqual({ ok: true, value: { resumed: 0, orphaned: 0, deferred: 0 } });
    expect(ledger.calls.some((c) => c.method === "parkUncertain")).toBe(true);
    expect(ledger.calls.some((c) => c.method === "commit")).toBe(false);
    expect(resumeRun).not.toHaveBeenCalled();
  });

  it("bounds the outward parking sweep and deterministically advances the next pass", async () => {
    const rows = Array.from({ length: 101 }, (_, stepIndex) =>
      ledgerRow({
        id: `root-batch:${stepIndex}`,
        rootRunId: "root-batch",
        stepIndex,
      }),
    );
    const ledger = makeLedger({ unreconciled: rows });
    const engine = createDurableResumeEngine(makeEngineDeps({ ledger }));

    const first = await engine.resumeAll();
    expect(first).toEqual({ ok: true, value: { resumed: 0, orphaned: 0, deferred: 1 } });
    expect(ledger.calls.filter((call) => call.method === "parkUncertain")).toHaveLength(100);

    const second = await engine.resumeAll();
    expect(second).toEqual({ ok: true, value: { resumed: 0, orphaned: 0, deferred: 0 } });
    expect(ledger.calls.filter((call) => call.method === "parkUncertain")).toHaveLength(101);
  });

  it("emits a durable:resumed event on a happy resume", async () => {
    const record = durableRecord({ rootRunId: "root-ev" });
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({
        resumable: [record],
        byCheckpoint: new Map([[record.checkpointId, record]]),
      }),
    });

    await createDurableResumeEngine(deps).resumeAll();

    const bus = deps.eventBus as ReturnType<typeof makeEventBus>;
    expect(bus.events.some((e) => e.event === "durable:resumed")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The durable:* events carry a CLOSED-enum reason + a numeric timestamp — never
// the engine's free text (content-free observability). The free string stays on
// the WARN log / notify only.
// ─────────────────────────────────────────────────────────────────────────────

/** The closed reason union the durable:orphaned EVENT may carry (events-orchestration.ts). */
const ORPHAN_ENUM = [
  "not_resumable",
  "reread_failed",
  "invalid_record",
  "invalid_caps",
  "outward_uncertain",
  "resume_failed",
] as const;

describe("orphanReasonToEnum content-free reason map, TOTAL over string", () => {
  it("maps each known engine free-text reason to its closed enum member (never echoes the input)", () => {
    // The known free-text reasons the engine passes to orphan().
    expect(orphanReasonToEnum("re-read failed")).toBe("reread_failed");
    expect(orphanReasonToEnum("not resumable: status=revoked")).toBe("not_resumable");
    expect(orphanReasonToEnum("not resumable: status=missing")).toBe("not_resumable");
    expect(orphanReasonToEnum("invalid durable record")).toBe("invalid_record");
    expect(orphanReasonToEnum("invalid caps")).toBe("invalid_caps");
    expect(orphanReasonToEnum("outward delivery uncertain")).toBe("outward_uncertain");
    expect(orphanReasonToEnum("resume failed")).toBe("resume_failed");
    // Each result is a member of the closed union, never the raw free text.
    for (const free of [
      "re-read failed",
      "not resumable: status=revoked",
      "invalid durable record",
      "invalid caps",
      "outward delivery uncertain",
      "resume failed",
    ]) {
      expect(ORPHAN_ENUM).toContain(orphanReasonToEnum(free));
      expect(orphanReasonToEnum(free)).not.toBe(free);
    }
  });

  it("is TOTAL: an unmapped brand-new reason STILL returns an enum member (the default arm), never the raw free text", () => {
    const brandNew = "some brand-new unmapped reason that matches no branch 0xDEADBEEF";
    const mapped = orphanReasonToEnum(brandNew);
    // The content-free invariant AT THE SOURCE: every input maps to an enum; the
    // function can never echo an unmapped free-text reason out onto the event.
    expect(ORPHAN_ENUM).toContain(mapped);
    expect(mapped).not.toBe(brandNew);
    expect(mapped).toBe("resume_failed"); // the default arm
    // Even the empty string is total.
    expect(ORPHAN_ENUM).toContain(orphanReasonToEnum(""));
  });
});

describe("durable:orphaned / durable:resumed event payloads typed, content-free", () => {
  it("durable:orphaned carries a closed reason enum instead of the free string plus a numeric timestamp", async () => {
    // A status='revoked' re-read drives the orphan path with the free-text reason
    // `not resumable: status=revoked` — the EVENT must carry the enum, not that string.
    const running = durableRecord({ rootRunId: "root-orphan-ev", status: "running" });
    const revoked = durableRecord({ rootRunId: "root-orphan-ev", status: "revoked" });
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({
        resumable: [running],
        byCheckpoint: new Map([[running.checkpointId, revoked]]),
      }),
      nowMs: () => 1_234_567,
    });

    await createDurableResumeEngine(deps).resumeAll();

    const bus = deps.eventBus as ReturnType<typeof makeEventBus>;
    const orphanEvent = bus.events.find((e) => e.event === "durable:orphaned");
    expect(orphanEvent).toBeDefined();
    const payload = orphanEvent!.payload;
    // The reason is one of the closed enum members — NEVER the engine's free text.
    expect(ORPHAN_ENUM).toContain(payload.reason);
    expect(payload.reason).toBe("not_resumable");
    expect(payload.reason).not.toBe("not resumable: status=revoked");
    // A numeric timestamp rides the event (from the engine's injected clock).
    expect(payload.timestamp).toBe(1_234_567);
    expect(payload.rootRunId).toBe("root-orphan-ev");
    // Content-free: the payload key-set is exactly {rootRunId, reason, timestamp} —
    // no `hint`, no free-text reason field leaked onto the event.
    expect(Object.keys(payload).sort()).toEqual(["reason", "rootRunId", "timestamp"]);
  });

  it("durable:orphaned reason for a resume failure maps to resume_failed (not the free string)", async () => {
    const record = durableRecord({ rootRunId: "root-resfail" });
    const resumeRun = vi.fn(async () => err(new Error("no live channel")));
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({
        resumable: [record],
        byCheckpoint: new Map([[record.checkpointId, record]]),
      }),
      resumeRun,
      nowMs: () => 42,
    });

    await createDurableResumeEngine(deps).resumeAll();

    const bus = deps.eventBus as ReturnType<typeof makeEventBus>;
    const orphanEvent = bus.events.find((e) => e.event === "durable:orphaned");
    expect(orphanEvent?.payload.reason).toBe("resume_failed");
    expect(orphanEvent?.payload.reason).not.toBe("resume failed");
    expect(orphanEvent?.payload.timestamp).toBe(42);
  });

  it("durable:resumed carries the execution checkpoint identity and timestamp", async () => {
    const record = durableRecord({ rootRunId: "root-resumed-ev", checkpointId: "checkpoint-resumed-ev" });
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({
        resumable: [record],
        byCheckpoint: new Map([[record.checkpointId, record]]),
      }),
      nowMs: () => 9_999,
    });

    await createDurableResumeEngine(deps).resumeAll();

    const bus = deps.eventBus as ReturnType<typeof makeEventBus>;
    const resumedEvent = bus.events.find((e) => e.event === "durable:resumed");
    expect(resumedEvent).toBeDefined();
    const payload = resumedEvent!.payload;
    expect(payload.checkpointId).toEqual(expect.stringMatching(/^resume-/));
    expect(payload.timestamp).toBe(9_999);
    expect(payload.rootRunId).toBe("root-resumed-ev");
    expect(Object.keys(payload).sort()).toEqual(["checkpointId", "rootRunId", "timestamp"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 1 (233): the orchestrate-kind resume arm — surface vs orphan.
//
// A durable row with a FLAT spawnTree AND scriptRef != null is a RE-RUNNABLE
// orchestrate row (the runner writes it). The boot sweep dispatches it to a NEW
// arm (never resumeGraph) that VERIFIES the pinned script + checkpoint are on
// disk: PRESENT → re-anchor + surface resumable (SURFACE-ONLY on boot — the byte
// re-execution is the explicit orchestrate({resumeRunId}), A2); GONE → an honest
// err the engine turns into a durable:orphaned with a CLOSED-ENUM reason (no
// silent loss). Proven against a REAL temp workspace (real fs) + the engine harness.
// ─────────────────────────────────────────────────────────────────────────────

const tempWorkspaces: string[] = [];
function makeTempWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "durable-orch-arm-"));
  tempWorkspaces.push(ws);
  return ws;
}
afterEach(() => {
  for (const ws of tempWorkspaces.splice(0)) {
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
});

/** Write a pinned script (workspace ROOT) + optionally a checkpoint blob (results/). */
function seedArtifacts(ws: string, opts: { script?: string; checkpoint?: string }): void {
  if (opts.script !== undefined) writeFileSync(join(ws, opts.script), "print('pinned')");
  if (opts.checkpoint !== undefined) {
    const checkpointPath = join(ws, opts.checkpoint);
    mkdirSync(dirname(checkpointPath), { recursive: true });
    writeFileSync(checkpointPath, '{"step":1}');
  }
}

function isolatedCheckpointRef(checkpointId: string): string {
  return `results/${safeResultRunId(checkpointId)}/cp.json`;
}

function isolatedResultsDir(ws: string, checkpointId: string): string {
  return join(ws, "results", safeResultRunId(checkpointId));
}

/**
 * The full orchestrate-resume wiring cluster pointed at a real temp workspace:
 * the arm seams (workspaceFor + real existsSync) PLUS the reclaim seams. The
 * reclaim reuses the REAL result-ref-store.cleanupRun (rmSync-recursive of
 * results/) — proving NG4 (compose the shipped GC, no new primitive) against real fs.
 */
function orchSeams(ws: string | undefined): OrchestrateResumeWiring {
  const store = createResultRefStore({ logger: silentLog });
  return {
    workspaceFor: () => ws,
    fileExists: (p) => existsSync(p),
    cleanupResults: (workspacePath, runId) => store.cleanupRun({ workspacePath, runId }),
    removePinnedScript: (workspacePath, scriptRef) => {
      // guarded rmSync — force:true makes a missing file a no-op (idempotent)
      rmSync(join(workspacePath, scriptRef), { force: true });
    },
  };
}

describe("verifyOrchestrateResumable — the orchestrate-kind arm over injected seams (surface-only, A2)", () => {
  it("present pinned script + checkpoint blob → ok (verified resumable — the engine re-anchors, never re-spawns on boot)", () => {
    const ws = makeTempWorkspace();
    seedArtifacts(ws, { script: "orch-a.py", checkpoint: "results/cp.json" });
    const record = durableRecord({ scriptRef: "orch-a.py", checkpointRef: "results/cp.json" });
    const r = verifyOrchestrateResumable(record, orchSeams(ws));
    expect(r.ok).toBe(true);
  });

  it("checkpoint blob MISSING → err whose free text maps through orphanReasonToEnum to not_resumable (no silent loss)", () => {
    const ws = makeTempWorkspace();
    seedArtifacts(ws, { script: "orch-a.py" }); // the pinned script is present, the checkpoint is NOT
    const record = durableRecord({ scriptRef: "orch-a.py", checkpointRef: "results/cp.json" });
    const r = verifyOrchestrateResumable(record, orchSeams(ws));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(orphanReasonToEnum(r.error.message)).toBe("not_resumable");
  });

  it("pinned script MISSING → err (not_resumable)", () => {
    const ws = makeTempWorkspace();
    seedArtifacts(ws, { checkpoint: "results/cp.json" }); // checkpoint present, script gone
    const record = durableRecord({ scriptRef: "orch-a.py", checkpointRef: "results/cp.json" });
    const r = verifyOrchestrateResumable(record, orchSeams(ws));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(orphanReasonToEnum(r.error.message)).toBe("not_resumable");
  });

  it("a scriptRef that escapes the workspace (traversal) → err, never a real fs touch outside the workspace", () => {
    const ws = makeTempWorkspace();
    const record = durableRecord({ scriptRef: "../../etc/passwd" });
    const r = verifyOrchestrateResumable(record, orchSeams(ws));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(orphanReasonToEnum(r.error.message)).toBe("not_resumable");
  });

  it("no checkpointRef (never checkpointed) + present pinned script → ok (resumable from the pinned bytes alone)", () => {
    const ws = makeTempWorkspace();
    seedArtifacts(ws, { script: "orch-a.py" });
    const record = durableRecord({ scriptRef: "orch-a.py" }); // checkpointRef undefined
    const r = verifyOrchestrateResumable(record, orchSeams(ws));
    expect(r.ok).toBe(true);
  });

  it("workspace unavailable → err (not_resumable), never a bare-path fs read", () => {
    const record = durableRecord({ scriptRef: "orch-a.py", checkpointRef: "results/cp.json" });
    const r = verifyOrchestrateResumable(record, orchSeams(undefined));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(orphanReasonToEnum(r.error.message)).toBe("not_resumable");
  });
});

// ── buildDurableResume dispatch: the closure routes flat + scriptRef != null to
//    the new arm, DAG rows still to resumeGraph. Ground truth: a synthetic row
//    against the real engine + a REAL temp workspace. ──────────────────────────

const silentLog = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, audit() {},
  level: "info",
  child() { return silentLog; },
} as unknown as ComisLogger;

function makeTimers(): TimerPort {
  const mk = (t: NodeJS.Timeout): TimerHandle => {
    let cancelled = false;
    return {
      get cancelled() { return cancelled; },
      cancel() { cancelled = true; clearInterval(t as never); },
      unref() { (t as unknown as { unref?: () => void }).unref?.(); },
    };
  };
  return { setTimeout: (cb, ms) => mk(setTimeout(cb, ms)), setInterval: (cb, ms) => mk(setInterval(cb, ms)) };
}
const wallClock: ClockPort = { now: () => Date.now(), nowDate: () => new Date() };

function makeLeaseMgr(): LeaseManager {
  return {
    mintLease: vi.fn(() => ({ leaseId: "lease-x", bearer: "bearer-x" })),
    revoke: vi.fn(() => ({ revoked: 1 })),
  } as unknown as LeaseManager;
}

interface WiringOver {
  store: DurableRunPort;
  orchestrateResume?: OrchestrateResumeWiring;
  resumeGraph?: (record: DurableRunRecord) => Promise<Result<void, Error>>;
}
function buildWiring(over: WiringOver): {
  wiring: ReturnType<typeof buildDurableResume>;
  events: { event: string; payload: Record<string, unknown> }[];
  registerRoot: ReturnType<typeof vi.fn>;
} {
  const events: { event: string; payload: Record<string, unknown> }[] = [];
  const registerRoot = vi.fn();
  const eventBus = new TypedEventBus();
  eventBus.on("durable:resumed", (payload) => {
    events.push({ event: "durable:resumed", payload });
  });
  eventBus.on("durable:orphaned", (payload) => {
    events.push({ event: "durable:orphaned", payload });
  });
  const wiring = buildDurableResume({
    db: {},
    durabilityCfg: { enabled: true, staleHeartbeatMs: 60_000, keepAliveMs: 30_000, recoveryBudgetMs: 5_000 },
    durableRunStore: over.store,
    outwardLedger: makeLedger(),
    boundedAutonomy: {
      registerRoot,
      leaseIdsForRoot: () => new Set<string>(),
      rehydrateBudget: vi.fn(),
      evictRootIfIdle: vi.fn(),
      exportBudgetState: () => ({ startedAtMs: 1, tokensConsumed: 0, usdConsumed: 0 }),
    } as never,
    sharedLeaseManager: makeLeaseMgr(),
    eventBus,
    logger: silentLog,
    clock: wallClock,
    timers: makeTimers(),
    resumeGraph: over.resumeGraph ?? (async () => ok(undefined)),
    ...(over.orchestrateResume ? { orchestrateResume: over.orchestrateResume } : {}),
  });
  return { wiring, events, registerRoot };
}

describe("buildDurableResume — orchestrate-kind dispatch (flat + scriptRef != null, never resumeGraph)", () => {
  it("routes a flat + scriptRef row with present artifacts to the arm → durable:resumed + registerRoot, NEVER resumeGraph (surface-only, no auto-re-spawn)", async () => {
    const ws = makeTempWorkspace();
    seedArtifacts(ws, { script: "orch-x.py", checkpoint: "results/cp.json" });
    const record = durableRecord({ rootRunId: "root-orch", scriptRef: "orch-x.py", checkpointRef: "results/cp.json" });
    const store = makeDurableRuns({ resumable: [record], byCheckpoint: new Map([[record.checkpointId, record]]) });
    const resumeGraph = vi.fn(async () => ok(undefined));
    const { wiring, events, registerRoot } = buildWiring({ store, orchestrateResume: orchSeams(ws), resumeGraph });

    await wiring.startAndResumeDurable();
    wiring.durableResume.shutdown();

    expect(events.some((e) => e.event === "durable:resumed" && e.payload.rootRunId === "root-orch")).toBe(true);
    expect(registerRoot).toHaveBeenCalledWith("root-orch", expect.any(String));
    // The orchestrate arm NEVER routes to the graph resume, and never orphaned it.
    expect(resumeGraph).not.toHaveBeenCalled();
    expect(events.some((e) => e.event === "durable:orphaned")).toBe(false);
  });

  it("a DAG row (spawn_tree objects with `status`) still routes to resumeGraph (regression — the arm is entered only for flat + scriptRef != null)", async () => {
    const ws = makeTempWorkspace();
    const dag = durableRecord({
      rootRunId: "root-dag",
      spawnTree: [{ nodeId: "A", status: "running", runId: "ra" }] as unknown as DurableRunRecord["spawnTree"],
      checkpointRef: "graph-runs/root-dag/durable-checkpoint.json",
    });
    const store = makeDurableRuns({ resumable: [dag], byCheckpoint: new Map([[dag.checkpointId, dag]]) });
    const resumeGraph = vi.fn(async () => ok(undefined));
    const { wiring, registerRoot } = buildWiring({ store, orchestrateResume: orchSeams(ws), resumeGraph });

    await wiring.startAndResumeDurable();
    wiring.durableResume.shutdown();

    expect(resumeGraph).toHaveBeenCalledTimes(1);
    expect(resumeGraph.mock.calls[0]![0].rootRunId).toBe("root-dag");
    expect(registerRoot).not.toHaveBeenCalled();
  });

  it("a flat + scriptRef row whose checkpoint is GONE → durable:orphaned with a closed-enum reason (no silent loss, not re-anchored as resumed)", async () => {
    const ws = makeTempWorkspace();
    seedArtifacts(ws, { script: "orch-x.py" }); // the checkpoint blob was NOT written (reclaimed/expired)
    const record = durableRecord({ rootRunId: "root-gone", scriptRef: "orch-x.py", checkpointRef: "results/cp.json" });
    const store = makeDurableRuns({ resumable: [record], byCheckpoint: new Map([[record.checkpointId, record]]) });
    const { wiring, events, registerRoot } = buildWiring({ store, orchestrateResume: orchSeams(ws) });

    await wiring.startAndResumeDurable();
    wiring.durableResume.shutdown();

    const orphan = events.find((e) => e.event === "durable:orphaned" && e.payload.rootRunId === "root-gone");
    expect(orphan).toBeDefined();
    expect(ORPHAN_ENUM).toContain(orphan!.payload.reason);
    // Not surfaced as a resumed run — an honest orphan, never a silent re-anchor.
    expect(events.some((e) => e.event === "durable:resumed" && e.payload.rootRunId === "root-gone")).toBe(false);
    expect(registerRoot).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 2 (233): the orphan-reclaim hook — reclaim a dead resumable run's artifacts.
//
// A run orphaned on boot (missing checkpoint) or on a lapsed-heartbeat watchdog
// tick has NO surviving runner to GC its workspace, so the engine's orphan path
// owns reclaiming the surviving results directory and checkpoint blob
// + the pinned <scriptRef>. Composes the EXISTING result-ref-store.cleanupRun +
// a guarded rmSync (NG4 — no new GC primitive). Scoped to orchestrate-kind rows;
// idempotent. Proven against a REAL temp workspace (real fs).
// ─────────────────────────────────────────────────────────────────────────────

describe("reclaimOrphanedOrchestrateRun — the orphan-reclaim hook (real fs, reuses cleanupRun, NG4)", () => {
  it("reclaims a dead resumable orchestrate run's results/ (checkpoint blob) + pinned script — real files gone", async () => {
    const ws = makeTempWorkspace();
    const checkpointId = "checkpoint-root-r1";
    const record = durableRecord({
      checkpointId,
      rootRunId: "root-r1",
      scriptRef: "orch-a.py",
      checkpointRef: isolatedCheckpointRef(checkpointId),
    });
    const runDir = isolatedResultsDir(ws, record.checkpointId);
    const siblingDir = isolatedResultsDir(ws, "checkpoint-concurrent");
    seedArtifacts(ws, {
      script: record.scriptRef ?? undefined,
      checkpoint: isolatedCheckpointRef(checkpointId),
    });
    writeFileSync(join(runDir, "leftover.json"), "{}");
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(join(siblingDir, "keep.json"), "{}");

    await reclaimOrphanedOrchestrateRun(record, orchSeams(ws));

    expect(existsSync(join(ws, "orch-a.py"))).toBe(false);
    expect(existsSync(runDir)).toBe(false);
    expect(existsSync(siblingDir)).toBe(true);
  });

  it("is idempotent — a second reclaim of the same run is a no-op, never a throw", async () => {
    const ws = makeTempWorkspace();
    const checkpointId = "checkpoint-root-r2";
    const record = durableRecord({
      checkpointId,
      rootRunId: "root-r2",
      scriptRef: "orch-a.py",
      checkpointRef: isolatedCheckpointRef(checkpointId),
    });
    const runDir = isolatedResultsDir(ws, record.checkpointId);
    seedArtifacts(ws, {
      script: record.scriptRef ?? undefined,
      checkpoint: isolatedCheckpointRef(checkpointId),
    });

    await reclaimOrphanedOrchestrateRun(record, orchSeams(ws));
    // second pass: the files are already gone — resolves without throwing
    await expect(reclaimOrphanedOrchestrateRun(record, orchSeams(ws))).resolves.toBeUndefined();
    expect(existsSync(join(ws, "orch-a.py"))).toBe(false);
    expect(existsSync(runDir)).toBe(false);
  });

  it("is scoped to orchestrate-kind rows — a record with no scriptRef is a no-op (a DAG/flat legacy orphan is unaffected)", async () => {
    const ws = makeTempWorkspace();
    seedArtifacts(ws, { checkpoint: "results/cp.json" });
    writeFileSync(join(ws, "sentinel.txt"), "keep");
    const flatLegacy = durableRecord({ rootRunId: "root-flat", spawnTree: ["lease-a"] }); // no scriptRef

    await reclaimOrphanedOrchestrateRun(flatLegacy, orchSeams(ws));

    // nothing reclaimed — the row is not orchestrate-kind (scriptRef == null)
    expect(existsSync(join(ws, "results"))).toBe(true);
    expect(existsSync(join(ws, "sentinel.txt"))).toBe(true);
  });
});

describe("createDurableResumeEngine — orphan-path reclaim + closed not_resumable reason", () => {
  it("reclaims a resumable orchestrate run when its resume fails and it is orphaned", async () => {
    const record = durableRecord({ rootRunId: "root-reclaim", scriptRef: "orch-a.py", checkpointRef: "results/cp.json" });
    const resumeRun = vi.fn(async () => err(new Error("orchestrate resume not resumable: the checkpoint blob is gone")));
    const reclaimOrchestrateRun = vi.fn(async () => {});
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({ resumable: [record], byCheckpoint: new Map([[record.checkpointId, record]]) }),
      resumeRun,
      reclaimOrchestrateRun,
    });

    const r = await createDurableResumeEngine(deps).resumeAll();

    expect(r.ok).toBe(true);
    expect(reclaimOrchestrateRun).toHaveBeenCalledTimes(1);
    expect(reclaimOrchestrateRun.mock.calls[0]![0].rootRunId).toBe("root-reclaim");
  });

  it("a missing-checkpoint resume failure orphans with the closed not_resumable reason (the arm's err text propagates, never the raw free string)", async () => {
    const record = durableRecord({ rootRunId: "root-nr", scriptRef: "orch-a.py", checkpointRef: "results/cp.json" });
    const resumeRun = vi.fn(async () => err(new Error("orchestrate resume not resumable: the checkpoint blob is gone")));
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({ resumable: [record], byCheckpoint: new Map([[record.checkpointId, record]]) }),
      resumeRun,
      nowMs: () => 555,
    });

    await createDurableResumeEngine(deps).resumeAll();

    const bus = deps.eventBus as ReturnType<typeof makeEventBus>;
    const orphanEvent = bus.events.find((e) => e.event === "durable:orphaned");
    expect(orphanEvent?.payload.reason).toBe("not_resumable");
    // The free-text arm reason never crosses onto the content-free event.
    expect(orphanEvent?.payload.reason).not.toBe("orchestrate resume not resumable: the checkpoint blob is gone");
    expect(orphanEvent?.payload.timestamp).toBe(555);
  });

  it("does NOT reclaim on a happy resume — reclaim is an orphan-path-only hook", async () => {
    const record = durableRecord({ rootRunId: "root-ok", scriptRef: "orch-a.py" });
    const reclaimOrchestrateRun = vi.fn(async () => {});
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({ resumable: [record], byCheckpoint: new Map([[record.checkpointId, record]]) }),
      resumeRun: vi.fn(async () => ok(undefined)),
      reclaimOrchestrateRun,
    });

    await createDurableResumeEngine(deps).resumeAll();

    expect(reclaimOrchestrateRun).not.toHaveBeenCalled();
  });
});

describe("buildDurableResume — orphan-reclaim end-to-end (missing checkpoint → orphaned + reclaim, real files gone)", () => {
  it("a flat + scriptRef row whose checkpoint is gone → durable:orphaned(not_resumable) AND its results/ + pinned script are reclaimed", async () => {
    const ws = makeTempWorkspace();
    const checkpointId = "checkpoint-root-e2e";
    const record = durableRecord({
      checkpointId,
      rootRunId: "root-e2e",
      scriptRef: "orch-x.py",
      checkpointRef: isolatedCheckpointRef(checkpointId),
    });
    const runDir = isolatedResultsDir(ws, record.checkpointId);
    seedArtifacts(ws, { script: record.scriptRef ?? undefined });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "leftover.json"), "{}"); // a surviving result, but cp.json is gone
    const store = makeDurableRuns({ resumable: [record], byCheckpoint: new Map([[record.checkpointId, record]]) });
    const { wiring, events } = buildWiring({ store, orchestrateResume: orchSeams(ws) });

    await wiring.startAndResumeDurable();
    wiring.durableResume.shutdown();

    const orphan = events.find((e) => e.event === "durable:orphaned" && e.payload.rootRunId === "root-e2e");
    expect(orphan?.payload.reason).toBe("not_resumable");
    // The dead run's surviving artifacts are reclaimed without a workspace leak.
    expect(existsSync(join(ws, "orch-x.py"))).toBe(false);
    expect(existsSync(runDir)).toBe(false);
  });
});
