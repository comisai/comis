// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the durable resume engine, covering both units:
 *   - `reconcileLedgerRow` — the exactly-once recovery resolution. Tests named
 *     "reconcile: ..." so `vitest -t reconcile` selects them.
 *   - `createDurableResumeEngine` — resume-or-orphan + cap rehydrate + bounded
 *     recovery.
 *
 * The stubs (a recording ledger, a configurable channel, spy replaySend/notify,
 * a fake clock) keep the engine exhaustively unit-testable with no real I/O — it
 * is bound to the real stores / LeaseManager / channel adapters by the wiring.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  ClockPort,
  TimerPort,
  TimerHandle,
  TypedEventBus,
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
import { createResultRefStore } from "@comis/skills/tools";

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

describe("reconcileLedgerRow exactly-once recovery resolution", () => {
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

  it("reconcile: not_sent + replay fails with a PERMANENT error → markFailed('permanent'), retry budget skipped", async () => {
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

  it("reconcile: an already-committed row is a no-op — no reconcileSend, no replaySend", async () => {
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

describe("createDurableResumeEngine resume-or-orphan and bounded recovery", () => {
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

  it("revoked-record-not-reminted: a status='revoked' re-read → markOrphaned + notify, remintLease NEVER called", async () => {
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
    const orphans = durableRuns.calls.filter((c) => c.method === "markOrphaned" && c.args[0] === "root-stuck");
    expect(orphans).toHaveLength(1); // orphaned exactly once, on the 4th (over-cap) pass
    expect(String(orphans[0]!.args[1])).toMatch(/no-progress re-anchor/); // reason names the cap
  });

  it("a NEVER-SENT run (stepIndex=-1) is re-anchored past the cap but NEVER orphaned — the no-progress cap only reaps runs that progressed past the spawn boundary", async () => {
    // The re-anchor cap reaps a run that has PROGRESSED (stepIndex >= 0) and then stalled.
    // A never-sent run (stepIndex = -1) is the canonical fresh-resumable checkpoint (nothing
    // sent yet) and MUST survive a restart / repeated boot-sweep re-anchors, never be
    // false-orphaned — the durable-resume-e2e "never-sent RESUMES, not orphaned" acceptance gate.
    const record = durableRecord({ rootRunId: "root-neversent-loop", stepIndex: -1, lastHeartbeatAt: 500_000 });
    const durableRuns = makeDurableRuns({
      resumable: [record],
      byRootRun: new Map([["root-neversent-loop", record]]),
    });
    const resumeRun = vi.fn(async () => ok(undefined));
    const engine = createDurableResumeEngine(makeEngineDeps({ durableRuns, resumeRun }));
    // Drive well past MAX_REANCHOR_ATTEMPTS with an UNCHANGED heartbeat (no progress).
    for (let i = 0; i < 6; i++) await engine.resumeAll();
    expect(
      durableRuns.calls.filter((c) => c.method === "markOrphaned" && c.args[0] === "root-neversent-loop"),
      "a never-sent run must never be reaped by the no-progress cap",
    ).toHaveLength(0);
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

  it("never-sent-run-resumes-not-orphaned: a status='running' record with stepIndex=-1 RESUMES (remintLease + resumeRun), NOT orphaned", async () => {
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

  it("budget-deferred-backlog: a backlog of N with a fake clock past budget after K → exactly K processed, N-K deferred (no thundering herd)", async () => {
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

  it("orphan path: resumeRun returns err → markOrphaned(reason) + notify, never silently dropped", async () => {
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
// The durable:* events carry a CLOSED-enum reason + a numeric timestamp — never
// the engine's free text (content-free observability). The free string stays on
// the WARN log / notify only.
// ─────────────────────────────────────────────────────────────────────────────

/** The closed reason union the durable:orphaned EVENT may carry (events-orchestration.ts). */
const ORPHAN_ENUM = ["not_resumable", "reread_failed", "invalid_caps", "resume_failed"] as const;

describe("orphanReasonToEnum content-free reason map, TOTAL over string", () => {
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

describe("durable:orphaned / durable:resumed event payloads typed, content-free", () => {
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
    mkdirSync(join(ws, "results"), { recursive: true });
    writeFileSync(join(ws, opts.checkpoint), '{"step":1}');
  }
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
  return { mintLease: vi.fn(() => ({ leaseId: "lease-x", bearer: "bearer-x" })) } as unknown as LeaseManager;
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
  const wiring = buildDurableResume({
    db: {},
    durabilityCfg: { enabled: true, staleHeartbeatMs: 60_000, keepAliveMs: 30_000, recoveryBudgetMs: 5_000 },
    durableRunStore: over.store,
    outwardLedger: makeLedger(),
    boundedAutonomy: { registerRoot, leaseIdsForRoot: () => new Set<string>() } as never,
    sharedLeaseManager: makeLeaseMgr(),
    channelAdaptersRef: new Map(),
    eventBus: {
      emit: (e: string, p: Record<string, unknown>) => { events.push({ event: e, payload: p }); },
    } as unknown as TypedEventBus,
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
    const store = makeDurableRuns({ resumable: [record], byRootRun: new Map([["root-orch", record]]) });
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
    });
    const store = makeDurableRuns({ resumable: [dag], byRootRun: new Map([["root-dag", dag]]) });
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
    const store = makeDurableRuns({ resumable: [record], byRootRun: new Map([["root-gone", record]]) });
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
// owns the reclaim (RESUME-04): delete the surviving results/ (the checkpoint blob)
// + the pinned <scriptRef>. Composes the EXISTING result-ref-store.cleanupRun +
// a guarded rmSync (NG4 — no new GC primitive). Scoped to orchestrate-kind rows;
// idempotent. Proven against a REAL temp workspace (real fs).
// ─────────────────────────────────────────────────────────────────────────────

describe("reclaimOrphanedOrchestrateRun — the orphan-reclaim hook (real fs, reuses cleanupRun, NG4)", () => {
  it("reclaims a dead resumable orchestrate run's results/ (checkpoint blob) + pinned script — real files gone", async () => {
    const ws = makeTempWorkspace();
    seedArtifacts(ws, { script: "orch-a.py", checkpoint: "results/cp.json" });
    writeFileSync(join(ws, "results", "leftover.json"), "{}"); // a surviving materialized result also reclaimed
    const record = durableRecord({ rootRunId: "root-r1", scriptRef: "orch-a.py", checkpointRef: "results/cp.json" });

    await reclaimOrphanedOrchestrateRun(record, orchSeams(ws));

    expect(existsSync(join(ws, "orch-a.py"))).toBe(false);
    expect(existsSync(join(ws, "results"))).toBe(false);
  });

  it("is idempotent — a second reclaim of the same run is a no-op, never a throw", async () => {
    const ws = makeTempWorkspace();
    seedArtifacts(ws, { script: "orch-a.py", checkpoint: "results/cp.json" });
    const record = durableRecord({ rootRunId: "root-r2", scriptRef: "orch-a.py", checkpointRef: "results/cp.json" });

    await reclaimOrphanedOrchestrateRun(record, orchSeams(ws));
    // second pass: the files are already gone — resolves without throwing
    await expect(reclaimOrphanedOrchestrateRun(record, orchSeams(ws))).resolves.toBeUndefined();
    expect(existsSync(join(ws, "orch-a.py"))).toBe(false);
    expect(existsSync(join(ws, "results"))).toBe(false);
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
  it("calls reclaimOrchestrateRun(record) on the orphan path when a resumable orchestrate row's resume fails (RESUME-04)", async () => {
    const record = durableRecord({ rootRunId: "root-reclaim", scriptRef: "orch-a.py", checkpointRef: "results/cp.json" });
    const resumeRun = vi.fn(async () => err(new Error("orchestrate resume not resumable: the checkpoint blob is gone")));
    const reclaimOrchestrateRun = vi.fn(async () => {});
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({ resumable: [record], byRootRun: new Map([["root-reclaim", record]]) }),
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
      durableRuns: makeDurableRuns({ resumable: [record], byRootRun: new Map([["root-nr", record]]) }),
      resumeRun,
      nowMs: () => 555,
    });

    await createDurableResumeEngine(deps).resumeAll();

    const bus = deps.eventBus as ReturnType<typeof makeEventBus>;
    const orphanEvent = bus.events.find((e) => e.event === "durable:orphaned");
    expect(orphanEvent?.payload.reason).toBe("not_resumable");
    // Content-free (INV-5): the free-text arm reason NEVER crosses onto the event.
    expect(orphanEvent?.payload.reason).not.toBe("orchestrate resume not resumable: the checkpoint blob is gone");
    expect(orphanEvent?.payload.timestamp).toBe(555);
  });

  it("does NOT reclaim on a happy resume — reclaim is an orphan-path-only hook", async () => {
    const record = durableRecord({ rootRunId: "root-ok", scriptRef: "orch-a.py" });
    const reclaimOrchestrateRun = vi.fn(async () => {});
    const deps = makeEngineDeps({
      durableRuns: makeDurableRuns({ resumable: [record], byRootRun: new Map([["root-ok", record]]) }),
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
    seedArtifacts(ws, { script: "orch-x.py" }); // pinned script present
    mkdirSync(join(ws, "results"), { recursive: true });
    writeFileSync(join(ws, "results", "leftover.json"), "{}"); // a surviving result, but the checkpoint cp.json is GONE
    const record = durableRecord({ rootRunId: "root-e2e", scriptRef: "orch-x.py", checkpointRef: "results/cp.json" });
    const store = makeDurableRuns({ resumable: [record], byRootRun: new Map([["root-e2e", record]]) });
    const { wiring, events } = buildWiring({ store, orchestrateResume: orchSeams(ws) });

    await wiring.startAndResumeDurable();
    wiring.durableResume.shutdown();

    const orphan = events.find((e) => e.event === "durable:orphaned" && e.payload.rootRunId === "root-e2e");
    expect(orphan?.payload.reason).toBe("not_resumable");
    // RESUME-04: the dead run's surviving artifacts are reclaimed (no workspace leak).
    expect(existsSync(join(ws, "orch-x.py"))).toBe(false);
    expect(existsSync(join(ws, "results"))).toBe(false);
  });
});
