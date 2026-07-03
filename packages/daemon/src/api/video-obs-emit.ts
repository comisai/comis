// SPDX-License-Identifier: Apache-2.0
/**
 * The video-turn trajectory direct-emit helper.
 *
 * The daemon video RPC handler (`video.generate`, in-turn) AND the off-turn
 * background poller (`setup-video-poller.ts`) record a video turn's lifecycle
 * onto the per-session trajectory so `comis explain <sessionKey>` reconstructs it
 * — INCLUDING a job that completes in the background AFTER the originating turn
 * ended (the submit ties the later completion via traceId/jobId; the persisted
 * `session_key` job-row column is how the off-turn poller resolves the recorder).
 *
 * THE OFF-TURN PRIMITIVE: the factory resolves the recorder by sessionKey and
 * NO-OPs every emit when no recorder resolved — a session that closed (the agent
 * destroyed it) or a daemon restart leaves the in-memory session registry empty,
 * so `getRecorder` returns null/undefined and the live off-turn emit is
 * best-effort. The BINDING oracle is the OFFLINE assembler (pinned by the
 * reconstruct test), which reads the persisted trajectory + the job store
 * independent of any live recorder — so a no-op here is correct, never a crash.
 *
 * DIVERGENCE FROM `createVisionObsEmitter` (vision-obs-emit.ts): the vision twin
 * FUSES the trajectory record AND the §2.7 log line per call, because the vision
 * handler carries no structured logging of its own. The video handler + poller
 * ALREADY carry the complete §2.7 logger floor — an INFO completion
 * line + an ERROR/WARN with errorKind+hint on EVERY branch, with branch-specific
 * `step` tags their tests pin. So THIS emitter is
 * trajectory-RECORD-focused: it adds ONLY the per-session trajectory records and
 * does NOT re-log (a fused log would DOUBLE-emit the §2.7 line). The handler/
 * poller keep their existing logger lines and call these methods beside them.
 *
 * CONTENT-FREE: every recorded payload carries ids / labels / counts /
 * `costUsd` / `outcome` / `errorKind` / booleans ONLY — NEVER the prompt, the
 * video bytes, a credential, the Veo keyed-download-URL, or a raw provider
 * message. `costUsd`/`model`/`sizeBytes`/`durationSecs` ride `video.generated`
 * presence-conditionally (FAL reports no actual cost, so an absent
 * value never appears as an `undefined` key). The domain `VideoErrorKind` rides
 * `video.failed.errorKind` verbatim (the redaction-safe detail + the closed log
 * union via VIDEO_ERR_TO_LOG ride the structured Pino LOG, not the trajectory).
 *
 * @module
 */

import type { SessionTrajectoryHandleRegistry, TrajectoryEventType } from "@comis/observability";
import type { VideoErrorKind } from "@comis/core";

/** A bound video-trajectory emitter. Returned by `createVideoObsEmitter` (which
 *  fires `video.requested` at construction). The handler calls `submitted`/
 *  `failed` in-turn; the off-turn poller calls `generated`/`delivered`/`failed`.
 *  Every emit is a no-op when no recorder resolved (off-turn safe). */
export interface VideoObsEmitter {
  /** True when a non-null recorder resolved (a session key + a registry + an
   *  open recorder). False off-turn / boot-without-registry — every method then
   *  no-ops (the offline assembler is the binding oracle). */
  readonly active: boolean;
  /** A job was SUBMITTED: record video.submitted {provider, jobId}. */
  submitted(args: { provider: string; jobId: string }): void;
  /** A render SUCCEEDED (off-turn): record video.generated with the cost-carry
   *  (model/costUsd/sizeBytes/durationSecs presence-conditional — some
   *  providers report no actual cost). */
  generated(args: {
    provider: string;
    model?: string;
    costUsd?: number;
    sizeBytes?: number;
    durationSecs?: number;
  }): void;
  /** A clip was DELIVERED (off-turn): record video.delivered {channelType,
   *  delivered} (delivered:false on the IRC persisted-only degrade). */
  delivered(args: { channelType: string; delivered: boolean }): void;
  /** A generation FAILED (a pre-submit quota block, a submit error, or an
   *  off-turn poll/timeout): record video.failed {errorKind, provider} (the
   *  domain VideoErrorKind; never the raw provider message). */
  failed(args: { errorKind: VideoErrorKind; provider: string }): void;
}

/**
 * Resolve the per-session recorder by `sessionKey`, fire the `video.requested`
 * entry record, and return a bound {@link VideoObsEmitter}. In-turn the handler
 * passes the dispatcher-injected `_callerSessionKey`; off-turn the poller passes
 * the persisted `record.sessionKey`. When the registry is absent, `getRecorder`
 * returns null/undefined, or there is no session key, the trajectory emits are
 * NO-OPs (never a crash) — the offline assembler is the binding oracle.
 *
 * `agentId` is retained for symmetry with `createVisionObsEmitter` + future
 * envelope use; it is NOT echoed into the content-free trajectory `data` (the
 * recorder's envelope carries it).
 */
export function createVideoObsEmitter(args: {
  sessionKey: string | undefined;
  trajectoryRegistry: SessionTrajectoryHandleRegistry | undefined;
  agentId: string;
  requested: { provider: string; mainProvider: string };
}): VideoObsEmitter {
  const { sessionKey, trajectoryRegistry, requested } = args;
  const recorder =
    sessionKey != null && sessionKey.length > 0 && trajectoryRegistry != null
      ? trajectoryRegistry.getRecorder?.(sessionKey)
      : undefined;

  const emit = (type: TrajectoryEventType, data: Record<string, unknown>): void => {
    if (recorder != null) recorder.recordEvent(type, data);
  };

  emit("video.requested", { provider: requested.provider, mainProvider: requested.mainProvider });

  return {
    active: recorder != null,
    submitted({ provider, jobId }) {
      emit("video.submitted", { provider, jobId });
    },
    generated({ provider, model, costUsd, sizeBytes, durationSecs }) {
      emit("video.generated", {
        provider,
        outcome: "ok",
        ...(model !== undefined ? { model } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        ...(durationSecs !== undefined ? { durationSecs } : {}),
      });
    },
    delivered({ channelType, delivered }) {
      emit("video.delivered", { channelType, delivered });
    },
    failed({ errorKind, provider }) {
      emit("video.failed", { errorKind, provider });
    },
  };
}
