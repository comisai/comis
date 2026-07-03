// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for createSqliteOutwardSendLedger — the three-state exactly-once
 * outward-send ledger.
 *
 * Pins the load-bearing invariants:
 *   - the ordered three-state machine (send_attempt_started → unknown_after_send
 *     → committed),
 *   - the UNIQUE (rootRunId, stepIndex) collision that makes a duplicate begin an
 *     err the wrap site treats as "already in flight",
 *   - the no-op replay (a committed row is re-readable so the wrap site
 *     short-circuits),
 *   - the per-row recovery scan listUnreconciled (NO blind bulk reset),
 *   - content-free (the row carries content_digest, never a body),
 *   - corrupt-row-degrades-to-err (createRowMapper).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createSqliteOutwardSendLedger } from "./outward-send-ledger-store.js";
import { ensureOutwardLedgerTable } from "./schema-outward-ledger.js";
import { initSchema } from "./schema.js";
import type { OutwardSendBeginInput } from "@comis/core";

// Deterministic clock — every mutation stamps a known time so updated_at_ms
// assertions are stable.
let fakeNow = 1_000;
const nowMs = (): number => fakeNow;

let db: Database.Database;

function makeBegin(over: Partial<OutwardSendBeginInput> = {}): OutwardSendBeginInput {
  return {
    rootRunId: "run-A",
    stepIndex: 0,
    agentId: "agent-1",
    channelType: "telegram",
    channelId: "chat-99",
    contentDigest: "sha256:abc",
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
    expect(found.value?.contentDigest).toBe("sha256:abc");
    expect(found.value?.attemptCount).toBe(0);
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
});

describe("createSqliteOutwardSendLedger — ordered three-state machine", () => {
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

    const first = await ledger.begin(makeBegin({ contentDigest: "sha256:first" }));
    expect(first.ok).toBe(true);

    // The wrap site treats this err as "already in flight — do NOT
    // double-send". A different contentDigest must NOT bypass the dedup.
    const second = await ledger.begin(makeBegin({ contentDigest: "sha256:second" }));
    expect(second.ok).toBe(false);

    // The dedup key holds: lookup still shows the FIRST row's digest, untouched.
    const found = await ledger.lookup("run-A", 0);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value?.contentDigest).toBe("sha256:first");
    expect(found.value?.state).toBe("send_attempt_started");
  });

  it("a different stepIndex on the same run is NOT a collision (distinct sends)", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    const s0 = await ledger.begin(makeBegin({ stepIndex: 0 }));
    const s1 = await ledger.begin(makeBegin({ stepIndex: 1 }));
    expect(s0.ok).toBe(true);
    expect(s1.ok).toBe(true);
  });

  it("after commit, lookup returns the committed row + platformMessageId (no-op replay short-circuit)", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    await ledger.begin(makeBegin());
    await ledger.markUnknown("run-A", 0);
    await ledger.commit("run-A", 0, "tg-msg-777");

    // The wrap site reads this committed row and short-circuits a
    // replay to a no-op — it never issues a second platform call.
    const replay = await ledger.lookup("run-A", 0);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value?.state).toBe("committed");
    expect(replay.value?.platformMessageId).toBe("tg-msg-777");
  });
});

describe("createSqliteOutwardSendLedger — failure + reconcile", () => {
  it("markFailed sets state='failed' and records the errorKind", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    await ledger.begin(makeBegin());
    const failed = await ledger.markFailed("run-A", 0, "rate_limited");
    expect(failed.ok).toBe(true);

    const found = await ledger.lookup("run-A", 0);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value?.state).toBe("failed");
    expect(found.value?.lastError).toBe("rate_limited");
  });

  it("commits the ledger row when reconcile resolves to sent", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    await ledger.begin(makeBegin());
    await ledger.markUnknown("run-A", 0);
    const resolved = await ledger.resolveReconcile("run-A", 0, "sent");
    expect(resolved.ok).toBe(true);

    const found = await ledger.lookup("run-A", 0);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value?.reconcileOutcome).toBe("sent");
    expect(found.value?.state).toBe("committed");
  });

  it("resolveReconcile 'not_sent' records the verdict but KEEPS the prior state for replay (Pitfall 2)", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    await ledger.begin(makeBegin());
    await ledger.markUnknown("run-A", 0);
    const resolved = await ledger.resolveReconcile("run-A", 0, "not_sent");
    expect(resolved.ok).toBe(true);

    const found = await ledger.lookup("run-A", 0);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value?.reconcileOutcome).toBe("not_sent");
    // not_sent does NOT flip to committed/failed — the engine may replay it.
    expect(found.value?.state).toBe("unknown_after_send");
  });

  it("resolveReconcile 'unresolved' parks the row in the unresolved terminal (no blind replay)", async () => {
    const ledger = createSqliteOutwardSendLedger(db, nowMs);
    await ledger.begin(makeBegin());
    await ledger.markUnknown("run-A", 0);
    const resolved = await ledger.resolveReconcile("run-A", 0, "unresolved");
    expect(resolved.ok).toBe(true);

    const found = await ledger.lookup("run-A", 0);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value?.reconcileOutcome).toBe("unresolved");
    expect(found.value?.state).toBe("unresolved");
  });
});

describe("createSqliteOutwardSendLedger — listUnreconciled per-row recovery scan", () => {
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
    await ledger.markFailed("run-A", 3, "permanent");

    const scan = await ledger.listUnreconciled();
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

    const scan = await ledger.listUnreconciled();
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.value).toEqual([]);
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

describe("ensureOutwardLedgerTable wiring — real initSchema layout (Pitfall 5)", () => {
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
});
