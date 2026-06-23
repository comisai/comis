// SPDX-License-Identifier: Apache-2.0
/**
 * wrapOutwardSend — the three-state outward-send ledger wrapper (Phase 216,
 * ONCE-01/02/04). It turns an irreversible chat-platform send into an
 * exactly-once side effect by keying every attempt on the `(rootRunId,
 * stepIndex)` idempotency pair (HIGH-1) the RPC chokepoint allocated.
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
 * `unknown_after_send` row the recovery scan (Plan 04) finds and reconciles —
 * never a blind replay.
 *
 * SECURITY (T-216-03): only a sha256 `contentDigest` reaches the ledger; the raw
 * `text` goes to `createHash` + `doSend` only — never to any ledger method.
 *
 * HIGH-1 (NEW-1/ONCE-02): a MISSING `outwardStepIndex` is a PASS-THROUGH (an
 * interactive / non-autonomy send), NOT stepIndex 0 — defaulting to 0 would make
 * two un-indexed sends collide on the idempotency key and silently drop one.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { ok, type Result } from "@comis/shared";
import { isPermanentError, systemNowMs, type OutwardSendLedgerPort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

/**
 * TEST-ONLY crash-injection seam (Phase 216 Plan 08, MED-6). The exactly-once
 * chaos test (`test/integration/durable-resume-e2e.test.ts`) drives a REAL
 * autonomy-originated outward send through this wrap and crashes the daemon in
 * the exact window invariant #12 protects — BETWEEN `markUnknown`
 * (state=unknown_after_send) and `commit` — so the post-restart recovery faces a
 * genuine `unknown_after_send` row written by the REAL code path (not a
 * direct-DB-seed). That makes the RED state a real double-send, not a "no such
 * table" miss.
 *
 *   - `"before_send"`: throw AFTER markUnknown but BEFORE `doSend` runs. The
 *     platform (Echo) NEVER records the message ⇒ platform truth = not_sent ⇒ on
 *     restart `reconcileSend` returns not_sent.
 *   - `"after_send"`: run `doSend` (the platform DOES record it ⇒ platform truth =
 *     sent) THEN throw before `commit`. On restart `reconcileSend` returns sent ⇒
 *     ack once, NO replay (a blind replay would be the double-send the test forbids).
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
  /** The three-state ledger, or `undefined` on an older/non-autonomy daemon (⇒ pass-through). */
  ledger: OutwardSendLedgerPort | undefined;
  /** The owning run — half the idempotency key. `undefined` for an interactive send (⇒ pass-through). */
  rootRunId: string | undefined;
  /**
   * The monotonic outward-step index the chokepoint allocated (HIGH-1). The
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
  /** The message content — hashed for the digest + handed to `doSend`; NEVER persisted (T-216-03). */
  text: string;
  /** The wrapped platform call (the existing `deliverToChannel`). */
  doSend: () => Promise<Result<{ messageId: string }, Error>>;
  /** §2.7 structured logger. */
  logger: ComisLogger;
}

/**
 * Wrap an outward send with the three-state ledger. Result-returning; never
 * throws. See the module doc for the lifecycle, the crash window, and the two
 * pass-through guards.
 */
export async function wrapOutwardSend(
  args: WrapOutwardSendArgs,
): Promise<Result<{ messageId: string }, Error>> {
  const { ledger, rootRunId, outwardStepIndex, agentId, channelType, channelId, text, doSend, logger } =
    args;

  // HIGH-1: a missing ledger / rootRunId / outwardStepIndex is a PASS-THROUGH —
  // an interactive send, a non-autonomy daemon, or no allocated index. NEVER
  // substitute 0 for a missing index (that would make two un-indexed sends
  // collide on the idempotency key and drop one).
  if (ledger === undefined || rootRunId === undefined || outwardStepIndex === undefined) {
    return doSend();
  }
  const stepIndex = outwardStepIndex; // defined past the guard

  // ONCE-02 dedup read: a committed row short-circuits a replay to a no-op,
  // returning the prior platformMessageId — doSend is never reached.
  const existing = await ledger.lookup(rootRunId, stepIndex);
  if (existing.ok && existing.value?.state === "committed") {
    logger.debug({ rootRunId, stepIndex, step: "ledger-dedup-hit" }, "Outward send dedup: committed row");
    return ok({ messageId: existing.value.platformMessageId ?? "delivered" });
  }

  const startedAt = systemNowMs();
  // Content-free key (T-216-03): only the sha256 slice — never the body.
  const contentDigest = createHash("sha256").update(text).digest("hex").slice(0, 16);

  // ONCE-01: write send_attempt_started BEFORE the platform call. The UNIQUE
  // (rootRunId, stepIndex) constraint makes a duplicate begin an err the wrap
  // treats as "already in flight" — another attempt owns this send, so we do
  // NOT issue a second platform call (no double send).
  const begun = await ledger.begin({ rootRunId, stepIndex, agentId, channelType, channelId, contentDigest });
  if (!begun.ok) {
    logger.warn(
      {
        rootRunId,
        stepIndex,
        errorKind: "precondition" as const,
        hint: "outward-send begin collided (UNIQUE) — another attempt owns this (rootRunId, stepIndex); treating as already-in-flight, NOT issuing a second platform call",
      },
      "Outward send already in flight",
    );
    return ok({ messageId: existing.ok ? (existing.value?.platformMessageId ?? "in-flight") : "in-flight" });
  }

  // unknown_after_send — written BEFORE the platform-call window closes, so a
  // crash mid-send leaves a durable row the recovery scan reconciles.
  await ledger.markUnknown(rootRunId, stepIndex);

  // TEST-ONLY (MED-6): crash in the exact invariant-#12 window. "before_send"
  // crashes with the platform NOT having recorded the message (truth=not_sent);
  // "after_send" runs the real platform call (truth=sent) THEN crashes before
  // commit. Either way the row is left unknown_after_send for the post-restart
  // recovery to reconcile. INERT in production (__crashHook is never armed).
  if (__crashHook === "before_send") {
    throw new Error(OUTWARD_SEND_CRASH_SENTINEL);
  }
  if (__crashHook === "after_send") {
    await doSend();
    throw new Error(OUTWARD_SEND_CRASH_SENTINEL);
  }

  const sent = await doSend();

  if (sent.ok) {
    await ledger.commit(rootRunId, stepIndex, sent.value.messageId);
    logger.info(
      { rootRunId, stepIndex, durationMs: systemNowMs() - startedAt },
      "Outward send committed",
    );
    return sent;
  }

  // ONCE-04: a permanent failure (chat not found / blocked / forbidden) is
  // terminal — markFailed and return, skipping the retry budget (no loop).
  if (isPermanentError(sent.error.message)) {
    await ledger.markFailed(rootRunId, stepIndex, "permanent");
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

  // A transient failure leaves the row in unknown_after_send: recovery (Plan 04)
  // reconciles it against the channel's reconcileSend? — NOT committed, NOT failed.
  logger.warn(
    {
      rootRunId,
      stepIndex,
      errorKind: "dependency" as const,
      hint: "transient send failure — will reconcile on recovery",
    },
    "Outward send transient failure (left for recovery)",
  );
  return sent;
}
