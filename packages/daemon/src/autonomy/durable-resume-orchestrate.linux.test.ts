// SPDX-License-Identifier: Apache-2.0
/**
 * (Linux/VPS restart-sim) — the REAL daemon-restart boot-sweep recovery for a
 * resumable `orchestrate` run (RESUME-03). A green run on the VPS (`pnpm
 * validate:full`) proves, against a real SQLite durable checkpoint store + a real
 * temp workspace (never a mock — CLAUDE.md Root-Cause), that:
 *
 *   - a resumable orchestrate row (`{ rootRunId, scriptRef, checkpointRef }`, flat
 *     spawnTree, `status:"running"`) seeded before a "bounce" is picked up by a
 *     FRESH resume engine's boot sweep and — with the pinned script + checkpoint
 *     still on disk — surfaces as **resumed** (re-anchored, NOT re-executed on boot);
 *   - when the checkpoint blob is gone, the SAME sweep emits an honest
 *     `durable:orphaned` with the CLOSED-ENUM reason `not_resumable` (never a silent
 *     loss, never free text on the event), and the orphan reclaim removes the
 *     surviving pinned script.
 *
 * This drives the composition-root {@link buildOrchestrateResumeWiring} cluster
 * (the real `existsSync` + `result-ref-store.cleanupRun` + `safePath`-guarded
 * rmSync) end to end — the seams the macOS unit suite exercises against a temp
 * workspace, here across a genuine persist → fresh-engine → resumeAll cycle.
 *
 * It MUST compile on macOS but the whole describe block SKIPS on non-Linux (a
 * daemon-lifecycle restart is a VPS-tier proof — mirrors the shipped `.linux`
 * suites), so the macOS `pnpm validate` floor reports it skipped, never failed.
 * DEFERRED: not claimed green until it runs under `pnpm validate:full` on the VPS.
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createConversationRef,
  TypedEventBus,
  type ClockPort,
  type TimerPort,
  type TimerHandle,
  type DurableRunPort,
} from "@comis/core";
import type { ComisLogger, LeaseManager } from "@comis/infra";
import { createSqliteDurableRunStore, ensureDurableRunTable, ensureOutwardLedgerTable } from "@comis/memory";

import { buildDurableResume, buildOrchestrateResumeWiring } from "../wiring/setup-durable-resume.js";

const RUN_LINUX = process.platform === "linux";

const testClock: ClockPort = { now: () => Date.now(), nowDate: () => new Date() };
const testTimers: TimerPort = {
  setTimeout: (fn, ms) => wrapHandle(setTimeout(fn, ms)),
  setInterval: (fn, ms) => wrapHandle(setInterval(fn, ms)),
};
function wrapHandle(t: NodeJS.Timeout): TimerHandle {
  let cancelled = false;
  return {
    get cancelled() { return cancelled; },
    cancel() { cancelled = true; clearTimeout(t); clearInterval(t); },
    unref() { t.unref?.(); },
  };
}
const silentLogger: ComisLogger = (() => {
  const noop = (): void => {};
  const l = { level: "silent", trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, audit: noop } as unknown as ComisLogger;
  (l as unknown as { child: () => ComisLogger }).child = () => l;
  return l;
})();

function makeBoundedAutonomy() {
  return {
    registerRoot: vi.fn(),
    rehydrateBudget: vi.fn(),
    evictRootIfIdle: vi.fn(),
    leaseIdsForRoot: vi.fn(() => new Set<string>()),
  };
}
function makeLeaseManager(): LeaseManager {
  return {
    mintLease: vi.fn(() => ({ leaseId: "lease-vps", bearer: "bearer-vps" })),
    revoke: vi.fn(() => ({ revoked: 1 })),
  } as unknown as LeaseManager;
}

describe.skipIf(!RUN_LINUX)("orchestrate durable-resume boot-sweep recovery (restart-sim, Linux/VPS only)", () => {
  let ws: string;
  let db: unknown;
  const ROOT = "orch-vps-1";
  const AGENT = "agent-vps";
  const SCRIPT_REF = "orch-vps-1.ts";
  const CHECKPOINT_REF = "results/ckpt.json";
  const endpoint = {
    channelType: "test",
    channelInstanceId: "durable-resume",
    conversationId: "resume-vps",
    conversationKind: "direct" as const,
  };
  const conversationScope = {
    tenantId: "tenant-a",
    agentId: AGENT,
    partition: {
      kind: "endpoint-conversation-principal" as const,
      endpoint,
      principalId: "user-a",
    },
  };
  const conversationReference = createConversationRef(conversationScope);
  if (!conversationReference.ok) throw conversationReference.error;

  beforeEach(async () => {
    ws = mkdtempSync(join(tmpdir(), "comis-resume-sim-"));
    mkdirSync(join(ws, "results"), { recursive: true });
    // eslint-disable-next-line no-restricted-syntax -- Linux/VPS integration gate.
    const Database = (await import("better-sqlite3")).default;
    db = new Database(":memory:");
    ensureDurableRunTable(db);
    ensureOutwardLedgerTable(db);
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  /** Seed a resumable orchestrate row into the persisted store (the pre-bounce state). */
  async function seedResumableRow(store: DurableRunPort): Promise<void> {
    const r = await store.upsertCheckpoint({
      checkpointId: ROOT,
      rootRunId: ROOT,
      tenantId: conversationScope.tenantId,
      agentId: AGENT,
      conversationRef: conversationReference.value,
      conversationScope,
      principalId: "user-a",
      deliveryOrigin: null,
      spawnTree: [], // FLAT ⇒ the orchestrate arm (never resumeGraph)
      caps: [],
      leaseIds: [],
      budgetConsumed: 0,
      rootBudget: { startedAtMs: testClock.now(), tokensConsumed: 0, usdConsumed: 0 },
      cronOrigin: null,
      trustLevel: "user",
      status: "running",
      lastHeartbeatAt: testClock.now(),
      scriptRef: SCRIPT_REF,
      checkpointRef: CHECKPOINT_REF,
    });
    if (!r.ok) throw r.error;
  }

  function freshEngineAfterBounce(emit: (event: string, payload: unknown) => void) {
    // A FRESH engine over the SAME persisted db + the REAL orchestrateResume cluster
    // = the daemon "bounce": the boot sweep scans the seeded running rows.
    const eventBus = new TypedEventBus();
    eventBus.on("durable:resumed", (payload) => emit("durable:resumed", payload));
    eventBus.on("durable:orphaned", (payload) => emit("durable:orphaned", payload));
    return buildDurableResume({
      db,
      durabilityCfg: { enabled: true, staleHeartbeatMs: 60_000, keepAliveMs: 15_000, recoveryBudgetMs: 30_000 },
      boundedAutonomy: makeBoundedAutonomy() as never,
      sharedLeaseManager: makeLeaseManager(),
      eventBus,
      logger: silentLogger,
      clock: testClock,
      timers: testTimers,
      orchestrateResume: buildOrchestrateResumeWiring({ workspaceDirs: new Map([[AGENT, ws]]), logger: silentLogger }),
    });
  }

  it("surfaces a resumable run (durable:resumed) when the pinned script + checkpoint survive the bounce", async () => {
    // eslint-disable-next-line no-restricted-syntax -- Linux/VPS integration gate.
    const store = createSqliteDurableRunStore(db as never);
    await seedResumableRow(store);
    // The pinned artifacts survive the bounce (skip-clean preserved them).
    writeFileSync(join(ws, SCRIPT_REF), "console.log('pinned')");
    writeFileSync(join(ws, CHECKPOINT_REF), JSON.stringify({ step: 1 }));

    const emit = vi.fn();
    const engine = freshEngineAfterBounce(emit);
    await engine.startAndResumeDurable();
    engine.durableResume.shutdown();

    const resumed = emit.mock.calls.find(([e]) => e === "durable:resumed");
    expect(resumed, "the boot sweep should surface the run as resumed (present artifacts)").toBeDefined();
    expect((resumed![1] as { rootRunId: string }).rootRunId).toBe(ROOT);
  });

  it("emits durable:orphaned (closed-enum not_resumable) + reclaims the pinned script when the checkpoint is gone", async () => {
    // eslint-disable-next-line no-restricted-syntax -- Linux/VPS integration gate.
    const store = createSqliteDurableRunStore(db as never);
    await seedResumableRow(store);
    // The pinned script survives but the checkpoint blob is GONE (reclaimed/expired).
    writeFileSync(join(ws, SCRIPT_REF), "console.log('pinned')");
    // (no checkpoint file written)

    const emit = vi.fn();
    const engine = freshEngineAfterBounce(emit);
    await engine.startAndResumeDurable();
    engine.durableResume.shutdown();

    const orphaned = emit.mock.calls.find(([e]) => e === "durable:orphaned");
    expect(orphaned, "a missing checkpoint should orphan, never silently resume").toBeDefined();
    expect((orphaned![1] as { reason: string }).reason).toBe("not_resumable");
    // The orphan reclaim removed the surviving pinned script.
    expect(existsSync(join(ws, SCRIPT_REF))).toBe(false);
  });
});
