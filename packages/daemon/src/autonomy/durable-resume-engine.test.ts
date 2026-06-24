// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the durable resume engine (Phase 216). RED-first — neither
 * `reconcileLedgerRow` nor `createDurableResumeEngine` exists yet, so this file
 * fails to import before the patch.
 *
 * This file covers BOTH plan tasks:
 *   - Task 2: `reconcileLedgerRow` — the exactly-once recovery resolution
 *     (ONCE-03/ONCE-04). Tests named "reconcile: ..." so `vitest -t reconcile`
 *     selects them.
 *   - Task 3: `createDurableResumeEngine` — resume-or-orphan + cap rehydrate +
 *     bounded recovery (DUR-02/03/04, HB-02/03).
 *
 * The stubs (a recording ledger, a configurable channel, spy replaySend/notify,
 * a fake clock) keep the engine exhaustively unit-testable with no real I/O — it
 * is bound to the real stores / LeaseManager / channel adapters in Plan 07.
 */
import { describe, it, expect, vi } from "vitest";
import { ok, err, type Result } from "@comis/shared";
import type {
  OutwardSendLedgerPort,
  OutwardSendRecord,
  OutwardSendState,
  ReconcileOutcome,
  ChannelPort,
  ReconcileSendOutcome,
  DurableRunRecord,
  DurableRunPort,
} from "@comis/core";
import {
  reconcileLedgerRow,
  createDurableResumeEngine,
  orphanReasonToEnum,
  type ReconcileLedgerDeps,
  type DurableResumeEngineDeps,
} from "./durable-resume-engine.js";

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
  return {
    events,
    emit(event: string, payload: Record<string, unknown>): void {
      events.push({ event, payload });
    },
  };
}

// ─── a recording ledger stub: tracks every method call, returns ok by default ─
interface LedgerCall {
  method: string;
  args: unknown[];
}
function makeLedger(opts?: {
  unreconciled?: OutwardSendRecord[];
  lookupRow?: OutwardSendRecord;
}): OutwardSendLedgerPort & { calls: LedgerCall[] } {
  const calls: LedgerCall[] = [];
  const record = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args });
  };
  return {
    calls,
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
    resolveReconcile: async (rootRunId, stepIndex, outcome) => {
      record("resolveReconcile", rootRunId, stepIndex, outcome);
      return ok(undefined);
    },
    listUnreconciled: async () => {
      record("listUnreconciled");
      return ok(opts?.unreconciled ?? []);
    },
  };
}

// ─── a configurable channel stub (reconcileSend present or absent) ────────────
function makeChannel(reconcile?: () => Promise<Result<ReconcileSendOutcome, Error>>): ChannelPort {
  // A minimal ChannelPort — only reconcileSend matters for these tests; the rest
  // throw if touched (they must not be).
  const stub = {
    reconcileSend: reconcile,
  } as unknown as ChannelPort;
  return stub;
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
    contentDigest: "deadbeef",
    attemptCount: 1,
    ...overrides,
  };
}

function makeReconcileDeps(
  overrides: Partial<ReconcileLedgerDeps>,
): ReconcileLedgerDeps {
  return {
    ledger: makeLedger(),
    channel: makeChannel(),
    replaySend: vi.fn(async () => ok({ platformMessageId: "pm-replay" })),
    notify: vi.fn(),
    nowMs: () => 1_000_000,
    logger: makeLogger(),
    ...overrides,
  };
}

describe("reconcileLedgerRow (ONCE-03/ONCE-04)", () => {
  it("reconcile: sent → resolveReconcile('sent') + commit(platformMessageId), NO replay (exactly once)", async () => {
    const ledger = makeLedger();
    const replaySend = vi.fn(async () => ok({ platformMessageId: "should-not-happen" }));
    const channel = makeChannel(async () => ok({ kind: "sent", platformMessageId: "pm-123" }));
    const deps = makeReconcileDeps({ ledger, channel, replaySend });

    const r = await reconcileLedgerRow(ledgerRow(), deps);

    expect(r.ok).toBe(true);
    expect(replaySend).not.toHaveBeenCalled(); // no double-send
    const methods = ledger.calls.map((c) => c.method);
    expect(methods).toContain("resolveReconcile");
    expect(methods).toContain("commit");
    // resolveReconcile got "sent"; commit got the platformMessageId
    const resolve = ledger.calls.find((c) => c.method === "resolveReconcile");
    expect(resolve?.args[2]).toBe("sent" satisfies ReconcileOutcome);
    const commit = ledger.calls.find((c) => c.method === "commit");
    expect(commit?.args[2]).toBe("pm-123");
  });

  it("reconcile: not_sent → resolveReconcile('not_sent') then EXACTLY ONE replay, then commit", async () => {
    const ledger = makeLedger();
    const replaySend = vi.fn(async () => ok({ platformMessageId: "pm-replayed" }));
    const channel = makeChannel(async () => ok({ kind: "not_sent" }));
    const deps = makeReconcileDeps({ ledger, channel, replaySend });

    const r = await reconcileLedgerRow(ledgerRow(), deps);

    expect(r.ok).toBe(true);
    expect(replaySend).toHaveBeenCalledTimes(1); // exactly one send
    const resolve = ledger.calls.find((c) => c.method === "resolveReconcile");
    expect(resolve?.args[2]).toBe("not_sent" satisfies ReconcileOutcome);
    const commit = ledger.calls.find((c) => c.method === "commit");
    expect(commit?.args[2]).toBe("pm-replayed");
  });

  it("reconcile: unresolved → resolveReconcile('unresolved') + notify escalation, NO replay, NO commit", async () => {
    const ledger = makeLedger();
    const replaySend = vi.fn(async () => ok({ platformMessageId: "nope" }));
    const notify = vi.fn();
    const channel = makeChannel(async () => ok({ kind: "unresolved" }));
    const deps = makeReconcileDeps({ ledger, channel, replaySend, notify });

    const r = await reconcileLedgerRow(ledgerRow(), deps);

    expect(r.ok).toBe(true);
    expect(replaySend).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    const resolve = ledger.calls.find((c) => c.method === "resolveReconcile");
    expect(resolve?.args[2]).toBe("unresolved" satisfies ReconcileOutcome);
    expect(ledger.calls.find((c) => c.method === "commit")).toBeUndefined();
  });

  it("reconcile: channel WITHOUT reconcileSend → treated as unresolved (park+escalate), NO replay (Pitfall 2)", async () => {
    const ledger = makeLedger();
    const replaySend = vi.fn(async () => ok({ platformMessageId: "nope" }));
    const notify = vi.fn();
    // channel is undefined (no live adapter) — the load-bearing fallback
    const deps = makeReconcileDeps({ ledger, channel: undefined, replaySend, notify });

    const r = await reconcileLedgerRow(ledgerRow(), deps);

    expect(r.ok).toBe(true);
    expect(replaySend).not.toHaveBeenCalled(); // never a double-send dressed as a reconcile
    expect(notify).toHaveBeenCalledTimes(1);
    const resolve = ledger.calls.find((c) => c.method === "resolveReconcile");
    expect(resolve?.args[2]).toBe("unresolved" satisfies ReconcileOutcome);
  });

  it("reconcile: channel present but reconcileSend method absent (undefined) → unresolved, NO replay", async () => {
    const ledger = makeLedger();
    const replaySend = vi.fn(async () => ok({ platformMessageId: "nope" }));
    const notify = vi.fn();
    const channel = makeChannel(undefined); // adapter exists but cannot reconcile
    const deps = makeReconcileDeps({ ledger, channel, replaySend, notify });

    const r = await reconcileLedgerRow(ledgerRow(), deps);

    expect(r.ok).toBe(true);
    expect(replaySend).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("reconcile: not_sent + replay fails with a PERMANENT error → markFailed('permanent'), retry budget skipped (ONCE-04)", async () => {
    const ledger = makeLedger();
    // 'chat not found' matches isPermanentError
    const replaySend = vi.fn(async () => err(new Error("Bad Request: chat not found")));
    const channel = makeChannel(async () => ok({ kind: "not_sent" }));
    const deps = makeReconcileDeps({ ledger, channel, replaySend });

    const r = await reconcileLedgerRow(ledgerRow(), deps);

    expect(r.ok).toBe(true); // a permanent failure is a resolved row, not an engine error
    expect(replaySend).toHaveBeenCalledTimes(1); // one attempt, then no more
    const markFailed = ledger.calls.find((c) => c.method === "markFailed");
    expect(markFailed).toBeDefined();
    expect(markFailed?.args[2]).toBe("permanent");
    // a permanent failure must NOT commit
    expect(ledger.calls.find((c) => c.method === "commit")).toBeUndefined();
  });

  it("reconcile: not_sent + replay fails with a TRANSIENT error → row LEFT for the next tick (no markFailed, no commit)", async () => {
    const ledger = makeLedger();
    const replaySend = vi.fn(async () => err(new Error("ETIMEDOUT socket hang up")));
    const channel = makeChannel(async () => ok({ kind: "not_sent" }));
    const deps = makeReconcileDeps({ ledger, channel, replaySend });

    const r = await reconcileLedgerRow(ledgerRow(), deps);

    expect(r.ok).toBe(true);
    expect(replaySend).toHaveBeenCalledTimes(1);
    // transient → neither terminal markFailed nor commit; the next boot retries
    expect(ledger.calls.find((c) => c.method === "markFailed")).toBeUndefined();
    expect(ledger.calls.find((c) => c.method === "commit")).toBeUndefined();
  });

  it("reconcile: an already-committed row is a no-op — no reconcileSend, no replaySend (ONCE-02)", async () => {
    const ledger = makeLedger();
    const replaySend = vi.fn(async () => ok({ platformMessageId: "nope" }));
    const reconcileSpy = vi.fn(async () => ok({ kind: "not_sent" } as ReconcileSendOutcome));
    const channel = makeChannel(reconcileSpy);
    const deps = makeReconcileDeps({ ledger, channel, replaySend });

    const r = await reconcileLedgerRow(ledgerRow({ state: "committed" }), deps);

    expect(r.ok).toBe(true);
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(replaySend).not.toHaveBeenCalled();
    expect(ledger.calls).toHaveLength(0); // pure no-op
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 3: createDurableResumeEngine
// ─────────────────────────────────────────────────────────────────────────────

const VALID_CAPS: DurableRunRecord["caps"] = ["orch:read", "orch:message"];

function durableRecord(overrides?: Partial<DurableRunRecord>): DurableRunRecord {
  return {
    rootRunId: "root-1",
    spawnTree: ["lease-1"],
    caps: VALID_CAPS,
    leaseIds: ["lease-1"],
    budgetConsumed: 0,
    cronOrigin: null,
    stepIndex: 0,
    status: "running",
    lastHeartbeatAt: 500_000,
    ...overrides,
  };
}

interface DurableCall {
  method: string;
  args: unknown[];
}
function makeDurableRuns(opts?: {
  resumable?: DurableRunRecord[];
  byRootRun?: Map<string, DurableRunRecord>;
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
      return ok(opts?.resumable ?? []);
    },
    getByRootRun: async (rootRunId) => {
      rec("getByRootRun", rootRunId);
      const found = opts?.byRootRun?.get(rootRunId);
      // default: echo a running record so the re-read passes unless overridden
      return ok(found ?? opts?.resumable?.find((r) => r.rootRunId === rootRunId));
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
    allocateOutwardStep: async (rootRunId) => {
      rec("allocateOutwardStep", rootRunId);
      return ok(0);
    },
  };
}

function makeEngineDeps(overrides: Partial<DurableResumeEngineDeps>): DurableResumeEngineDeps {
  return {
    durableRuns: makeDurableRuns(),
    ledger: makeLedger(),
    channelFor: () => makeChannel(),
    remintLease: vi.fn((input) => ({ leaseId: `lease-for-${input.rootRunId}`, bearer: "bearer-x" })),
    resumeRun: vi.fn(async () => ok(undefined)),
    replaySend: vi.fn(async () => ok({ platformMessageId: "pm" })),
    notify: vi.fn(),
    nowMs: () => 1_000_000,
    recoveryBudgetMs: 60_000,
    logger: makeLogger(),
    eventBus: makeEventBus(),
    ...overrides,
  };
}

describe("createDurableResumeEngine (DUR-02/03/04, HB-02/03)", () => {
  it("resume happy path: re-mints a lease passing record.caps VERBATIM, then resumes from stepIndex (verbatim-caps-passed-to-mint)", async () => {
    const record = durableRecord({ caps: VALID_CAPS });
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
    expect(resumeRun).toHaveBeenCalledTimes(1);
    // resumeRun got the record (carrying stepIndex) + the minted leaseId
    expect(resumeRun.mock.calls[0][0].stepIndex).toBe(record.stepIndex);
    expect(resumeRun.mock.calls[0][1]).toBe("lease-x");
  });

  it("DUR-03 revoked-record-not-reminted: a status='revoked' re-read → markOrphaned + notify, remintLease NEVER called", async () => {
    // listResumable returns a running record, but the belt re-read shows revoked
    const running = durableRecord({ rootRunId: "root-rev", status: "running" });
    const revoked = durableRecord({ rootRunId: "root-rev", status: "revoked" });
    const remintLease = vi.fn(() => ({ leaseId: "x", bearer: "b" }));
    const notify = vi.fn();
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({
        resumable: [running],
        byRootRun: new Map([["root-rev", revoked]]),
      }),
      remintLease,
      notify,
    });

    const r = await createDurableResumeEngine(deps).resumeAll();

    expect(r.ok).toBe(true);
    expect(remintLease).not.toHaveBeenCalled();
    const dr = deps.durableRuns as ReturnType<typeof makeDurableRuns>;
    expect(dr.calls.some((c) => c.method === "markOrphaned" && c.args[0] === "root-rev")).toBe(true);
    expect(notify).toHaveBeenCalled();
    if (r.ok) expect(r.value.orphaned).toBe(1);
  });

  it("DUR-03 cap-tamper-orphan: a record whose caps fail parseDurableRunRecord (a tampered superset) → orphaned, NOT re-minted", async () => {
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
        byRootRun: new Map([["root-tamper", tampered]]),
      }),
      remintLease,
      notify,
    });

    const r = await createDurableResumeEngine(deps).resumeAll();

    expect(r.ok).toBe(true);
    expect(remintLease).not.toHaveBeenCalled();
    const dr = deps.durableRuns as ReturnType<typeof makeDurableRuns>;
    const orphan = dr.calls.find((c) => c.method === "markOrphaned" && c.args[0] === "root-tamper");
    expect(orphan).toBeDefined();
    expect(String(orphan?.args[1])).toMatch(/cap/i); // reason mentions caps
    expect(notify).toHaveBeenCalled();
  });

  it("NEW-5 never-sent-run-resumes-not-orphaned: a status='running' record with stepIndex=-1 RESUMES (remintLease + resumeRun), NOT orphaned", async () => {
    const neverSent = durableRecord({ rootRunId: "root-neversent", stepIndex: -1 });
    const remintLease = vi.fn(() => ({ leaseId: "lease-ns", bearer: "b" }));
    const resumeRun = vi.fn(async () => ok(undefined));
    const notify = vi.fn();
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({
        resumable: [neverSent],
        byRootRun: new Map([["root-neversent", neverSent]]),
      }),
      remintLease,
      resumeRun,
      notify,
    });

    const r = await createDurableResumeEngine(deps).resumeAll();

    expect(r.ok).toBe(true);
    // the cap-tamper guard must NOT reject a legitimate -1 sentinel
    expect(remintLease).toHaveBeenCalledTimes(1);
    expect(resumeRun).toHaveBeenCalledTimes(1);
    const dr = deps.durableRuns as ReturnType<typeof makeDurableRuns>;
    expect(dr.calls.some((c) => c.method === "markOrphaned")).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    if (r.ok) expect(r.value.resumed).toBe(1);
  });

  it("HB-02 budget-deferred-backlog: a backlog of N with a fake clock past budget after K → exactly K processed, N-K deferred (no thundering herd)", async () => {
    const N = 5;
    const backlog = Array.from({ length: N }, (_, i) =>
      durableRecord({ rootRunId: `root-${i}` }),
    );
    const byRootRun = new Map(backlog.map((r) => [r.rootRunId, r]));

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
      durableRuns: makeDurableRuns({ resumable: backlog, byRootRun }),
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

  it("DUR-02 orphan path: resumeRun returns err → markOrphaned(reason) + notify (HB-03), never silently dropped", async () => {
    const record = durableRecord({ rootRunId: "root-fail" });
    const resumeRun = vi.fn(async () => err(new Error("no live channel for pending sends")));
    const notify = vi.fn();
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({
        resumable: [record],
        byRootRun: new Map([["root-fail", record]]),
      }),
      resumeRun,
      notify,
    });

    const r = await createDurableResumeEngine(deps).resumeAll();

    expect(r.ok).toBe(true);
    const dr = deps.durableRuns as ReturnType<typeof makeDurableRuns>;
    expect(dr.calls.some((c) => c.method === "markOrphaned" && c.args[0] === "root-fail")).toBe(true);
    expect(notify).toHaveBeenCalled();
    if (r.ok) expect(r.value.orphaned).toBe(1);
    // an eventBus durable:orphaned event fired
    const bus = deps.eventBus as ReturnType<typeof makeEventBus>;
    expect(bus.events.some((e) => e.event === "durable:orphaned")).toBe(true);
  });

  it("ledger reconcile integration: each resumable run's unreconciled rows are reconciled BEFORE the run resumes", async () => {
    const record = durableRecord({ rootRunId: "root-rec" });
    const row = ledgerRow({ rootRunId: "root-rec", state: "unknown_after_send" });
    const ledger = makeLedger({ unreconciled: [row] });
    // channel reconciles to "sent" → commit (no replay)
    const channelFor = vi.fn(() =>
      makeChannel(async () => ok({ kind: "sent", platformMessageId: "pm-rec" })),
    );
    const resumeRun = vi.fn(async () => ok(undefined));
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({
        resumable: [record],
        byRootRun: new Map([["root-rec", record]]),
      }),
      ledger,
      channelFor,
      resumeRun,
    });

    const r = await createDurableResumeEngine(deps).resumeAll();

    expect(r.ok).toBe(true);
    // the row was reconciled (resolveReconcile + commit) AND the run resumed
    expect(ledger.calls.some((c) => c.method === "resolveReconcile")).toBe(true);
    expect(ledger.calls.some((c) => c.method === "commit")).toBe(true);
    expect(resumeRun).toHaveBeenCalledTimes(1);
  });

  it("emits a durable:resumed event on a happy resume", async () => {
    const record = durableRecord({ rootRunId: "root-ev" });
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({
        resumable: [record],
        byRootRun: new Map([["root-ev", record]]),
      }),
    });

    await createDurableResumeEngine(deps).resumeAll();

    const bus = deps.eventBus as ReturnType<typeof makeEventBus>;
    expect(bus.events.some((e) => e.event === "durable:resumed")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FLEET-03 (Phase 220-01): the durable:* events carry a CLOSED-enum reason + a
// numeric timestamp — never the engine's free text (T-220-01 content-free
// observability). The free string stays on the WARN log / notify only.
// ─────────────────────────────────────────────────────────────────────────────

/** The closed reason union the durable:orphaned EVENT may carry (events-orchestration.ts). */
const ORPHAN_ENUM = ["not_resumable", "reread_failed", "invalid_caps", "resume_failed"] as const;

describe("orphanReasonToEnum (FLEET-03 content-free reason map, TOTAL over string)", () => {
  it("maps each known engine free-text reason to its closed enum member (never echoes the input)", () => {
    // The four free-text reasons the engine passes to orphan() today.
    expect(orphanReasonToEnum("re-read failed")).toBe("reread_failed");
    expect(orphanReasonToEnum("not resumable: status=revoked")).toBe("not_resumable");
    expect(orphanReasonToEnum("not resumable: status=missing")).toBe("not_resumable");
    expect(orphanReasonToEnum("invalid caps")).toBe("invalid_caps");
    expect(orphanReasonToEnum("resume failed")).toBe("resume_failed");
    // Each result is a member of the closed union, never the raw free text.
    for (const free of [
      "re-read failed",
      "not resumable: status=revoked",
      "invalid caps",
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

describe("durable:orphaned / durable:resumed event payloads (FLEET-03 typed, content-free)", () => {
  it("durable:orphaned carries a CLOSED-enum reason (∈ the 4-member union, ≠ the free string) + a numeric timestamp", async () => {
    // A status='revoked' re-read drives the orphan path with the free-text reason
    // `not resumable: status=revoked` — the EVENT must carry the enum, not that string.
    const running = durableRecord({ rootRunId: "root-orphan-ev", status: "running" });
    const revoked = durableRecord({ rootRunId: "root-orphan-ev", status: "revoked" });
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({
        resumable: [running],
        byRootRun: new Map([["root-orphan-ev", revoked]]),
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
        byRootRun: new Map([["root-resfail", record]]),
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

  it("durable:resumed carries a numeric stepIndex + timestamp", async () => {
    const record = durableRecord({ rootRunId: "root-resumed-ev", stepIndex: 7 });
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({
        resumable: [record],
        byRootRun: new Map([["root-resumed-ev", record]]),
      }),
      nowMs: () => 9_999,
    });

    await createDurableResumeEngine(deps).resumeAll();

    const bus = deps.eventBus as ReturnType<typeof makeEventBus>;
    const resumedEvent = bus.events.find((e) => e.event === "durable:resumed");
    expect(resumedEvent).toBeDefined();
    const payload = resumedEvent!.payload;
    expect(payload.stepIndex).toBe(7);
    expect(typeof payload.stepIndex).toBe("number");
    expect(payload.timestamp).toBe(9_999);
    expect(payload.rootRunId).toBe("root-resumed-ev");
    // Content-free: exactly {rootRunId, stepIndex, timestamp}.
    expect(Object.keys(payload).sort()).toEqual(["rootRunId", "stepIndex", "timestamp"]);
  });
});
