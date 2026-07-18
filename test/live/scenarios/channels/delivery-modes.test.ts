// SPDX-License-Identifier: Apache-2.0
/**
 * CHAN-03 — Delivery / streaming / queue / dmScope certification.
 *
 * Stage-B (always runs, file-backed SQLite, keyless, deterministic — no daemon, no
 * network, no LLM):
 *   - Crash-mid-delivery resume on the REAL crash-safe SQLite delivery queue (the
 *     persistence-oracle case): enqueue + enqueueInFlight rows persist
 *     (`delivery:enqueued` fires per row); close the DB (simulated crash); reopen the
 *     SAME file → recoverInFlight() parks the in_flight row as 'failed' (ambiguous
 *     send outcome, no blind replay) → pendingEntries() drains only the genuinely
 *     pending row → statusCounts() reflects them; then runDbOracle()
 *     proves the store survived uncorrupted (integrity_check + foreign_key_check).
 *     A FILE-backed DB is used (NOT :memory:) so runDbOracle can re-open it by path.
 *   - Ordered delivery: pendingEntries() returns rows oldest-first (created_at ASC).
 *   - Streaming chunk/typing/table/reply/markdownIR × queue mode/overflow × dmScope
 *     config-shape: every real enum value round-trips through its real Zod schema; a
 *     non-enum value is rejected. dmScope uses the REAL enum
 *     {main,per-peer,per-channel-peer,per-account-channel-peer}.
 *
 * `delivery:enqueued` is the real event (there is NO `delivery:delivered` — the
 * delivered state is observed via ack()/statusCounts()).
 *
 * Stage-C (describe.skipIf(!isLive) + it.skip, COMIS_LIVE + a real account/network):
 *   - real paced streamed block delivery over a live channel cadence; the queue
 *     drains over the real cadence. No account in sandbox ⇒ SKIPPED(no-account);
 *     procedure in test/live/RUNBOOK.md. skip≠fail.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDeliveryQueue, initSchema } from "@comis/memory";
import { StreamingConfigSchema } from "@comis/core";
import type { TypedEventBus } from "@comis/core";
import { runDbOracle } from "../../assert/db-oracle.js";
import {
  buildStreamingConfig,
  buildQueueConfig,
  buildDmScopeConfig,
  buildDeliveryTimingConfig,
} from "../../harness/channel-config.js";

const isLive = !!process.env["COMIS_LIVE"];

// Tmp dirs created per DB-using test — cleaned up after each test.
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

/** Allocate a fresh tmp dir + file DB path (registered for cleanup). */
function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "chan-dq-"));
  tmpDirs.push(dir);
  return join(dir, "memory.db");
}

/** Minimal DeliveryQueueEnqueueInput (mirrors delivery-queue-adapter.test.ts makeEntry). */
function makeEntry(over: Record<string, unknown> = {}): {
  text: string;
  channelType: string;
  channelId: string;
  tenantId: string;
  optionsJson: string;
  origin: string;
  maxAttempts: number;
  createdAt: number;
  scheduledAt: number;
  expireAt: number;
  traceId: string;
} {
  const now = Date.now();
  return {
    text: "hi",
    channelType: "telegram",
    channelId: "ch-1",
    tenantId: "default",
    optionsJson: "{}",
    origin: "agent",
    maxAttempts: 5,
    createdAt: now,
    scheduledAt: now,
    expireAt: now + 3_600_000,
    traceId: "t-1",
    ...over,
  };
}

/** Minimal Pick<TypedEventBus,"emitSafely"> spy. The delivery queue adapter
 *  emits via emitSafely (never-throw), so the spy records those calls. */
function makeBus(): { emit: (event: string, payload: unknown) => boolean; emitSafely: (event: string, payload: unknown) => void; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    emit: (event: string) => {
      calls.push(event);
      return true;
    },
    emitSafely: (event: string) => {
      calls.push(event);
    },
  };
}

// ---------------------------------------------------------------------------
// Stage-B — crash-mid-delivery resume (persistence oracle, file-backed SQLite)
// ---------------------------------------------------------------------------

describe("CHAN-03 Stage-B — crash-mid-delivery resume (persistence oracle, file-backed SQLite)", () => {
  it("recoverInFlight resumes a persisted in_flight row after a simulated crash; runDbOracle confirms integrity", async () => {
    const dbPath = freshDbPath();
    const bus = makeBus();

    // Boot: enqueue one pending + one in_flight row.
    let db = new Database(dbPath);
    initSchema(db, 768);
    let q = createSqliteDeliveryQueue(db, bus as Pick<TypedEventBus, "emitSafely">);
    const enq = await q.enqueue(makeEntry({ text: "pending-1" }));
    expect(enq.ok).toBe(true);
    const enqIf = await q.enqueueInFlight(makeEntry({ text: "inflight-1" }));
    expect(enqIf.ok).toBe(true);
    // one delivery:enqueued per persisted row (the documented invariant)
    expect(bus.calls.filter((c) => c === "delivery:enqueued").length).toBe(2);

    // Simulate crash: drop the handle (file persists).
    db.close();

    // Reopen the SAME file (fresh process).
    db = new Database(dbPath);
    q = createSqliteDeliveryQueue(db, bus as Pick<TypedEventBus, "emitSafely">);

    const recovered = await q.recoverInFlight();
    expect(recovered.ok).toBe(true);
    // The crashed in_flight row is PARKED as failed (ambiguous send outcome —
    // a crash can land after the platform accepted the message but before the
    // ack was stored, so recovery must NOT blindly re-queue the body).
    if (recovered.ok) expect(recovered.value).toBe(1);

    const pending = await q.pendingEntries();
    expect(pending.ok).toBe(true);
    // Only the genuinely-pending row stays drainable; the parked in_flight row
    // is 'failed', never silently re-delivered.
    if (pending.ok) expect(pending.value).toHaveLength(1);

    const counts = await q.statusCounts();
    expect(counts.ok).toBe(true);
    if (counts.ok) {
      expect(counts.value.pending).toBe(1);
      expect(counts.value.inFlight).toBe(0);
      expect(counts.value.failed).toBe(1);
    }

    db.close();

    // Persistence oracle: the store survived the crash uncorrupted, with exactly
    // the 2 persisted rows (integrity_check + foreign_key_check + row-delta).
    await expect(
      runDbOracle(dbPath, {
        expectedDeltas: [{ table: "delivery_queue", expectedRowDelta: 2 }],
        beforeCounts: { delivery_queue: 0 },
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stage-B — ordered delivery + delivery-timing config-shape
// ---------------------------------------------------------------------------

describe("CHAN-03 Stage-B — ordered delivery + delivery-timing config-shape", () => {
  it("pendingEntries returns rows oldest-first (created_at ASC)", async () => {
    const dbPath = freshDbPath();
    const db = new Database(dbPath);
    initSchema(db, 768);
    const q = createSqliteDeliveryQueue(db, makeBus() as Pick<TypedEventBus, "emitSafely">);

    const base = Date.now();
    await q.enqueue(makeEntry({ text: "first", createdAt: base, scheduledAt: base }));
    await q.enqueue(makeEntry({ text: "second", createdAt: base + 10, scheduledAt: base + 10 }));
    await q.enqueue(makeEntry({ text: "third", createdAt: base + 20, scheduledAt: base + 20 }));

    const pending = await q.pendingEntries();
    expect(pending.ok).toBe(true);
    if (pending.ok) {
      const times = pending.value.map((e: { createdAt: number }) => e.createdAt);
      for (let i = 1; i < times.length; i++) {
        expect(times[i - 1]!).toBeLessThanOrEqual(times[i]!);
      }
    }
    db.close();
  });

  it.each(["off", "natural", "custom", "adaptive"] as const)(
    "delivery-timing mode=%s round-trips through the real schema",
    (mode) => {
      expect(buildDeliveryTimingConfig({ mode }).mode).toBe(mode);
    },
  );

  it("a custom delivery-timing window round-trips (config-shape, not wall-clock)", () => {
    const t = buildDeliveryTimingConfig({ mode: "custom", minMs: 0, maxMs: 10 });
    expect(t.minMs).toBe(0);
    expect(t.maxMs).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Stage-B — streaming / queue / overflow / dmScope config-shape
// ---------------------------------------------------------------------------

describe("CHAN-03 Stage-B — streaming/queue/overflow/dmScope config-shape (real schemas)", () => {
  it.each(["followup", "collect", "steer", "steer+followup"] as const)(
    "queue defaultMode=%s round-trips",
    (mode) => {
      expect(buildQueueConfig({ defaultMode: mode }).defaultMode).toBe(mode);
    },
  );

  it.each(["drop-old", "drop-new", "summarize"] as const)(
    "queue overflow policy=%s round-trips",
    (policy) => {
      expect(buildQueueConfig({ defaultOverflow: { maxDepth: 20, policy } }).defaultOverflow.policy).toBe(policy);
    },
  );

  it.each(["paragraph", "newline", "sentence", "length"] as const)(
    "streaming defaultChunkMode=%s round-trips",
    (mode) => {
      expect(buildStreamingConfig({ defaultChunkMode: mode }).defaultChunkMode).toBe(mode);
    },
  );

  it.each(["never", "instant", "thinking", "message"] as const)(
    "streaming defaultTypingMode=%s round-trips",
    (mode) => {
      expect(buildStreamingConfig({ defaultTypingMode: mode }).defaultTypingMode).toBe(mode);
    },
  );

  it.each(["code", "bullets", "off"] as const)(
    "streaming defaultTableMode=%s round-trips",
    (mode) => {
      expect(buildStreamingConfig({ defaultTableMode: mode }).defaultTableMode).toBe(mode);
    },
  );

  it.each(["off", "first", "all"] as const)(
    "streaming defaultReplyMode=%s round-trips",
    (mode) => {
      expect(buildStreamingConfig({ defaultReplyMode: mode }).defaultReplyMode).toBe(mode);
    },
  );

  it.each([true, false] as const)("streaming defaultUseMarkdownIR=%s round-trips", (v) => {
    expect(buildStreamingConfig({ defaultUseMarkdownIR: v }).defaultUseMarkdownIR).toBe(v);
  });

  it.each(["main", "per-peer", "per-channel-peer", "per-account-channel-peer"] as const)(
    "dmScope mode=%s round-trips (the REAL enum, NOT {global,agent,session,channel})",
    (mode) => {
      expect(buildDmScopeConfig({ mode }).mode).toBe(mode);
    },
  );

  it("a non-enum streaming chunk mode is rejected by the real schema (round-trip integrity)", () => {
    expect(() => StreamingConfigSchema.parse({ defaultChunkMode: "bogus" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Stage-C — real paced streamed delivery over a live channel (operator-run)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("CHAN-03 Stage-C — real paced streamed delivery (COMIS_LIVE)", () => {
  it.skip(
    "streamed blocks over a live channel arrive ordered/paced; the queue drains over the real cadence (deferred to operator; no account in sandbox; skip≠fail; see test/live/RUNBOOK.md)",
    () => {
      // Operator (COMIS_LIVE + a real channel account): drive a real multi-block response,
      // assert the channel received blocks in order with the configured pacing, and that the
      // delivery queue drains (statusCounts.pending → 0). The persistence-oracle crash-resume
      // path above is the deterministic complement.
    },
  );
});
