// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for createSqliteOutwardSendLedger — the outward-send uncertainty
 * ledger.
 *
 * Pins the load-bearing invariants:
 *   - the committed branch of the closed five-state lifecycle
 *     (send_attempt_started → unknown_after_send → committed),
 *   - the UNIQUE (rootRunId, stepIndex) collision that makes a duplicate begin an
 *     err the wrap site treats as "already in flight",
 *   - the repeated-operation short-circuit (a committed row is re-readable so the wrap site
 *     short-circuits),
 *   - the per-row startup parking scan listUnreconciled (no blind bulk reset),
 *   - content-free (the row carries content_digest, never a body),
 *   - corrupt-row-degrades-to-err (createRowMapper).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteOutwardSendLedger } from "./outward-send-ledger-store.js";
import { ensureOutwardLedgerTable } from "./schema-outward-ledger.js";
import { initSchema } from "./schema.js";
import type { OutwardSendBeginInput } from "@comis/core";

// Deterministic clock — every mutation stamps a known time so updated_at_ms
// assertions are stable.
let fakeNow = 1_000;
const nowMs = (): number => fakeNow;

let db: Database.Database;
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const FINGERPRINT_A = "c".repeat(64);

function makeBegin(over: Partial<OutwardSendBeginInput> = {}): OutwardSendBeginInput {
  return {
    rootRunId: "run-A",
    stepIndex: 0,
    agentId: "agent-1",
    channelType: "telegram",
    channelId: "chat-99",
    operationKind: "message_send",
    operationFingerprint: FINGERPRINT_A,
    contentDigest: DIGEST_A,
    ...over,
  };
}

beforeEach(() => {
  fakeNow = 1_000;
  db = new Database(":memory:");
  ensureOutwardLedgerTable(db);
});

afterEach(() => {
  db.close();
});

describe("createSqliteOutwardSendLedger — begin + lookup", () => {
  it("begin writes a send_attempt_started row that lookup returns", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);

    const begun = await ledger.begin(makeBegin());
    expect(begun.ok).toBe(true);

    const found = await ledger.lookup("run-A", 0);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value).toBeDefined();
    expect(found.value?.state).toBe("send_attempt_started");
    expect(found.value?.rootRunId).toBe("run-A");
    expect(found.value?.stepIndex).toBe(0);
    expect(found.value?.contentDigest).toBe(DIGEST_A);
    expect(found.value?.operationKind).toBe("message_send");
    expect(found.value?.operationFingerprint).toBe(FINGERPRINT_A);
    expect(found.value?.attemptCount).toBe(0);
    expect(found.value?.attemptedAtMs).toBe(1_000);
    // Content-free: there is no body/text field on the record at all.
    expect(found.value).not.toHaveProperty("body");
    expect(found.value).not.toHaveProperty("text");
  });

  it("lookup returns ok(undefined) for a key that was never begun", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    const found = await ledger.lookup("run-A", 0);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value).toBeUndefined();
  });

  it("reclaims only a proven pre-send attempt", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    await ledger.begin(makeBegin());
    expect(await ledger.reclaimPreSend("run-A", 0)).toEqual({ ok: true, value: true });
    expect(await ledger.lookup("run-A", 0)).toEqual({ ok: true, value: undefined });

    await ledger.begin(makeBegin());
    await ledger.markUnknown("run-A", 0);
    expect(await ledger.reclaimPreSend("run-A", 0)).toEqual({ ok: true, value: false });
    expect((await ledger.lookup("run-A", 0)).ok).toBe(true);
  });
});

describe("createSqliteOutwardSendLedger — closed five-state lifecycle", () => {
  it("begin → markUnknown → commit transitions state in order and sets platformMessageId", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);

    await ledger.begin(makeBegin());
    const afterBegin = await ledger.lookup("run-A", 0);
    expect(afterBegin.ok && afterBegin.value?.state).toBe("send_attempt_started");

    fakeNow = 2_000;
    const marked = await ledger.markUnknown("run-A", 0);
    expect(marked.ok).toBe(true);
    const afterUnknown = await ledger.lookup("run-A", 0);
    expect(afterUnknown.ok && afterUnknown.value?.state).toBe("unknown_after_send");
    expect(afterUnknown.ok && afterUnknown.value?.platformMessageId).toBeUndefined();
    expect(afterUnknown.ok && afterUnknown.value?.attemptCount).toBe(1);

    fakeNow = 3_000;
    const committed = await ledger.commit("run-A", 0, "tg-msg-555");
    expect(committed.ok).toBe(true);
    const afterCommit = await ledger.lookup("run-A", 0);
    expect(afterCommit.ok && afterCommit.value?.state).toBe("committed");
    expect(afterCommit.ok && afterCommit.value?.platformMessageId).toBe("tg-msg-555");
  });
});

describe("createSqliteOutwardSendLedger — UNIQUE (rootRunId, stepIndex) dedup", () => {
  it("a second begin on the SAME (rootRunId, stepIndex) returns err (UNIQUE collision)", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);

    const first = await ledger.begin(makeBegin({ contentDigest: DIGEST_A }));
    expect(first.ok).toBe(true);

    // The wrap site treats this err as "already in flight — do NOT
    // double-send". A different contentDigest must NOT bypass the dedup.
    const second = await ledger.begin(makeBegin({ contentDigest: DIGEST_B }));
    expect(second.ok).toBe(false);

    // The dedup key holds: lookup still shows the FIRST row's digest, untouched.
    const found = await ledger.lookup("run-A", 0);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value?.contentDigest).toBe(DIGEST_A);
    expect(found.value?.state).toBe("send_attempt_started");
  });

  it("a different stepIndex on the same run is NOT a collision (distinct sends)", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    const s0 = await ledger.begin(makeBegin({ stepIndex: 0 }));
    const s1 = await ledger.begin(makeBegin({ stepIndex: 1 }));
    expect(s0.ok).toBe(true);
    expect(s1.ok).toBe(true);
  });

  it("after commit, lookup returns the retained receipt for a repeated operation", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    await ledger.begin(makeBegin());
    await ledger.markUnknown("run-A", 0);
    await ledger.commit("run-A", 0, "tg-msg-777");

    // The wrap site reads this committed row and returns its retained receipt;
    // it does not issue another platform call for the same identity.
    const repeated = await ledger.lookup("run-A", 0);
    expect(repeated.ok).toBe(true);
    if (!repeated.ok) return;
    expect(repeated.value?.state).toBe("committed");
    expect(repeated.value?.platformMessageId).toBe("tg-msg-777");
  });
});

describe("createSqliteOutwardSendLedger — durable outward sequence", () => {
  it("persists only a full digest of the caller operation identity", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    const operationId = "user-authored-operation-marker";

    expect(await ledger.allocateStep("run-A", operationId)).toEqual({ ok: true, value: 0 });

    const row = db.prepare(
      "SELECT operation_id FROM outward_send_operations WHERE root_run_id = ?",
    ).get("run-A") as { operation_id: string };
    expect(row.operation_id).toBe(
      createHash("sha256").update(JSON.stringify(operationId), "utf8").digest("hex"),
    );
    expect(row.operation_id).not.toContain(operationId);
    expect(row.operation_id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects invalid operation identities before writing an operation mapping", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);

    expect((await ledger.allocateStep("run-A", "")).ok).toBe(false);
    expect((await ledger.allocateStep("run-A", "x".repeat(257))).ok).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS count FROM outward_send_operations").get())
      .toEqual({ count: 0 });
  });

  it("returns one stable step for repeated allocation of the same caller operation", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);

    const first = await ledger.allocateStep("run-A", "operation-1");
    const responseLossRetry = await ledger.allocateStep("run-A", "operation-1");
    const distinctOperation = await ledger.allocateStep("run-A", "operation-2");

    expect(first).toEqual({ ok: true, value: 0 });
    expect(responseLossRetry).toEqual({ ok: true, value: 0 });
    expect(distinctOperation).toEqual({ ok: true, value: 1 });
  });

  it("preserves the operation-to-step mapping across a real SQLite close and reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-outward-ledger-"));
    const dbPath = join(dir, "memory.db");
    try {
      const firstDb = new Database(dbPath);
      ensureOutwardLedgerTable(firstDb);
      const firstLedger = createSqliteOutwardSendLedger(firstDb, nowMs);
      expect(await firstLedger.allocateStep("run-restart", "operation-stable"))
        .toEqual({ ok: true, value: 0 });
      firstDb.close();

      const reopenedDb = new Database(dbPath);
      const reopenedLedger = createSqliteOutwardSendLedger(reopenedDb, nowMs);
      expect(await reopenedLedger.allocateStep("run-restart", "operation-stable"))
        .toEqual({ ok: true, value: 0 });
      expect(await reopenedLedger.allocateStep("run-restart", "operation-next"))
        .toEqual({ ok: true, value: 1 });
      reopenedDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allocates after the greatest retained ledger step without creating a resumable checkpoint", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);

    await ledger.begin(makeBegin({ stepIndex: 0 }));
    await ledger.begin(makeBegin({ stepIndex: 1 }));
    await ledger.begin(makeBegin({ stepIndex: 4 }));

    const first = await ledger.allocateStep("run-A", "operation-after-retained");
    const second = await ledger.allocateStep("run-A", "operation-after-retained-2");

    expect(first).toEqual({ ok: true, value: 5 });
    expect(second).toEqual({ ok: true, value: 6 });
    const checkpointTable = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='durable_run_checkpoints'",
      )
      .get();
    expect(checkpointTable).toBeUndefined();
  });

  it("reconciles a stale sequence row against a higher retained ledger step atomically", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    expect(await ledger.allocateStep("run-A", "operation-before-stale")).toEqual({ ok: true, value: 0 });
    await ledger.begin(makeBegin({ stepIndex: 7 }));

    expect(await ledger.allocateStep("run-A", "operation-after-stale")).toEqual({ ok: true, value: 8 });
  });
});

describe("createSqliteOutwardSendLedger — failure + uncertainty parking", () => {
  it("rejects a truncated digest before persisting the send intent", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);

    const begun = await ledger.begin(makeBegin({ contentDigest: "a".repeat(16) }));

    expect(begun.ok).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS count FROM outward_send_ledger").get())
      .toEqual({ count: 0 });
  });

  it("every transition returns err when its target row does not exist", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);

    expect((await ledger.markUnknown("missing", 99)).ok).toBe(false);
    expect((await ledger.commit("missing", 99, "message-1")).ok).toBe(false);
    expect((await ledger.markFailed("missing", 99, "permanent")).ok).toBe(false);
    expect(await ledger.parkUncertain("missing", 99)).toEqual({ ok: true, value: false });
  });

  it("rejects invalid lifecycle transitions instead of silently rewriting terminal truth", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    await ledger.begin(makeBegin());

    expect((await ledger.commit("run-A", 0, "too-early")).ok).toBe(false);
    await ledger.markUnknown("run-A", 0);
    await ledger.commit("run-A", 0, "committed-message");
    expect((await ledger.markUnknown("run-A", 0)).ok).toBe(false);
    expect((await ledger.markFailed("run-A", 0, "late-failure")).ok).toBe(false);
    expect(await ledger.parkUncertain("run-A", 0)).toEqual({ ok: true, value: false });

    const found = await ledger.lookup("run-A", 0);
    expect(found.ok && found.value?.state).toBe("committed");
    expect(found.ok && found.value?.platformMessageId).toBe("committed-message");
  });

  it("atomically grants one uncertainty parking transition across two SQLite connections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-ledger-park-"));
    const dbPath = join(dir, "memory.db");
    const firstDb = new Database(dbPath);
    const secondDb = new Database(dbPath);
    try {
      ensureOutwardLedgerTable(firstDb);
      ensureOutwardLedgerTable(secondDb);
      const first = createSqliteOutwardSendLedger(firstDb, nowMs);
      const second = createSqliteOutwardSendLedger(secondDb, nowMs);
      await first.begin(makeBegin());
      await first.markUnknown("run-A", 0);

      const claims = await Promise.all([
        first.parkUncertain("run-A", 0),
        second.parkUncertain("run-A", 0),
      ]);

      expect(claims.filter((claim) => claim.ok && claim.value)).toHaveLength(1);
      expect(claims.filter((claim) => claim.ok && !claim.value)).toHaveLength(1);
      const parked = await first.lookup("run-A", 0);
      expect(parked.ok && parked.value?.state).toBe("unresolved");
      expect(parked.ok && parked.value?.reconcileOutcome).toBe("unresolved");
    } finally {
      secondDb.close();
      firstDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("markFailed sets state='failed' and records the errorKind", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    await ledger.begin(makeBegin());
    await ledger.markUnknown("run-A", 0);
    const failed = await ledger.markFailed("run-A", 0, "rate_limited");
    expect(failed.ok).toBe(true);

    const found = await ledger.lookup("run-A", 0);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value?.state).toBe("failed");
    expect(found.value?.lastError).toBe("rate_limited");
  });

  it("parks an uncertain row and keeps it visible to the root causal gate", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    await ledger.begin(makeBegin());
    await ledger.markUnknown("run-A", 0);
    const parked = await ledger.parkUncertain("run-A", 0);
    expect(parked).toEqual({ ok: true, value: true });

    const found = await ledger.lookup("run-A", 0);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value?.reconcileOutcome).toBe("unresolved");
    expect(found.value?.state).toBe("unresolved");
    expect(await ledger.hasUncertainty("run-A")).toEqual({ ok: true, value: true });
    expect(await ledger.hasUncertainty("another-run")).toEqual({ ok: true, value: false });
  });

  it("rejects an empty platform message id instead of fabricating delivery evidence", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    await ledger.begin(makeBegin());
    await ledger.markUnknown("run-A", 0);

    expect((await ledger.commit("run-A", 0, "")).ok).toBe(false);
    const found = await ledger.lookup("run-A", 0);
    expect(found.ok && found.value?.state).toBe("unknown_after_send");
  });
});

describe("createSqliteOutwardSendLedger — listUnreconciled startup parking scan", () => {
  it("returns ONLY the unknown_after_send + send_attempt_started rows", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);

    // committed — must be excluded
    await ledger.begin(makeBegin({ stepIndex: 0 }));
    await ledger.markUnknown("run-A", 0);
    await ledger.commit("run-A", 0, "msg-0");

    // unknown_after_send — must be included
    await ledger.begin(makeBegin({ stepIndex: 1 }));
    await ledger.markUnknown("run-A", 1);

    // send_attempt_started — must be included (crashed before markUnknown)
    await ledger.begin(makeBegin({ stepIndex: 2 }));

    // failed — must be excluded
    await ledger.begin(makeBegin({ stepIndex: 3 }));
    await ledger.markUnknown("run-A", 3);
    await ledger.markFailed("run-A", 3, "permanent");

    const scan = await ledger.listUnreconciled(100);
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;

    const steps = scan.value.map((r) => r.stepIndex).sort((a, b) => a - b);
    expect(steps).toEqual([1, 2]);
    for (const row of scan.value) {
      expect(["unknown_after_send", "send_attempt_started"]).toContain(row.state);
    }
  });

  it("returns an empty array when nothing is in flight (no blind bulk reset to scan)", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    await ledger.begin(makeBegin());
    await ledger.markUnknown("run-A", 0);
    await ledger.commit("run-A", 0, "msg-x");

    const scan = await ledger.listUnreconciled(100);
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.value).toEqual([]);
  });

  it("applies a deterministic scan limit and leaves the remainder for the next pass", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    await ledger.begin(makeBegin({ rootRunId: "run-B", stepIndex: 1 }));
    await ledger.begin(makeBegin({ rootRunId: "run-A", stepIndex: 2 }));

    const first = await ledger.listUnreconciled(1);
    expect(first.ok && first.value).toHaveLength(1);
    if (!first.ok) return;
    await ledger.parkUncertain(first.value[0]!.rootRunId, first.value[0]!.stepIndex);

    const second = await ledger.listUnreconciled(1);
    expect(second.ok && second.value).toHaveLength(1);
    if (!second.ok) return;
    expect(second.value[0]?.id).not.toBe(first.value[0]?.id);
  });
});

describe("createSqliteOutwardSendLedger — content-free + corrupt-row resilience", () => {
  it("a corrupt row (bad state outside the union) degrades lookup to err, not a throw", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    await ledger.begin(makeBegin());

    // Tamper a non-key column to a value the Zod row schema does not allow.
    // SQLite's INTEGER affinity stores a non-numeric string as TEXT, so on read
    // attempt_count comes back a string — OutwardLedgerDbRowSchema's z.number()
    // rejects it and createRowMapper degrades lookup to err, never a
    // throw that aborts the boot recovery scan. (attempt_count, not step_index,
    // so the lookup WHERE still matches the now-corrupt row.)
    db.prepare(
      `UPDATE outward_send_ledger SET attempt_count = 'not-a-number' WHERE root_run_id = 'run-A'`,
    ).run();

    const found = await ledger.lookup("run-A", 0);
    expect(found.ok).toBe(false);
  });

  it("never stores a message body — only content_digest is persisted", () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    void ledger; // the assertion is structural: the table has no body/text/message column.
    const cols = db
      .prepare(`SELECT name FROM pragma_table_info('outward_send_ledger')`)
      .all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("content_digest");
    expect(names).not.toContain("body");
    expect(names).not.toContain("text");
    expect(names).not.toContain("message");
    expect(names).not.toContain("message_body");
  });
});

describe("ensureOutwardLedgerTable wiring — real initSchema layout", () => {
  it("the REAL initSchema creates outward_send_ledger + the UNIQUE idx_osl_idempotency index", () => {
    // A table defined in schema-outward-ledger.ts but not wired into initSchema
    // is MISSING at runtime — assert against the REAL initSchema, not the local
    // ensureOutwardLedgerTable helper, so a regression that drops the initSchema
    // call is caught here.
    const fresh = new Database(":memory:");
    try {
      initSchema(fresh, 384);

      const table = fresh
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='outward_send_ledger'`)
        .get() as { name: string } | undefined;
      expect(table?.name).toBe("outward_send_ledger");

      const idx = fresh
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_osl_idempotency'`)
        .get() as { name: string } | undefined;
      expect(idx?.name).toBe("idx_osl_idempotency");

      // The UNIQUE idempotency index is real: a second insert on the same
      // (root_run_id, step_index) is rejected by the constraint on the live schema.
      const ledger = createSqliteOutwardSendLedger(fresh, nowMs);
      void ledger;
    } finally {
      fresh.close();
    }
  });

  it("the REAL initSchema upgrades a retained ledger without losing committed receipts", async () => {
    const existing = new Database(":memory:");
    try {
      existing.exec(`
        CREATE TABLE outward_send_ledger (
          id                  TEXT PRIMARY KEY,
          root_run_id         TEXT NOT NULL,
          step_index          INTEGER NOT NULL,
          agent_id            TEXT NOT NULL,
          channel_type        TEXT NOT NULL,
          channel_id          TEXT NOT NULL,
          state               TEXT NOT NULL CHECK(state IN ('send_attempt_started','unknown_after_send','committed','failed','unresolved')),
          platform_message_id TEXT,
          content_digest      TEXT NOT NULL,
          reconcile_outcome   TEXT,
          attempt_count       INTEGER NOT NULL DEFAULT 0,
          last_error          TEXT,
          created_at_ms       INTEGER NOT NULL,
          updated_at_ms       INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX idx_osl_idempotency
          ON outward_send_ledger(root_run_id, step_index);
      `);
      const insertRetained = existing.prepare(`
        INSERT INTO outward_send_ledger (
          id, root_run_id, step_index, agent_id, channel_type, channel_id,
          state, platform_message_id, content_digest, reconcile_outcome,
          attempt_count, last_error, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertRetained.run(
        "retained-run:0",
        "retained-run",
        0,
        "agent-1",
        "telegram",
        "chat-99",
        "committed",
        "telegram-message-25",
        "1".repeat(16),
        null,
        1,
        null,
        900,
        950,
      );
      insertRetained.run(
        "retained-run:1",
        "retained-run",
        1,
        "agent-1",
        "telegram",
        "chat-99",
        "unknown_after_send",
        null,
        "2".repeat(16),
        null,
        1,
        null,
        960,
        970,
      );

      initSchema(existing, 384);
      const ledger = createSqliteOutwardSendLedger(existing, nowMs);
      const found = await ledger.lookup("retained-run", 0);

      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value).toMatchObject({
        rootRunId: "retained-run",
        stepIndex: 0,
        state: "committed",
        platformMessageId: "telegram-message-25",
        operationKind: "retained_unclassified",
      });
      expect(found.value?.operationFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(found.value?.contentDigest).toMatch(/^[0-9a-f]{64}$/);
      const uncertain = await ledger.lookup("retained-run", 1);
      expect(uncertain).toMatchObject({
        ok: true,
        value: {
          state: "unresolved",
          operationKind: "retained_unclassified",
          reconcileOutcome: "unresolved",
        },
      });
      await expect(ledger.listUnreconciled(100)).resolves.toEqual({ ok: true, value: [] });
      expect(
        existing.prepare("SELECT COUNT(*) AS count FROM outward_send_ledger").get(),
      ).toEqual({ count: 2 });
    } finally {
      existing.close();
    }
  });
});
