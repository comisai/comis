// SPDX-License-Identifier: Apache-2.0
// @allow-throw: better-sqlite3 transaction callbacks must throw on validated-row failures so the sequence allocation rolls back atomically; the surrounding adapter boundary converts every throw to Result.err.
/**
 * createSqliteOutwardSendLedger — SQLite persistence for the outward-send
 * uncertainty ledger, implementing the
 * `@comis/core` {@link OutwardSendLedgerPort}.
 *
 * Factory-function pattern (modeled wholesale on `createSqliteDurableRunStore` /
 * `createVideoJobStore`): prepares fixed SQL statements once in the closure,
 * returns a frozen `OutwardSendLedgerPort`. Reads go through
 * `createRowMapper(OutwardLedgerDbRowSchema)` so a corrupt row degrades to a
 * `Result.err`, never a throw — one bad row cannot abort the whole boot
 * recovery scan.
 *
 * WHY THE IN-FLIGHT STATES EXIST: a send-intent is persisted as
 * `send_attempt_started` before the irreversible platform call, then moved to
 * `unknown_after_send` immediately before that call starts, and only
 * `committed` once the platform receipt persists. On a crash mid-send, the
 * recovery scan finds a durable row whose outcome may be ambiguous and
 * atomically parks it for operator review. This store has no
 * blind `in_flight → pending` bulk reset (the `delivery-queue-adapter.ts:141-145`
 * bulk-reset anti-pattern) — that blanket UPDATE is the double-send a
 * restart must never do.
 *
 * THE IDEMPOTENCY KEY: the UNIQUE `(root_run_id, step_index)`
 * index (`ensureOutwardLedgerTable`) is the dedup. `begin` is the SOLE INSERT, so
 * a repeated step collides — a `better-sqlite3` UNIQUE-constraint SqliteError the
 * boundary-catch turns into `err`, which the wrap site reads as "already
 * in flight → do NOT issue a second platform call". `id` is the deterministic
 * `${rootRunId}:${stepIndex}` so the PK and the UNIQUE pair agree.
 *
 * SECURITY: the persisted columns carry the `content_digest` (sha256)
 * ONLY — there is no body/text column on the table or the record, and no secret /
 * token / bearer column. Digests bind immutable operation identity without
 * retaining the body.
 *
 * @module
 */

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import {
  systemNowMs,
  type OutwardSendLedgerPort,
  type OutwardSendRecord,
  type OutwardSendBeginInput,
  type OutwardSendState,
  type OutwardTerminalDecision,
  type StoredOutwardOperationKind,
} from "@comis/core";
import { createRowMapper } from "./row-mapper.js";
import { OutwardLedgerDbRowSchema, type OutwardLedgerDbRow } from "./outward-ledger-row-schema.js";

// ---------------------------------------------------------------------------
// Row mapper (snake_case -> camelCase)
// ---------------------------------------------------------------------------

const outwardLedgerMapper = createRowMapper(OutwardLedgerDbRowSchema);
const outwardSequenceMapper = createRowMapper(
  z.strictObject({ last_step_index: z.number().int().min(0) }),
);
const outwardOperationMapper = createRowMapper(
  z.strictObject({ step_index: z.number().int().min(0) }),
);
const outwardTerminalDecisionMapper = createRowMapper(
  z.strictObject({ outcome: z.enum(["delivered", "discarded", "no_reply"]) }),
);
const outwardOperationLedgerStateMapper = createRowMapper(
  z.strictObject({ state: z.enum([
    "send_attempt_started",
    "unknown_after_send",
    "committed",
    "failed",
    "unresolved",
  ]) }),
);
const outwardUncertaintyCountMapper = createRowMapper(
  z.strictObject({ count: z.number().int().min(0) }),
);

/** Hash the canonical string encoding so caller-controlled operation text is never persisted. */
function digestOperationId(operationId: string): string {
  return createHash("sha256")
    .update(JSON.stringify(operationId), "utf8")
    .digest("hex");
}

/**
 * Map a validated DB row to the domain `OutwardSendRecord`. Nullable columns map
 * `?? undefined` at the domain boundary so an absent value is "field absent" on
 * the optional record fields (SQLite NULL ≠ undefined). The `state` /
 * `reconcile_outcome` TEXT columns carry the closed unions (the SQL CHECK, Zod
 * row schema, and domain type all agree) — cast to the domain union.
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
    operationKind: row.operation_kind as StoredOutwardOperationKind,
    operationFingerprint: row.operation_fingerprint,
    ...(row.platform_message_id !== null ? { platformMessageId: row.platform_message_id } : {}),
    contentDigest: row.content_digest,
    ...(row.reconcile_outcome !== null
      ? { reconcileOutcome: row.reconcile_outcome }
      : {}),
    attemptCount: row.attempt_count,
    attemptedAtMs: row.created_at_ms,
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

  // begin is the SOLE INSERT, so the UNIQUE (root_run_id, step_index)
  // index makes a duplicate begin throw a SqliteError (caught below → err). id is
  // the deterministic ${rootRunId}:${stepIndex} so the PK and the UNIQUE pair agree.
  const beginStmt = db.prepare(`
    INSERT INTO outward_send_ledger (
      id, root_run_id, step_index, agent_id, channel_type, channel_id,
      operation_kind, operation_fingerprint, state, content_digest,
      attempt_count, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'send_attempt_started', ?, 0, ?, ?)
  `);

  const allocateStepStmt = db.prepare(`
    INSERT INTO outward_send_sequences (root_run_id, last_step_index, updated_at_ms)
    VALUES (
      ?,
      MAX(
        COALESCE((SELECT MAX(step_index) FROM outward_send_ledger WHERE root_run_id = ?), -1),
        COALESCE((SELECT MAX(step_index) FROM outward_send_operations WHERE root_run_id = ?), -1)
      ) + 1,
      ?
    )
    ON CONFLICT(root_run_id) DO UPDATE SET
      last_step_index = MAX(
        outward_send_sequences.last_step_index,
        MAX(
          COALESCE(
            (SELECT MAX(step_index) FROM outward_send_ledger WHERE root_run_id = excluded.root_run_id),
            -1
          ),
          COALESCE(
            (SELECT MAX(step_index) FROM outward_send_operations WHERE root_run_id = excluded.root_run_id),
            -1
          )
        )
      ) + 1,
      updated_at_ms = excluded.updated_at_ms
    RETURNING last_step_index
  `);

  const lookupOperationStmt = db.prepare(`
    SELECT step_index FROM outward_send_operations
    WHERE root_run_id = ? AND operation_id = ?
  `);

  const insertOperationStmt = db.prepare(`
    INSERT INTO outward_send_operations (
      root_run_id, operation_id, step_index, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?)
  `);

  const lookupOperatorDecisionStmt = db.prepare(`
    SELECT outcome FROM outward_send_operator_decisions
    WHERE root_run_id = ? AND operation_id = ?
  `);

  const lookupNoReplyDecisionStmt = db.prepare(`
    SELECT 'no_reply' AS outcome FROM outward_send_no_reply_decisions
    WHERE root_run_id = ? AND operation_id = ?
  `);

  const insertOperatorDecisionStmt = db.prepare(`
    INSERT INTO outward_send_operator_decisions (
      root_run_id, operation_id, outcome, decided_at_ms
    ) VALUES (?, ?, ?, ?)
  `);

  const insertNoReplyDecisionStmt = db.prepare(`
    INSERT INTO outward_send_no_reply_decisions (
      root_run_id, operation_id, decided_at_ms
    ) VALUES (?, ?, ?)
  `);

  const lookupOperationLedgerStateStmt = db.prepare(`
    SELECT ledger.state
    FROM outward_send_operations AS operation
    JOIN outward_send_ledger AS ledger
      ON ledger.root_run_id = operation.root_run_id
      AND ledger.step_index = operation.step_index
    WHERE operation.root_run_id = ? AND operation.operation_id = ?
  `);

  const lookupOperatorDecisionByStepStmt = db.prepare(`
    SELECT decision.outcome
    FROM outward_send_operations AS operation
    JOIN outward_send_operator_decisions AS decision
      ON decision.root_run_id = operation.root_run_id
      AND decision.operation_id = operation.operation_id
    WHERE operation.root_run_id = ? AND operation.step_index = ?
  `);

  const lookupNoReplyDecisionByStepStmt = db.prepare(`
    SELECT 'no_reply' AS outcome
    FROM outward_send_operations AS operation
    JOIN outward_send_no_reply_decisions AS decision
      ON decision.root_run_id = operation.root_run_id
      AND decision.operation_id = operation.operation_id
    WHERE operation.root_run_id = ? AND operation.step_index = ?
  `);

  const lookupStmt = db.prepare(
    `SELECT * FROM outward_send_ledger WHERE root_run_id = ? AND step_index = ?`,
  );

  const markUnknownStmt = db.prepare(`
    UPDATE outward_send_ledger
    SET state = 'unknown_after_send', attempt_count = attempt_count + 1, updated_at_ms = ?
    WHERE root_run_id = ? AND step_index = ? AND state = 'send_attempt_started'
  `);

  const reclaimPreSendStmt = db.prepare(`
    DELETE FROM outward_send_ledger
    WHERE root_run_id = ? AND step_index = ? AND state = 'send_attempt_started'
  `);

  const commitStmt = db.prepare(`
    UPDATE outward_send_ledger
    SET state = 'committed', platform_message_id = ?, updated_at_ms = ?
    WHERE root_run_id = ? AND step_index = ? AND state = 'unknown_after_send'
  `);

  const markFailedStmt = db.prepare(`
    UPDATE outward_send_ledger SET state = 'failed', last_error = ?, updated_at_ms = ?
    WHERE root_run_id = ? AND step_index = ? AND state = 'unknown_after_send'
  `);

  const parkUncertainStmt = db.prepare(`
    UPDATE outward_send_ledger
    SET state = 'unresolved', reconcile_outcome = 'unresolved', updated_at_ms = ?
    WHERE root_run_id = ? AND step_index = ?
      AND state IN ('send_attempt_started','unknown_after_send')
  `);

  const hasUncertaintyStmt = db.prepare(`
    SELECT COUNT(*) AS count
    FROM outward_send_ledger AS ledger
    LEFT JOIN outward_send_operations AS operation
      ON operation.root_run_id = ledger.root_run_id
      AND operation.step_index = ledger.step_index
    WHERE ledger.root_run_id = ?
      AND ledger.state IN ('send_attempt_started','unknown_after_send','unresolved')
      AND (
        operation.operation_id IS NULL
        OR (
          NOT EXISTS (
            SELECT 1 FROM outward_send_operator_decisions AS operator_decision
            WHERE operator_decision.root_run_id = operation.root_run_id
              AND operator_decision.operation_id = operation.operation_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM outward_send_no_reply_decisions AS no_reply_decision
            WHERE no_reply_decision.root_run_id = operation.root_run_id
              AND no_reply_decision.operation_id = operation.operation_id
          )
        )
      )
  `);

  // The per-row recovery scan. ONLY the still-in-flight rows; the partial
  // idx_osl_unknown index serves it. This is NOT a blind bulk reset — it RETURNS
  // the rows so the engine atomically parks each one.
  const listUnreconciledStmt = db.prepare(`
    SELECT * FROM outward_send_ledger
    WHERE state IN ('unknown_after_send','send_attempt_started')
    ORDER BY created_at_ms ASC, root_run_id ASC, step_index ASC
    LIMIT ?
  `);

  function parseTerminalDecision(
    operatorRow: unknown,
    noReplyRow: unknown,
  ): Result<OutwardTerminalDecision | undefined, Error> {
    const operatorDecision = outwardTerminalDecisionMapper.parseOptionalRow(operatorRow);
    if (!operatorDecision.ok) {
      return err(new Error(`Row validation failed: ${operatorDecision.error.message}`));
    }
    const noReplyDecision = outwardTerminalDecisionMapper.parseOptionalRow(noReplyRow);
    if (!noReplyDecision.ok) {
      return err(new Error(`Row validation failed: ${noReplyDecision.error.message}`));
    }
    if (operatorDecision.value !== undefined && noReplyDecision.value !== undefined) {
      return err(new Error("outward terminal decision has conflicting durable outcomes"));
    }
    return ok(operatorDecision.value?.outcome ?? noReplyDecision.value?.outcome);
  }

  const beginOperation = db.transaction((input: OutwardSendBeginInput, timestamp: number) => {
    const retainedDecision = parseTerminalDecision(
      lookupOperatorDecisionByStepStmt.get(input.rootRunId, input.stepIndex),
      lookupNoReplyDecisionByStepStmt.get(input.rootRunId, input.stepIndex),
    );
    if (!retainedDecision.ok) throw retainedDecision.error;
    if (retainedDecision.value !== undefined) {
      throw new Error("outward operation has a terminal decision");
    }
    beginStmt.run(
      `${input.rootRunId}:${input.stepIndex}`,
      input.rootRunId,
      input.stepIndex,
      input.agentId,
      input.channelType,
      input.channelId,
      input.operationKind,
      input.operationFingerprint,
      input.contentDigest,
      timestamp,
      timestamp,
    );
  });

  // --- Store implementation ---

  const store: OutwardSendLedgerPort = {
    lookupTerminalDecision(
      rootRunId: string,
      operationId: string,
    ): Promise<Result<OutwardTerminalDecision | undefined, Error>> {
      try {
        if (rootRunId.length === 0 || operationId.length === 0 || operationId.length > 256) {
          return Promise.resolve(err(new Error("outward terminal decision identity is invalid")));
        }
        const operationDigest = digestOperationId(operationId);
        const parsed = parseTerminalDecision(
          lookupOperatorDecisionStmt.get(rootRunId, operationDigest),
          lookupNoReplyDecisionStmt.get(rootRunId, operationDigest),
        );
        return Promise.resolve(parsed);
      } catch (cause) {
        return Promise.resolve(err(cause instanceof Error ? cause : new Error(String(cause))));
      }
    },

    recordTerminalDecision(
      rootRunId: string,
      operationId: string,
      outcome: OutwardTerminalDecision,
    ): Promise<Result<void, Error>> {
      try {
        if (
          rootRunId.length === 0
          || operationId.length === 0
          || operationId.length > 256
          || (outcome !== "delivered" && outcome !== "discarded" && outcome !== "no_reply")
        ) {
          return Promise.resolve(err(new Error("outward terminal decision is invalid")));
        }
        const operationDigest = digestOperationId(operationId);
        const recordDecision = db.transaction(() => {
          const existing = parseTerminalDecision(
            lookupOperatorDecisionStmt.get(rootRunId, operationDigest),
            lookupNoReplyDecisionStmt.get(rootRunId, operationDigest),
          );
          if (!existing.ok) throw existing.error;
          if (existing.value !== undefined) {
            if (existing.value !== outcome) {
              throw new Error("outward terminal decision conflicts with its durable outcome");
            }
            return;
          }
          const ledgerState = outwardOperationLedgerStateMapper.parseOptionalRow(
            lookupOperationLedgerStateStmt.get(rootRunId, operationDigest),
          );
          if (!ledgerState.ok) {
            throw new Error(`Row validation failed: ${ledgerState.error.message}`);
          }
          if (
            ledgerState.value !== undefined
            && (
              ledgerState.value.state === "send_attempt_started"
              || ledgerState.value.state === "unknown_after_send"
            )
          ) {
            throw new Error("outward operation is still in flight");
          }
          if (ledgerState.value?.state === "committed" && outcome !== "delivered") {
            throw new Error("outward terminal decision conflicts with committed delivery receipt");
          }
          if (outcome === "no_reply") {
            insertNoReplyDecisionStmt.run(rootRunId, operationDigest, nowMs());
          } else {
            insertOperatorDecisionStmt.run(rootRunId, operationDigest, outcome, nowMs());
          }
        });
        recordDecision.immediate();
        return Promise.resolve(ok(undefined));
      } catch (cause) {
        return Promise.resolve(err(cause instanceof Error ? cause : new Error(String(cause))));
      }
    },

    allocateStep(rootRunId: string, operationId: string): Promise<Result<number, Error>> {
      try {
        if (rootRunId.length === 0 || operationId.length === 0 || operationId.length > 256) {
          return Promise.resolve(err(new Error("outward operation identity is invalid")));
        }
        const operationDigest = digestOperationId(operationId);
        const resolveOperation = db.transaction((root: string, operation: string, t: number) => {
          const existing = outwardOperationMapper.parseOptionalRow(
            lookupOperationStmt.get(root, operation),
          );
          if (!existing.ok) throw new Error(`Row validation failed: ${existing.error.message}`);
          if (existing.value !== undefined) return existing.value.step_index;

          const allocated = outwardSequenceMapper.parseOptionalRow(
            allocateStepStmt.get(root, root, root, t),
          );
          if (!allocated.ok) throw new Error(`Row validation failed: ${allocated.error.message}`);
          if (allocated.value === undefined) {
            throw new Error("outward sequence allocation returned no row");
          }
          insertOperationStmt.run(root, operation, allocated.value.last_step_index, t, t);
          return allocated.value.last_step_index;
        });
        return Promise.resolve(ok(resolveOperation.immediate(rootRunId, operationDigest, nowMs())));
      } catch (cause) {
        return Promise.resolve(err(cause instanceof Error ? cause : new Error(String(cause))));
      }
    },

    begin(input: OutwardSendBeginInput): Promise<Result<void, Error>> {
      try {
        if (!/^[0-9a-f]{64}$/.test(input.contentDigest)) {
          return Promise.resolve(err(new Error("contentDigest must be a full SHA-256 hex digest")));
        }
        if (!/^[0-9a-f]{64}$/.test(input.operationFingerprint)) {
          return Promise.resolve(
            err(new Error("operationFingerprint must be a full SHA-256 hex digest")),
          );
        }
        const t = nowMs();
        // The UNIQUE (root_run_id, step_index) index throws here on a repeated
        // step — the boundary-catch turns it into err, which the wrap site
        // treats as "already in flight, do NOT double-send".
        beginOperation.immediate(input, t);
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
        const changed = markUnknownStmt.run(nowMs(), rootRunId, stepIndex);
        if (changed.changes !== 1) {
          return Promise.resolve(err(new Error("outward ledger markUnknown transition rejected")));
        }
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    reclaimPreSend(rootRunId: string, stepIndex: number): Promise<Result<boolean, Error>> {
      try {
        const changed = reclaimPreSendStmt.run(rootRunId, stepIndex);
        return Promise.resolve(ok(changed.changes === 1));
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
        if (platformMessageId.length === 0) {
          return Promise.resolve(err(new Error("platformMessageId must be non-empty")));
        }
        const changed = commitStmt.run(platformMessageId, nowMs(), rootRunId, stepIndex);
        if (changed.changes !== 1) {
          return Promise.resolve(err(new Error("outward ledger commit transition rejected")));
        }
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
        const changed = markFailedStmt.run(errorKind, nowMs(), rootRunId, stepIndex);
        if (changed.changes !== 1) {
          return Promise.resolve(err(new Error("outward ledger markFailed transition rejected")));
        }
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    parkUncertain(rootRunId: string, stepIndex: number): Promise<Result<boolean, Error>> {
      try {
        const changed = parkUncertainStmt.run(nowMs(), rootRunId, stepIndex);
        return Promise.resolve(ok(changed.changes === 1));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    hasUncertainty(rootRunId: string): Promise<Result<boolean, Error>> {
      try {
        const parsed = outwardUncertaintyCountMapper.parseOptionalRow(
          hasUncertaintyStmt.get(rootRunId),
        );
        if (!parsed.ok) {
          return Promise.resolve(err(new Error(`Row validation failed: ${parsed.error.message}`)));
        }
        if (parsed.value === undefined) {
          return Promise.resolve(err(new Error("outward uncertainty count returned no row")));
        }
        return Promise.resolve(ok(parsed.value.count > 0));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    listUnreconciled(limit: number): Promise<Result<OutwardSendRecord[], Error>> {
      try {
        if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_001) {
          return Promise.resolve(err(new Error("outward recovery scan limit is invalid")));
        }
        const parsed = outwardLedgerMapper.parseRows(listUnreconciledStmt.all(limit));
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
