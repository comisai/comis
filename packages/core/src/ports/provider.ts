// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { VideoErrorKind } from "../media/video-error.js";

/**
 * Input for image generation providers.
 */
export interface ImageGenInput {
  /** Text prompt describing the desired image */
  prompt: string;
  /** Image dimensions (e.g., "1024x1024", "square_hd") */
  size?: string;
  /** Whether to run safety checker on output (default: true) */
  safetyChecker?: boolean;
  /** Optional reference image (edit/img2img) — base64 + mime, resolved by the handler. */
  referenceImage?: { data: string; mimeType: string };
  /** Optional model override (validated by the handler against the provider's list). */
  model?: string;
}

/**
 * Output from image generation providers.
 *
 * `costUsd`/`model`/`provider` are OPTIONAL and ADDITIVE:
 * the pi-ai adapter (`toImageGenOutput`) maps them from `AssistantImages`
 * (`usage.cost.total`/`model`/`provider`), but the fal/openai skills
 * adapters that also implement `ImageGenerationPort` simply leave them unset —
 * a minimal `{ buffer, mimeType }` return is still valid.
 */
export interface ImageGenOutput {
  /** Raw image bytes */
  buffer: Buffer;
  /** MIME type of the image (e.g., "image/png") */
  mimeType: string;
  /** Generation cost in USD (pi-ai `Usage.cost.total`); unset when the
   *  provider reports no usage or the adapter does not map it. */
  costUsd?: number;
  /** The model id that produced the image (e.g. "gpt-image-1"). */
  model?: string;
  /** The executing provider id (e.g. "openai", "google"). */
  provider?: string;
}

/**
 * Image generation port — concrete hexagonal boundary for image-generation
 * adapters (OpenAI gpt-image-1, fal.ai, etc.).
 *
 * Deliberately a concrete interface, not a `Provider<TInput, TOutput>`
 * generic: a generic would have a single consumer
 * (`ImageGenerationPort`), and an optional `estimateCost` field would have zero
 * production callers.
 */
export interface ImageGenerationPort {
  /** Unique provider identifier (e.g., "fal", "openai") */
  readonly id: string;
  /** Whether the provider is currently available (API key present, etc.) */
  isAvailable(): boolean;
  /** Execute the provider with the given input */
  execute(input: ImageGenInput): Promise<Result<ImageGenOutput, Error>>;
}

/**
 * Input for a video generation request (text-to-video, plus image-to-video via
 * `referenceImage`). All fields beyond `prompt` are optional and
 * provider-validated.
 */
export interface VideoGenInput {
  /** Text prompt describing the desired video */
  prompt: string;
  /** Clip length in normalized seconds; the adapter encodes per backend */
  durationSecs?: number;
  /** "16:9" | "9:16" | "1:1" (provider-validated) */
  aspectRatio?: string;
  /** "720p" | "1080p" | "4k" (provider-validated) */
  resolution?: string;
  /** Generate audio (provider-dependent) */
  audio?: boolean;
  /** Negative prompt (provider-dependent) */
  negativePrompt?: string;
  /** Deterministic seed (provider-dependent) */
  seed?: number;
  /** SSRF-resolved first-frame reference image for image-to-video — base64 +
   *  mime, resolved by the handler. This singular field is the PRIMARY and the
   *  ONLY consumed image input: each adapter variant-selects on its presence
   *  (FAL swaps to its /image-to-video endpoint; Veo/Grok add the image on the
   *  same model). */
  referenceImage?: { data: string; mimeType: string };
  /** FORWARD-COMPAT SCAFFOLDING — NOT consumed yet. Additional reference
   *  images for i2v, each with a role. `referenceImage` (the first-frame) stays
   *  the primary, sole-consumed singular input; multi-ref consumption (Veo
   *  lastFrame/referenceImages, Grok reference_images, FAL first-last-frame) is
   *  a deliberate deferral. This optional field is byte-compatible scaffolding
   *  so future consumption is additive-only — no adapter reads it yet. Each
   *  `ref` is the SSRF-resolved { data, mimeType }. */
  referenceImages?: { ref: { data: string; mimeType: string }; role: "first_frame" | "last_frame" | "reference" }[];
  /** Overrides the per-backend default video model */
  model?: string;
}

/**
 * An in-flight job handle — the durable `submit()` result.
 *
 * `jobId` is the OPAQUE provider id (e.g. the FAL `request_id`): it is stable
 * across `poll()` calls and contains NO secret. It is safe to log;
 * the bearer token / `FAL_KEY` that authenticated the submit is never part of
 * it. The runtime no-secret assertion lives in the adapter tests.
 */
export interface VideoGenJob {
  /** Opaque, stable-across-poll, secret-free provider request id */
  jobId: string;
  /** The executing backend id (e.g. "fal") */
  provider: string;
  /** The model that produced (or is producing) the clip */
  model: string;
}

/**
 * A `poll()` snapshot. `state` is the normalized lifecycle; `done` is the only
 * terminal-success state (`failed` short-circuits the poll loop).
 *
 * `errorKind`/`hint` are OPTIONAL and ADDITIVE: when an adapter
 * can classify a terminal `failed` state at poll time (a Veo `operation.error`, a
 * Grok `status:"failed"|"expired"`), it threads the SAME classified
 * `{ videoErrorKind, hint }` it produces on the in-turn `execute()` path onto the
 * snapshot — so the off-turn background poller (which drives `poll()`, never
 * `execute()`) can persist the specific kind + the actionable hint instead of
 * collapsing every terminal failure to a generic `empty_response`. They are
 * absent on `pending`/`done` and on adapters (e.g. FAL) that signal a failure as
 * a throw rather than a terminal poll status — those keep their existing behavior
 * (the poller falls back to its generic classification). The `hint` names the
 * knob/action, never a secret (the classifiers emit FIXED auth/quota/content
 * hints, never the raw provider message).
 */
export interface VideoJobStatus {
  jobId: string;
  state: "pending" | "done" | "failed";
  /** The classified domain error kind on a terminal `failed` snapshot. */
  errorKind?: VideoErrorKind;
  /** The actionable, secret-free operator hint paired with `errorKind`. */
  hint?: string;
}

/**
 * Output of a completed render.
 *
 * `durationSecs`/`costUsd`/`model`/`provider`/`sourceUrl` are OPTIONAL and
 * ADDITIVE (mirror `ImageGenOutput`): a minimal `{ buffer, mimeType }` return
 * is still valid.
 */
export interface VideoGenOutput {
  /** Raw video bytes (downloaded from the expiring provider URL) */
  buffer: Buffer;
  /** MIME type of the video (e.g. "video/mp4") */
  mimeType: string;
  /** Clip length in seconds, when the provider reports it */
  durationSecs?: number;
  /** Generation cost in USD (provider actual, or the worst-case estimate) */
  costUsd?: number;
  /** The model id that produced the video */
  model?: string;
  /** The executing provider id (e.g. "fal", "google") */
  provider?: string;
  /** The (expiring) provider URL retained for the buffer-vs-link
   *  delivery choice; the buffer is the durable artifact. */
  sourceUrl?: string;
}

/**
 * Video generation port — the concrete hexagonal boundary for video-generation
 * adapters (FAL queue, Google Veo, xAI Grok Imagine).
 *
 * Unlike `ImageGenerationPort`, video is an async submit→poll→download
 * lifecycle: renders take 30 s–5 min and can outlive the originating turn. The
 * port therefore exposes the discrete `submit`/`poll`/`fetchResult` steps (so
 * the daemon's background poller can drive the loop externally byte-for-byte)
 * AND an inline `execute()` convenience that runs the bounded poll-loop in one
 * call.
 */
export interface VideoGenerationPort {
  /** Unique provider identifier (e.g., "fal", "veo", "grok") */
  readonly id: string;
  /** Whether the provider is currently available (API key present, etc.) */
  isAvailable(): boolean;
  /** Submit a render; capture the durable opaque jobId. */
  submit(input: VideoGenInput): Promise<Result<VideoGenJob, Error>>;
  /** Poll a submitted job's status (idempotent; jobId stable). */
  poll(job: VideoGenJob): Promise<Result<VideoJobStatus, Error>>;
  /** Fetch + download the finished result to a buffer. `opts` bounds the
   *  download: an optional abort signal (the operator deadline; threaded
   *  by `execute`) and a byte cap (defaulted by the adapter). */
  fetchResult(
    job: VideoGenJob,
    opts?: { signal?: AbortSignal; maxBytes?: number },
  ): Promise<Result<VideoGenOutput, Error>>;
  /** Inline convenience: submit + bounded poll-loop + fetchResult (a deadline
   *  overrun surfaces as `job_timeout`). */
  execute(
    input: VideoGenInput,
    opts: { timeoutMs: number; pollIntervalMs: number; signal?: AbortSignal },
  ): Promise<Result<VideoGenOutput, Error>>;
}
