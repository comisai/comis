// SPDX-License-Identifier: Apache-2.0
/**
 * OutwardSendLedgerPort — the three-state outward-send ledger (Phase 216,
 * ONCE-01..ONCE-04). It makes an irreversible outward send (a chat-platform
 * message) exactly-once by keying every attempt on the `(rootRunId, stepIndex)`
 * idempotency pair allocated by `DurableRunPort.allocateOutwardStep` (HIGH-1).
 *
 * The lifecycle is a CLOSED five-state union (AGENTS §2.8): `send_attempt_started`
 * → `unknown_after_send` → (`committed` | `failed`), with `unresolved` for the
 * honest "the reconcile could not tell" terminal. An out-of-band state is
 * unrepresentable, so recovery (Wave 3) can never mis-route a row to "replay"
 * (T-216-02). The store's Zod row schema (Plan 02) enforces the same union at
 * read.
 *
 * SECURITY (T-216-03): the record carries `contentDigest` (a sha256 set by the
 * caller), NEVER the message body — there is deliberately no `body`/`text` field
 * on {@link OutwardSendRecord}, so the ledger is content-free by interface design.
 *
 * @module
 */

import type { Result } from "@comis/shared";

/**
 * The closed outward-send lifecycle. Recovery (Wave 3) branches on this exact
 * five-member set:
 *   - `send_attempt_started` — `begin` written BEFORE the platform call (ONCE-01).
 *   - `unknown_after_send`   — written right BEFORE the platform call returns, so a
 *                              crash mid-send leaves a row the recovery scan finds.
 *   - `committed`            — the platform confirmed; `platformMessageId` is set.
 *   - `failed`              — a permanent failure (ONCE-04); will not be replayed.
 *   - `unresolved`         — the reconcile could not determine sent/not-sent; the
 *                              row is parked + escalated rather than blindly replayed.
 */
// prettier-ignore
export type OutwardSendState = "send_attempt_started" | "unknown_after_send" | "committed" | "failed" | "unresolved";

/**
 * The verdict a reconcile produces for an `unknown_after_send` row (ONCE-03).
 * `unresolved` is a first-class designed outcome (the channel cannot tell), NOT
 * a failure — a silent default-to-`sent` would be a double-send dressed as a
 * reconcile (Pitfall 2).
 */
export type ReconcileOutcome = "sent" | "not_sent" | "unresolved";

/**
 * A single outward-send ledger row. Content-free (T-216-03): `contentDigest`
 * only, never the body. `(rootRunId, stepIndex)` is the UNIQUE idempotency key.
 */
export interface OutwardSendRecord {
  /** The ledger row id. */
  readonly id: string;
  /** The owning run — half of the idempotency key. */
  readonly rootRunId: string;
  /** The outward-send sequence number from `allocateOutwardStep` — the other half. */
  readonly stepIndex: number;
  /** The agent that issued the send. */
  readonly agentId: string;
  /** The channel type (e.g. "telegram"). */
  readonly channelType: string;
  /** The channel/chat/room identifier. */
  readonly channelId: string;
  /** The closed lifecycle state. */
  readonly state: OutwardSendState;
  /** The platform-assigned message id, present once `state === "committed"`. */
  readonly platformMessageId?: string;
  /** sha256 of the message content — NEVER the body itself (T-216-03). */
  readonly contentDigest: string;
  /** The reconcile verdict, present once a reconcile has resolved the row. */
  readonly reconcileOutcome?: ReconcileOutcome;
  /** How many send attempts this row has accrued. */
  readonly attemptCount: number;
  /** The last error description (errorKind / hint), present on a failed attempt. */
  readonly lastError?: string;
}

/** The caller-supplied fields for `begin` — the store assigns id/state/attemptCount. */
export interface OutwardSendBeginInput {
  readonly rootRunId: string;
  readonly stepIndex: number;
  readonly agentId: string;
  readonly channelType: string;
  readonly channelId: string;
  /** sha256 of the content — content-free key, never the body (T-216-03). */
  readonly contentDigest: string;
}

/**
 * The three-state outward-send ledger. Every method is `Result`-returning and
 * never throws. The SQLite adapter (Plan 02) enforces the UNIQUE
 * `(rootRunId, stepIndex)` constraint that makes a duplicate `begin` a no-op the
 * caller treats as "already in flight".
 */
export interface OutwardSendLedgerPort {
  /**
   * ONCE-02 — the dedup read. Returns the existing row for this idempotency key,
   * or `ok(undefined)` when no send has been attempted at this `(rootRunId,
   * stepIndex)` yet. The send path consults this before issuing the platform call.
   */
  lookup(rootRunId: string, stepIndex: number): Promise<Result<OutwardSendRecord | undefined, Error>>;

  /**
   * ONCE-01 — write `state = send_attempt_started` for a new idempotency key. The
   * UNIQUE `(rootRunId, stepIndex)` makes a duplicate `begin` an error the caller
   * treats as "already in flight" (another attempt owns this send), so two
   * concurrent attempts never both proceed to the platform.
   */
  begin(input: OutwardSendBeginInput): Promise<Result<void, Error>>;

  /**
   * Transition to `unknown_after_send` — written BEFORE the platform call returns,
   * so a crash mid-send leaves a durable row the `listUnreconciled` scan finds and
   * a reconcile can resolve (instead of a lost send or a blind replay).
   */
  markUnknown(rootRunId: string, stepIndex: number): Promise<Result<void, Error>>;

  /**
   * Transition to `committed` and record the `platformMessageId` — the platform
   * confirmed the send. A committed row is the terminal success and is never replayed.
   */
  commit(rootRunId: string, stepIndex: number, platformMessageId: string): Promise<Result<void, Error>>;

  /**
   * ONCE-04 — transition to `failed` (a permanent failure) and record `errorKind`.
   * A failed row is terminal and is not replayed.
   */
  markFailed(rootRunId: string, stepIndex: number, errorKind: string): Promise<Result<void, Error>>;

  /**
   * ONCE-03 — record the reconcile verdict (`sent` | `not_sent` | `unresolved`)
   * for an `unknown_after_send` row. `unresolved` parks the row for escalation
   * rather than replaying it.
   */
  resolveReconcile(rootRunId: string, stepIndex: number, outcome: ReconcileOutcome): Promise<Result<void, Error>>;

  /**
   * ONCE-03 — the recovery scan: every row whose state is still in flight
   * (`unknown_after_send` or `send_attempt_started`). The recovery loop reconciles
   * each against its channel's `reconcileSend?` and resolves it.
   */
  listUnreconciled(): Promise<Result<OutwardSendRecord[], Error>>;
}
