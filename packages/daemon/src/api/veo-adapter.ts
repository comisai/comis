// SPDX-License-Identifier: Apache-2.0
// @allow-throw: integration/SDK boundary wrapper; throws caught by fromPromise at the port boundary.
/**
 * Google Veo video adapter.
 *
 * A `VideoGenerationPort` over `@google/genai@1.52.0`. Unlike the FAL adapter
 * (a queue API), Veo is an SDK LONG-RUNNING OPERATION (LRO):
 *   - submit:  `ai.models.generateVideos({ model, prompt, config })` → an
 *              operation whose `.name` is the durable, secret-free jobId
 *              — DIFFERS from FAL's queue `request_id`.
 *   - poll:    `ai.operations.getVideosOperation({ operation: { name } })` →
 *              `.done` + `.error`; `!done ? pending : (error ? failed : done)`.
 *   - fetch:   `op.response.generatedVideos[0].video` → either inline base64
 *              `videoBytes` (no fetch) or a 2-day-expiry `uri` fetched WITH the
 *              Dev-API `&key=` query param → a Buffer (download BEFORE
 *              return so the expiring URI can never orphan the job).
 *
 * PLACEMENT: this adapter lives in `@comis/daemon/src/api/` (NOT `@comis/skills`,
 * where `fal-adapter.ts` lives) because `@google/genai` is a DAEMON dep, not a
 * skills dep — building it in skills would be a phantom-dep / cycles violation
 * (matching the codex/google-images precedent). The three bounded-download
 * helpers are COPIED from `fal-adapter.ts` (private there) rather than imported,
 * to avoid a skills→daemon import edge (the FAL file's comment directs this).
 *
 * COST: `GenerateVideosResponse` has NO usage/cost field — Veo's actual
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
 * Hard fallback timeout for the result download when the caller threads no
 * AbortSignal (a standalone `fetchResult` from the off-turn poller). Bounds a hung
 * CDN on the download leg. Copied from fal-adapter.ts.
 */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Default streamed byte ceiling for the result download (a Content-Length
 * pre-check + a streamed running total → OOM guard). 200 MB matches
 * VIDEO_PERSIST_MAX_BYTES. Copied from fal-adapter.ts.
 */
const DEFAULT_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;

/** Options bounding the result download. Copied from fal-adapter.ts. */
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
   *  poll() and fetchResult() use this (the off-turn poller calls them with only the
   *  persisted { jobId }, so the operation handle is reconstructed from the name —
   *  the SDK reads `.name`). */
  const getOperation = (jobId: string): Promise<GenerateVideosOperation> =>
    ai.operations.getVideosOperation({ operation: { name: jobId } as GenerateVideosOperation });

  /**
   * Build the `VideoGenOutput` from an ALREADY-FETCHED terminal operation
   * — the single source of the download decision. `fetchResult` polls once then
   * calls this; `execute()` passes the terminal operation its poll loop ALREADY
   * read, so it makes ONE getVideosOperation round-trip instead of two.
   * The download fetch is separate.
   */
  const buildVeoOutput = async (
    job: VideoGenJob,
    cur: GenerateVideosOperation,
    fetchOpts?: VideoFetchResultOpts,
  ): Promise<VideoGenOutput> => {
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
      // Inline base64 — no fetch.
      buffer = Buffer.from(video.videoBytes, "base64");
      mimeType = video.mimeType ?? "video/mp4";
    } else if (video.uri) {
      // The Dev API requires the key as a query param. SEC: this keyed URL is
      // NEVER logged. deriveVideoMime reads the UN-keyed video.uri.
      const url = `${video.uri}&key=${opts.apiKey}`;
      const { buffer: dl, contentType } = await downloadVideoBytes(url, fetchOpts);
      buffer = dl;
      mimeType = deriveVideoMime(contentType, video.uri);
    } else {
      const c = classifyVeoVideoError(null, { emptyResult: true });
      throw new VideoGenError(c.hint, c);
    }

    // The output model reflects what actually rendered — `job.model` (set
    // at submit from `input.model ?? construction model`; round-tripped through
    // the persisted row to the off-turn poller) when present, else the default.
    const outModel = job.model || model;
    opts.logger?.debug({ model: outModel, jobId: job.jobId, step: "video.fetch" }, "veo: downloaded result");
    // NO costUsd: GenerateVideosResponse has no usage/cost field; the
    // handler's estimate is the actual. Do NOT invent a cost field.
    return {
      buffer,
      mimeType,
      sourceUrl: video.uri,
      model: outModel,
      provider: "veo",
    } satisfies VideoGenOutput;
  };

  return {
    id: "veo",
    isAvailable: () => true,

    submit(input: VideoGenInput): Promise<Result<VideoGenJob, Error>> {
      return fromPromise(
        (async () => {
          // The PER-REQUEST `input.model` (what the handler validated
          // against, `params.model ?? config.model`) wins over the construction
          // default so validation and execution AGREE. poll()/fetchResult() key on
          // the operation NAME (not the model), so the effective model only matters
          // here at submit + on `job.model` (obs + the persisted row).
          const effectiveModel = input.model ?? model;
          const op = await ai.models.generateVideos({
            model: effectiveModel,
            prompt: input.prompt,
            // The first-frame image is a TOP-LEVEL generateVideos arg
            // (the SDK Image_2 raw-bytes shape { imageBytes, mimeType }), NOT a
            // config field. SAME model id for t2v AND i2v (no endpoint swap,
            // unlike FAL). Only the SINGULAR referenceImage is consumed; the
            // additive referenceImages array (Veo lastFrame/referenceImages) is
            // deliberately unsupported — buildVeoConfig is unchanged on that axis.
            ...(input.referenceImage
              ? { image: { imageBytes: input.referenceImage.data, mimeType: input.referenceImage.mimeType } }
              : {}),
            config: buildVeoConfig(input),
          });
          if (!op.name) {
            throw new Error("veo: generateVideos returned no operation name");
          }
          const job: VideoGenJob = {
            jobId: op.name, // op.name is the durable, secret-free jobId
            provider: "veo",
            model: effectiveModel, // the model that actually rendered
          };
          opts.logger?.debug(
            { model: effectiveModel, jobId: job.jobId, step: "video.submit" },
            "veo: submitted render",
          );
          return job;
        })(),
      );
    },

    poll(job: VideoGenJob): Promise<Result<VideoJobStatus, Error>> {
      return fromPromise(
        (async () => {
          const cur = await getOperation(job.jobId);
          const state: VideoJobStatus["state"] = !cur.done ? "pending" : cur.error ? "failed" : "done";
          // On a terminal failure, thread the SAME classified kind+hint the
          // execute() path emits onto the snapshot (reusing the existing classifier,
          // not a third one) so the off-turn poller persists the specific kind +
          // actionable hint instead of collapsing to empty_response. The hint is a
          // FIXED auth/quota/content string — never the raw operation.error.
          if (state === "failed") {
            const c = classifyVeoVideoError(cur.error);
            return { jobId: job.jobId, state, errorKind: c.videoErrorKind, hint: c.hint } satisfies VideoJobStatus;
          }
          return { jobId: job.jobId, state } satisfies VideoJobStatus;
        })(),
      );
    },

    fetchResult(job: VideoGenJob, fetchOpts?: VideoFetchResultOpts): Promise<Result<VideoGenOutput, Error>> {
      return fromPromise(
        (async () => {
          // Standalone path (the off-turn poller calls poll() then
          // fetchResult() with NO terminal snapshot): read the operation ONCE here
          // — it is the source of the download uri/bytes — then build the output.
          const cur = await getOperation(job.jobId);
          return buildVeoOutput(job, cur, fetchOpts);
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
      // Capture the TERMINAL operation the poll loop reads so fetchResult
      // does not re-read it. The poll callback reads the operation DIRECTLY (once
      // per iteration) and derives the state, instead of calling this.poll() (which
      // would discard the operation) + a separate re-read of operation.error on the
      // failed branch — one read per iteration instead of 2–3.
      let doneOp: GenerateVideosOperation | undefined;
      const outcome = await pollUntilDone<VideoJobStatus>({
        poll: async () => {
          let cur: GenerateVideosOperation;
          try {
            cur = await getOperation(job.jobId);
          } catch (e) {
            lastErr = e instanceof Error ? e : new Error(String(e));
            return { jobId: job.jobId, state: "failed" };
          }
          const state: VideoJobStatus["state"] = !cur.done ? "pending" : cur.error ? "failed" : "done";
          if (state === "failed") {
            // Classify directly from THIS read (no re-poll) — same kind+hint the
            // standalone path produces.
            const c = classifyVeoVideoError(cur.error ?? new Error("veo: job failed"));
            lastErr = new VideoGenError(c.hint, c);
          } else if (state === "done") {
            doneOp = cur; // hand the terminal operation to buildVeoOutput below
          }
          return { jobId: job.jobId, state };
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

      // Build from the terminal operation the loop already read — no second
      // getVideosOperation. `doneOp` is set whenever the loop reached `done`.
      const fetched = await fromPromise(
        buildVeoOutput(job, doneOp ?? (await getOperation(job.jobId)), runOpts.signal ? { signal: runOpts.signal } : undefined),
      );
      if (!fetched.ok) {
        return mapThrownToErr(fetched.error);
      }
      // Veo reports no duration — fall back to the duration WE
      // requested so the handler's reconcile + delivery metadata is not empty.
      if (fetched.value.durationSecs === undefined && input.durationSecs !== undefined) {
        return ok({ ...fetched.value, durationSecs: input.durationSecs });
      }
      return fetched;
    },
  };
}

/**
 * Map a normalized `VideoGenInput` to the Veo `GenerateVideosConfig`.
 * `durationSeconds` is a NUMBER (NOT the FAL `${n}s` string). Omitted input
 * fields are ABSENT from the config (the `...(x !== undefined ? {k:x} : {})`
 * idiom — no `undefined` keys).
 *
 * The first-frame i2v image is wired as a TOP-LEVEL
 * `generateVideos({image})` arg in `submit`, NOT here — the config holds
 * only `lastFrame`/`referenceImages`, which are deliberately unsupported
 * (no adapter reads `input.referenceImages`), so this config is
 * unchanged on the i2v axis.
 */
function buildVeoConfig(input: VideoGenInput): GenerateVideosConfig {
  return {
    ...(input.durationSecs !== undefined ? { durationSeconds: input.durationSecs } : {}),
    ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
    ...(input.resolution ? { resolution: input.resolution } : {}),
    ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
    ...(input.audio !== undefined ? { generateAudio: input.audio } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  };
}

/**
 * Trust boundary: `url` is the Veo `video.uri` (with the Dev-API key) — a
 * PROVIDER-OWNED CDN URL, NOT the agent-supplied i2v `image_url`. The input path
 * is SSRF-guarded elsewhere; this OUTPUT download trusts the Google CDN by design
 * and so does NOT re-run the SSRF resolver — but it still hardens with
 * `redirect:"error"` (never silently follow a CDN open-redirect to an internal
 * IP), a bounded signal, and a streamed byte cap. COPIED from
 * fal-adapter.ts (see the module header for why it is copied, not imported).
 *
 * @returns the downloaded bytes plus the CDN `content-type` (for MIME derivation).
 * @throws on a non-2xx status, an empty body, an over-cap body,
 *   or an aborted signal — all caught by `fromPromise` at the call site and
 *   classified by `classifyVeoVideoError` into a typed `VideoGenError`.
 */
async function downloadVideoBytes(
  url: string,
  opts?: VideoFetchResultOpts,
): Promise<{ buffer: Buffer; contentType: string | null }> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
  // Honor the caller's deadline signal; else a hard fallback timeout.
  const signal = opts?.signal ?? AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const response = await fetch(url, { redirect: "error", signal });

  // Reject a non-2xx status BEFORE reading the body: an expired/4xx Veo
  // URI returns a 403 error page; without this guard it would flow out as a
  // "successful" mp4, orphaning the job when the URI has expired.
  if (!response.ok) {
    throw new Error(`veo: failed to download video.uri: HTTP ${response.status}`);
  }

  // Content-Length pre-check — abort before buffering if the server
  // DECLARES a body over the cap (an OOM guard).
  const declared = parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`veo: video.uri body exceeds the ${maxBytes}-byte cap (declared ${declared})`);
  }

  // Stream with a running byte cap when a body reader is available; fall
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

/** Known video MIME types for the URL-extension fallback. Copied from fal-adapter.ts. */
const VIDEO_EXT_MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

/**
 * Derive the output MIME from the CDN `content-type` header when it is a
 * `video/*` type, else from the URL path extension, else fall back to mp4. The
 * `url` passed here is the UN-keyed `video.uri` (no credential in a
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
