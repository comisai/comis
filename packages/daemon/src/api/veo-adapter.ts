// SPDX-License-Identifier: Apache-2.0
// @allow-throw: integration/SDK boundary wrapper; throws caught by fromPromise at the port boundary.
/**
 * Google Veo video adapter (VEO-01 / VEO-02).
 *
 * A `VideoGenerationPort` over `@google/genai@1.52.0`. Unlike the FAL adapter
 * (a queue API), Veo is an SDK LONG-RUNNING OPERATION (LRO):
 *   - submit:  `ai.models.generateVideos({ model, prompt, config })` → an
 *              operation whose `.name` is the durable, secret-free jobId
 *              (VPORT-03) — DIFFERS from FAL's queue `request_id`.
 *   - poll:    `ai.operations.getVideosOperation({ operation: { name } })` →
 *              `.done` + `.error`; `!done ? pending : (error ? failed : done)`.
 *   - fetch:   `op.response.generatedVideos[0].video` → either inline base64
 *              `videoBytes` (no fetch) or a 2-day-expiry `uri` fetched WITH the
 *              Dev-API `&key=` query param → a Buffer (DEL-01: download BEFORE
 *              return so the expiring URI can never orphan the job).
 *
 * PLACEMENT: this adapter lives in `@comis/daemon/src/api/` (NOT `@comis/skills`,
 * where `fal-adapter.ts` lives) because `@google/genai` is a DAEMON dep, not a
 * skills dep — building it in skills would be a phantom-dep / cycles violation
 * (matching the codex/google-images precedent). The three bounded-download
 * helpers are COPIED from `fal-adapter.ts` (private there) rather than imported,
 * to avoid a skills→daemon import edge (the FAL file's comment directs this).
 *
 * COST (A4): `GenerateVideosResponse` has NO usage/cost field — Veo's actual
 * cost is the pre-submit estimate (rate × duration). The adapter therefore does
 * NOT populate `costUsd`; the handler's `estimateVideoCostUsd` is the actual.
 *
 * SECURITY: the `apiKey` flows ONLY into `new GoogleGenAI({ apiKey })` and the
 * `&key=` download URL — NEVER to a logger. The keyed URL is never logged;
 * `deriveVideoMime` reads the UN-keyed `video.uri`. The jobId is `op.name`
 * (opaque, no credential — safe to log).
 *
 * @module
 */
import { GoogleGenAI } from "@google/genai";
import type { GenerateVideosConfig, GenerateVideosOperation } from "@google/genai";
import type {
  VideoGenerationPort,
  VideoGenInput,
  VideoGenJob,
  VideoJobStatus,
  VideoGenOutput,
} from "@comis/core";
import { VideoGenError, createPollDeadline, pollUntilDone } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { Result } from "@comis/shared";
import { err, fromPromise, ok } from "@comis/shared";
import { classifyVeoVideoError } from "./classify-veo-video-error.js";

/**
 * Default Veo model — the GA `-001` id (re-verified 2026-06-15; drifts ~monthly).
 * LOCK: a `-preview` id is config-only, never the default. Veo 3.x GA generates
 * audio by default.
 */
const DEFAULT_VEO_MODEL = "veo-3.0-fast-generate-001";

/**
 * WR-01: hard fallback timeout for the result download when the caller threads no
 * AbortSignal (a standalone `fetchResult` from Phase 189's poller). Bounds a hung
 * CDN on the download leg. Copied from fal-adapter.ts.
 */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * WR-01: default streamed byte ceiling for the result download (a Content-Length
 * pre-check + a streamed running total → OOM guard). 200 MB matches
 * VIDEO_PERSIST_MAX_BYTES. Copied from fal-adapter.ts.
 */
const DEFAULT_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;

/** Options bounding the result download (WR-01). Copied from fal-adapter.ts. */
export interface VideoFetchResultOpts {
  signal?: AbortSignal;
  maxBytes?: number;
}

/**
 * Create a Google Veo video-generation adapter over `@google/genai`.
 *
 * @param opts - `apiKey` (passed ONLY to `new GoogleGenAI` + the `&key=` download
 *               URL, never logged), an optional `model` override, and an optional
 *               logger (used for `{ model, jobId, step }` shapes only).
 */
export function createVeoVideoAdapter(opts: {
  apiKey: string;
  model?: string;
  logger?: ComisLogger;
}): VideoGenerationPort {
  // SEC: apiKey → SDK only (the google-images-transport.ts:88 idiom), never logged.
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const model = opts.model ?? DEFAULT_VEO_MODEL;

  /** Re-poll the operation by name to obtain its current state/response. Both
   *  poll() and fetchResult() use this (the 189 poller calls them with only the
   *  persisted { jobId }, so the operation handle is reconstructed from the name —
   *  the SDK reads `.name`). */
  const getOperation = (jobId: string): Promise<GenerateVideosOperation> =>
    ai.operations.getVideosOperation({ operation: { name: jobId } as GenerateVideosOperation });

  return {
    id: "veo",
    isAvailable: () => true,

    submit(input: VideoGenInput): Promise<Result<VideoGenJob, Error>> {
      return fromPromise(
        (async () => {
          const op = await ai.models.generateVideos({
            model,
            prompt: input.prompt,
            config: buildVeoConfig(input),
          });
          if (!op.name) {
            throw new Error("veo: generateVideos returned no operation name");
          }
          const job: VideoGenJob = {
            jobId: op.name, // op.name is the durable, secret-free jobId (VPORT-03)
            provider: "veo",
            model,
          };
          opts.logger?.debug({ model, jobId: job.jobId, step: "video.submit" }, "veo: submitted render");
          return job;
        })(),
      );
    },

    poll(job: VideoGenJob): Promise<Result<VideoJobStatus, Error>> {
      return fromPromise(
        (async () => {
          const cur = await getOperation(job.jobId);
          const state: VideoJobStatus["state"] = !cur.done ? "pending" : cur.error ? "failed" : "done";
          return { jobId: job.jobId, state } satisfies VideoJobStatus;
        })(),
      );
    },

    fetchResult(job: VideoGenJob, fetchOpts?: VideoFetchResultOpts): Promise<Result<VideoGenOutput, Error>> {
      return fromPromise(
        (async () => {
          // Re-poll: the operation is the source of the download uri/bytes.
          const cur = await getOperation(job.jobId);
          if (cur.error) {
            const c = classifyVeoVideoError(cur.error);
            throw new VideoGenError(c.hint, c); // -> classified failure
          }
          const video = cur.response?.generatedVideos?.[0]?.video;
          if (!video) {
            const c = classifyVeoVideoError(null, { emptyResult: true });
            throw new VideoGenError(c.hint, c); // -> empty_response
          }

          let buffer: Buffer;
          let mimeType: string;
          if (video.videoBytes) {
            // Inline base64 — no fetch (Pitfall 2).
            buffer = Buffer.from(video.videoBytes, "base64");
            mimeType = video.mimeType ?? "video/mp4";
          } else if (video.uri) {
            // Dev API requires the key as a query param (A5). SEC: this keyed URL
            // is NEVER logged. deriveVideoMime reads the UN-keyed video.uri.
            const url = `${video.uri}&key=${opts.apiKey}`;
            const { buffer: dl, contentType } = await downloadVideoBytes(url, fetchOpts);
            buffer = dl;
            mimeType = deriveVideoMime(contentType, video.uri);
          } else {
            const c = classifyVeoVideoError(null, { emptyResult: true });
            throw new VideoGenError(c.hint, c);
          }

          opts.logger?.debug({ model, jobId: job.jobId, step: "video.fetch" }, "veo: downloaded result");
          // NO costUsd (A4): GenerateVideosResponse has no usage/cost field; the
          // handler's estimate is the actual. Do NOT invent a cost field.
          return {
            buffer,
            mimeType,
            sourceUrl: video.uri,
            model,
            provider: "veo",
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
            lastErr = p.error;
            return { jobId: job.jobId, state: "failed" };
          }
          if (p.value.state === "failed") {
            // A .done operation with an error — surface the classified failure by
            // re-reading the operation so the loop's failed branch maps it.
            lastErr = await readOperationError(getOperation, job.jobId);
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
        return mapThrownToErr(lastErr ?? new Error("veo: job failed"));
      }

      const fetched = await this.fetchResult(job, runOpts.signal ? { signal: runOpts.signal } : undefined);
      if (!fetched.ok) {
        return mapThrownToErr(fetched.error);
      }
      // WR-05: Veo reports no duration (A4) — fall back to the duration WE
      // requested so the handler's reconcile + delivery metadata is not empty.
      if (fetched.value.durationSecs === undefined && input.durationSecs !== undefined) {
        return ok({ ...fetched.value, durationSecs: input.durationSecs });
      }
      return fetched;
    },
  };
}

/**
 * Read the `operation.error` of a failed Veo operation and turn it into a
 * classified `VideoGenError`. The poll loop's `failed` branch maps this so the
 * caller gets the auth/content/quota kind + hint (not a generic "job failed").
 */
async function readOperationError(
  getOperation: (jobId: string) => Promise<GenerateVideosOperation>,
  jobId: string,
): Promise<Error> {
  try {
    const cur = await getOperation(jobId);
    const c = classifyVeoVideoError(cur.error ?? new Error("veo: job failed"));
    return new VideoGenError(c.hint, c);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/**
 * Map a normalized `VideoGenInput` to the Veo `GenerateVideosConfig` (VEO-02).
 * `durationSeconds` is a NUMBER (NOT the FAL `${n}s` string). Omitted input
 * fields are ABSENT from the config (the `...(x !== undefined ? {k:x} : {})`
 * idiom — no `undefined` keys). i2v config (lastFrame/referenceImages from
 * `input.referenceImage`) is Phase 191 — the field is acknowledged but NOT mapped
 * here (variant-select is 191).
 */
function buildVeoConfig(input: VideoGenInput): GenerateVideosConfig {
  return {
    ...(input.durationSecs !== undefined ? { durationSeconds: input.durationSecs } : {}),
    ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
    ...(input.resolution ? { resolution: input.resolution } : {}),
    ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
    ...(input.audio !== undefined ? { generateAudio: input.audio } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    // i2v config plumbing (Phase 191 does variant-select): lastFrame, referenceImages.
  };
}

/**
 * WR-07 (trust boundary): `url` is the Veo `video.uri` (with the Dev-API key) — a
 * PROVIDER-OWNED CDN URL, NOT the agent-supplied i2v `image_url`. The input path
 * is SSRF-guarded elsewhere; this OUTPUT download trusts the Google CDN by design
 * and so does NOT re-run the SSRF resolver — but it still hardens with
 * `redirect:"error"` (never silently follow a CDN open-redirect to an internal
 * IP), a bounded signal (CR-01/WR-01), and a streamed byte cap. COPIED from
 * fal-adapter.ts (the FAL file's comment directs Phase 190 to follow this shape).
 *
 * @returns the downloaded bytes plus the CDN `content-type` (for WR-06 MIME).
 * @throws on a non-2xx status (CR-01), an empty body, an over-cap body (WR-01),
 *   or an aborted signal — all caught by `fromPromise` at the call site and
 *   classified by `classifyVeoVideoError` into a typed `VideoGenError`.
 */
async function downloadVideoBytes(
  url: string,
  opts?: VideoFetchResultOpts,
): Promise<{ buffer: Buffer; contentType: string | null }> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
  // WR-01: honor the caller's deadline signal; else a hard fallback timeout.
  const signal = opts?.signal ?? AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const response = await fetch(url, { redirect: "error", signal });

  // CR-01: reject a non-2xx status BEFORE reading the body (an expired/4xx Veo
  // URI returns a 403 error page; without this guard it flows out as a
  // "successful" mp4 — the orphan-on-expiry class DEL-01 closes).
  if (!response.ok) {
    throw new Error(`veo: failed to download video.uri: HTTP ${response.status}`);
  }

  // WR-01: Content-Length pre-check — abort before buffering if the server
  // DECLARES a body over the cap (an OOM guard).
  const declared = parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`veo: video.uri body exceeds the ${maxBytes}-byte cap (declared ${declared})`);
  }

  // WR-01: stream with a running byte cap when a body reader is available; fall
  // back to arrayBuffer otherwise.
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
          throw new Error(`veo: video.uri body exceeds the ${maxBytes}-byte cap`);
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
      throw new Error(`veo: video.uri body exceeds the ${maxBytes}-byte cap`);
    }
  }

  if (buffer.byteLength === 0) {
    throw new Error("veo: video.uri returned an empty body");
  }
  return { buffer, contentType: response.headers.get("content-type") };
}

/** Known video MIME types for the URL-extension fallback (WR-06). Copied from fal-adapter.ts. */
const VIDEO_EXT_MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

/**
 * WR-06: derive the output MIME from the CDN `content-type` header when it is a
 * `video/*` type, else from the URL path extension, else fall back to mp4. The
 * `url` passed here is the UN-keyed `video.uri` (SEC — no credential in a
 * logged/errored mime-derivation source). Copied from fal-adapter.ts.
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

/** Map a thrown error to a typed `VideoGenError` Result via `classifyVeoVideoError`. */
function mapThrownToErr(error: Error, opts?: { emptyResult?: boolean }): Result<VideoGenOutput, Error> {
  // A VideoGenError thrown inside fetchResult/execute already carries the kind/hint.
  if (error instanceof VideoGenError) return err(error);
  const c = classifyVeoVideoError(error, opts);
  return err(new VideoGenError(c.hint, c));
}
