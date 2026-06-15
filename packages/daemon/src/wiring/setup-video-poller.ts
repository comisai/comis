// SPDX-License-Identifier: Apache-2.0
/**
 * Background video poller (Phase 189 / Plan 02 — JOB-02 / JOB-03, the
 * milestone's durability keystone).
 *
 * This is the two-phase crash-safe delivery queue (`setup-delivery.ts`
 * `setupDeliveryQueue`) RETYPED for an EXTERNAL-provider poll. A long video
 * render (30 s–5 min) outlives the originating agent turn AND a daemon restart;
 * the poller completes it independently and announces the finished clip to the
 * RECORDED channel.
 *
 * LIFECYCLE (the two-phase contract, mirroring the delivery queue):
 *   1. `createVideoPoller(...)` returns `{ track, startAndResume, shutdown }`
 *      IMMEDIATELY — before `setupChannels` exists. `track(job)` may be called
 *      from the handler once a job is submitted.
 *   2. `startAndResume()` is called AFTER `setupChannels` populates the channel
 *      registry (so `sendAttachment` works outside a turn): it reloads
 *      `store.listPending()` and resumes each, then arms the low-frequency outer
 *      sweeper (single-tick gate + `.unref()`).
 *   3. `shutdown()` clears the sweeper interval + stops in-flight per-job loops.
 *
 * THE PER-JOB POLL IS THE SHIPPED `pollUntilDone` (I5) — `@comis/core` authored
 * it in 188 EXPRESSLY for this reuse; this file does NOT re-author a second loop
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
 *      from the persisted job row and put ON every log object (I8 / Pitfall 5).
 *   4. at-least-once announce: `markDone` is the LAST step — AFTER delivery — so
 *      a `pending` row on restart re-runs poll→fetch→deliver→markDone. A crash
 *      AFTER deliver but BEFORE the `markDone` write yields ONE bounded duplicate
 *      (T-189-08, accepted: announce-on-complete is "deliver the clip", not
 *      exactly-once).
 *
 * SECURITY: delivery targets ONLY the recorded `channelType`/`channelId`/`agentId`
 * from the job row (T-189-06 — never a silent default, never another agent's
 * channel). The off-turn log lines carry `{ traceId, jobId, errorKind, hint,
 * costUsd }` only — never a key/token (T-189-05; the boot-bound adapter holds the
 * credential, the poller never re-reads it).
 *
 * @module
 */

import {
  systemNowMs,
  systemSetInterval,
  systemClearInterval,
  createPollDeadline,
  pollUntilDone,
  VIDEO_ERR_TO_LOG,
  type VideoGenJob,
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

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** The two-phase background poller (mirrors `DeliveryQueueResult`). */
export interface VideoPoller {
  /** Hand a freshly-submitted job to the poller (the row was already inserted). */
  track(job: VideoGenJob): void;
  /**
   * RESTART RESUME (JOB-03): reload `listPending()` + resume each, then arm the
   * outer sweeper. Call AFTER `setupChannels` (the channel registry is now
   * populated so `sendAttachment` reaches a live adapter outside a turn).
   */
  startAndResume(): Promise<void>;
  /** Clear the sweeper interval + stop in-flight per-job loops (call on shutdown). */
  shutdown(): void;
}

/** Persist getter — the per-agent `persistVideo` from the bundle (DEL-01). */
type PersistVideo = (
  agentId: string,
  buffer: Buffer,
  opts: { mediaKind: "video"; mimeType: string },
) => Promise<import("@comis/shared").Result<PersistedFile, Error>>;

export interface VideoPollerDeps {
  store: VideoJobStore;
  provider: VideoGenerationPort;
  /** DEL-01: per-agent persist getter (videos/). */
  persist: PersistVideo;
  /** SEC-02 reconcile: record the actual cost on done. Optional (count-only). */
  costLimiter?: { record(agentId: string, cost: number): void };
  /** The announce path — resolve a channel adapter by type (live reference). */
  getChannelAdapter: (channelType: string) => Pick<ChannelPort, "sendAttachment"> | undefined;
  config: VideoGenerationConfig;
  logger: ComisLogger;
  /** Injectable timer for the outer sweeper (default: a `systemSetInterval`
   *  adapter). Tests pass `createFakeTimers()` to assert `.unref()` + advance. */
  timers?: TimerPort;
  /** Injectable per-job poll sleep (default: the `pollUntilDone` system sleep). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for the per-job deadline (default: `systemNowMs`). */
  nowMs?: () => number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** A `.mp4` default; the buffer is the durable artifact regardless. */
function extForMime(mimeType: string): string {
  if (mimeType === "video/webm") return ".webm";
  if (mimeType === "video/quicktime") return ".mov";
  return ".mp4";
}

/**
 * Default TimerPort over the sanctioned `systemSetInterval`/`systemClearInterval`
 * (the daemon composition root is a sanctioned globals-gate root). Used when no
 * `TimerPort` is injected. Only `setInterval` is exercised by the poller; the
 * `setTimeout` member is provided for interface completeness.
 */
function defaultTimerPort(): TimerPort {
  const wrap = (h: ReturnType<typeof setInterval>): TimerHandle => {
    let cancelled = false;
    return {
      get cancelled() {
        return cancelled;
      },
      cancel() {
        if (cancelled) return;
        cancelled = true;
        systemClearInterval(h);
      },
      unref() {
        h.unref();
      },
    };
  };
  return {
    setInterval: (cb, ms) => wrap(systemSetInterval(cb, ms)),
    setTimeout: (cb, ms) => wrap(systemSetInterval(cb, ms)), // unused by the poller
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createVideoPoller(deps: VideoPollerDeps): VideoPoller {
  const { store, provider, persist, costLimiter, getChannelAdapter, config, logger } = deps;
  const timers = deps.timers ?? defaultTimerPort();
  const sleep = deps.sleep;
  const nowMs = deps.nowMs ?? systemNowMs;

  // In-flight jobIds (bounded by config.maxConcurrentJobs when set). A row that
  // would exceed the bound is left `pending` for the sweeper to pick up later.
  const inFlight = new Set<string>();
  const maxConcurrent =
    typeof config.maxConcurrentJobs === "number" && config.maxConcurrentJobs > 0
      ? config.maxConcurrentJobs
      : undefined;

  let sweepInterval: TimerHandle | undefined;
  let sweeping: Promise<void> | null = null;
  let stopped = false;

  /** Map a `pollUntilDone` failed/timeout outcome to a domain errorKind. */
  function classifyOutcome(kind: "failed" | "timeout"): VideoErrorKind {
    return kind === "timeout" ? "job_timeout" : "empty_response";
  }

  /**
   * Resolve the durable routing for a job from its persisted row. The poller
   * delivers ONLY to the recorded channel/agent (T-189-06). `listPending()` is
   * the agent-agnostic scan (the store's `get` requires an agentId we don't have
   * at `track` time); a freshly-inserted row is `pending`, so it is present.
   */
  async function loadRecord(jobId: string): Promise<VideoJobRecord | undefined> {
    const pending = await store.listPending();
    if (!pending.ok) {
      logger.warn(
        { jobId, err: pending.error, errorKind: "internal" as const, hint: "Could not load pending video jobs; the row may resume on the next sweep", step: "video_poll_load" },
        "Video poller: listPending failed",
      );
      return undefined;
    }
    return pending.value.find((r) => r.jobId === jobId);
  }

  /** The completion tail (moved verbatim from the 188 handler :306-394). */
  async function completeJob(record: VideoJobRecord, startMs: number): Promise<void> {
    const fetched = await provider.fetchResult(
      { jobId: record.jobId, provider: record.provider, model: record.model ?? "" },
      { signal: undefined },
    );
    if (!fetched.ok) {
      await markFailed(record, "empty_response", fetched.error);
      return;
    }
    const out = fetched.value;
    const mimeType = out.mimeType;
    const ext = extForMime(mimeType);

    // SEC-02 reconcile to the ACTUAL cost (never under-account).
    costLimiter?.record(record.agentId, out.costUsd ?? record.estimatedCostUsd ?? 0);

    // DEL-01 persist BEFORE any delivery decision (the fetch already happened).
    const persisted = await persist(record.agentId, out.buffer, { mediaKind: "video", mimeType });
    if (!persisted.ok) {
      logger.warn(
        { traceId: record.traceId, jobId: record.jobId, agentId: record.agentId, err: persisted.error, errorKind: "resource" as const, hint: "Video rendered but persistence failed; the job is marked failed (no durable artifact to announce)", step: "video_poll_persist" },
        "Video poller: persistence failed",
      );
      await markFailed(record, "empty_response");
      return;
    }

    // DEL-02 capability-gated direct delivery to the RECORDED channel only
    // (T-189-06; never a channel-name list — sendAttachment is optional on
    // ChannelPort, omitted by IRC). MUST-DIFFER 2: the attachment send, not text.
    if (record.channelType && record.channelId) {
      const adapter = getChannelAdapter(record.channelType);
      if (adapter && typeof adapter.sendAttachment === "function") {
        const sendAttachment = adapter.sendAttachment.bind(adapter);
        const sendResult = await sendAttachment(record.channelId, {
          type: "video",
          url: persisted.value.filePath,
          mimeType,
          fileName: `generated-video${ext}`,
          ...(out.durationSecs !== undefined ? { durationSecs: out.durationSecs } : {}),
        });
        if (!sendResult.ok) {
          // Delivery failed — leave the row pending so a later sweep re-delivers
          // (at-least-once). Do NOT markDone (MUST-DIFFER 4).
          logger.warn(
            { traceId: record.traceId, jobId: record.jobId, channelType: record.channelType, err: sendResult.error, errorKind: "network" as const, hint: "Video persisted but channel delivery failed; the job stays pending and the next sweep retries", step: "video_poll_deliver" },
            "Video poller: channel delivery failed (will retry)",
          );
          return;
        }
      } else {
        // DEL-02 IRC degrade: the adapter cannot attach. The clip IS persisted,
        // so the at-least-once contract still marks done (parity with the 188
        // handler's IRC branch). Logged as a notice, never a throw.
        logger.info(
          { traceId: record.traceId, jobId: record.jobId, channelType: record.channelType, mediaPath: persisted.value.filePath, step: "video_poll_deliver_skipped", hint: "Channel cannot attach media (no sendAttachment); the clip is saved to the agent workspace" },
          "Video poller: channel cannot attach; persisted-only",
        );
      }
    }

    // MUST-DIFFER 4: markDone LAST — AFTER delivery (at-least-once A2). A crash
    // between the send above and this write yields ONE bounded restart-duplicate
    // (T-189-08, accepted) — never infinite redelivery (markDone flips the row
    // out of `pending`).
    const done = await store.markDone(record.jobId, {
      mediaPath: persisted.value.filePath,
      ...(out.costUsd !== undefined ? { actualCostUsd: out.costUsd } : {}),
    });
    if (!done.ok) {
      logger.warn(
        { traceId: record.traceId, jobId: record.jobId, err: done.error, errorKind: "internal" as const, hint: "Delivered but markDone failed; the row stays pending and a later sweep may re-deliver once (bounded duplicate)", step: "video_poll_markdone" },
        "Video poller: markDone failed after delivery",
      );
      return;
    }

    // I8 obs floor: the INFO completion line. MUST-DIFFER 3 — traceId is read
    // from the row and put ON the object (the bg ctx has no ALS frame).
    logger.info(
      {
        traceId: record.traceId,
        jobId: record.jobId,
        agentId: record.agentId,
        videoProvider: record.provider,
        model: out.model ?? record.model,
        costUsd: out.costUsd,
        sizeBytes: persisted.value.sizeBytes,
        durationMs: nowMs() - startMs,
        step: "video_poll_complete",
      },
      "Video poller: render completed and delivered",
    );
  }

  /** markFailed + a §2.7 WARN with errorKind + hint + the off-turn traceId. */
  async function markFailed(record: VideoJobRecord, kind: VideoErrorKind, cause?: Error): Promise<void> {
    await store.markFailed(record.jobId, kind);
    const hint =
      kind === "job_timeout"
        ? "The render exceeded integrations.media.videoGeneration.timeoutMs; raise it or retry."
        : "The provider returned no usable result; retry or adjust the prompt.";
    logger.warn(
      {
        traceId: record.traceId,
        jobId: record.jobId,
        agentId: record.agentId,
        videoProvider: record.provider,
        errorKind: VIDEO_ERR_TO_LOG[kind],
        videoErrorKind: kind,
        hint,
        ...(cause ? { err: cause } : {}),
        step: "video_poll_failed",
      },
      "Video poller: render failed",
    );
  }

  /**
   * The per-job loop: the SHIPPED `pollUntilDone` (I5 — REUSED, not re-authored).
   * On done → the completion tail; on failed/timeout → markFailed + WARN. The
   * jobId is ALWAYS removed from the in-flight set in the finally.
   */
  async function runJob(record: VideoJobRecord): Promise<void> {
    const startMs = nowMs();
    try {
      const outcome = await pollUntilDone<{ state: string }>({
        poll: () =>
          provider
            .poll({ jobId: record.jobId, provider: record.provider, model: record.model ?? "" })
            .then((r) => (r.ok ? { state: r.value.state } : { state: "failed" })),
        isDone: (s) => s.state === "done",
        isFailed: (s) => s.state === "failed",
        deadline: createPollDeadline(config.timeoutMs, nowMs),
        pollIntervalMs: config.pollIntervalMs,
        ...(sleep ? { sleep } : {}),
      });
      if (stopped) return; // shutdown raced the loop — do not deliver
      if (outcome.kind === "done") {
        await completeJob(record, startMs);
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
    suppressError(runJob(record), "video poller per-job loop");
  }

  /** `track(job)`: resolve the freshly-inserted row, then start its loop. */
  function track(job: VideoGenJob): void {
    suppressError(
      loadRecord(job.jobId).then((record) => {
        if (record) startJob(record);
      }),
      "video poller track",
    );
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
    // RESTART RESUME (JOB-03): runs UNCONDITIONALLY (a pending row from a prior
    // crash must resume regardless of policy).
    const pending = await store.listPending();
    if (!pending.ok) {
      logger.warn(
        { err: pending.error, errorKind: "internal" as const, hint: "Could not load pending video jobs on boot; they resume on the next sweep", step: "video_poll_resume" },
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
      suppressError(sweeping, "video poller sweep tick");
    }, config.pollIntervalMs);
    sweepInterval.unref(); // NEVER keep the daemon alive for polling
  }

  function shutdown(): void {
    stopped = true;
    if (sweepInterval) {
      sweepInterval.cancel();
      sweepInterval = undefined;
    }
  }

  return { track, startAndResume, shutdown };
}
