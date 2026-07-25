// SPDX-License-Identifier: Apache-2.0
// @allow-throw: TEST-ONLY crash-injection seam. The two
// `throw new Error(OUTWARD_SEND_CRASH_SENTINEL)` sites (lines ~158/162) MUST be real
// throws — they simulate a process crash in the exact crash window (BETWEEN
// markUnknown and commit) so the post-restart recovery faces a genuine
// `unknown_after_send` row written by the REAL code path. A `Result.err(...)` cannot
// model this: the function would return normally and `commit` would NOT be skipped the
// way an actual mid-send crash skips it, so the chaos test would not exercise
// the real duplicate-send risk. INERT in production (__crashHook is never armed). The throws
// unwind to the chaos test's `.rejects.toThrow(OUTWARD_SEND_CRASH_SENTINEL)` assertion.
/**
 * wrapOutwardSend — the outward-send ledger wrapper. It binds an irreversible
 * chat-platform operation to the `(rootRunId,
 * stepIndex)` idempotency pair the RPC chokepoint allocated.
 *
 * It wraps the EXISTING `deliveryService.deliverToChannel` call at
 * message.send/reply/react — it is inserted AFTER `enforceOutwardQuota`, so the
 * §3.5 outward floor + per-root quota still gate every send. There is NO
 * parallel send path: the real delivery still happens inside the injected
 * `doSend`.
 *
 * The lifecycle written around `doSend`:
 *   begin (send_attempt_started) → markUnknown (unknown_after_send) → doSend →
 *   commit(platformMessageId).
 * The crash window is BETWEEN markUnknown and commit: a crash there leaves an
 * `unknown_after_send` row the recovery scan atomically parks — never a blind
 * replay or a content-history guess.
 *
 * This wrapper suppresses another execution only when the caller reuses one
 * retained operation identity. A committed row returns its prior receipt; an
 * in-flight, failed, or unresolved row blocks. If the platform outcome may be
 * ambiguous, the row is parked `unresolved` and escalated. No channel query can
 * turn that ambiguity into a universal exactly-once guarantee.
 *
 * SECURITY: only a sha256 `contentDigest` reaches the ledger; the raw
 * `text` goes to `createHash` + `doSend` only — never to any ledger method.
 *
 * A MISSING `outwardStepIndex` is a PASS-THROUGH (an
 * interactive / non-autonomy send), NOT stepIndex 0 — defaulting to 0 would make
 * two un-indexed sends collide on the idempotency key and silently drop one.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { err, ok, type Result } from "@comis/shared";
import {
  isPermanentError,
  systemNowMs,
  type ComisLogger,
  type OutwardOperationKind,
  type OutwardSendLedgerPort,
} from "@comis/core";

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

function canonicalize(
  value: unknown,
  seen: Set<object> = new Set<object>(),
): Result<CanonicalValue, Error> {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return ok(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? ok(value)
      : err(new Error("outward operation options contain a non-finite number"));
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return err(new Error("outward operation options are cyclic"));
    seen.add(value);
    const result: CanonicalValue[] = [];
    for (const item of value) {
      const canonical = canonicalize(item === undefined ? null : item, seen);
      if (!canonical.ok) return canonical;
      result.push(canonical.value);
    }
    seen.delete(value);
    return ok(result);
  }
  if (typeof value === "object") {
    if (seen.has(value)) return err(new Error("outward operation options are cyclic"));
    seen.add(value);
    const entries: Array<[string, CanonicalValue]> = [];
    for (const [key, item] of Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (item === undefined) continue;
      const canonical = canonicalize(item, seen);
      if (!canonical.ok) return canonical;
      entries.push([key, canonical.value]);
    }
    seen.delete(value);
    return ok(Object.fromEntries(entries));
  }
  return err(new Error("outward operation options contain an unsupported value"));
}

function computeOperationFingerprint(args: {
  operationKind: OutwardOperationKind;
  channelType: string;
  channelId: string;
  targetMessageId?: string;
  text: string;
  operationOptions?: unknown;
}): Result<string, Error> {
  const envelope = canonicalize({
    kind: args.operationKind,
    channelType: args.channelType,
    channelId: args.channelId,
    targetMessageId: args.targetMessageId ?? null,
    text: args.text,
    options: args.operationOptions ?? null,
  });
  if (!envelope.ok) return envelope;
  return ok(
    createHash("sha256")
      .update(JSON.stringify(envelope.value))
      .digest("hex"),
  );
}

/**
 * TEST-ONLY crash-injection seam. The crash-safety
 * chaos test (`test/integration/durable-resume-e2e.test.ts`) drives a REAL
 * autonomy-originated outward send through this wrap and crashes the daemon in
 * the exact crash window — BETWEEN `markUnknown`
 * (state=unknown_after_send) and `commit` — so the post-restart recovery faces a
 * genuine `unknown_after_send` row written by the REAL code path (not a
 * direct-DB-seed). That exercises the real interrupted-send uncertainty rather
 * than a missing-table setup failure.
 *
 *   - `"before_send"`: throw AFTER markUnknown but BEFORE `doSend` runs.
 *   - `"after_send"`: run `doSend` and throw before `commit`.
 * In both cases recovery must conservatively park the row; it cannot infer the
 * platform outcome from local process state.
 *
 * This is the `_resetSigusr1Timer` test-seam precedent: a module-scoped hook with
 * an exported setter, INERT in production (never set) and re-exported from the
 * `@comis/daemon` barrel so the in-process integration test can arm/disarm it.
 */
export type OutwardSendCrashHookMode = "before_send" | "after_send";

let __crashHook: OutwardSendCrashHookMode | undefined;

/**
 * Arm (or, with `undefined`, disarm) the test-only crash hook. INERT in
 * production — only the chaos test calls it. Returns nothing; idempotent.
 */
export function __setOutwardSendCrashHookForTest(mode: OutwardSendCrashHookMode | undefined): void {
  __crashHook = mode;
}

/** The sentinel error message the crash hook throws — recognized in tests/logs. */
export const OUTWARD_SEND_CRASH_SENTINEL = "outward-send crash hook (test-only): simulated mid-send crash";

/** The arguments to {@link wrapOutwardSend}. */
export interface WrapOutwardSendArgs {
  /** The ledger, or `undefined` when durability is disabled (⇒ pass-through). */
  ledger: OutwardSendLedgerPort | undefined;
  /** The owning run — half the idempotency key. `undefined` for an interactive send (⇒ pass-through). */
  rootRunId: string | undefined;
  /**
   * The monotonic outward-step index the chokepoint allocated. The
   * OTHER half of the idempotency key. `undefined` ⇒ PASS-THROUGH (no ledger).
   * NEVER substitute 0 for a missing index (that would collide two sends).
   */
  outwardStepIndex: number | undefined;
  /** The agent that issued the send. */
  agentId: string;
  /** The channel type (e.g. "telegram"). */
  channelType: string;
  /** The channel/chat/room identifier. */
  channelId: string;
  /** The immutable outward operation discriminator. */
  operationKind: OutwardOperationKind;
  /** Reply/reaction target, when the operation addresses an existing message. */
  targetMessageId?: string;
  /** Validated buttons/cards/effects/thread options included in operation identity. */
  operationOptions?: unknown;
  /** The message content — hashed for the digest + handed to `doSend`; NEVER persisted. */
  text: string;
  /** The wrapped platform call (the existing `deliverToChannel`). */
  doSend: () => Promise<Result<{ messageId: string }, Error>>;
  /** §2.7 structured logger. */
  logger: ComisLogger;
}

export class OutwardSendPreSendError extends Error {
  readonly phase = "mark_unknown" as const;

  constructor(cause: Error) {
    super(cause.message, { cause });
    this.name = "OutwardSendPreSendError";
  }
}

/**
 * Wrap an outward send with the five-state ledger. Result-returning; never
 * throws. See the module doc for the lifecycle, the crash window, and the two
 * pass-through guards.
 */
export async function wrapOutwardSend(
  args: WrapOutwardSendArgs,
): Promise<Result<{ messageId: string }, Error>> {
  const {
    ledger,
    rootRunId,
    outwardStepIndex,
    agentId,
    channelType,
    channelId,
    operationKind,
    targetMessageId,
    operationOptions,
    text,
    doSend,
    logger,
  } = args;

  // A missing ledger / rootRunId / outwardStepIndex is a PASS-THROUGH —
  // an interactive send, a non-autonomy daemon, or no allocated index. NEVER
  // substitute 0 for a missing index (that would make two un-indexed sends
  // collide on the idempotency key and drop one).
  if (ledger === undefined || rootRunId === undefined || outwardStepIndex === undefined) {
    return doSend();
  }
  const stepIndex = outwardStepIndex; // defined past the guard

  const contentDigest = createHash("sha256").update(text).digest("hex");
  const fingerprint = computeOperationFingerprint({
    operationKind,
    channelType,
    channelId,
    ...(targetMessageId !== undefined ? { targetMessageId } : {}),
    text,
    ...(operationOptions !== undefined ? { operationOptions } : {}),
  });
  if (!fingerprint.ok) return fingerprint;

  // Duplicate-suppression read: a committed row short-circuits a repeated call,
  // returning the prior platformMessageId — doSend is never reached.
  const existing = await ledger.lookup(rootRunId, stepIndex);
  if (!existing.ok) {
    logger.error(
      {
        rootRunId,
        stepIndex,
        errorKind: "dependency" as const,
        hint: "the send was blocked before delivery; restore outward-ledger reads and retry with the same operation identity",
      },
      "Outward send ledger lookup failed",
    );
    return err(existing.error);
  }
  if (existing.value !== undefined) {
    const sameOperation =
      existing.value.agentId === agentId &&
      existing.value.channelType === channelType &&
      existing.value.channelId === channelId &&
      existing.value.operationKind === operationKind &&
      existing.value.operationFingerprint === fingerprint.value &&
      existing.value.contentDigest === contentDigest;
    if (!sameOperation) {
      const identityError = new Error("outward operation identity does not match its ledger row");
      logger.error(
        {
          rootRunId,
          stepIndex,
          errorKind: "validation" as const,
          hint: "reuse an operation identity only with the exact original destination, target, payload, and options",
        },
        "Outward send operation identity mismatch",
      );
      return err(identityError);
    }
  }
  if (existing.value?.state === "committed") {
    if (existing.value.platformMessageId === undefined || existing.value.platformMessageId.length === 0) {
      return err(new Error("committed outward operation has no platform receipt"));
    }
    logger.debug({ rootRunId, stepIndex, step: "ledger-dedup-hit" }, "Outward send dedup: committed row");
    return ok({ messageId: existing.value.platformMessageId });
  }
  if (existing.value !== undefined) {
    return err(new Error("outward operation is already in flight or unresolved"));
  }

  const startedAt = systemNowMs();
  // Content-free key: the full SHA-256 digest, never the body. The full digest
  // is a content-free identity; truncation would silently reduce it to a
  // collision-prone 64-bit key.
  // Write send_attempt_started BEFORE the platform call. The UNIQUE
  // (rootRunId, stepIndex) constraint makes a duplicate begin an err the wrap
  // treats as "already in flight" — another attempt owns this retained
  // operation identity, so this call does not reach the platform.
  const begun = await ledger.begin({
    rootRunId,
    stepIndex,
    agentId,
    channelType,
    channelId,
    operationKind,
    operationFingerprint: fingerprint.value,
    contentDigest,
  });
  if (!begun.ok) {
    logger.error(
      {
        rootRunId,
        stepIndex,
        errorKind: "dependency" as const,
        hint: "the send was blocked because its durable begin was not recorded; inspect the existing ledger row and retry with the same operation identity",
      },
      "Outward send ledger begin failed",
    );
    return err(begun.error);
  }

  // unknown_after_send — written BEFORE the platform-call window closes, so a
  // crash mid-send leaves a durable row the recovery scan parks.
  const markedUnknown = await ledger.markUnknown(rootRunId, stepIndex);
  if (!markedUnknown.ok) {
    logger.error(
      {
        rootRunId,
        stepIndex,
        errorKind: "dependency" as const,
        hint: "the send was blocked before delivery because the uncertain-send state was not durable; repair ledger writes and retry with the same operation identity",
      },
      "Outward send ledger mark-unknown failed",
    );
    return err(new OutwardSendPreSendError(markedUnknown.error));
  }

  // TEST-ONLY: crash in the exact crash window. Either way the row is left
  // unknown_after_send for post-restart recovery to park. INERT in production
  // (__crashHook is never armed).
  if (__crashHook === "before_send") {
    throw new Error(OUTWARD_SEND_CRASH_SENTINEL);
  }
  if (__crashHook === "after_send") {
    await doSend();
    throw new Error(OUTWARD_SEND_CRASH_SENTINEL);
  }

  const sent = await doSend();

  if (sent.ok) {
    if (sent.value.messageId.length === 0) {
      const parked = await ledger.parkUncertain(rootRunId, stepIndex);
      if (!parked.ok) return err(parked.error);
      return err(new Error("platform send returned no durable receipt"));
    }
    const committed = await ledger.commit(rootRunId, stepIndex, sent.value.messageId);
    if (!committed.ok) {
      const parked = await ledger.parkUncertain(rootRunId, stepIndex);
      if (!parked.ok) {
        logger.error(
          {
            rootRunId,
            stepIndex,
            errorKind: "dependency" as const,
            hint: "both commit and uncertainty parking failed; repair the outward ledger before any retry",
          },
          "Outward send ledger persistence failed after delivery",
        );
        return err(parked.error);
      }
      if (parked.value) {
        logger.error(
          {
            rootRunId,
            stepIndex,
            errorKind: "dependency" as const,
            hint: "the delivery is parked as uncertain; verify the platform manually before any retry",
          },
          "Outward send commit failed after delivery",
        );
      }
      return err(committed.error);
    }
    logger.info(
      { rootRunId, stepIndex, durationMs: systemNowMs() - startedAt },
      "Outward send committed",
    );
    return sent;
  }

  // A permanent failure (chat not found / blocked / forbidden) is
  // terminal — markFailed and return, skipping the retry budget (no loop).
  if (isPermanentError(sent.error.message)) {
    const markedFailed = await ledger.markFailed(rootRunId, stepIndex, "permanent");
    if (!markedFailed.ok) {
      const parked = await ledger.parkUncertain(rootRunId, stepIndex);
      if (!parked.ok) return err(parked.error);
      logger.error(
        {
          rootRunId,
          stepIndex,
          errorKind: "dependency" as const,
          hint: "the platform rejected the send permanently but the terminal ledger state was not recorded; repair ledger writes before retrying",
        },
        "Outward send ledger mark-failed failed",
      );
      return err(markedFailed.error);
    }
    logger.error(
      {
        rootRunId,
        stepIndex,
        errorKind: "platform" as const,
        hint: "permanent send failure (chat not found/blocked) — not retried",
      },
      "Outward send permanently failed",
    );
    return sent;
  }

  const parked = await ledger.parkUncertain(rootRunId, stepIndex);
  if (!parked.ok) return err(parked.error);
  if (parked.value) {
    logger.warn(
      {
        rootRunId,
        stepIndex,
        errorKind: "dependency" as const,
        hint: "the delivery outcome is uncertain; verify the platform manually before any retry",
      },
      "Outward send failure parked for manual verification",
    );
  }
  return sent;
}
