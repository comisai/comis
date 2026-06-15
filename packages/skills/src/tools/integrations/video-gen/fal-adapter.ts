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
 * WR-01: hard fallback timeout for the result download when the caller threads
 * no AbortSignal (a standalone `fetchResult` from Phase 189's poller). The poll
 * loop deadline bounds `execute()`; this bounds a hung CDN on the download leg
 * so it cannot block past the operator-configured budget indefinitely.
 */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * WR-01: default streamed byte ceiling for the result download. The handler's
 * MediaPersistenceService rejects oversize POST-buffer; this rejects DURING the
 * download (a Content-Length pre-check + a streamed running total) so a hostile
 * /buggy CDN body cannot OOM the process before the persist cap is consulted.
 * 200 MB matches VIDEO_PERSIST_MAX_BYTES (main-helpers.ts).
 */
const DEFAULT_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;

/** Options bounding the result download (WR-01): caller-supplied abort signal
 *  and/or a byte cap. Threaded from `execute`'s runOpts; defaulted otherwise. */
export interface VideoFetchResultOpts {
  signal?: AbortSignal;
  maxBytes?: number;
}

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

    fetchResult(job: VideoGenJob, fetchOpts?: VideoFetchResultOpts): Promise<Result<VideoGenOutput, Error>> {
      return fromPromise(
        (async () => {
          const res = await fal.queue.result(endpoint, { requestId: job.jobId });
          const url = (res.data as { video?: { url?: string } }).video?.url;
          if (!url) {
            throw new Error("fal: COMPLETED with no video.url"); // -> empty_response (FAL-02)
          }
          const { buffer, contentType } = await downloadVideoBytes(url, fetchOpts);
          return {
            buffer,
            // WR-06: derive the MIME from the CDN content-type (or the URL
            // extension), falling back to mp4 — do NOT hard-code video/mp4 (a
            // webm/mov output would otherwise be mislabeled, and extForMime in
            // the handler would pick the wrong filename extension).
            mimeType: deriveVideoMime(contentType, url),
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

      // WR-01: thread the operator deadline's signal into the DOWNLOAD leg too
      // (not just the poll loop), so a hung CDN on fetchResult honors the same
      // budget the poll loop did.
      const fetched = await this.fetchResult(job, runOpts.signal ? { signal: runOpts.signal } : undefined);
      if (!fetched.ok) {
        return mapThrownToErr(fetched.error, {
          emptyResult: /no video\.url/.test(fetched.error.message),
        });
      }
      return fetched;
    },
  };
}

/**
 * WR-07 (trust boundary): `url` is the FAL queue-result `video.url` — a
 * PROVIDER-OWNED CDN URL, NOT the agent-supplied `image_url` input. The input
 * path is rigorously SSRF-guarded (the DNS-pinned `fetchImageBytesSsrfSafe`
 * resolver, Phase 185); this OUTPUT download trusts the provider CDN, so it does
 * NOT re-run the SSRF resolver. That is a DELIBERATE trust decision, not an
 * oversight. We still harden it: `redirect:"error"` (never silently follow a CDN
 * open-redirect to an internal IP), a bounded signal (CR-01/WR-01), and a
 * streamed byte cap. Phase 190's Veo/Grok adapters each fetch their own provider
 * URL — they should follow this same bounded-download shape.
 *
 * @returns the downloaded bytes plus the CDN `content-type` (for WR-06 MIME).
 * @throws on a non-2xx status (CR-01), an empty body, an over-cap body (WR-01),
 *   or an aborted signal — all caught by `fromPromise` at the call site and
 *   classified by `classifyFalVideoError` into a typed `VideoGenError`.
 */
async function downloadVideoBytes(
  url: string,
  opts?: VideoFetchResultOpts,
): Promise<{ buffer: Buffer; contentType: string | null }> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
  // WR-01: honor the caller's deadline signal; else a hard fallback timeout so a
  // hung CDN cannot block forever.
  const signal = opts?.signal ?? AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const response = await fetch(url, { redirect: "error", signal });

  // CR-01: reject a non-2xx status BEFORE reading the body. An expired/4xx/5xx
  // FAL CDN URL resolves with `ok:false` and `arrayBuffer()` returns the ERROR
  // body (an HTML/JSON 403 page, or empty) — without this guard that garbage
  // flows out as a "successful" mp4 and is persisted + delivered as success
  // (the exact orphan-on-expiry class DEL-01 claims to close).
  if (!response.ok) {
    throw new Error(`fal: failed to download video.url: HTTP ${response.status}`);
  }

  // WR-01: Content-Length pre-check — abort before buffering if the server
  // DECLARES a body over the cap (an OOM guard; mirrors ssrf-image-fetch.ts).
  const declared = parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`fal: video.url body exceeds the ${maxBytes}-byte cap (declared ${declared})`);
  }

  // WR-01: stream with a running byte cap when a body reader is available (the
  // server may under-declare/omit length); fall back to arrayBuffer otherwise.
  const reader = response.body?.getReader?.();
  let buffer: Buffer;
  if (reader) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`fal: video.url body exceeds the ${maxBytes}-byte cap`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    buffer = Buffer.concat(chunks);
  } else {
    buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error(`fal: video.url body exceeds the ${maxBytes}-byte cap`);
    }
  }

  if (buffer.byteLength === 0) {
    throw new Error("fal: video.url returned an empty body");
  }
  return { buffer, contentType: response.headers.get("content-type") };
}

/** Known video MIME types for the URL-extension fallback (WR-06). */
const VIDEO_EXT_MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

/**
 * WR-06: derive the output MIME from the CDN `content-type` header when it is a
 * `video/*` type, else from the URL path extension, else fall back to mp4. A
 * non-video content-type (e.g. `application/octet-stream`) is ignored in favor
 * of the extension/default so a generic CDN type does not mislabel the bytes.
 */
function deriveVideoMime(contentType: string | null, url: string): string {
  const ct = contentType?.split(";")[0]?.trim().toLowerCase();
  if (ct && ct.startsWith("video/")) return ct;
  try {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase();
    if (ext && VIDEO_EXT_MIME[ext]) return VIDEO_EXT_MIME[ext];
  } catch {
    // Malformed URL — fall through to the default.
  }
  return "video/mp4";
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
