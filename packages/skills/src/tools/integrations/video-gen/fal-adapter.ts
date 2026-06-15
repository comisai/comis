// SPDX-License-Identifier: Apache-2.0
// @allow-throw: integration/SDK boundary wrapper; throws caught by fromPromise at the consumer site.
/**
 * FAL queue-API video adapter (DIVERGENCE 1).
 *
 * Unlike the image FAL adapter (which uses the blocking subscribe wrapper),
 * this adapter uses the EXPLICIT `fal.queue.submit/status/result` calls so it
 * captures the durable opaque `request_id` (VPORT-03) that Phase 189's
 * restart-surviving background poller needs. The blocking subscribe wrapper is
 * deliberately NOT used here (it hides the request_id — DIVERGENCE 1).
 *
 * Failure model (RESEARCH Pitfall 2): the FAL status union has only IN_QUEUE /
 * IN_PROGRESS / COMPLETED — there is no "FAILED" status. A failure is a THROWN
 * error from `status()` / `result()` (HTTP 4xx/5xx), or a COMPLETED-with-no-url.
 * `classifyFalVideoError` maps those onto the domain `VideoErrorKind`; ONLY the
 * bounded `pollUntilDone` deadline yields `job_timeout`.
 *
 * @module
 */
import type {
  VideoGenerationPort,
  VideoGenInput,
  VideoGenJob,
  VideoJobStatus,
  VideoGenOutput,
} from "@comis/core";
import { VideoGenError, createPollDeadline, pollUntilDone } from "@comis/core";
import type { Result } from "@comis/shared";
import { err, fromPromise } from "@comis/shared";
import { fal } from "@fal-ai/client";
import { classifyFalVideoError } from "./classify-fal-video-error.js";

/** Default FAL video endpoint (re-verified 2026-06-15; drifts ~monthly). */
const DEFAULT_VIDEO_ENDPOINT = "fal-ai/veo3.1/fast";

/**
 * Create a FAL video-generation adapter over the queue API.
 *
 * @param opts - API key (passed ONLY to `fal.config`, never into a job/output)
 *               and an optional endpoint/model override.
 */
export function createFalVideoAdapter(opts: { apiKey: string; model?: string }): VideoGenerationPort {
  fal.config({ credentials: opts.apiKey });
  const endpoint = opts.model ?? DEFAULT_VIDEO_ENDPOINT;

  return {
    id: "fal",
    isAvailable: () => true,

    submit(input: VideoGenInput): Promise<Result<VideoGenJob, Error>> {
      return fromPromise(
        (async () => {
          const submitted = await fal.queue.submit(endpoint, { input: buildFalInput(input) });
          const job: VideoGenJob = {
            jobId: submitted.request_id, // opaque, secret-free, stable across poll() (VPORT-03)
            provider: "fal",
            model: endpoint,
          };
          return job;
        })(),
      );
    },

    poll(job: VideoGenJob): Promise<Result<VideoJobStatus, Error>> {
      return fromPromise(
        (async () => {
          const st = await fal.queue.status(endpoint, { requestId: job.jobId });
          const state: VideoJobStatus["state"] = st.status === "COMPLETED" ? "done" : "pending";
          return { jobId: job.jobId, state } satisfies VideoJobStatus;
        })(),
      );
    },

    fetchResult(job: VideoGenJob): Promise<Result<VideoGenOutput, Error>> {
      return fromPromise(
        (async () => {
          const res = await fal.queue.result(endpoint, { requestId: job.jobId });
          const url = (res.data as { video?: { url?: string } }).video?.url;
          if (!url) {
            throw new Error("fal: COMPLETED with no video.url"); // -> empty_response (FAL-02)
          }
          const response = await fetch(url);
          const buffer = Buffer.from(await response.arrayBuffer());
          return {
            buffer,
            mimeType: "video/mp4",
            sourceUrl: url,
            model: endpoint,
            provider: "fal",
          } satisfies VideoGenOutput;
        })(),
      );
    },

    async execute(
      input: VideoGenInput,
      runOpts: { timeoutMs: number; pollIntervalMs: number; signal?: AbortSignal },
    ): Promise<Result<VideoGenOutput, Error>> {
      const submitted = await this.submit(input);
      if (!submitted.ok) return mapThrownToErr(submitted.error);
      const job = submitted.value;

      const deadline = createPollDeadline(runOpts.timeoutMs);
      let lastErr: Error | undefined;
      const outcome = await pollUntilDone<VideoJobStatus>({
        poll: async () => {
          const p = await this.poll(job);
          if (!p.ok) {
            // A thrown HTTP error from status() is the failure branch (there is
            // no FAILED status) — capture it for classification, then signal
            // `failed` so the loop short-circuits (VPORT-02).
            lastErr = p.error;
            return { jobId: job.jobId, state: "failed" };
          }
          return p.value;
        },
        isDone: (s) => s.state === "done",
        isFailed: (s) => s.state === "failed",
        deadline,
        pollIntervalMs: runOpts.pollIntervalMs,
        signal: runOpts.signal,
      });

      if (outcome.kind === "timeout") {
        const hint = `Video render exceeded ${runOpts.timeoutMs}ms (jobId=${job.jobId}).`;
        return err(new VideoGenError(hint, { videoErrorKind: "job_timeout", hint }));
      }
      if (outcome.kind === "failed") {
        return mapThrownToErr(lastErr ?? new Error("fal: job failed"));
      }

      const fetched = await this.fetchResult(job);
      if (!fetched.ok) {
        return mapThrownToErr(fetched.error, {
          emptyResult: /no video\.url/.test(fetched.error.message),
        });
      }
      return fetched;
    },
  };
}

/** Map a thrown error to a typed `VideoGenError` Result via `classifyFalVideoError`. */
function mapThrownToErr(error: Error, opts?: { emptyResult?: boolean }): Result<VideoGenOutput, Error> {
  const c = classifyFalVideoError(error, opts);
  return err(new VideoGenError(c.hint, c));
}

/**
 * Map a normalized `VideoGenInput` to the FAL request input. Baseline pass-through;
 * per-model duration wire-encoding is refined in Phase 191.
 */
function buildFalInput(input: VideoGenInput): Record<string, unknown> {
  return {
    prompt: input.prompt,
    ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
    ...(input.durationSecs ? { duration: `${input.durationSecs}s` } : {}),
    ...(input.resolution ? { resolution: input.resolution } : {}),
    ...(input.audio !== undefined ? { generate_audio: input.audio } : {}),
    ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  };
}
