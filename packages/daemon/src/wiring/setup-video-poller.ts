// SPDX-License-Identifier: Apache-2.0
/**
 * Background video poller — the durability keystone for long video renders.
 *
 * This is the two-phase crash-safe delivery queue (`setup-delivery.ts`
 * `setupDeliveryQueue`) RETYPED for an EXTERNAL-provider poll. A long video
 * render (30 s–5 min) outlives the originating agent turn AND a daemon restart;
 * the poller completes it independently and announces the finished clip to the
 * RECORDED channel.
 *
 * LIFECYCLE (the two-phase contract, mirroring the delivery queue):
 *   1. `createVideoPoller(...)` returns `{ track, startAndResume, shutdown }`
 *      IMMEDIATELY — before `setupChannels` exists. `track(record)` may be called
 *      from the handler once a job is submitted; it takes the FULL in-memory
 *      `VideoJobRecord` the handler already has (no `listPending`
 *      scan, and the insert-failure path still delivers in-memory, never orphans).
 *   2. `startAndResume()` is called AFTER `setupChannels` populates the channel
 *      registry (so `sendAttachment` works outside a turn): it reloads
 *      `store.listPending()` and resumes each, then arms the low-frequency outer
 *      sweeper (single-tick gate + `.unref()`).
 *   3. `shutdown()` aborts in-flight loops/downloads + clears the sweeper.
 *
 * REDELIVERY BOUND: a row whose channel delivery keeps failing is
 * re-driven by the sweeper every `pollIntervalMs`; without a bound that re-poll +
 * re-download (up to 200 MB) + re-send repeats forever, and the cost was being
 * re-recorded each pass. The poller now (a) bumps the persisted `deliver_attempts`
 * on each delivery failure and dead-letters the row to `failed` once it exceeds
 * `config.maxDeliveryAttempts`, (b) records the cost EXACTLY ONCE — on the
 * terminal `markDone`, never before the delivery decision and never on a retry,
 * and (c) checks the `markFailed` Result (a failed terminal write is logged at
 * ERROR, with the attempt bound as the backstop).
 *
 * THE PER-JOB POLL IS THE SHIPPED `pollUntilDone` — `@comis/core` authored
 * it EXPRESSLY for this reuse; this file does NOT re-author a second loop
 * (zero raw `setTimeout`/`while`-poll). The genuinely-NEW outer code is the
 * lifecycle: which jobs to poll, the resume scan, and the sweeper.
 *
 * FOUR MUST-DIFFER-FROM-THE-DELIVERY-QUEUE POINTS:
 *   1. external-provider poll via `pollUntilDone` (the queue retries a LOCAL send).
 *   2. `sendAttachment` (the attachment send), NOT the text-send — video is an
 *      attachment; it is NEVER routed through the text `deliveryQueue` (whose
 *      media mirroring is deferred).
 *   3. explicit off-turn `traceId`: the poller tick runs in a FRESH context with
 *      NO ALS frame, so the Pino mixin won't auto-inject `traceId`. It is read
 *      from the persisted job row and put ON every log object.
 *   4. at-least-once announce: `markDone` is the LAST step — AFTER delivery — so
 *      a `pending` row on restart re-runs poll→fetch→deliver→markDone. A crash
 *      AFTER deliver but BEFORE the `markDone` write yields ONE bounded duplicate
 *      (accepted: announce-on-complete is "deliver the clip", not exactly-once).
 *
 * SECURITY: delivery targets ONLY the recorded `channelType`/`channelId`/`agentId`
 * from the job row (never a silent default, never another agent's channel). The
 * off-turn log lines carry `{ traceId, jobId, errorKind, hint, costUsd }` only —
 * never a key/token (the boot-bound adapter holds the credential, the poller never
 * re-reads it).
 *
 * @module
 */

import {
  systemNowMs,
  createPollDeadline,
  pollUntilDone,
  sanitizeLogString,
  VIDEO_ERR_TO_LOG,
  type VideoGenerationPort,
  type VideoGenerationConfig,
  type ChannelPort,
  type TimerPort,
  type TimerHandle,
  type VideoErrorKind,
} from "@comis/core";
import { suppressError } from "@comis/shared";
import type { VideoJobStore, VideoJobRecord } from "@comis/memory";
import type { PersistedFile } from "@comis/skills/tools";
import type { ComisLogger } from "@comis/infra";
import type { SessionTrajectoryHandleRegistry, TrajectoryEventType } from "@comis/observability";
import type { AppContainer } from "@comis/core";
import { resolveVideoSizeLimit, buildOversizedDegradeMessage } from "./video-delivery-limits.js";
// Scrub a raw provider/channel error before it rides a log line.
import { makeRedactErr } from "./video-log-redaction.js";
import { defaultVideoPollerTimerPort } from "./setup-video-poller-timer.js";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** The two-phase background poller (mirrors `DeliveryQueueResult`). */
export interface VideoPoller {
  /**
   * Hand a freshly-submitted job to the poller. The caller passes
   * the FULL in-memory `VideoJobRecord` it already has at submit (jobId +
   * routing + traceId + estimate), so the poller starts the loop directly WITHOUT
   * an `O(pending)` `listPending()` scan and WITHOUT depending on the row being
   * observably `pending` at that instant. This also makes the handler's
   * insert-failure path honest: a job whose row could not be persisted is still
   * driven to delivery in-memory (no silent orphan) — the persisted-row
   * machinery (markDone/markFailed/incrementDeliveryAttempt) simply no-ops on the
   * missing row, which is naturally bounded (the sweeper never re-discovers a row
   * that does not exist).
   */
  track(record: VideoJobRecord): void;
  /**
   * RESTART RESUME: reload `listPending()` + resume each, then arm the
   * outer sweeper. Call AFTER `setupChannels` (the channel registry is now
   * populated so `sendAttachment` reaches a live adapter outside a turn).
   */
  startAndResume(): Promise<void>;
  /** Clear the sweeper interval + stop in-flight per-job loops (call on shutdown). */
  shutdown(): void;
}

/** Persist getter — the per-agent `persistVideo` from the bundle. */
type PersistVideo = (
  agentId: string,
  buffer: Buffer,
  opts: { mediaKind: "video"; mimeType: string },
) => Promise<import("@comis/shared").Result<PersistedFile, Error>>;

export interface VideoPollerDeps {
  store: VideoJobStore;
  provider: VideoGenerationPort;
  /** Per-agent persist getter (videos/). */
  persist: PersistVideo;
  /** Reconcile: record the actual cost on done. Optional (count-only). */
  costLimiter?: { record(agentId: string, cost: number): void };
  /** The announce path — resolve a channel adapter by type (live reference).
   *  Widened to also expose `sendMessage` (a REQUIRED ChannelPort method,
   *  present on every adapter) so the oversized-degrade link/notice can be sent
   *  without an attachment. The runtime objects ARE full ChannelPorts (the
   *  main-helpers `resolveAttachmentAdapter` runtime-narrow note); `sendAttachment`
   *  stays optional (IRC omits it — the capability gate). */
  getChannelAdapter: (
    channelType: string,
  ) => Pick<ChannelPort, "sendAttachment" | "sendMessage"> | undefined;
  config: VideoGenerationConfig;
  logger: ComisLogger;
  /** Injectable timer for the outer sweeper (default: a `systemSetInterval`
   *  adapter). Tests pass `createFakeTimers()` to assert `.unref()` + advance. */
  timers?: TimerPort;
  /** Injectable per-job poll sleep (default: the `pollUntilDone` system sleep). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for the per-job deadline (default: `systemNowMs`). */
  nowMs?: () => number;
  /** The per-session trajectory recorder registry. On the
   *  terminal done/fail branches the poller BEST-EFFORT live-emits
   *  video.generated/delivered/failed via getRecorder(record.sessionKey) — the
   *  OFF-TURN key read from the ROW (the poller tick has NO ALS frame). Optional +
   *  no-op when absent OR when the recorder is gone (session closed / daemon
   *  restarted) — the OFFLINE assembler is the binding reconstruction oracle; the
   *  live emit captures the common fast-render case. */
  trajectoryRegistry?: SessionTrajectoryHandleRegistry;
  /** The typed event bus for the off-turn synthetic
   *  `observability:token_usage` cost route (the cost rollup is emitted from the
   *  poller's done branch). Threaded here so the wiring lands in one place.
   *  Optional → no-op when absent. */
  eventBus?: AppContainer["eventBus"];
  /** Optional operator override for the per-channelType video
   *  upload limit (the media-compressor `maxVideoBytes` knob). When set it WINS
   *  over the per-channel constant in `resolveVideoSizeLimit`; when absent each
   *  channel's documented limit applies (the honest default). Not a field on the
   *  strictObject `VideoGenerationConfig` (it belongs to the channels-package
   *  MediaCompressionConfig); injected here so a future config wire-up threads it
   *  in one place without a schema change. */
  maxVideoBytes?: number;
  /** The RESOLVED video creds (GOOGLE_API_KEY /
   *  XAI_API_KEY / FAL_KEY / Grok bearer), bound for EXACT-MATCH scrub of every
   *  off-turn log surface (the knownSecrets precedent — catches the FAL
   *  `uuid:hex` shape + any future shape). Absent → pattern scrub only (no crash). */
  videoSecrets?: readonly string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * The per-job `pollUntilDone` snapshot. `state` drives the loop; `errorKind`/`hint`
 * are the classified failure detail an adapter threads onto the terminal
 * `failed` snapshot (absent for FAL / a thrown poll). Carried through the loop so
 * the failed branch persists/logs the specific kind+hint, not empty_response.
 */
interface PollSnapshot {
  state: string;
  errorKind?: VideoErrorKind;
  hint?: string;
}

/** A `.mp4` default; the buffer is the durable artifact regardless. */
function extForMime(mimeType: string): string {
  if (mimeType === "video/webm") return ".webm";
  if (mimeType === "video/quicktime") return ".mov";
  return ".mp4";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createVideoPoller(deps: VideoPollerDeps): VideoPoller {
  const { store, provider, persist, costLimiter, getChannelAdapter, config, logger } = deps;
  const timers = deps.timers ?? defaultVideoPollerTimerPort();
  const sleep = deps.sleep;
  const nowMs = deps.nowMs ?? systemNowMs;
  const trajectoryRegistry = deps.trajectoryRegistry;
  // Bind resolved video secrets ONCE; every off-turn redactErr below scrubs them.
  const redactErr = makeRedactErr(deps.videoSecrets ?? []);

  /**
   * BEST-EFFORT off-turn trajectory record. Resolves the
   * per-session recorder by the ROW's `sessionKey` (the off-turn key — there is
   * NO ALS frame in the poller tick) and records a content-free
   * video.* event. NO-OP when there is no sessionKey (a row lacking one / in-flight),
   * no registry (a boot mode without one), or no recorder (the session closed or
   * the daemon restarted — the common off-turn case). The §2.7 log lines fire
   * regardless; the OFFLINE assembler is the BINDING reconstruction
   * oracle, so a no-op here is correct, never a crash. Content-free:
   * ids/labels/counts/costUsd/outcome/errorKind/booleans ONLY — never the bytes,
   * a credential, the keyed-download-URL, or a raw provider message.
   */
  function emitTrajectory(record: VideoJobRecord, type: TrajectoryEventType, data: Record<string, unknown>): void {
    const sessionKey = record.sessionKey;
    if (sessionKey == null || sessionKey.length === 0 || trajectoryRegistry == null) return;
    const recorder = trajectoryRegistry.getRecorder?.(sessionKey);
    if (recorder != null) recorder.recordEvent(type, data);
  }

  // In-flight jobIds (bounded by config.maxConcurrentJobs when set). A row that
  // would exceed the bound is left `pending` for the sweeper to pick up later.
  const inFlight = new Set<string>();
  const maxConcurrent =
    typeof config.maxConcurrentJobs === "number" && config.maxConcurrentJobs > 0
      ? config.maxConcurrentJobs
      : undefined;

  // The redelivery bound. A row whose delivery keeps failing is dead-
  // lettered to `failed` once `deliver_attempts` exceeds this, so the sweeper
  // stops re-polling + re-downloading it every pollIntervalMs forever. Defaulted
  // defensively (the config schema defaults it to 5, but a hand-built test config
  // may omit it).
  const maxDeliveryAttempts =
    typeof config.maxDeliveryAttempts === "number" && config.maxDeliveryAttempts > 0
      ? config.maxDeliveryAttempts
      : 5;

  let sweepInterval: TimerHandle | undefined;
  let sweeping: Promise<void> | null = null;
  let stopped = false;
  // A shutdown abort so an in-flight fetchResult download (up to the
  // adapter's 120s timeout) aborts promptly on SIGTERM rather than racing
  // db.close() with a late markDone/markFailed write.
  const shutdownAbort = new AbortController();

  /** Map a `pollUntilDone` failed/timeout outcome to a domain errorKind. The
   *  failed→empty_response fallback applies ONLY when the adapter did not classify
   *  the failure on the poll snapshot (the specific kind is carried otherwise). */
  function classifyOutcome(kind: "failed" | "timeout"): VideoErrorKind {
    return kind === "timeout" ? "job_timeout" : "empty_response";
  }

  /**
   * Handle a channel delivery failure under the redelivery bound. The row
   * stays `pending` (at-least-once retry) UNLESS the bumped `deliver_attempts`
   * reaches `maxDeliveryAttempts`, at which point the job is dead-lettered to
   * `failed` so the sweeper stops re-polling + re-downloading it forever. A
   * non-persisted row (the handler's insert-failure in-memory job → increment
   * returns 0) is already bounded — the sweeper never re-discovers it — so it
   * just WARNs once and stops.
   */
  async function handleDeliveryFailure(record: VideoJobRecord, cause: Error): Promise<void> {
    const attempt = await store.incrementDeliveryAttempt(record.jobId);
    const attempts = attempt.ok ? attempt.value : 0;
    // attempts > 0 means a real persisted row; >= max → dead-letter (terminal).
    if (attempts > 0 && attempts >= maxDeliveryAttempts) {
      // The render SUCCEEDED; only off-turn channel delivery
      // exhausted its retries. Dead-letter with the DELIVERY-specific
      // `delivery_failed` kind (NOT the render kind `empty_response`) so the
      // trajectory `video.failed` → `IncidentReport.videoGenerated.errorKind` and
      // `comis explain` point at the CHANNEL, not the provider/prompt. The hint
      // (persisted as last_error) names delivery; the log ErrorKind rides VIDEO_ERR_TO_LOG.
      const deadLetterHint =
        "Video delivery failed repeatedly and was dead-lettered to `failed` " +
        "(no further retries). Check the channel's attachment support / size " +
        "limits / credentials, or raise integrations.media.videoGeneration." +
        "maxDeliveryAttempts.";
      await markFailed(record, "delivery_failed", cause, deadLetterHint);
      logger.warn(
        {
          traceId: record.traceId,
          jobId: record.jobId,
          channelType: record.channelType,
          agentId: record.agentId,
          attempts,
          maxDeliveryAttempts,
          errorKind: VIDEO_ERR_TO_LOG.delivery_failed,
          videoErrorKind: "delivery_failed" as const,
          hint: deadLetterHint,
          step: "video_poll_deadletter",
        },
        "Video poller: delivery dead-lettered after max attempts",
      );
      return;
    }
    // Still pending, but now BOUNDED by maxDeliveryAttempts (the sweeper re-drives).
    logger.warn(
      {
        traceId: record.traceId,
        jobId: record.jobId,
        channelType: record.channelType,
        attempts,
        maxDeliveryAttempts,
        // A channel delivery error can echo a token/URL — scrub it.
        ...redactErr(cause),
        errorKind: "network" as const,
        hint:
          "Video persisted but channel delivery failed; the job stays pending and " +
          "the next sweep retries (bounded by maxDeliveryAttempts).",
        step: "video_poll_deliver",
      },
      "Video poller: channel delivery failed (will retry)",
    );
  }

  /** The completion tail: fetch the render, persist, deliver, then markDone + reconcile cost. */
  async function completeJob(record: VideoJobRecord, startMs: number): Promise<void> {
    const fetched = await provider.fetchResult(
      { jobId: record.jobId, provider: record.provider, model: record.model ?? "" },
      { signal: shutdownAbort.signal },
    );
    if (!fetched.ok) {
      await markFailed(record, "empty_response", fetched.error);
      return;
    }
    const out = fetched.value;
    const mimeType = out.mimeType;
    const ext = extForMime(mimeType);

    // Persist BEFORE any delivery decision (the fetch already happened).
    // Cost is NOT recorded here — it rides the terminal markDone, so
    // a persist failure (no deliverable artifact) never charges the limiter and a
    // retried completeJob never double-counts.
    const persisted = await persist(record.agentId, out.buffer, { mediaKind: "video", mimeType });
    if (!persisted.ok) {
      logger.warn(
        { traceId: record.traceId, jobId: record.jobId, agentId: record.agentId, ...redactErr(persisted.error), errorKind: "resource" as const, hint: "Video rendered but persistence failed; the job is marked failed (no durable artifact to announce)", step: "video_poll_persist" },
        "Video poller: persistence failed",
      );
      await markFailed(record, "empty_response");
      return;
    }

    // Capability-gated direct delivery to the RECORDED channel only
    // (never a channel-name list — sendAttachment is optional on
    // ChannelPort, omitted by IRC). Use the attachment send, not text.
    // Track whether the clip was actually attached so the
    // off-turn video.delivered record below carries an honest `delivered` flag
    // (false on the IRC persisted-only degrade or when no channel was recorded).
    let delivered = false;
    if (record.channelType && record.channelId) {
      const adapter = getChannelAdapter(record.channelType);
      // Per-channelType upload-size check at the DELIVERY site. A clip
      // over the channel's documented limit is NEVER silently dropped and is
      // NEVER routed through the media-compressor `compressAttachments` (which
      // would silently drop it). The limit is per-channelType
      // (resolveVideoSizeLimit), overridable via deps.maxVideoBytes. `oversized`
      // is only meaningful when the persisted size is known.
      const limit = resolveVideoSizeLimit(record.channelType, deps.maxVideoBytes);
      const oversized =
        persisted.value.sizeBytes !== undefined && persisted.value.sizeBytes > limit;
      if (adapter && typeof adapter.sendAttachment === "function" && oversized) {
        // Oversized-degrade: do NOT call sendAttachment. Send a link/notice
        // via sendMessage (a REQUIRED ChannelPort method on every adapter). The
        // clip IS persisted, so markDone still holds below (at-least-once parity
        // with the IRC branch). delivered stays false — the off-turn
        // video.delivered record carries the honest flag. The message builder owns
        // the link-vs-notice choice + the (never-`[Attachment too large]`) text.
        const degrade = buildOversizedDegradeMessage({
          channelType: record.channelType,
          sizeBytes: persisted.value.sizeBytes ?? 0,
          limit,
          filePath: persisted.value.filePath,
          ...(out.sourceUrl !== undefined ? { sourceUrl: out.sourceUrl } : {}),
        });
        const sendMessage = adapter.sendMessage.bind(adapter);
        const noticeResult = await sendMessage(record.channelId, degrade.text);
        // §2.7: a content-free INFO names the degrade (ids/labels/counts
        // only — never the bytes, a credential, or the keyed-download-URL). The
        // policy (link|notice) is recorded so the fleet lens can see it.
        logger.info(
          {
            traceId: record.traceId,
            jobId: record.jobId,
            agentId: record.agentId,
            channelType: record.channelType,
            sizeBytes: persisted.value.sizeBytes,
            limit,
            policy: degrade.policy,
            mediaPath: persisted.value.filePath,
            ...(noticeResult.ok ? {} : { sent: false }),
            hint:
              "Video exceeded the channel's upload limit; delivered a link/notice " +
              "with the saved workspace path instead of the attachment (never dropped).",
            step: "video_poll_oversized_degrade",
          },
          "Video poller: oversized clip degraded to a link/notice",
        );
        if (!noticeResult.ok) {
          // A failed degrade-message is logged at WARN (errorKind + hint), but the
          // row STILL markDone below — the clip is persisted (recoverable from the
          // workspace) and the at-least-once contract is "the clip exists", not
          // "the channel acknowledged". Re-driving would only re-send the notice.
          logger.warn(
            {
              traceId: record.traceId,
              jobId: record.jobId,
              channelType: record.channelType,
              // A channel send error can echo a token/URL — scrub it.
              ...redactErr(noticeResult.error),
              errorKind: "platform" as const,
              hint:
                "Oversized-degrade notice send failed; the clip is saved to the " +
                "workspace (recoverable). The job is still marked done — re-driving " +
                "would only re-send the notice.",
              step: "video_poll_oversized_degrade",
            },
            "Video poller: oversized-degrade notice send failed",
          );
        }
        // delivered stays false (a degrade is not an attachment delivery).
      } else if (adapter && typeof adapter.sendAttachment === "function") {
        const sendAttachment = adapter.sendAttachment.bind(adapter);
        const sendResult = await sendAttachment(record.channelId, {
          type: "video",
          url: persisted.value.filePath,
          mimeType,
          fileName: `generated-video${ext}`,
          ...(out.durationSecs !== undefined ? { durationSecs: out.durationSecs } : {}),
        });
        if (!sendResult.ok) {
          // Bound the redelivery. Do NOT markDone; either
          // stay pending (bounded retry) or dead-letter to `failed`.
          await handleDeliveryFailure(record, sendResult.error);
          return;
        }
        delivered = true;
      } else {
        // IRC degrade: the adapter cannot attach. The clip IS persisted,
        // so the at-least-once contract still marks done. Logged as a notice,
        // never a throw.
        logger.info(
          { traceId: record.traceId, jobId: record.jobId, channelType: record.channelType, mediaPath: persisted.value.filePath, step: "video_poll_deliver_skipped", hint: "Channel cannot attach media (no sendAttachment); the clip is saved to the agent workspace" },
          "Video poller: channel cannot attach; persisted-only",
        );
      }
    }

    // markDone LAST — AFTER delivery (at-least-once). A crash
    // between the send above and this write yields ONE bounded restart-duplicate
    // (accepted) — never infinite redelivery (markDone flips the row
    // out of `pending`).
    const done = await store.markDone(record.jobId, {
      mediaPath: persisted.value.filePath,
      ...(out.costUsd !== undefined ? { actualCostUsd: out.costUsd } : {}),
    });
    if (!done.ok) {
      logger.warn(
        { traceId: record.traceId, jobId: record.jobId, ...redactErr(done.error), errorKind: "internal" as const, hint: "Delivered but markDone failed; the row stays pending and a later sweep may re-deliver once (bounded duplicate)", step: "video_poll_markdone" },
        "Video poller: markDone failed after delivery",
      );
      return;
    }

    // Reconcile to the ACTUAL cost — recorded EXACTLY ONCE, here, only on
    // the terminal successful delivery. markDone flipped the row out
    // of `pending`, so a retried completeJob can never reach this line twice for
    // one render → no phantom per-hour USD inflation.
    const reconciledCostUsd = out.costUsd ?? record.estimatedCostUsd ?? 0;
    costLimiter?.record(record.agentId, reconciledCostUsd);

    // The off-turn synthetic `observability:token_usage` cost
    // route (the SAME route images use in image-handlers.ts) — emitted RIGHT
    // AFTER the reconcile, EXACTLY ONCE per render (markDone already flipped the
    // row out of pending → can't repeat), gated `> 0`. Routing is read
    // from the persisted ROW not ALS (no off-turn ALS frame); 0
    // tokens (subscribers SUM cost.total, the token-tracker guards `> 0`);
    // FAL/Veo `?? estimate` (no per-call actual) so the rollup + the reconstruction agree.
    if (deps.eventBus && reconciledCostUsd > 0) {
      deps.eventBus.emit("observability:token_usage", {
        timestamp: systemNowMs(),
        traceId: record.traceId ?? "",
        agentId: record.agentId,
        channelId: record.channelId ?? "",
        executionId: "",
        provider: out.provider ?? record.provider,
        model: out.model ?? record.model ?? "",
        tokens: { prompt: 0, completion: 0, total: 0 },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: reconciledCostUsd },
        latencyMs: nowMs() - startMs,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        sessionKey: record.sessionKey ?? "",
        savedVsUncached: 0,
        cacheEligible: false,
        warmupTurn: false,
        pendingCacheInvestmentUsd: 0,
      });
    }

    // BEST-EFFORT off-turn live emit — video.generated (the
    // cost-carry: costUsd ?? estimate, FAL has no actual) THEN
    // video.delivered. Resolved by the ROW's sessionKey (off-turn, no ALS); a
    // no-op when the recorder is gone (the OFFLINE assembler is the
    // binding oracle). After markDone so it never fires for a non-terminal pass.
    emitTrajectory(record, "video.generated", {
      provider: record.provider,
      outcome: "ok",
      ...(out.model ?? record.model ? { model: out.model ?? record.model } : {}),
      ...((out.costUsd ?? record.estimatedCostUsd) !== undefined
        ? { costUsd: out.costUsd ?? record.estimatedCostUsd }
        : {}),
      ...(persisted.value.sizeBytes !== undefined ? { sizeBytes: persisted.value.sizeBytes } : {}),
      ...(out.durationSecs !== undefined ? { durationSecs: out.durationSecs } : {}),
    });
    if (record.channelType) {
      emitTrajectory(record, "video.delivered", { channelType: record.channelType, delivered });
    }

    // The INFO completion line with the FULL field set.
    // traceId is read from the row and put ON the object (the bg
    // ctx has no ALS frame). `costUsd` is the RECONCILED cost (actual ?? estimate)
    // so the completion line agrees with the cost rollup + the reconstruction
    // (FAL/Veo have no per-call actual). mimeType + durationSecs ride
    // it where derivable from the fetched `out`.
    logger.info(
      {
        traceId: record.traceId,
        jobId: record.jobId,
        agentId: record.agentId,
        videoProvider: record.provider,
        model: out.model ?? record.model,
        costUsd: reconciledCostUsd,
        sizeBytes: persisted.value.sizeBytes,
        mimeType,
        ...(out.durationSecs !== undefined ? { durationSecs: out.durationSecs } : {}),
        durationMs: nowMs() - startMs,
        step: "video_poll_complete",
      },
      "Video poller: render completed and delivered",
    );
  }

  /**
   * markFailed + a §2.7 WARN with errorKind + hint + the off-turn traceId.
   *
   * `classifiedHint` is the adapter's actionable hint when the failure was
   * classified at poll time; when present it is BOTH logged AND persisted
   * to `last_error` (so `video.status` returns the actionable string, not the bare
   * enum token). When absent, a generic kind-based hint is computed and persisted —
   * still actionable text, never the raw kind token. The hint never carries a
   * secret (the classifiers emit FIXED auth/quota/content strings).
   */
  async function markFailed(
    record: VideoJobRecord,
    kind: VideoErrorKind,
    cause?: Error,
    classifiedHint?: string,
  ): Promise<void> {
    const hint =
      classifiedHint ??
      (kind === "job_timeout"
        ? "The render exceeded integrations.media.videoGeneration.timeoutMs; raise it or retry."
        : "The provider returned no usable result; retry or adjust the prompt.");
    // Do NOT discard the store Result. A failed terminal write leaves the
    // row `pending`; the sweeper will retry it, but the redelivery bound
    // (deliver_attempts / maxDeliveryAttempts) is the backstop so even a
    // persistent markFailed-write failure converges. Log it at ERROR so the
    // stranded row is diagnosable from daemon.log by jobId/traceId. Persist
    // the actionable `hint` as last_error (not the bare `kind`).
    const failed = await store.markFailed(record.jobId, kind, hint);
    if (!failed.ok) {
      logger.error(
        {
          traceId: record.traceId,
          jobId: record.jobId,
          agentId: record.agentId,
          ...redactErr(failed.error),
          errorKind: "internal" as const,
          hint:
            "markFailed write failed; the row stays pending and a later sweep " +
            "retries (bounded by maxDeliveryAttempts). Check the SQLite db health.",
          step: "video_poll_markfailed",
        },
        "Video poller: markFailed store write failed",
      );
    }
    logger.warn(
      {
        traceId: record.traceId,
        jobId: record.jobId,
        agentId: record.agentId,
        videoProvider: record.provider,
        errorKind: VIDEO_ERR_TO_LOG[kind],
        videoErrorKind: kind,
        hint: sanitizeLogString(hint),
        // `cause` is the RAW provider error (fetchResult/delivery) whose
        // message can echo a key/bearer/the Veo keyed-download-URL — scrub it.
        ...(cause ? redactErr(cause) : {}),
        step: "video_poll_failed",
      },
      "Video poller: render failed",
    );
    // BEST-EFFORT off-turn live emit of video.failed beside
    // the WARN (trajectory-only — the WARN is the §2.7 line). The DOMAIN kind
    // rides the trajectory payload; the closed log union (VIDEO_ERR_TO_LOG) +
    // the hint/cause ride the WARN, never the trajectory. No-op when the recorder
    // is gone (the OFFLINE assembler is the binding oracle). No secret —
    // only the typed kind + the provider id.
    emitTrajectory(record, "video.failed", { errorKind: kind, provider: record.provider });
  }

  /**
   * The per-job loop: the SHIPPED `pollUntilDone` (REUSED, not re-authored).
   * On done → the completion tail; on failed/timeout → markFailed + WARN. The
   * jobId is ALWAYS removed from the in-flight set in the finally.
   */
  async function runJob(record: VideoJobRecord): Promise<void> {
    const startMs = nowMs();
    try {
      // Lost-update guard. The in-memory `inFlight` set dedups within this
      // process, but the sweeper rebuilds records from a `listPending()` SNAPSHOT,
      // so a row that was transitioned to terminal between the snapshot and now
      // (a racing completion, or — defensively — a second daemon on the shared db)
      // must not be re-fetched + re-delivered. Re-read the authoritative row
      // state: bail if it EXISTS and is no longer `pending`. A NOT-FOUND row
      // (`ok(undefined)`) is the handler's insert-failure in-memory job — proceed
      // and drive it from the in-memory `record`, never re-read again.
      const current = await store.get(record.jobId, record.agentId);
      if (current.ok && current.value && current.value.state !== "pending") {
        logger.debug(
          { traceId: record.traceId, jobId: record.jobId, state: current.value.state, step: "video_poll_terminal_skip" },
          "Video poller: job already terminal on re-read; skipping",
        );
        return;
      }
      if (stopped) return; // shutdown raced the re-read — do not deliver
      // Carry the adapter's classified errorKind+hint off the poll snapshot
      // (a Veo operation.error / Grok status:failed|expired classifies at poll time)
      // so a terminal failure is persisted/logged with its SPECIFIC kind, not the
      // generic empty_response. A failed poll Result (a thrown HTTP error) carries
      // neither — the generic classifyOutcome fallback then applies (FAL parity).
      const outcome = await pollUntilDone<PollSnapshot>({
        poll: () =>
          provider
            .poll({ jobId: record.jobId, provider: record.provider, model: record.model ?? "" })
            .then((r) =>
              r.ok
                ? {
                    state: r.value.state,
                    ...(r.value.errorKind !== undefined ? { errorKind: r.value.errorKind } : {}),
                    ...(r.value.hint !== undefined ? { hint: r.value.hint } : {}),
                  }
                : { state: "failed" },
            ),
        isDone: (s) => s.state === "done",
        isFailed: (s) => s.state === "failed",
        deadline: createPollDeadline(config.timeoutMs, nowMs),
        pollIntervalMs: config.pollIntervalMs,
        // A shutdown aborts the poll loop promptly (pollUntilDone returns
        // `timeout` on `signal.aborted`); the `stopped` guard below then bails
        // before any delivery.
        signal: shutdownAbort.signal,
        ...(sleep ? { sleep } : {}),
      });
      if (stopped) return; // shutdown raced the loop — do not deliver
      if (outcome.kind === "done") {
        await completeJob(record, startMs);
      } else if (outcome.kind === "failed" && outcome.status.errorKind !== undefined) {
        // The adapter classified this terminal failure — persist its
        // specific kind + actionable hint (not the generic empty_response).
        await markFailed(record, outcome.status.errorKind, undefined, outcome.status.hint);
      } else {
        await markFailed(record, classifyOutcome(outcome.kind));
      }
    } finally {
      inFlight.delete(record.jobId);
    }
  }

  /** Kick a per-job loop for a record, honoring the concurrency bound. */
  function startJob(record: VideoJobRecord): void {
    if (stopped) return;
    if (inFlight.has(record.jobId)) return; // already running
    if (maxConcurrent !== undefined && inFlight.size >= maxConcurrent) {
      // Leave the row pending; the sweeper re-discovers it when a slot frees.
      return;
    }
    inFlight.add(record.jobId);
    // Route the suppressed rejection through the Pino logger (off-turn, no
    // ALS frame), NOT console.debug — so a throw escaping runJob is reconstructable
    // from daemon.log / `comis fleet` / `comis explain` (§2.7).
    suppressError(runJob(record), "video poller per-job loop", (m) =>
      logger.debug({ step: "video_poll_suppressed" }, m),
    );
  }

  /**
   * `track(record)`: start the per-job loop DIRECTLY from the in-memory record
   * the handler already has (no `listPending()` scan, no dependence
   * on the row being observably `pending` at this instant). The handler calls this
   * on a successful submit; on an insert-FAILURE it still calls it so the rendered
   * clip is delivered in-memory rather than silently orphaned (the persisted-row
   * writes then no-op on the missing row, which is bounded — the sweeper never
   * re-discovers a non-existent row).
   */
  function track(record: VideoJobRecord): void {
    startJob(record);
  }

  /**
   * One sweeper pass: re-discover `pending` rows NOT in the in-flight set (a row
   * whose in-memory loop was lost — e.g. delivery failed, or it exceeded the
   * concurrency bound on `track`) and re-track them.
   */
  async function runOneSweep(): Promise<void> {
    if (stopped) return;
    const pending = await store.listPending();
    if (!pending.ok) return;
    for (const record of pending.value) {
      if (!inFlight.has(record.jobId)) startJob(record);
    }
  }

  /** Step 1 of the two-phase boot: reload pending + resume, then arm the sweeper. */
  async function startAndResume(): Promise<void> {
    // RESTART RESUME: runs UNCONDITIONALLY (a pending row from a prior
    // crash must resume regardless of policy).
    const pending = await store.listPending();
    if (!pending.ok) {
      logger.warn(
        { ...redactErr(pending.error), errorKind: "internal" as const, hint: "Could not load pending video jobs on boot; they resume on the next sweep", step: "video_poll_resume" },
        "Video poller: listPending failed on resume",
      );
    } else if (pending.value.length > 0) {
      // Transition-gated INFO — names the resumed count (never per-empty-tick).
      logger.info({ resumed: pending.value.length, step: "video_poll_resume" }, "Video poller: resumed pending jobs after restart");
      for (const record of pending.value) startJob(record);
    }

    // The low-frequency outer sweeper (single-tick re-entrancy gate + .unref()),
    // mirroring the delivery-queue drain loop.
    sweepInterval = timers.setInterval(() => {
      if (sweeping) return; // single-tick gate
      sweeping = runOneSweep().finally(() => {
        sweeping = null;
      });
      // Pino-route the suppressed sweep-tick rejection (off-turn).
      suppressError(sweeping, "video poller sweep tick", (m) =>
        logger.debug({ step: "video_poll_suppressed" }, m),
      );
    }, config.pollIntervalMs);
    sweepInterval.unref(); // NEVER keep the daemon alive for polling
  }

  function shutdown(): void {
    stopped = true;
    // Abort any in-flight poll loop + fetchResult download so a mid-render
    // job stops promptly on SIGTERM rather than landing a markDone/markFailed
    // write after db.close(). The `stopped` guard prevents a post-shutdown
    // delivery; the abort just makes the in-flight download return faster.
    shutdownAbort.abort();
    if (sweepInterval) {
      sweepInterval.cancel();
      sweepInterval = undefined;
    }
  }

  return { track, startAndResume, shutdown };
}
