// SPDX-License-Identifier: Apache-2.0
/**
 * createSqliteOutwardSendLedger — SQLite persistence for the Phase-216 three-state
 * exactly-once outward-send ledger (ONCE-01..ONCE-04), implementing the
 * `@comis/core` {@link OutwardSendLedgerPort}.
 *
 * Factory-function pattern (modeled wholesale on `createSqliteDurableRunStore` /
 * `createVideoJobStore`): prepares fixed SQL statements once in the closure,
 * returns a frozen `OutwardSendLedgerPort`. Reads go through
 * `createRowMapper(OutwardLedgerDbRowSchema)` so a corrupt row degrades to a
 * `Result.err`, never a throw (T-216-12) — one bad row cannot abort the whole boot
 * recovery scan.
 *
 * WHY THREE STATES (the §9 invariant #12 this store pins): a send-intent is
 * persisted as `send_attempt_started` BEFORE the irreversible platform call, then
 * flipped to `unknown_after_send` immediately BEFORE control returns from that
 * call, and only `committed` once the local ack persists. So on a crash mid-send,
 * the recovery scan finds a durable row whose state DISTINGUISHES "definitely
 * sent" from "crashed, must ask the platform" — and reconciles it PER-ROW
 * (`listUnreconciled` → the engine's `reconcileSend?`, Plan 04). This store has NO
 * blind `in_flight → pending` bulk reset (the `delivery-queue-adapter.ts:141-145`
 * anti-pattern §9 forbids, T-216-09) — that blanket UPDATE is the double-send a
 * restart must never do.
 *
 * THE IDEMPOTENCY KEY (ONCE-02, T-216-10): the UNIQUE `(root_run_id, step_index)`
 * index (`ensureOutwardLedgerTable`) is the dedup. `begin` is the SOLE INSERT, so
 * a REPLAYED step collides — a `better-sqlite3` UNIQUE-constraint SqliteError the
 * boundary-catch turns into `err`, which the wrap site (Plan 05) reads as "already
 * in flight → do NOT issue a second platform call". `id` is the deterministic
 * `${rootRunId}:${stepIndex}` so the PK and the UNIQUE pair agree.
 *
 * SECURITY (T-216-11): the persisted columns carry the `content_digest` (sha256)
 * ONLY — there is no body/text column on the table or the record, and no secret /
 * token / bearer column. The reconcile matches on the digest, never the body.
 *
 * @module
 */

import type Database from "better-sqlite3";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import {
  systemNowMs,
  type OutwardSendLedgerPort,
  type OutwardSendRecord,
  type OutwardSendBeginInput,
  type OutwardSendState,
  type ReconcileOutcome,
} from "@comis/core";
import { createRowMapper } from "./row-mapper.js";
import { OutwardLedgerDbRowSchema, type OutwardLedgerDbRow } from "./outward-ledger-row-schema.js";

// ---------------------------------------------------------------------------
// Row mapper (snake_case -> camelCase)
// ---------------------------------------------------------------------------

const outwardLedgerMapper = createRowMapper(OutwardLedgerDbRowSchema);

/**
 * Map a validated DB row to the domain `OutwardSendRecord`. Nullable columns map
 * `?? undefined` at the domain boundary so an absent value is "field absent" on
 * the optional record fields (SQLite NULL ≠ undefined). The `state` /
 * `reconcile_outcome` TEXT columns carry the closed unions (the SQL CHECK + the
 * Zod row schema + the Plan-01 type all agree) — cast to the domain union.
 */
function rowToRecord(row: OutwardLedgerDbRow): OutwardSendRecord {
  return {
    id: row.id,
    rootRunId: row.root_run_id,
    stepIndex: row.step_index,
    agentId: row.agent_id,
    channelType: row.channel_type,
    channelId: row.channel_id,
    state: row.state as OutwardSendState,
    ...(row.platform_message_id !== null ? { platformMessageId: row.platform_message_id } : {}),
    contentDigest: row.content_digest,
    ...(row.reconcile_outcome !== null
      ? { reconcileOutcome: row.reconcile_outcome as ReconcileOutcome }
      : {}),
    attemptCount: row.attempt_count,
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SQLite-backed `OutwardSendLedgerPort`.
 *
 * Assumes `initSchema()` (which calls `ensureOutwardLedgerTable`) has already been
 * called — the `outward_send_ledger` table + its UNIQUE idempotency index exist.
 * Prepares fixed SQL once.
 *
 * @param db - An open better-sqlite3 Database instance
 * @param nowMs - Optional injectable wall-clock (deterministic tests); defaults to systemNowMs
 * @returns OutwardSendLedgerPort implementation (frozen)
 */
export function createSqliteOutwardSendLedger(
  db: Database.Database,
  nowMs: () => number = systemNowMs,
): OutwardSendLedgerPort {
  // --- Prepared statements ---

  // ONCE-01 — begin is the SOLE INSERT, so the UNIQUE (root_run_id, step_index)
  // index makes a duplicate begin throw a SqliteError (caught below → err). id is
  // the deterministic ${rootRunId}:${stepIndex} so the PK and the UNIQUE pair agree.
  const beginStmt = db.prepare(`
    INSERT INTO outward_send_ledger (
      id, root_run_id, step_index, agent_id, channel_type, channel_id,
      state, content_digest, attempt_count, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, 'send_attempt_started', ?, 0, ?, ?)
  `);

  const lookupStmt = db.prepare(
    `SELECT * FROM outward_send_ledger WHERE root_run_id = ? AND step_index = ?`,
  );

  const markUnknownStmt = db.prepare(`
    UPDATE outward_send_ledger SET state = 'unknown_after_send', updated_at_ms = ?
    WHERE root_run_id = ? AND step_index = ?
  `);

  const commitStmt = db.prepare(`
    UPDATE outward_send_ledger
    SET state = 'committed', platform_message_id = ?, updated_at_ms = ?
    WHERE root_run_id = ? AND step_index = ?
  `);

  const markFailedStmt = db.prepare(`
    UPDATE outward_send_ledger SET state = 'failed', last_error = ?, updated_at_ms = ?
    WHERE root_run_id = ? AND step_index = ?
  `);

  // ONCE-03 — record the reconcile verdict. 'sent' commits the row; 'unresolved'
  // parks it in the unresolved terminal (escalate, never blind-replay); 'not_sent'
  // records the verdict but KEEPS the prior state so the engine can replay (Pitfall
  // 2 — a default-to-sent would be a double-send dressed as a reconcile). The CASE
  // computes the next state from the outcome in a single UPDATE.
  const resolveReconcileStmt = db.prepare(`
    UPDATE outward_send_ledger
    SET reconcile_outcome = ?,
        state = CASE
          WHEN ? = 'sent' THEN 'committed'
          WHEN ? = 'unresolved' THEN 'unresolved'
          ELSE state
        END,
        updated_at_ms = ?
    WHERE root_run_id = ? AND step_index = ?
  `);

  // ONCE-03 — the per-row recovery scan. ONLY the still-in-flight rows; the partial
  // idx_osl_unknown index serves it. This is NOT a blind bulk reset — it RETURNS
  // the rows so the engine reconciles each against its channel (T-216-09).
  const listUnreconciledStmt = db.prepare(`
    SELECT * FROM outward_send_ledger
    WHERE state IN ('unknown_after_send','send_attempt_started')
    ORDER BY created_at_ms ASC
  `);

  // --- Store implementation ---

  const store: OutwardSendLedgerPort = {
    begin(input: OutwardSendBeginInput): Promise<Result<void, Error>> {
      try {
        const t = nowMs();
        // The UNIQUE (root_run_id, step_index) index throws here on a replayed
        // step — the boundary-catch turns it into err, which the wrap site (Plan
        // 05) treats as "already in flight, do NOT double-send" (ONCE-02).
        beginStmt.run(
          `${input.rootRunId}:${input.stepIndex}`,
          input.rootRunId,
          input.stepIndex,
          input.agentId,
          input.channelType,
          input.channelId,
          input.contentDigest,
          t, // created_at_ms
          t, // updated_at_ms
        );
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    lookup(
      rootRunId: string,
      stepIndex: number,
    ): Promise<Result<OutwardSendRecord | undefined, Error>> {
      try {
        const parsed = outwardLedgerMapper.parseOptionalRow(lookupStmt.get(rootRunId, stepIndex));
        if (!parsed.ok) {
          return Promise.resolve(err(new Error(`Row validation failed: ${parsed.error.message}`)));
        }
        if (parsed.value === undefined) return Promise.resolve(ok(undefined));
        return Promise.resolve(ok(rowToRecord(parsed.value)));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    markUnknown(rootRunId: string, stepIndex: number): Promise<Result<void, Error>> {
      try {
        markUnknownStmt.run(nowMs(), rootRunId, stepIndex);
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    commit(
      rootRunId: string,
      stepIndex: number,
      platformMessageId: string,
    ): Promise<Result<void, Error>> {
      try {
        commitStmt.run(platformMessageId, nowMs(), rootRunId, stepIndex);
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    markFailed(
      rootRunId: string,
      stepIndex: number,
      errorKind: string,
    ): Promise<Result<void, Error>> {
      try {
        markFailedStmt.run(errorKind, nowMs(), rootRunId, stepIndex);
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    resolveReconcile(
      rootRunId: string,
      stepIndex: number,
      outcome: ReconcileOutcome,
    ): Promise<Result<void, Error>> {
      try {
        // outcome is bound 3x (the CASE reads it twice + the column once) — the
        // closed ReconcileOutcome union is the only value that flows here.
        resolveReconcileStmt.run(outcome, outcome, outcome, nowMs(), rootRunId, stepIndex);
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    listUnreconciled(): Promise<Result<OutwardSendRecord[], Error>> {
      try {
        const parsed = outwardLedgerMapper.parseRows(listUnreconciledStmt.all());
        if (!parsed.ok) {
          return Promise.resolve(err(new Error(`Row validation failed: ${parsed.error.message}`)));
        }
        return Promise.resolve(ok(parsed.value.map(rowToRecord)));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },
  };

  return Object.freeze(store);
}
