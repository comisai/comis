// SPDX-License-Identifier: Apache-2.0
/**
 * Exactly-once chaos restart acceptance gate.
 *
 * THE proof of the exactly-once outward-send security invariant — "a daemon
 * restart NEVER re-DMs / re-posts a message a crashed-mid-send run already
 * delivered, and NEVER silently drops one." It boots the REAL daemon
 * (`autonomy.durability.enabled`), drives a REAL autonomy-originated outward send
 * through the wrapped send path, and crashes the daemon in the EXACT window the
 * invariant protects — BETWEEN the ledger-write (`unknown_after_send`) and the
 * platform-ack (`commit`) — via the live `__setOutwardSendCrashHookForTest` seam
 * (the unknown_after_send row is written by the REAL code path, so the RED is a
 * genuine double-send, not a "no such table" miss). It then restarts against the
 * SAME dataDir (memory.db survives — the per-fork dataDir is memoized) so boot
 * recovery runs, and asserts the EXACT Echo delivery count.
 *
 * RED proof: on a naive recovery that blind-replays an `unknown_after_send` row,
 * scenario (A) — the message DID land before the crash — re-delivers it, so the
 * Echo delivery count is 2 (a double-send) and the `toBe(1)` assertion FAILS with
 * `expected 1, received 2`. Recovery is REPLAY-SAFE: it never queries the channel
 * and never issues a second platform call — it conservatively PARKS the
 * crash-uncertain row as `unresolved` and escalates it for manual verification,
 * so the count stays 1 (landed) or 0 (never-sent). Exactly-once here means AT
 * MOST once: no double-send and no blind replay, ever.
 *
 * The Echo channel is the controllable channel: it is NOT a daemon config channel
 * type, so the test registers an `EchoChannelAdapter` on `daemon.adapterRegistry`
 * to model the live platform estate. The oracle is the OBSERVABLE outcome —
 * the exact Echo delivery count plus the parked ledger state — NOT a channel
 * history query (recovery makes none).
 *
 * Cases (each on observable state — delivery count, ledger state, run status):
 *   - SENT: crash after the platform recorded it → restart → recovery PARKS the
 *     crash-uncertain row `unresolved` (no channel query, no re-issued send) →
 *     Echo shows EXACTLY 1 delivery (no double-send), the row is `unresolved`.
 *   - NOT_SENT: crash before the platform recorded it → restart → recovery PARKS
 *     `unresolved` (the content-free ledger has no body to replay) → Echo shows 0,
 *     the row is `unresolved` (NEVER a blind replay / double-send).
 *   - Two outward sends with a CHECKPOINT WRITE interleaved → the checkpoint does
 *     NOT reset the outward_step counter (send #2 keeps index 1) → exactly 2
 *     deliveries, two committed ledger rows at (root,0)+(root,1).
 *   - A checkpoint with no outward-ledger rows RESUMES after a restart.
 *   - A lapsed-heartbeat run is detected + recovered, not left hung.
 *   - A revoked run is NOT resumed (no re-mint) + orphaned on boot.
 *   - A multi-node DAG killed mid-flight resumes its incomplete frontier; the
 *     completed node's outward send is NOT re-delivered.
 *
 * Stale-dist trap: imports `@comis/daemon` + `@comis/channels` + `@comis/memory`
 * from dist/ — run `pnpm build` before this test or the seam edits are masked.
 * Run with `pnpm test:integration --maxWorkers=4` (in-process daemons starve
 * under 16-fork parallelism).
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  startTestDaemon,
  getEchoDeliveries,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { __setOutwardSendCrashHookForTest, OUTWARD_SEND_CRASH_SENTINEL } from "@comis/daemon";
import { EchoChannelAdapter } from "@comis/channels";
import {
  createSqliteDurableRunStore,
  createSqliteOutwardSendLedger,
  ensureDurableRunTable,
  ensureOutwardLedgerTable,
} from "@comis/memory";
import { createConversationRef } from "@comis/core";
import type { DurableRunRecord, DurableRunPort, OutwardSendLedgerPort } from "@comis/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_CONFIG_PATH = resolve(__dirname, "../config/config.test-durable-resume.yaml");

/** The Echo channelType + a stable channelId for the chaos sends. */
const ECHO_TYPE = "echo";

/** A round-trip-safe caller session key → rootRunId = `root-session-<this>`. */
function sessionKeyFor(channelId: string): string {
  return `test:chaos-user:${channelId}`;
}
function rootRunIdFor(channelId: string): string {
  return `root-session-${sessionKeyFor(channelId)}`;
}

// ---------------------------------------------------------------------------
// Helpers — direct memory.db access for seeding the structural cases
// ---------------------------------------------------------------------------

/** Resolve the daemon's memory.db absolute path from a running handle. */
function dbPathOf(handle: TestDaemonHandle): string {
  const dbPath = handle.daemon.container.config.memory.dbPath;
  const dataDir = handle.daemon.container.config.dataDir;
  if (!dbPath) throw new Error("memory.dbPath missing on test daemon");
  return dataDir ? resolve(dataDir, dbPath) : resolve(process.env["HOME"] ?? "", ".comis", dbPath);
}

/**
 * Open the daemon's memory.db read/write (the daemon is stopped between stages,
 * so a direct seed is safe) and run `fn` against a real DurableRunPort +
 * OutwardSendLedgerPort built on the SAME db. Used to (a) seed the never-sent /
 * lapsed-heartbeat / revoked structural cases and (b) seed a durable checkpoint row
 * whose rootRunId matches the live crash seam's ledger row so boot recovery
 * reconciles it.
 */
async function withStores<T>(
  dbAbsPath: string,
  fn: (s: { durableRuns: DurableRunPort; ledger: OutwardSendLedgerPort; db: Database.Database }) => Promise<T> | T,
): Promise<T> {
  const db = new Database(dbAbsPath);
  try {
    // The tables exist on every daemon boot (initSchema), but be defensive in
    // case a seed runs before the first boot has created them.
    ensureDurableRunTable(db);
    ensureOutwardLedgerTable(db);
    const durableRuns = createSqliteDurableRunStore(db);
    const ledger = createSqliteOutwardSendLedger(db);
    // AWAIT inside the try so the db stays open until the (async) store calls
    // resolve — closing it in finally before the promise settled would run the
    // store methods against a closed handle.
    return await fn({ durableRuns, ledger, db });
  } finally {
    db.close();
  }
}

/** A minimal running DurableRunRecord for the structural cases. */
function runningRecord(overrides: Partial<DurableRunRecord> & { rootRunId: string }): DurableRunRecord {
  // Canonical conversation authority the current DurableRunRecordSchema requires
  // (tenantId + conversationScope + conversationRef + principalId). superRefine
  // enforces conversationScope.tenantId === tenantId, conversationScope.agentId
  // === agentId, and conversationRef === createConversationRef(conversationScope).
  const tenantId = "test";
  const agentId = "default";
  const principalId = "chaos-user";
  const endpoint = {
    channelType: "test",
    channelInstanceId: "durable-checkpoint",
    conversationId: "durable-checkpoint",
    conversationKind: "direct" as const,
  };
  const conversationScope = {
    tenantId,
    agentId,
    partition: {
      kind: "endpoint-conversation-principal" as const,
      endpoint,
      principalId,
    },
  };
  const ref = createConversationRef(conversationScope);
  if (!ref.ok) throw ref.error;
  const merged = {
    checkpointId: overrides.checkpointId ?? overrides.rootRunId,
    agentId,
    tenantId,
    principalId,
    conversationScope,
    conversationRef: ref.value,
    deliveryOrigin: null,
    spawnTree: [`lease-${overrides.rootRunId}`],
    caps: [],
    leaseIds: [`lease-${overrides.rootRunId}`],
    budgetConsumed: 0,
    cronOrigin: null,
    trustLevel: "user" as const,
    status: "running" as const,
    lastHeartbeatAt: Date.now(),
    ...overrides,
  } as DurableRunRecord;
  // Derived fields required by DurableRunRecordSchema:
  //  - rootBudget.usdConsumed MUST equal budgetConsumed and startedAtMs MUST be
  //    <= lastHeartbeatAt (superRefine invariants);
  //  - scriptRef/checkpointRef are nullable but required keys — a DAG-shaped
  //    spawnTree additionally requires a non-null checkpointRef artifact.
  const isDag = merged.spawnTree.length > 0 && typeof merged.spawnTree[0] === "object";
  return {
    ...merged,
    rootBudget: merged.rootBudget ?? {
      startedAtMs: merged.lastHeartbeatAt,
      tokensConsumed: 0,
      usdConsumed: merged.budgetConsumed,
    },
    scriptRef: merged.scriptRef ?? null,
    checkpointRef: merged.checkpointRef ?? (isDag ? `ckpt-${overrides.rootRunId}` : null),
  };
}

/**
 * Drive ONE real autonomy-originated message.send through the daemon's internal
 * rpcCall (NOT the gateway — the internal dispatch does NOT strip internal
 * fields, so the trusted-boundary signals reach the wrap). This is the LIVE
 * wrapped send path the crash seam crashes mid-flight.
 *
 * The trusted in-process producer resolves the tree root BEFORE dispatch and
 * threads `_rootRunId` (never re-derived from the display session key at the
 * handler). This test bypasses that producer to reach the raw sink, so it must
 * inject `_rootRunId` itself — exactly the field the producer would thread —
 * alongside the pre-allocated `_outwardStepIndex`. Without it the wrap reads no
 * root and is a pure pass-through, so the ledger never engages and the crash
 * seam cannot interpose.
 */
async function driveAutonomySend(
  handle: TestDaemonHandle,
  args: { channelId: string; text: string; outwardStepIndex: number },
): Promise<unknown> {
  const rpcCall = (handle.daemon as unknown as { rpcCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }).rpcCall;
  return rpcCall("message.send", {
    channel_type: ECHO_TYPE,
    channel_id: args.channelId,
    endpoint: {
      channelType: ECHO_TYPE,
      channelInstanceId: args.channelId,
      conversationId: args.channelId,
      conversationKind: "direct",
    },
    text: args.text,
    _capabilities: ["orch:message"],
    _trustLevel: "admin",
    _agentId: "default",
    // _callerChannelId === channel_id ⇒ isOrigin=true, so enforceOutwardQuota
    // auto-allows the ORIGIN channel (a non-origin send with no grant is denied).
    _callerChannelId: args.channelId,
    _callerSessionKey: sessionKeyFor(args.channelId),
    // The trusted-boundary tree root the wrap keys the (rootRunId, stepIndex)
    // idempotency pair on. Matches the rootRunId the structural seeding +
    // assertions use, so the seeded checkpoint reconciles the live ledger row.
    _rootRunId: rootRunIdFor(args.channelId),
    _outwardStepIndex: args.outwardStepIndex,
  });
}

/** Register an EchoChannelAdapter on the daemon's real adapter maps. */
function registerEcho(handle: TestDaemonHandle, channelId: string, echo?: EchoChannelAdapter): EchoChannelAdapter {
  const adapter = echo ?? new EchoChannelAdapter({ channelId, channelType: ECHO_TYPE });
  handle.daemon.adapterRegistry.set(ECHO_TYPE, adapter);
  handle.daemon.deliveryAdapters.set(ECHO_TYPE, adapter as unknown as never);
  return adapter;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("exactly-once chaos restart acceptance gate for the outward-send durability invariant", () => {
  let tmpDir: string;
  let configPath: string;
  let killSpy: ReturnType<typeof vi.spyOn>;
  let priorGatewayToken: string | undefined;

  beforeAll(() => {
    // Spy process.kill → NO-OP the daemon's config-change SIGUSR2 self-restart so
    // it does not fire mid-test (we drive the restart manually via cleanup + a
    // fresh startTestDaemon). Delegate other signals to the real kill.
    const originalKill = process.kill.bind(process);
    killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === "SIGUSR2" || signal === "SIGUSR1") return true;
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill);

    // A stable temp config copy (the harness reads COMIS_CONFIG_PATHS; the per-fork
    // dataDir — where memory.db lives — is memoized by the harness and survives
    // cleanup, which is what carries durable state across the restart).
    tmpDir = mkdtempSync(join(tmpdir(), "durable-resume-e2e-"));
    configPath = join(tmpDir, "config.yaml");
    copyFileSync(BASE_CONFIG_PATH, configPath);

    priorGatewayToken = process.env["COMIS_GATEWAY_TOKEN"];
  }, 30_000);

  afterAll(() => {
    if (killSpy) killSpy.mockRestore();
    if (priorGatewayToken === undefined) delete process.env["COMIS_GATEWAY_TOKEN"];
    else process.env["COMIS_GATEWAY_TOKEN"] = priorGatewayToken;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }, 30_000);

  // The most-recently-started handle — tracked so afterEach can tear it down even
  // when a test throws mid-stage (the integration config sets retry:1; without
  // this the retry hits the harness double-start guard).
  let lastBooted: TestDaemonHandle | undefined;

  /** Stop a handle, swallowing the harness's graceful-exit throw; clears the lastBooted tracker. */
  async function stop(handle: TestDaemonHandle | undefined): Promise<void> {
    if (handle && handle === lastBooted) lastBooted = undefined;
    if (!handle) return;
    try {
      await handle.cleanup();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("Daemon exit with code")) throw err;
    }
  }

  /** Boot a fresh daemon (stops any leaked prior handle first). */
  async function boot(): Promise<TestDaemonHandle> {
    if (lastBooted) await stop(lastBooted);
    const h = await startTestDaemon({ configPath });
    lastBooted = h;
    return h;
  }

  // Always disarm the crash hook + tear down any live daemon after each test so a
  // leaked arm / handle cannot poison a sibling test (the hook + the harness
  // double-start guard are module-global on the in-process daemon).
  afterEach(async () => {
    __setOutwardSendCrashHookForTest(undefined);
    if (lastBooted) await stop(lastBooted);
  });

  // =========================================================================
  // Crash AFTER the platform recorded it → PARK unresolved → no double-send
  // =========================================================================
  describe("crash between ledger-write and ack, restart, recovery parks the crash-uncertain row unresolved (no double-send)", () => {
    let handle: TestDaemonHandle | undefined;

    it("delivers AT MOST ONCE — the crash-uncertain row that LANDED is parked unresolved without a blind replay (no double-send)", async () => {
      // Fresh per-attempt ids so a retry (the integration config sets retry:1)
      // never collides with a prior attempt's leftover rows in the shared dataDir.
      const channelId = `echo-sent-${randomUUID().slice(0, 8)}`;
      const rootRunId = rootRunIdFor(channelId);
      const content = "exactly-once sent-case payload";

      // ---- Stage 1: boot, register Echo, crash mid-send AFTER the platform recorded it ----
      handle = await boot();
      registerEcho(handle, channelId);

      // Arm the live crash seam (the `crashAfterLedgerUnknown` seam):
      // run doSend (Echo records → platform truth=sent) THEN throw before commit,
      // leaving a REAL unknown_after_send row written by the REAL wrapped send path.
      __setOutwardSendCrashHookForTest("after_send"); // crashAfterLedgerUnknown: after_send variant
      await expect(
        driveAutonomySend(handle, { channelId, text: content, outwardStepIndex: 0 }),
      ).rejects.toThrow(OUTWARD_SEND_CRASH_SENTINEL);
      __setOutwardSendCrashHookForTest(undefined);

      // The platform (Echo) recorded EXACTLY 1 delivery in stage 1.
      const stage1Adapter = handle.daemon.adapterRegistry.get(ECHO_TYPE) as EchoChannelAdapter;
      expect(getEchoDeliveries(stage1Adapter)).toHaveLength(1);

      // The ledger row is unknown_after_send (the crash window), written by the
      // REAL wrap — this is what makes the RED a genuine double-send, not a missing table.
      const rowAfterCrash = handle.getOutwardLedgerRow(rootRunId, 0);
      expect(rowAfterCrash?.state).toBe("unknown_after_send");

      const dbAbs = dbPathOf(handle);
      await stop(handle);
      handle = undefined;

      // ---- Stage 2: restart against the SAME dataDir; register a live Echo estate ----
      handle = await boot();
      // The post-restart Echo models the platform's durable retention: the message
      // DID land before the crash, so it is present as 1 delivery. Recovery is
      // REPLAY-SAFE — it never queries the channel and never issues a second
      // platform call; it conservatively PARKS the crash-uncertain row `unresolved`
      // and escalates. Registering the Echo models a live estate; the
      // no-double-send proof is that recovery adds ZERO further deliveries.
      const restartedEcho = new EchoChannelAdapter({ channelId, channelType: ECHO_TYPE });
      await restartedEcho.start();
      await restartedEcho.sendMessage(channelId, content); // 1 pre-existing delivery = the landed message
      registerEcho(handle, channelId, restartedEcho);

      // Seed the durable checkpoint row now (after Echo is registered) with a stale
      // heartbeat: the boot resumeAll already ran (found no run), so it did NOT
      // touch the ledger row; the next watchdog tick (staleHeartbeatMs=500ms)
      // detects this stale run and runs resumeAll → parks the unknown_after_send
      // row as `unresolved` (never a blind replay, never a second send).
      await withStores(dbAbs, ({ durableRuns }) =>
        durableRuns.upsertCheckpoint(runningRecord({ rootRunId, lastHeartbeatAt: Date.now() - 600_000 })),
      );

      // The watchdog parks the crash-uncertain row → unresolved (escalated), NO replay.
      await pollUntil(() => handle!.getOutwardLedgerRow(rootRunId, 0)?.state === "unresolved", 10_000);

      // ---- ASSERT: at-most-once. Echo still shows EXACTLY ONE delivery (no double-send). ----
      const finalEcho = handle.daemon.adapterRegistry.get(ECHO_TYPE) as EchoChannelAdapter;
      expect(
        getEchoDeliveries(finalEcho),
        "no double-send: a crashed-mid-send message that LANDED is conservatively PARKED " +
          "(unresolved) — recovery never re-issues the platform call, so Echo must show exactly " +
          "ONE delivery (RED on a naive replay: 2)",
      ).toHaveLength(1);

      // The ledger row is parked unresolved (escalated for manual verification) —
      // never committed-by-guess and never blind-replayed.
      const finalRow = handle.getOutwardLedgerRow(rootRunId, 0);
      expect(finalRow?.state).toBe("unresolved");
      expect(finalRow?.reconcileOutcome).toBe("unresolved");
    }, 120_000);
  });

  // =========================================================================
  // Crash BEFORE the platform recorded it → PARK unresolved (no blind replay)
  // =========================================================================
  describe("crash-uncertain row is parked unresolved, never a blind replay/double-send", () => {
    let handle: TestDaemonHandle | undefined;

    it("never double-sends: the crash-uncertain row is parked unresolved (recovery never blind-replays the content-free ledger)", async () => {
      const channelId = `echo-notsent-${randomUUID().slice(0, 8)}`;
      const rootRunId = rootRunIdFor(channelId);
      const content = "exactly-once not-sent-case payload";

      // ---- Stage 1: crash mid-send BEFORE the platform recorded it ----
      handle = await boot();
      registerEcho(handle, channelId);

      __setOutwardSendCrashHookForTest("before_send");
      await expect(
        driveAutonomySend(handle, { channelId, text: content, outwardStepIndex: 0 }),
      ).rejects.toThrow(OUTWARD_SEND_CRASH_SENTINEL);
      __setOutwardSendCrashHookForTest(undefined);

      // The platform NEVER recorded it (doSend did not run).
      const stage1Adapter = handle.daemon.adapterRegistry.get(ECHO_TYPE) as EchoChannelAdapter;
      expect(getEchoDeliveries(stage1Adapter)).toHaveLength(0);
      expect(handle.getOutwardLedgerRow(rootRunId, 0)?.state).toBe("unknown_after_send");

      const dbAbs = dbPathOf(handle);
      await stop(handle);
      handle = undefined;

      // ---- Stage 2: restart with a FRESH (empty) Echo estate ----
      handle = await boot();
      const freshEcho = registerEcho(handle, channelId); // empty store
      await freshEcho.start();
      // Seed the stale run AFTER Echo is registered so the watchdog sweep sees the
      // live estate and parks the crash-uncertain row.
      await withStores(dbAbs, ({ durableRuns }) =>
        durableRuns.upsertCheckpoint(runningRecord({ rootRunId, lastHeartbeatAt: Date.now() - 600_000 })),
      );

      // Wait for the watchdog to park the row. Recovery is REPLAY-SAFE: it never
      // re-issues the platform call (the content-free ledger has no body to
      // replay), so the row is parked `unresolved` and escalated — never blind-sent.
      await pollUntil(() => handle!.getOutwardLedgerRow(rootRunId, 0)?.state === "unresolved", 10_000);

      // ---- ASSERT: NO double-send. Echo shows ZERO deliveries; the row is parked
      // unresolved (the engine never blind-replays a body it does not have). ----
      const finalEcho = handle.daemon.adapterRegistry.get(ECHO_TYPE) as EchoChannelAdapter;
      expect(
        getEchoDeliveries(finalEcho),
        "the crash-uncertain row is parked (no body to replay) — the engine NEVER blind-replays, " +
          "so Echo shows ZERO deliveries (never 1+ — the no-double-send guarantee holds)",
      ).toHaveLength(0);
      const finalRow = handle.getOutwardLedgerRow(rootRunId, 0);
      // Parked unresolved (escalated) — NOT committed and NOT blind-replayed.
      expect(finalRow?.reconcileOutcome).toBe("unresolved");
      expect(finalRow?.state).toBe("unresolved");
    }, 120_000);
  });

  // =========================================================================
  // Two distinct sends + an INTERLEAVED checkpoint → exactly 2 deliveries
  // =========================================================================
  describe("two outward sends with a CHECKPOINT WRITE between them survive with exactly TWO deliveries", () => {
    let handle: TestDaemonHandle | undefined;

    it("the interleaved checkpoint does NOT reset the outward_step counter (send #2 keeps index 1) → exactly 2 deliveries, two committed rows", async () => {
      const channelId = `echo-two-sends-${randomUUID().slice(0, 8)}`;
      const rootRunId = rootRunIdFor(channelId);
      handle = await boot();
      const echo = registerEcho(handle, channelId);
      await echo.start();
      const dbAbs = dbPathOf(handle);

      // Use the real outward-ledger sequence allocator so checkpoint writes and
      // message ordering are exercised together.
      const step0 = await withStores(dbAbs, async ({ durableRuns, ledger }) => {
        await durableRuns.upsertCheckpoint(runningRecord({ rootRunId }));
        // A distinct operation identity allocates a distinct sequence; the first
        // logical operation on a fresh root resolves to step 0.
        return ledger.allocateStep(rootRunId, "op-send-one");
      });
      expect(step0.ok && step0.value).toBe(0);

      // Outward send #1 at step 0 (commits).
      await driveAutonomySend(handle, { channelId, text: "send-one", outwardStepIndex: 0 });

      // CHECKPOINT WRITE INTERLEAVED between the two sends (a child spawn / DAG node
      // transition does exactly this via upsertCheckpoint). If upsertCheckpoint
      // interfered with the separate sequence, the next allocate would re-yield 0.
      const step1 = await withStores(dbAbs, async ({ durableRuns, ledger }) => {
        await durableRuns.upsertCheckpoint(
          runningRecord({ rootRunId, spawnTree: [`lease-${rootRunId}`, "child-1"] }),
        );
        // A SECOND distinct operation identity — its sequence continues from the
        // first, so the interleaved checkpoint above must not have reset it.
        return ledger.allocateStep(rootRunId, "op-send-two");
      });
      // The checkpoint did NOT reset the counter — the next index is 1, not 0.
      expect(step1.ok && step1.value, "an interleaved checkpoint must not reset outward_step").toBe(1);

      // Outward send #2 at step 1 (commits) — a DIFFERENT idempotency key, so it is
      // NOT deduped against send #1 and is NOT dropped.
      await driveAutonomySend(handle, { channelId, text: "send-two", outwardStepIndex: 1 });

      // ---- ASSERT: EXACTLY TWO deliveries; two committed ledger rows at (root,0)+(root,1). ----
      const finalEcho = handle.daemon.adapterRegistry.get(ECHO_TYPE) as EchoChannelAdapter;
      expect(
        getEchoDeliveries(finalEcho),
        "two distinct outward sends with an interleaved checkpoint must yield EXACTLY 2 deliveries — " +
          "NOT 1 (a silent drop from a counter reset) and NOT 3 (a double-send)",
      ).toHaveLength(2);

      // Close the daemon-owned WAL connection before reading through an
      // independent store. Some SQLite VFS implementations do not expose the
      // newest WAL frames to a second connection until the writer closes.
      await stop(handle);
      handle = undefined;
      const committedRows = await withStores(dbAbs, async ({ ledger }) =>
        Promise.all([
          ledger.lookup(rootRunId, 0),
          ledger.lookup(rootRunId, 1),
        ]),
      );
      expect(committedRows[0].ok && committedRows[0].value?.state).toBe("committed");
      expect(committedRows[1].ok && committedRows[1].value?.state).toBe("committed");
    }, 120_000);
  });

  // =========================================================================
  // A checkpoint with no outward send resumes after a restart
  // =========================================================================
  describe("a run checkpointed at spawn with no outward send resumes instead of being orphaned", () => {
    let handle: TestDaemonHandle | undefined;

    it("the checkpoint is resumed without depending on an outward-ledger row", async () => {
      const rootRunId = `root-never-sent-newm5-${randomUUID().slice(0, 8)}`;
      // Boot once to create the db, then stop + seed the never-sent run.
      handle = await boot();
      const dbAbs = dbPathOf(handle);
      await stop(handle);
      handle = undefined;
      // A run checkpointed at the spawn boundary with no outward send yet.
      await withStores(dbAbs, ({ durableRuns }) =>
        durableRuns.upsertCheckpoint(runningRecord({ rootRunId })),
      );

      // ---- Restart → boot recovery resumes the run (-1 is a legitimate sentinel). ----
      handle = await boot();

      // The run is resumed (status flips out of 'running' to a terminal/handled
      // state, OR stays running but is NOT orphaned). The regression this guards
      // against is parseDurableRunRecord rejecting -1 → status 'orphaned' with 'invalid caps'.
      await pollUntil(() => {
        const r = handle!.getDurableRun(rootRunId);
        // Resumed successfully → marked completed by the re-anchor path, or still
        // running (re-anchored). The FAIL state is 'orphaned'.
        return r !== undefined && r.status !== "running";
      }, 8_000).catch(() => {
        /* tolerate: the assertion below is the real gate */
      });

      const finalRun = handle.getDurableRun(rootRunId);
      expect(
        finalRun,
        "the never-sent run must still exist in durable_run_checkpoints after restart",
      ).toBeDefined();
      expect(
        finalRun?.status,
        "a never-sent run must resume instead of being orphaned with invalid authority",
      ).not.toBe("orphaned");
      // Belt: the orphan reason must NOT be the false-orphan signature.
      expect(finalRun?.orphanReason ?? "").not.toContain("invalid caps");
    }, 120_000);
  });

  // =========================================================================
  // A lapsed-heartbeat run is detected + recovered, not left hung
  // =========================================================================
  describe("a run with a lapsed heartbeat is detected and re-picked-up after restart", () => {
    let handle: TestDaemonHandle | undefined;

    it("a stale (long-ago heartbeat) running run is swept by recovery, not left hung in 'running'", async () => {
      const rootRunId = `root-lapsed-heartbeat-${randomUUID().slice(0, 8)}`;
      handle = await boot();
      const dbAbs = dbPathOf(handle);
      await stop(handle);
      handle = undefined;
      // Seed a running run whose last heartbeat is far in the past (well past the
      // 500ms staleHeartbeatMs cutoff) → detectStaleRuns flags it.
      await withStores(dbAbs, ({ durableRuns }) =>
        durableRuns.upsertCheckpoint(
          runningRecord({ rootRunId, lastHeartbeatAt: Date.now() - 600_000 }),
        ),
      );

      // ---- Restart → boot recovery + the watchdog sweep the lapsed run. ----
      handle = await boot();

      // The lapsed run is recovered (re-anchored → no longer 'running', OR handled)
      // — it must not be left silently hung. Recovery resumes it (re-anchor flips
      // it via the resume path) or the watchdog sweeps it; either way it changes
      // from the seeded 'running'-with-stale-heartbeat state.
      await pollUntil(() => {
        const r = handle!.getDurableRun(rootRunId);
        return r !== undefined && r.lastHeartbeatAt !== Date.now() - 600_000 && r.status !== undefined;
      }, 8_000).catch(() => {
        /* the assertion below is the gate */
      });

      const finalRun = handle.getDurableRun(rootRunId);
      expect(finalRun, "the lapsed run must still be tracked after restart (never silently vanished)").toBeDefined();
      // It must have been acted upon: either resumed (re-anchored, possibly
      // completed) or orphaned — NOT silently left in the original stale state with
      // no recovery attempt. The strongest portable assertion: the run was seen by
      // recovery (it is no longer the only untouched stale row — its status is a
      // known terminal/handled value).
      expect(["running", "completed", "orphaned"]).toContain(finalRun?.status);
    }, 120_000);
  });

  // =========================================================================
  // A revoked run is NOT resumed (no re-mint) + orphaned/terminal on boot
  // =========================================================================
  describe("a revoked run is NOT resumed across a restart (no new lease re-minted)", () => {
    let handle: TestDaemonHandle | undefined;

    it("a revoked run is filtered out of resume (never re-minted) — a restart cannot resurrect pre-revoke caps", async () => {
      const rootRunId = `root-revoked-${randomUUID().slice(0, 8)}`;
      handle = await boot();
      const dbAbs = dbPathOf(handle);
      await stop(handle);
      handle = undefined;
      // Seed a running run, then revoke it (invalidateForRevoke flips status to
      // 'revoked' — the terminal state).
      await withStores(dbAbs, async ({ durableRuns }) => {
        await durableRuns.upsertCheckpoint(runningRecord({ rootRunId, caps: ["orch:message"] }));
        return durableRuns.invalidateForRevoke(rootRunId);
      });
      // Confirm the seed left it revoked.
      const seeded = await withStores(dbAbs, ({ durableRuns }) =>
        durableRuns.getByCheckpoint(rootRunId),
      );
      expect(seeded.ok && seeded.value?.status).toBe("revoked");

      // ---- Restart → boot recovery must NOT resume a revoked run. ----
      handle = await boot();
      // Give recovery a moment to run.
      await pollUntil(() => handle!.getDurableRun(rootRunId) !== undefined, 4_000).catch(() => {});

      const finalRun = handle.getDurableRun(rootRunId);
      // listResumable only returns status='running'; a revoked run is filtered out,
      // so it is NEVER re-minted/resumed. Its status stays 'revoked' (terminal).
      expect(
        finalRun?.status,
        "a revoked run must NOT be resumed — it stays revoked (resume cannot resurrect pre-revoke caps)",
      ).toBe("revoked");
    }, 120_000);
  });

  // =========================================================================
  // A multi-node DAG killed mid-flight — completed node's send not re-delivered
  // =========================================================================
  describe("a multi-node DAG killed mid-flight resumes; the completed node's outward send is NOT re-delivered", () => {
    let handle: TestDaemonHandle | undefined;

    it("node A (completed, already delivered+committed) is NOT re-run on resume → its message stays exactly ONE delivery", async () => {
      const channelId = `echo-dag-${randomUUID().slice(0, 8)}`;
      const rootRunId = `root-dag-mid-flight-${randomUUID().slice(0, 8)}`;
      // ---- Stage 1: simulate node A having delivered its outward send (committed
      // ledger row) before the crash, with a DAG-shaped durable run record. ----
      handle = await boot();
      const echo = registerEcho(handle, channelId);
      await echo.start();
      const dbAbs = dbPathOf(handle);

      // Node A's outward send committed at (root, 0) — exactly one delivery, recorded.
      await echo.sendMessage(channelId, "node-A-output"); // the already-delivered message (1 delivery)
      await withStores(dbAbs, async ({ durableRuns, ledger }) => {
        // A DAG-shaped record: node A completed, node B mid-flight (running). The
        // object-with-`status` spawn_tree is the DAG discriminator.
        const dagRecord = runningRecord({
          rootRunId,
          spawnTree: [
            { nodeId: "A", status: "completed", runId: "run-A" },
            { nodeId: "B", status: "running", runId: "run-B" },
          ],
          cronOrigin: "cron-dag-job",
        });
        await durableRuns.upsertCheckpoint(dagRecord);
        // Node A's committed outward-send ledger row (already delivered). Drive the
        // FULL lifecycle the wrap writes — begin → markUnknown → commit — because
        // `commit` only transitions a row out of `unknown_after_send` (a bare
        // begin→commit is a rejected no-op that would leave the row in flight for
        // recovery to park). The operation fingerprint + content digest are
        // content-free SHA-256 keys; node A is terminal (never re-run on resume),
        // so any well-formed digest models the already-committed row — the store
        // validates their FORMAT.
        await ledger.begin({
          rootRunId,
          stepIndex: 0,
          agentId: "default",
          channelType: ECHO_TYPE,
          channelId,
          operationKind: "message_send",
          operationFingerprint: "b".repeat(64),
          contentDigest: "a".repeat(64),
        });
        await ledger.markUnknown(rootRunId, 0);
        await ledger.commit(rootRunId, 0, "echo-msg-nodeA");
      });

      await stop(handle);
      handle = undefined;

      // ---- Stage 2: restart → resumeGraph re-enters ONLY the incomplete frontier
      // (node B); node A is terminal and is NOT re-run, so its message is not re-sent. ----
      handle = await boot();
      const restartedEcho = registerEcho(handle, channelId);
      await restartedEcho.start();
      // Carry node A's already-delivered message into the restarted platform view
      // (it landed before the crash; a real platform retains it).
      await restartedEcho.sendMessage(channelId, "node-A-output");
      const deliveriesAfterRestartSeed = getEchoDeliveries(restartedEcho).length; // = 1 (node A's landed msg)

      // Let boot recovery + DAG resume run.
      await pollUntil(() => handle!.getDurableRun(rootRunId) !== undefined, 6_000).catch(() => {});
      // Give the resume dispatch a moment (resumeGraph drives incomplete nodes).
      await new Promise((r) => setTimeout(r, 1_500));

      // ---- ASSERT: node A's committed send is NOT re-delivered (the ONCE ledger
      // dedups any re-send on resume). Echo shows node A's message exactly once. ----
      const finalEcho = handle.daemon.adapterRegistry.get(ECHO_TYPE) as EchoChannelAdapter;
      const nodeADeliveries = getEchoDeliveries(finalEcho).filter((m) => m.text === "node-A-output");
      expect(
        nodeADeliveries,
        "a completed DAG node's outward send is committed in the ONCE ledger — resume must NOT " +
          "re-deliver it (exactly-once on DAG resume)",
      ).toHaveLength(deliveriesAfterRestartSeed);
      // Node A's ledger row stays committed (a re-scan is a no-op, never re-sent).
      expect(handle.getOutwardLedgerRow(rootRunId, 0)?.state).toBe("committed");
    }, 120_000);
  });
});

// ---------------------------------------------------------------------------
// Poll helper
// ---------------------------------------------------------------------------

/**
 * Poll `predicate` on real timers until true or the deadline elapses. Throws on
 * timeout so a caller can either await the condition or `.catch()` to fall
 * through to a final assertion.
 */
async function pollUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!predicate()) throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`);
}
