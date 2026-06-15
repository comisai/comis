// SPDX-License-Identifier: Apache-2.0
/**
 * Media + image-domain RPC contracts. Mirrors the two daemon handler
 * factory files that share the `MediaApiDeps` cluster slice:
 *
 *   - `packages/daemon/src/api/media-handlers.ts`  (15 methods)
 *   - `packages/daemon/src/api/image-handlers.ts`  ( 1 method)
 *
 * Both handler files map to the SAME ApiDeps slice (`MediaApiDeps` — with
 * image-handlers receiving the nested `imageHandlerDeps` sub-shape) and so
 * share one contract file. The aggregator below preserves per-handler
 * grouping via `// --- xxx-handlers.ts ---` comment blocks; the order
 * within the array is documentation-only (the bidirectional 1:1 test
 * treats it as an unordered set).
 *
 * **Scope assignments** (mirror `setup-gateway-api.ts` registrations):
 *
 *   media-handlers.ts:
 *   - `image.analyze`           (rpc)   — agent tool dispatch (NOT in
 *                                          setup-gateway-api.ts); contract
 *                                          scope documents the intended
 *                                          trust model.
 *   - `tts.synthesize`          (rpc)   — agent tool dispatch.
 *   - `tts.auto_check`          (rpc)   — agent tool dispatch.
 *   - `link.process`            (rpc)   — agent tool dispatch.
 *   - `audio.transcribe`        (rpc)   — setup-gateway-api.ts:187.
 *   - `media.transcribe`        (rpc)   — agent tool dispatch.
 *   - `media.describe_video`    (rpc)   — agent tool dispatch.
 *   - `media.extract_document`  (rpc)   — agent tool dispatch.
 *   - `media.test.stt`          (admin) — setup-gateway-api.ts:189.
 *   - `media.test.tts`          (admin) — setup-gateway-api.ts:189.
 *   - `media.test.vision`       (admin) — setup-gateway-api.ts:190.
 *   - `media.test.document`     (admin) — setup-gateway-api.ts:190.
 *   - `media.test.video`        (admin) — setup-gateway-api.ts:191.
 *   - `media.test.link`         (admin) — setup-gateway-api.ts:191.
 *   - `media.providers`         (admin) — setup-gateway-api.ts:192.
 *
 *   image-handlers.ts:
 *   - `image.generate`          (rpc)   — agent tool dispatch (NOT in
 *                                          setup-gateway-api.ts; bridges
 *                                          the agent's image-generation
 *                                          tool to provider + channel
 *                                          delivery).
 *
 * **Loose-record use** (escape hatch). Multiple response shapes carry
 * nested adapter-specific fields where modeling them tighter would pin
 * underlying wire formats across daemon restarts:
 *
 *   - `media.providers.response` — top-level keys mirror the provider
 *     groups (stt/tts/vision/documentExtraction/linkUnderstanding); each
 *     nested value is provider-specific (vision.providers is the dynamic
 *     `[...registry.keys()]` array; tts.format strings vary per provider).
 *     The handler returns `null` for unconfigured providers — modelled at
 *     the top level via a loose record.
 *   - `image.generate.response` — discriminated by `success` + delivery
 *     mode (delivered: true vs imageBase64 fallback). Modelled as a loose
 *     record to forward-compat both variants without pinning the failure
 *     vs delivered vs base64 shape sets.
 *
 * **Allowlist compliance.** All schemas use the 12-shape allowlist:
 * z.object, z.string (no `.url()` / `.regex()` refinements — `attachment_url`
 * and similar URL-typed params are bare `z.string()`; the handler validates
 * via `validateUrl` from `@comis/core/security` when the URL is fetched),
 * z.number, z.boolean, z.literal, z.enum, z.array, z.union, z.nullable,
 * z.optional, z.record (loose-record value-type).
 *
 * The CLI has ZERO `client.call("media.*"|"audio.*"|"image.*", ...)` sites:
 * these 16 handler-factory methods have no CLI consumers in scope. The
 * CLI's doctor command does NOT invoke media/audio/image RPC methods.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// ===========================================================================
// --- media-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// image.analyze
// ---------------------------------------------------------------------------

/**
 * `image.analyze` — describe an image via the configured vision provider.
 * Supports 4 source types (file / url / base64 / attachment) discriminated
 * by `source_type` + `source` (or `attachment_url` for the attachment
 * shorthand). The handler routes the source to the right loader,
 * downloads/decodes the bytes, validates the buffer size against the
 * configured `imageAnalysis.maxFileSizeMb`, and forwards to the selected
 * vision provider's `describeImage(...)` call.
 *
 * Bespoke pre-Zod validation:
 *   - No vision registry / empty registry → `"No vision provider available
 *     for image analysis."`.
 *   - Vision scope rule `deny` → returns
 *     `{ description: "Vision analysis not available for this context." }`.
 *   - Unknown `source_type` → throws (handler default branch).
 *
 * Request: union shape — caller supplies either `(source_type + source)`
 * or `attachment_url`. The contract uses optional fields so both shapes
 * type-check; the handler's switch-case enforces the discriminator at
 * runtime.
 *
 * Response: `{ description, provider?, model? }`. The "deny" branch
 * returns only `description`; the normal branch carries `provider` +
 * `model` from the vision provider's return value.
 */
export const ImageAnalyzeContract = defineContract({
  method: "image.analyze",
  request: z.object({
    source_type: z.string().optional(),
    source: z.string().optional(),
    attachment_url: z.string().optional(),
    prompt: z.string().optional(),
    mime_type: z.string().optional(),
  }),
  response: z.object({
    description: z.string(),
    provider: z.string().optional(),
    model: z.string().optional(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// tts.synthesize
// ---------------------------------------------------------------------------

/**
 * `tts.synthesize` — synthesize text to audio via the configured TTS
 * adapter. Parses optional `[[tts:voice=...]]` directives from the text,
 * resolves output format per channel (Opus for Telegram, MP3 default),
 * writes the audio to a per-agent `media/tts/<uuid>.<ext>` file, and
 * returns the file path + mimeType + size.
 *
 * Bespoke pre-Zod validation:
 *   - No TTS adapter configured → `"TTS not configured. Set
 *     media.tts.provider in config."`.
 *
 * Response: `{ filePath, mimeType, sizeBytes }`. The audio is delivered
 * via the file path (handler-side TTL cleanup deletes files older than
 * 1 hour on the next invocation).
 */
export const TtsSynthesizeContract = defineContract({
  method: "tts.synthesize",
  request: z.object({
    text: z.string(),
    voice: z.string().optional(),
    format: z.string().optional(),
  }),
  response: z.object({
    filePath: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// tts.auto_check
// ---------------------------------------------------------------------------

/**
 * `tts.auto_check` — check whether a response should auto-trigger TTS
 * based on the configured `autoMode` + `tagPattern`. Pure decision —
 * does NOT synthesize audio. Returns the (possibly tag-stripped) text +
 * the boolean decision + the current mode.
 *
 * Response: `{ shouldSynthesize, strippedText?, mode }`. `strippedText`
 * is present only when the `tagPattern` matched and stripped the trigger
 * tag from the response.
 */
export const TtsAutoCheckContract = defineContract({
  method: "tts.auto_check",
  request: z.object({
    response_text: z.string(),
    has_inbound_audio: z.boolean().optional(),
    has_media_url: z.boolean().optional(),
  }),
  response: z.object({
    shouldSynthesize: z.boolean(),
    strippedText: z.string().optional(),
    mode: z.string(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// link.process
// ---------------------------------------------------------------------------

/**
 * `link.process` — process message text through the link understanding
 * pipeline (web-fetch + `wrapWebContent` + summary). Returns enriched
 * text with inline summaries + per-link error messages.
 *
 * Response: `{ enrichedText, linksProcessed, errors[] }`. `errors[]` is
 * `string[]` — `LinkRunner.processMessage` returns `errors: string[]`
 * (per-link error messages from failed web fetches).
 */
export const LinkProcessContract = defineContract({
  method: "link.process",
  request: z.object({
    text: z.string(),
  }),
  response: z.object({
    enrichedText: z.string(),
    linksProcessed: z.number(),
    errors: z.array(z.string()),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// audio.transcribe
// ---------------------------------------------------------------------------

/**
 * `audio.transcribe` — base64-encoded audio transcription (gateway-
 * facing). The handler accepts a base64-encoded audio buffer + optional
 * mimeType + language, decodes via Buffer, and forwards to the configured
 * STT provider.
 *
 * Bespoke pre-Zod validation (handler returns `{ error }`-shape on
 * non-throw failures):
 *   - `audio` missing or not a string → `{ error: "Missing required
 *     parameter: audio (base64-encoded string)" }`.
 *   - No transcriber configured → `{ error: "STT not configured -- check
 *     integrations.media.transcription settings" }`.
 *   - STT provider returns `err()` → `{ error: result.error.message }`.
 *
 * Response: loose-record. Two variants — success carries
 * `{ text, language, durationMs }`; failure carries `{ error: string }`
 * (the handler returns the `error` shape WITHOUT throwing for the
 * missing-parameter / not-configured / provider-error cases).
 */
export const AudioTranscribeContract = defineContract({
  method: "audio.transcribe",
  request: z.object({
    audio: z.string().optional(),
    mimeType: z.string().optional(),
    language: z.string().optional(),
  }),
  response: z.record(z.string(), z.unknown()),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// media.transcribe
// ---------------------------------------------------------------------------

/**
 * `media.transcribe` — attachment-URL-based audio transcription. The
 * handler resolves the attachment via the channel-specific
 * `resolveAttachment` callback, detects mime from magic bytes, and
 * forwards to the configured STT provider. Distinct from
 * `audio.transcribe` (which accepts inline base64); used by the agent
 * tool for voice-message processing on the call site.
 *
 * Bespoke pre-Zod validation (throws on failure):
 *   - No transcriber configured → throws `"Transcription service not
 *     configured..."`.
 *   - No `resolveAttachment` → throws `"Attachment resolution not
 *     available in this context."`.
 *   - Attachment resolution returns null → throws `"Failed to resolve
 *     attachment: <url>"`.
 *
 * Response: `{ text, language?, durationMs }`.
 */
export const MediaTranscribeContract = defineContract({
  method: "media.transcribe",
  request: z.object({
    attachment_url: z.string(),
    language: z.string().optional(),
  }),
  response: z.object({
    text: z.string(),
    language: z.string().optional(),
    durationMs: z.number(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// media.describe_video
// ---------------------------------------------------------------------------

/**
 * `media.describe_video` — describe video content via a vision provider
 * capable of `describeVideo` (Gemini, etc.). Resolves the attachment +
 * detects mime + forwards.
 *
 * Bespoke pre-Zod validation (throws):
 *   - No vision registry / empty → `"No vision provider available for
 *     video description."`.
 *   - No `resolveAttachment` → `"Attachment resolution not available..."`.
 *   - Attachment returns null → `"Failed to resolve attachment: <url>"`.
 *   - No video-capable provider → `"No video-capable vision provider
 *     available (requires Gemini or compatible provider)."`.
 *
 * Response: `{ description, provider, model }`.
 */
export const MediaDescribeVideoContract = defineContract({
  method: "media.describe_video",
  request: z.object({
    attachment_url: z.string(),
    prompt: z.string().optional(),
  }),
  response: z.object({
    description: z.string(),
    provider: z.string(),
    model: z.string(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// media.extract_document
// ---------------------------------------------------------------------------

/**
 * `media.extract_document` — extract text from a document attachment
 * (PDF, CSV, plaintext, JSON). Resolves the attachment + detects mime +
 * forwards to the configured `fileExtractor` port.
 *
 * Bespoke pre-Zod validation (throws):
 *   - No fileExtractor configured → `"Document extraction service not
 *     configured..."`.
 *   - No `resolveAttachment` → `"Attachment resolution not available..."`.
 *   - Attachment returns null → `"Failed to resolve attachment: <url>"`.
 *
 * Response: `{ text, fileName, mimeType, extractedChars, truncated,
 * durationMs }`.
 */
export const MediaExtractDocumentContract = defineContract({
  method: "media.extract_document",
  request: z.object({
    attachment_url: z.string(),
  }),
  response: z.object({
    text: z.string(),
    fileName: z.string().optional(),
    mimeType: z.string(),
    extractedChars: z.number(),
    truncated: z.boolean(),
    durationMs: z.number(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// media.test.stt
// ---------------------------------------------------------------------------

/**
 * `media.test.stt` — operator-facing STT test. Inline base64 audio,
 * inline base64 response, no disk I/O. Admin-scoped (setup-gateway-api.ts
 * line 189).
 *
 * Bespoke pre-Zod validation (throws):
 *   - No transcriber configured → `"Transcription service not
 *     configured..."`.
 *
 * Response: `{ text, language?, durationMs, provider }`. `provider` is
 * the configured TTS provider name OR `"configured"` placeholder when
 * the TTS-config name is unset.
 */
export const MediaTestSttContract = defineContract({
  method: "media.test.stt",
  request: z.object({
    audio: z.string(),
    mimeType: z.string(),
    language: z.string().optional(),
  }),
  response: z.object({
    text: z.string(),
    language: z.string().optional(),
    durationMs: z.number(),
    provider: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// media.test.tts
// ---------------------------------------------------------------------------

/**
 * `media.test.tts` — operator-facing TTS test. Inline base64 audio
 * response. Admin-scoped (setup-gateway-api.ts line 189).
 *
 * Bespoke pre-Zod validation (throws):
 *   - No TTS adapter configured → `"TTS not configured. Set
 *     integrations.media.tts.provider in config."`.
 *
 * Response: `{ audio (base64), mimeType, sizeBytes, provider }`. The
 * audio buffer is base64-encoded into the response (no disk I/O).
 */
export const MediaTestTtsContract = defineContract({
  method: "media.test.tts",
  request: z.object({
    text: z.string(),
    voice: z.string().optional(),
    format: z.string().optional(),
  }),
  response: z.object({
    audio: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number(),
    provider: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// media.test.vision
// ---------------------------------------------------------------------------

/**
 * `media.test.vision` — operator-facing vision test. Inline base64 image,
 * vision provider selection by name. Admin-scoped (setup-gateway-api.ts
 * line 190).
 *
 * Bespoke pre-Zod validation (throws):
 *   - No vision registry / empty → `"No vision provider available.
 *     Configure integrations.media.vision in config."`.
 *   - No provider matches preferred name → `"No vision provider
 *     available for image analysis."`.
 *
 * Response: `{ description, provider, model }`.
 */
export const MediaTestVisionContract = defineContract({
  method: "media.test.vision",
  request: z.object({
    image: z.string(),
    mimeType: z.string(),
    prompt: z.string().optional(),
    provider: z.string().optional(),
  }),
  response: z.object({
    description: z.string(),
    provider: z.string(),
    model: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// media.test.document
// ---------------------------------------------------------------------------

/**
 * `media.test.document` — operator-facing document extraction test.
 * Inline base64 file, optional filename hint. Admin-scoped
 * (setup-gateway-api.ts line 190).
 *
 * Bespoke pre-Zod validation (throws):
 *   - No fileExtractor configured → `"Document extraction service not
 *     configured. Set integrations.media.documentExtraction in config."`.
 *
 * Response: `{ text, fileName, mimeType, extractedChars, truncated,
 * durationMs, pageCount? }`. `fileName` falls back to `fileName` param
 * OR `"unknown"` if the extractor didn't echo it back.
 */
export const MediaTestDocumentContract = defineContract({
  method: "media.test.document",
  request: z.object({
    file: z.string(),
    mimeType: z.string(),
    fileName: z.string().optional(),
  }),
  response: z.object({
    text: z.string(),
    fileName: z.string(),
    mimeType: z.string(),
    extractedChars: z.number(),
    truncated: z.boolean(),
    durationMs: z.number(),
    pageCount: z.number().optional(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// media.test.video
// ---------------------------------------------------------------------------

/**
 * `media.test.video` — operator-facing video description test. Inline
 * base64 video, vision provider selection by name. Admin-scoped
 * (setup-gateway-api.ts line 191).
 *
 * Bespoke pre-Zod validation (throws):
 *   - No vision registry / empty → `"No vision provider available.
 *     Configure integrations.media.vision in config."`.
 *   - No video-capable provider → `"No video-capable vision provider
 *     available (requires Gemini or compatible provider)."`.
 *
 * Response: `{ description, provider, model }`.
 */
export const MediaTestVideoContract = defineContract({
  method: "media.test.video",
  request: z.object({
    video: z.string(),
    mimeType: z.string(),
    prompt: z.string().optional(),
    provider: z.string().optional(),
  }),
  response: z.object({
    description: z.string(),
    provider: z.string(),
    model: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// media.test.link
// ---------------------------------------------------------------------------

/**
 * `media.test.link` — operator-facing link-understanding test. Forwards
 * the URL through the same `linkRunner.processMessage(...)` pipeline as
 * `link.process` but treats the URL as the entire message. Admin-scoped
 * (setup-gateway-api.ts line 191).
 *
 * Bespoke pre-Zod validation (throws):
 *   - No linkRunner configured → `"Link understanding not configured."`.
 *
 * Response: `{ enrichedText, linksProcessed, errors[] }`. Same shape as
 * `link.process` (errors[] is loose-recorded).
 */
export const MediaTestLinkContract = defineContract({
  method: "media.test.link",
  request: z.object({
    url: z.string(),
  }),
  response: z.object({
    enrichedText: z.string(),
    linksProcessed: z.number(),
    errors: z.array(z.string()),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// media.providers
// ---------------------------------------------------------------------------

/**
 * `media.providers` — return current provider availability for the 5
 * media-pipeline groups (stt / tts / vision / documentExtraction /
 * linkUnderstanding). Admin-scoped (setup-gateway-api.ts line 192).
 *
 * Response: loose-record. Each top-level group is either `null`
 * (provider not configured) or an object with group-specific keys (e.g.,
 * `vision.providers` is the dynamic `[...registry.keys()]` array,
 * `vision.videoCapable` is the filtered subset, `tts.voice`/`tts.format`
 * are nullable strings, `documentExtraction.supportedMimes[]` is fixed).
 * Modeling the response tightly would pin each provider group's wire
 * format across daemon restarts.
 *
 * Request: `{}` (no params).
 */
export const MediaProvidersContract = defineContract({
  method: "media.providers",
  request: z.object({}),
  response: z.record(z.string(), z.unknown()),
  scopes: ["admin"] as const,
});

// ===========================================================================
// --- image-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// image.generate
// ---------------------------------------------------------------------------

/**
 * `image.generate` — generate an image via the configured provider (fal,
 * OpenAI). Applies per-agent rate limit + safety check + direct channel
 * delivery (via `adapter.sendAttachment`) OR base64 fallback when no
 * channel context is present.
 *
 * Request: `prompt`/`size` plus the optional CFG-02 fields `model` (a
 * provider-default override, validated by the handler against the provider's
 * model list — IN-02) and `reference_image` (a workspace path / url / data-uri
 * STRING for edit/img2img, resolved by the handler — IN-01). The fields are
 * additive (prompt-only callers are unaffected) and exist on the parsed request
 * so the handler sees them typed (Pitfall 5).
 *
 * Bespoke pre-Zod validation (handler returns `{ success: false, error }`-
 * shape — does NOT throw):
 *   - `prompt` missing → `{ success: false, error: "Missing required
 *     parameter: prompt" }`.
 *   - Rate limit exceeded → `{ success: false, error: "Rate limit
 *     exceeded: max <N> images per hour" }`.
 *   - Provider returns `err()` → `{ success: false, error: <message> }`.
 *
 * Response: loose-record. Three variants — failure (`success:
 * false` + `error`), delivered (`success: true, delivered: true,
 * mimeType`), and base64 fallback (`success: true, imageBase64,
 * mimeType`). Tight discriminated-union modeling would pin the variant
 * field-set across daemon-restarts.
 */
export const ImageGenerateContract = defineContract({
  method: "image.generate",
  request: z.object({
    prompt: z.string().optional(),
    size: z.string().optional(),
    // CFG-02 (Pitfall 5): the handler `.parse`s this request — without growing
    // it, `params.model`/`params.reference_image` are typed `undefined` to the
    // handler even though Zod would pass unknown keys through at runtime. Plan 03
    // consumes these typed fields (IN-01 reference resolution + IN-02 model
    // validation). Additive: existing prompt/size callers are unaffected.
    model: z.string().optional(),
    // A workspace file path / url / data-uri STRING (resolved by the handler).
    reference_image: z.string().optional(),
  }),
  response: z.record(z.string(), z.unknown()),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// video.generate
// ---------------------------------------------------------------------------

/**
 * `video.generate` — generate a video via the agent's main provider's video
 * backend (or explicit FAL), through one `VideoGenerationPort` whose inline
 * `execute()` does submit→poll→download. Applies a per-agent rate limit + a
 * PRE-submit worst-case cost ceiling (SEC-02, I6) + direct channel delivery
 * (via `adapter.sendAttachment` with `AttachmentPayload.type:"video"`) OR a
 * size-capped base64 fallback when no channel context is present (DEL-04).
 *
 * Request: `prompt` plus the optional fields `duration` / `aspect_ratio` /
 * `resolution` / `audio` / `negative_prompt` / `seed` / `image_url`
 * (SSRF-guarded workspace path / url / data-uri for image-to-video) / `model`
 * (a provider-default endpoint override). The fields are additive (prompt-only
 * callers are unaffected) and exist on the parsed request so the handler
 * (Plan 04) sees them typed. Only the allowlisted request shapes
 * (z.string()/z.number()/z.boolean()/.optional()) are used — NO `.url()` /
 * `.regex()` refinements (the 12-shape contract allowlist; the handler enforces
 * SSRF on `image_url`).
 *
 * Response: loose-record — forward-compat the delivered / base64 / failure
 * variants across daemon-restarts (the ImageGenerateContract precedent).
 */
export const VideoGenerateContract = defineContract({
  method: "video.generate",
  request: z.object({
    prompt: z.string().optional(),
    duration: z.number().optional(),
    aspect_ratio: z.string().optional(),
    resolution: z.string().optional(),
    audio: z.boolean().optional(),
    negative_prompt: z.string().optional(),
    seed: z.number().optional(),
    image_url: z.string().optional(),
    model: z.string().optional(),
  }),
  response: z.record(z.string(), z.unknown()),
  scopes: ["rpc"] as const,
});

/**
 * `video.status` — read the status/progress/result of a video-generation job
 * by its opaque job handle (the `jobId` `video.generate` returned at submit),
 * SCOPED to the calling agent. The Phase-189 async lifecycle: `video.generate`
 * submits + returns a handle; the background poller drives the render to
 * completion off-turn; `video.status{job_id}` reports the durable terminal state.
 *
 * AGENT-SCOPED (JOB-04 / TARGET-01): the handler resolves the agent explicitly
 * and reads `videoJobStore.get(job_id, agentId)` — a job belonging to ANOTHER
 * agent returns not-found (`{state:"failed", error:"No video job <id> for this
 * agent"}`), NEVER the other agent's mediaPath/cost (threat T-189-10).
 *
 * Request: `job_id` (the opaque, secret-free provider request id — T-189-12;
 * echoing an unknown id in the not-found error leaks nothing).
 *
 * Response: `state` is a CLOSED `z.enum(["pending","done","failed"])` (O4 — the
 * enum tightens the contract over the loose-record `video.generate` handle);
 * `progress` / `mediaPath` / `costUsd` / `error` are present per terminal state.
 * Only the allowlisted request/response shapes are used (z.string()/z.number()/
 * z.enum/.optional()) — NO `.url()`/`.regex()` refinements (the 12-shape allowlist).
 */
export const VideoStatusContract = defineContract({
  method: "video.status",
  request: z.object({ job_id: z.string() }),
  response: z.object({
    state: z.enum(["pending", "done", "failed"]),
    progress: z.number().optional(),
    mediaPath: z.string().optional(),
    costUsd: z.number().optional(),
    error: z.string().optional(),
  }),
  scopes: ["rpc"] as const,
});

// ===========================================================================
// Domain array — appended to API_CONTRACTS_ORDERED in index.ts.
// ===========================================================================

/**
 * 18 contracts spanning the media + image + video umbrella (15 from
 * media-handlers.ts + 1 from image-handlers.ts + 2 from video-handlers.ts +
 * video-status-handlers.ts), grouped by handler file in handler-factory
 * PropertyAssignment order. The order within this array is documentation-only;
 * the bidirectional 1:1 architecture test treats `MEDIA_CONTRACTS` as an
 * unordered set.
 *
 * NOTE: `video.status`'s daemon handler (`createVideoStatusHandlers`) lands in
 * Phase 189 Plan 03 in the SAME wave the contract is declared, so the
 * bidirectional handler-parity gate and the web codegen drift gate both see it
 * closed within this plan (no cross-wave strand — the 188 BLOCKER-1 class).
 */
export const MEDIA_CONTRACTS = [
  // media-handlers.ts (15)
  ImageAnalyzeContract,
  TtsSynthesizeContract,
  TtsAutoCheckContract,
  LinkProcessContract,
  AudioTranscribeContract,
  MediaTranscribeContract,
  MediaDescribeVideoContract,
  MediaExtractDocumentContract,
  MediaTestSttContract,
  MediaTestTtsContract,
  MediaTestVisionContract,
  MediaTestDocumentContract,
  MediaTestVideoContract,
  MediaTestLinkContract,
  MediaProvidersContract,
  // image-handlers.ts (1)
  ImageGenerateContract,
  // video-handlers.ts (1) + video-status-handlers.ts (1)
  VideoGenerateContract,
  VideoStatusContract,
] as const;
