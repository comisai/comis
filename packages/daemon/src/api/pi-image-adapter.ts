// SPDX-License-Identifier: Apache-2.0
// @allow-throw: integration/SDK boundary. `toImageGenOutput` throws a classified
// `ImageGenError` internally; every throw is caught by `fromPromise` at the
// `execute()` boundary and converted to a `Result` err — no throw escapes the
// port (the same boundary-throw discipline the relegated skills fal-adapter used).
/**
 * The single pi-ai image shim (I1 keystone).
 *
 * `createPiImageAdapter` implements `ImageGenerationPort.execute()` over EXACTLY
 * ONE `generateImages` call site. pi-ai owns dispatch, cost, retries, abort,
 * and the `ImagesOptions` plumbing; this module only:
 *   1. forwards the full `ImagesOptions` set (PI-03),
 *   2. maps a successful `AssistantImages` → `{ buffer, mimeType }` (PI-01),
 *   3. classifies any non-`"stop"` outcome to an `ImageErrorKind` (Plan-01
 *      domain union) and surfaces it as a `Result` err — never a throw.
 *
 * `registerComisImageProviders()` is the once-at-boot registration hook (PI-02);
 * for Phase 183 the only image transport is the built-in `openrouter-images`
 * (auto-registered by pi-ai on import), so this is a near-noop whose forward
 * seam is where the custom `openai-codex-images` / `openai-images` /
 * `google-images` transports get registered in Phases 184/185.
 *
 * Placement: `@comis/daemon` (NOT `@comis/skills`) — pi-ai is a daemon
 * dependency, not a skills one. The design's skills placement is infeasible.
 *
 * @module
 */
import {
  generateImages,
  getImagesApiProvider,
  registerImagesApiProvider,
  type AssistantImages,
  type ImageContent,
  type ImagesModel,
  type ProviderImagesOptions,
} from "@earendil-works/pi-ai";
import {
  IMAGE_ERR_TO_LOG,
  type ImageErrorKind,
  type ImageGenInput,
  type ImageGenOutput,
  type ImageGenerationPort,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { fromPromise, type Result } from "@comis/shared";
import { generateImagesCodex } from "./codex-images-transport.js";
import { generateImagesOpenAI } from "./openai-images-transport.js";
import { generateImagesGoogle } from "./google-images-transport.js";

/**
 * Typed error carrying the domain `ImageErrorKind` + an operator-facing hint.
 *
 * The adapter throws this inside the `execute()` boundary (caught by
 * `fromPromise`), so the resulting `Result` err carries a structured error —
 * NOT a message-only/string-encoded one. Plan 04's `makeUnavailableImagePort`
 * + `extractImageHint` construct/read this exact shape, so the typed-class form
 * is the cross-plan contract. The `message` is user-safe (never echoes the raw
 * provider error, which could contain a key).
 */
export class ImageGenError extends Error {
  readonly imageErrorKind: ImageErrorKind;
  readonly hint: string;

  constructor(message: string, opts: { imageErrorKind: ImageErrorKind; hint: string }) {
    super(message);
    this.name = "ImageGenError";
    this.imageErrorKind = opts.imageErrorKind;
    this.hint = opts.hint;
  }
}

/** User-safe message per domain error kind (no provider internals, no secrets). */
const SAFE_MESSAGE: Record<ImageErrorKind, string> = {
  content_blocked: "Image request was blocked by the provider's safety system.",
  auth_required: "Image generation is not authenticated for the selected provider.",
  quota_exceeded: "Image generation quota or rate limit was exceeded.",
  timeout: "Image generation timed out or was aborted.",
  unsupported_provider: "The selected provider cannot generate images.",
  empty_response: "The image provider returned no image.",
};

/** Operator-facing hint per domain error kind (rides the WARN log + the err). */
const ERROR_HINT: Record<ImageErrorKind, string> = {
  content_blocked: "Adjust the prompt; the provider's safety filter rejected it.",
  auth_required:
    "Provide the provider's credential (e.g. OPENROUTER_API_KEY) via the same secret store the main provider uses.",
  quota_exceeded: "Wait for the quota window to reset or raise the provider plan limit.",
  timeout: "Increase integrations.media.imageGeneration.timeoutMs or retry.",
  unsupported_provider:
    "Set integrations.media.imageGeneration.provider to an image-capable provider (e.g. \"openrouter\").",
  empty_response: "Retry; the provider returned a non-image response.",
};

/**
 * Classify a non-`"stop"` `AssistantImages` to a domain `ImageErrorKind`.
 *
 * Order matters — first match wins. Keyed off `stopReason` + a lowercased
 * `errorMessage` substring scan (the raw message is inspected here ONLY for
 * classification; it is never logged or surfaced to the user).
 */
function classifyImageError(res: AssistantImages): ImageErrorKind {
  if (res.stopReason === "aborted") return "timeout";
  const msg = (res.errorMessage ?? "").toLowerCase();
  if (/content|blocked|safety|moderat|nsfw/.test(msg)) return "content_blocked";
  if (/no api key|unauthor|forbidden|invalid api key|401|403|auth/.test(msg)) return "auth_required";
  if (/quota|rate limit|rate-limit|ratelimit|too many|429|insufficient|credit/.test(msg)) {
    return "quota_exceeded";
  }
  if (/timed out|timeout|deadline|etimedout/.test(msg)) return "timeout";
  return "empty_response";
}

/**
 * Map a pi-ai `AssistantImages` to the port's `ImageGenOutput`, or throw a
 * classified `ImageGenError` (caught by `fromPromise` at the `execute()`
 * boundary → `Result` err). Logs a WARN with `{ errorKind, imageErrorKind,
 * hint }` on every failure branch (§2.7 — never the key, never the raw
 * provider message).
 */
// Exported for INTRA-PACKAGE reuse (`codex-image-adapter.ts` imports it via
// `./pi-image-adapter.js`) — deliberately NOT added to the daemon barrel: the
// public-export-consumers gate (commit `e8a5e3bd` dropped dead barrel exports)
// requires an in-repo barrel consumer, and there is none. A file-to-file import
// is the in-package consumer and does not trip that gate.
// classifyImageError/SAFE_MESSAGE/ERROR_HINT stay private — toImageGenOutput
// already encapsulates them.
export function toImageGenOutput(res: AssistantImages, logger: ComisLogger): ImageGenOutput {
  if (res.stopReason === "stop") {
    const img = res.output.find((o): o is ImageContent => o.type === "image");
    if (img) {
      // 186: also map costUsd from res.usage?.cost.total, model from res.model,
      // provider from res.provider (additive ImageGenOutput change, deferred).
      return { buffer: Buffer.from(img.data, "base64"), mimeType: img.mimeType };
    }
    // stop but no image content → empty response.
    const kind: ImageErrorKind = "empty_response";
    logger.warn(
      { errorKind: IMAGE_ERR_TO_LOG[kind], imageErrorKind: kind, hint: ERROR_HINT[kind] },
      "image generation returned no image content",
    );
    throw new ImageGenError(SAFE_MESSAGE[kind], { imageErrorKind: kind, hint: ERROR_HINT[kind] });
  }

  const kind = classifyImageError(res);
  logger.warn(
    { errorKind: IMAGE_ERR_TO_LOG[kind], imageErrorKind: kind, hint: ERROR_HINT[kind] },
    "image generation failed",
  );
  throw new ImageGenError(SAFE_MESSAGE[kind], { imageErrorKind: kind, hint: ERROR_HINT[kind] });
}

/**
 * Create an `ImageGenerationPort` over a single pi-ai `generateImages` call.
 *
 * @param opts.model      - The `ImagesModel` to drive (built by the caller —
 *                          `getImageModel("openrouter", defaultModel)` for 183).
 * @param opts.apiKey     - Resolved by the caller from the SAME secret source
 *                          the main provider uses (Plan 04); forwarded via
 *                          `ImagesOptions.apiKey` (never interpolated).
 * @param opts.signal     - Optional abort signal (construction-time — the port's
 *                          `ImageGenInput` has no `signal`; widening it is a
 *                          deferred additive port change, not this plan).
 */
export function createPiImageAdapter(opts: {
  model: ImagesModel<string>;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  logger: ComisLogger;
}): ImageGenerationPort {
  return {
    id: opts.model.provider,
    // Boolean per the port contract. Honest-unavailable (no creds / incapable
    // provider) is decided by Plan 04's resolver and surfaces from execute().
    isAvailable: () => true,
    execute(input: ImageGenInput): Promise<Result<ImageGenOutput, Error>> {
      // PI-03 passthrough — every ImagesOptions field forwarded. Typed as the
      // SDK's ProviderImagesOptions (= ImagesOptions & Record<string,unknown>).
      const options: ProviderImagesOptions = {
        apiKey: opts.apiKey,
        headers: opts.headers,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        maxRetries: opts.maxRetries ?? 1,
      };
      return fromPromise(
        (async () => {
          // ── THE ONE generateImages call site (I1) ─────────────────────────
          // IN-04 (183-REVIEW): only `input.prompt` is forwarded. `input.size`
          // and `input.safetyChecker` (passed by the handler) are NOT yet
          // mapped for the pi path — pi-ai's `ImagesContext` exposes only
          // `input`, and `ImagesOptions` has no `size`/`safetyChecker` field,
          // so forwarding them needs a provider-specific payload mapping
          // (e.g. via `onPayload`/`metadata`). Deferred to Phase 185 (custom
          // transports) — mirrors the cost/model deferral in `toImageGenOutput`
          // above. Until then an operator/agent-supplied `size` has no effect
          // on the openrouter built-in (a feature gap, not a misroute/crash).
          //
          // IN-01 (185): append the resolved reference image as a SECOND
          // ImageContent element ONLY when present (edit/img2img). The
          // openai-images transport routes it to images.edit, the
          // google-images transport to an inlineData part. Absence keeps the
          // array EXACTLY [{type:"text"}] — byte-identical to the text-only
          // path so the SHARED openrouter built-in + codex transports cannot
          // regress (Pitfall 3). `input.model` is consumed at the SELECTOR
          // (sel.model → the model literal id, Plan 02), NOT re-read here.
          const inputContent: Array<
            { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
          > = [{ type: "text", text: input.prompt }];
          if (input.referenceImage) {
            inputContent.push({
              type: "image",
              data: input.referenceImage.data,
              mimeType: input.referenceImage.mimeType,
            });
          }
          const res = await generateImages(opts.model, { input: inputContent }, options);
          return toImageGenOutput(res, opts.logger);
        })(),
      );
    },
  };
}

/**
 * Map an image `ImagesApi` to the env-key name its credential lives under, then
 * read it from the SAME `SecretManager` the main provider uses (CRED-01
 * resolution half) — never the raw environment.
 *
 * For Phase 183 only the built-in `openrouter-images` path is exercised
 * (`OPENROUTER_API_KEY`). The codex transport (`openai-codex-images`) resolves
 * its bearer via `OAuthTokenManager` in Phase 184 — added to this switch then.
 */
export function resolveImageApiKey(
  imagesApi: string,
  secretManager: { get(key: string): string | undefined },
): string | undefined {
  switch (imagesApi) {
    case "openrouter-images":
      return secretManager.get("OPENROUTER_API_KEY");
    case "openai-images":
      return secretManager.get("OPENAI_API_KEY");
    case "google-images":
      // CRED-01 lockstep (185): GOOGLE_API_KEY — the SAME key the completion
      // path (DEFAULT_PROVIDER_KEYS.google), the vision provider registry, and
      // the env-vars docs all use for the `google` provider. (Was GEMINI_API_KEY
      // — a speculative 183 stub that would have reported a GOOGLE_API_KEY-only
      // agent image-unavailable.)
      return secretManager.get("GOOGLE_API_KEY");
    // "openai-codex-images" → OAuthTokenManager.getApiKey("openai-codex") in Phase 184.
    default:
      return undefined;
  }
}

/**
 * Register Comis's custom image-api providers with pi-ai's module-level
 * registry — ONCE at daemon boot, BEFORE any `generateImages` call (PI-02).
 *
 * Idempotent and safe to call repeatedly (the registry is a Map keyed by api).
 * The built-in `openrouter-images` is auto-registered by pi-ai on import; this
 * is the single place where Comis's CUSTOM transports land. Phase 184 registers
 * the Codex Responses transport (`openai-codex-images`); Phase 185 registers the
 * two genuinely-new SDK transports (`openai-images` + `google-images`).
 */
export function registerComisImageProviders(): void {
  // 184: the custom Codex Responses image transport (CDX-02/03). The built-in
  // openrouter-images provider is auto-registered on pi-ai import
  // (register-builtins.ts); this adds the transports pi-ai lacks. Idempotent
  // — the registry is a Map keyed by api, so re-registration is a harmless set.
  registerImagesApiProvider({ api: "openai-codex-images", generateImages: generateImagesCodex });
  // 185 (PRV-01/02): the two SDK transports, dispatched by model.api through the
  // ONE generateImages call site. Registered here so the selector's
  // createPiImageAdapter path can reach them (the built-but-not-wired guard).
  registerImagesApiProvider({ api: "openai-images", generateImages: generateImagesOpenAI });
  registerImagesApiProvider({ api: "google-images", generateImages: generateImagesGoogle });
  // getImagesApiProvider is the round-trip read side (used by callers + tests);
  // touched here so the once-at-boot import surface stays honest.
  void getImagesApiProvider;
}
