// SPDX-License-Identifier: Apache-2.0
/**
 * OutwardSendLedgerPort — durable duplicate suppression and uncertainty
 * tracking for an irreversible outward send (a chat-platform message). It
 * resolves a caller-created logical operation id to one stable `(rootRunId,
 * stepIndex)` pair. While that mapping and ledger row are retained, a repeated
 * call with the same identity cannot execute the platform operation again: a
 * committed row returns its receipt, and every other existing state blocks.
 * Allocating a fresh identity for a retry defeats that protection.
 *
 * The lifecycle is a closed five-state union: `send_attempt_started`
 * → `unknown_after_send` → (`committed` | `failed`), with `unresolved` for the
 * honest "the outcome may be ambiguous" terminal. Startup atomically parks and
 * escalates every `send_attempt_started` or `unknown_after_send` row; it does
 * not query channel history or replay the operation. This is not a universal
 * exactly-once guarantee because no local record can prove what happened after
 * an interrupted platform call. The store's Zod row schema enforces the same
 * union at read.
 *
 * SECURITY: the record carries `contentDigest` (a sha256 set by the
 * caller), NEVER the message body — there is deliberately no `body`/`text` field
 * on {@link OutwardSendRecord}, so the ledger is content-free by interface design.
 *
 * @module
 */

import type { Result } from "@comis/shared";

/**
 * The closed outward-send lifecycle. The crash-recovery scan branches on this
 * exact five-member set:
 *   - `send_attempt_started` — `begin` written BEFORE the platform call.
 *   - `unknown_after_send`   — written immediately BEFORE the platform call starts,
 *                              so a crash anywhere in the call window leaves a row
 *                              the recovery scan finds.
 *   - `committed`            — the platform confirmed; `platformMessageId` is set.
 *   - `failed`              — a permanent failure; will not be replayed.
 *   - `unresolved`           — the platform outcome may be ambiguous; the row is
 *                              parked and escalated rather than replayed.
 */
// prettier-ignore
export type OutwardSendState = "send_attempt_started" | "unknown_after_send" | "committed" | "failed" | "unresolved";

/**
 * The persisted recovery outcome for an uncertain outward-send row. The only
 * admissible value is `unresolved`: recovery never claims `sent` or `not_sent`
 * from content history and never uses such a claim to replay a send.
 */
export type ReconcileOutcome = "unresolved";

/** Closed discriminator for the irreversible outward operation. */
export type OutwardOperationKind =
  | "message_send"
  | "message_reply"
  | "message_react"
  | "cross_session_announcement";

/**
 * Operation identity stored in the ledger. `retained_unclassified` is assigned
 * only when an existing row has no recorded kind; new begin requests cannot
 * select it. Its synthetic fingerprint guarantees that a current operation
 * cannot deduplicate against an identity the store cannot prove.
 */
export type StoredOutwardOperationKind = OutwardOperationKind | "retained_unclassified";

/**
 * A single outward-send ledger row. Content-free: `contentDigest`
 * only, never the body. `(rootRunId, stepIndex)` is the UNIQUE idempotency key.
 */
export interface OutwardSendRecord {
  /** The ledger row id. */
  readonly id: string;
  /** The owning run — half of the idempotency key. */
  readonly rootRunId: string;
  /** The outward-send sequence number resolved by `allocateStep` — the other half. */
  readonly stepIndex: number;
  /** The agent that issued the send. */
  readonly agentId: string;
  /** The channel type (e.g. "telegram"). */
  readonly channelType: string;
  /** The channel/chat/room identifier. */
  readonly channelId: string;
  /** The closed lifecycle state. */
  readonly state: OutwardSendState;
  /** The closed outward operation discriminator. */
  readonly operationKind: StoredOutwardOperationKind;
  /** SHA-256 of the canonical immutable operation envelope. */
  readonly operationFingerprint: string;
  /** The platform-assigned message id, present once `state === "committed"`. */
  readonly platformMessageId?: string;
  /** sha256 of the message content — NEVER the body itself. */
  readonly contentDigest: string;
  /** The recovery outcome, present after an uncertain row is parked. */
  readonly reconcileOutcome?: ReconcileOutcome;
  /** How many send attempts this row has accrued. */
  readonly attemptCount: number;
  /** Durable timestamp captured when the send intent was created. */
  readonly attemptedAtMs: number;
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
  readonly operationKind: OutwardOperationKind;
  /** SHA-256 of kind/destination/target/options/payload, never the envelope. */
  readonly operationFingerprint: string;
  /** sha256 of the content — content-free key, never the body. */
  readonly contentDigest: string;
}

/**
 * The five-state outward-send ledger. Every method is `Result`-returning and
 * never throws. The SQLite adapter enforces the UNIQUE
 * `(rootRunId, stepIndex)` constraint that makes a duplicate `begin` a no-op the
 * caller treats as "already in flight".
 */
export interface OutwardSendLedgerPort {
  /**
   * Resolve a caller-provided logical operation identity to one stable outward
   * sequence for a tree root. Repeating the same `(rootRunId, operationId)`
   * returns the original step, including after process restart. A distinct
   * operation id allocates the next sequence after every retained ledger or
   * operation mapping, so a stale sequence row cannot reuse an existing key.
   */
  allocateStep(rootRunId: string, operationId: string): Promise<Result<number, Error>>;

  /**
   * The dedup read. Returns the existing row for this idempotency key,
   * or `ok(undefined)` when no send has been attempted at this `(rootRunId,
   * stepIndex)` yet. The send path consults this before issuing the platform call.
   */
  lookup(rootRunId: string, stepIndex: number): Promise<Result<OutwardSendRecord | undefined, Error>>;

  /**
   * Write `state = send_attempt_started` for a new idempotency key. The
   * UNIQUE `(rootRunId, stepIndex)` makes a duplicate `begin` an error the caller
   * treats as "already in flight" (another attempt owns this send), so two
   * concurrent attempts never both proceed to the platform.
   */
  begin(input: OutwardSendBeginInput): Promise<Result<void, Error>>;

  /**
   * Transition to `unknown_after_send` — written BEFORE the platform call starts,
   * so a crash mid-send leaves a durable row the `listUnreconciled` scan finds and
   * parks rather than blindly replaying.
   */
  markUnknown(rootRunId: string, stepIndex: number): Promise<Result<void, Error>>;

  /** Remove a retained begin only when the platform call was never entered. */
  reclaimPreSend?(rootRunId: string, stepIndex: number): Promise<Result<boolean, Error>>;

  /**
   * Transition to `committed` and record the `platformMessageId` — the platform
   * confirmed the send. A committed row is the terminal success and is never replayed.
   */
  commit(rootRunId: string, stepIndex: number, platformMessageId: string): Promise<Result<void, Error>>;

  /**
   * Transition to `failed` (a permanent failure) and record `errorKind`.
   * A failed row is terminal and is not replayed.
   */
  markFailed(rootRunId: string, stepIndex: number, errorKind: string): Promise<Result<void, Error>>;

  /** Atomically park a crash-uncertain row. Only the winning caller escalates. */
  parkUncertain(rootRunId: string, stepIndex: number): Promise<Result<boolean, Error>>;

  /** True when the root has an in-flight or parked-uncertain outward operation. */
  hasUncertainty(rootRunId: string): Promise<Result<boolean, Error>>;

  /**
   * The recovery scan: every row whose state is still in flight
   * (`unknown_after_send` or `send_attempt_started`). The recovery loop
   * atomically parks and escalates each one without a channel query or replay.
   * The limit bounds one recovery sweep.
   */
  listUnreconciled(limit: number): Promise<Result<OutwardSendRecord[], Error>>;
}
