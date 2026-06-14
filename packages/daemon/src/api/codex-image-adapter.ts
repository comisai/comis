// SPDX-License-Identifier: Apache-2.0
// @allow-throw: integration/SDK boundary. The `execute()` async throws a
// classified `ImageGenError` (auth failure) or lets the reused
// `toImageGenOutput` throw one (provider failure); EVERY throw is caught by
// `fromPromise` at the `execute()` boundary and converted to a `Result` err —
// no throw escapes the port. Mirrors the pi-image-adapter.ts precedent.
/**
 * Per-call-bearer Codex image adapter (CDX-01 + CDX-02 wiring).
 *
 * An `ImageGenerationPort` for the Codex (ChatGPT-login) provider that, on
 * EVERY `execute()`:
 *   1. resolves the OAuth bearer via `oauthManager.getApiKey("openai-codex",
 *      {oauthProfiles})` — PER CALL, so an expired token refreshes inside
 *      getApiKey (CDX-01). `getApiKey` self-short-circuits on a still-valid
 *      token (60s buffer), so per-call is cheap in the common case.
 *   2. on a `!ok` result (any `OAuthError.code`: NO_CREDENTIALS / REFRESH_FAILED
 *      / PROFILE_NOT_FOUND / …) → throws a typed `ImageGenError(auth_required)`
 *      with a `comis auth login` hint (success-criterion 3). The image port
 *      maps ALL auth-resolution failures to `auth_required` (it never falls
 *      through to a plain key — unlike the completion path).
 *   3. builds the CF headers from THAT SAME freshly-resolved bearer's JWT
 *      (`buildCodexImageHeaders` — one JWT → its own account-id, so the
 *      identity cannot diverge from the credential), and
 *   4. drives the ONE `generateImages()` call site, mapping the result via the
 *      reused `toImageGenOutput` (base64→buffer + classify + WARN).
 *
 * Why a separate adapter (not `createPiImageAdapter`): the shipped pi adapter
 * resolves `apiKey` at construction — correct for openrouter's static
 * SecretManager key, WRONG for an expiring OAuth bearer. This keeps the
 * openrouter static-key path untouched (no regression).
 *
 * The custom `openai-codex-images` transport (`generateImagesCodex`) must be
 * registered in pi-ai's registry before this adapter runs (Plan 02's PI-02
 * seam extension); this file does not register it.
 *
 * SEC-03 (Pitfall 3): the bearer flows ONLY via `ImagesOptions.apiKey`, the CF
 * headers ONLY via `ImagesOptions.headers`; neither is ever logged. The only
 * log surface is `toImageGenOutput`'s WARN (`{errorKind, imageErrorKind,
 * hint}` — never the key/account-id/headers).
 *
 * @module
 */
import { type ImagesModel, generateImages, type ProviderImagesOptions } from "@earendil-works/pi-ai";
import {
  type OAuthTokenManager,
  type ImageGenInput,
  type ImageGenOutput,
  type ImageGenerationPort,
  systemSetTimeout,
  systemClearTimeout,
} from "@comis/core";
import { fromPromise, type Result } from "@comis/shared";
import type { ComisLogger } from "@comis/infra";
import { ImageGenError, toImageGenOutput } from "./pi-image-adapter.js";
import { buildCodexImageHeaders } from "./codex-images-transport.js";

/** The Codex OAuth provider id (distinct from "openai"). */
const CODEX_PROVIDER_ID = "openai-codex";

/**
 * Hand-built codex `ImagesModel` (Pitfall 5 — pi-ai's image catalog is
 * openrouter-only, so `getImageModel("openai-codex", …)` has no entry). The
 * transport reads only `model.baseUrl`/`model.id`/`model.api`/`model.provider`.
 * `cost: 0` is fine for 184 — real cost mapping is Phase 186 (OBS-03). The
 * model id is overridable later by config/tool (A2); for 184 it defaults to
 * `gpt-image-1` (the hosted tool may select the image model server-side under
 * `tool_choice:image_generation` regardless of this top-level value).
 */
export const CODEX_IMAGE_MODEL: ImagesModel<"openai-codex-images"> = {
  id: "gpt-image-1",
  name: "Codex Image (gpt-image-1)",
  api: "openai-codex-images",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  input: ["text"],
  output: ["image", "text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/**
 * Create the per-call-bearer Codex `ImageGenerationPort`.
 *
 * @param opts.oauthManager  - The per-agent OAuth manager (its `getApiKey`
 *   refreshes inside on expiry; `hasCredentials` backs `isAvailable`).
 * @param opts.oauthProfiles - The agent's `Record<provider, profileId>` map,
 *   passed to `getApiKey` for per-agent profile preference.
 * @param opts.model         - Optional override of {@link CODEX_IMAGE_MODEL}.
 * @param opts.timeoutMs     - Optional HTTP timeout (ms). WR-02 (184-REVIEW):
 *   the custom codex transport does NOT honor `ImagesOptions.timeoutMs` (only
 *   pi-ai's openrouter builtin does), so the adapter enforces it here by
 *   aborting the request's `AbortSignal` after `timeoutMs` — a hung SSE stream
 *   surfaces as `imageErrorKind:"timeout"` instead of blocking forever.
 * @param opts.logger        - Logger for the `toImageGenOutput` WARN path.
 */
export function createCodexImageAdapter(opts: {
  oauthManager: OAuthTokenManager;
  oauthProfiles?: Record<string, string>;
  model?: ImagesModel<"openai-codex-images">;
  timeoutMs?: number;
  logger: ComisLogger;
}): ImageGenerationPort {
  return {
    id: CODEX_PROVIDER_ID,
    // CRED-01: codex credential availability is the OAuth manager, NOT the
    // SecretManager (the bearer is OAuth, not an env key).
    isAvailable: () => opts.oauthManager.hasCredentials(CODEX_PROVIDER_ID),
    execute(input: ImageGenInput): Promise<Result<ImageGenOutput, Error>> {
      return fromPromise(
        (async () => {
          // CDX-01: resolve the bearer PER CALL — refresh fires inside getApiKey
          // on expiry; self-short-circuits when the cached token is still valid.
          const tok = await opts.oauthManager.getApiKey(CODEX_PROVIDER_ID, {
            oauthProfiles: opts.oauthProfiles,
          });
          if (!tok.ok) {
            // ALL !ok codes (NO_CREDENTIALS / REFRESH_FAILED / PROFILE_NOT_FOUND
            // / NO_PROVIDER / STORE_FAILED) → honest auth_required + login hint.
            // Never logged here — the absent/failed bearer is not surfaced.
            throw new ImageGenError("Codex image generation is not authenticated.", {
              imageErrorKind: "auth_required",
              hint: 'Run "comis auth login --provider openai-codex" to authenticate.',
            });
          }
          const bearer = tok.value;
          // WR-02 (184-REVIEW): the custom codex transport never reads
          // `options.timeoutMs` (it is only honored by pi-ai's openrouter
          // builtin), so a hung SSE stream would block `reader.read()` — and
          // this image RPC + a rate-limiter slot — forever. Enforce the timeout
          // HERE by aborting the request's signal after `timeoutMs`. The
          // transport already maps `signal.aborted → stopReason:"aborted" →
          // timeout`, so the abort surfaces as `imageErrorKind:"timeout"`.
          const ac = new AbortController();
          const timer =
            opts.timeoutMs && opts.timeoutMs > 0
              ? systemSetTimeout(() => ac.abort(), opts.timeoutMs)
              : undefined;
          try {
            // CDX-02: headers from the SAME freshly-resolved JWT (one JWT → its
            // own account-id; cannot diverge — T-184-05). The bearer rides
            // options.apiKey; the headers ride options.headers. Neither is
            // logged. WR-03 (184-REVIEW): no `maxRetries` — the custom codex
            // transport is single-shot (it has no retry loop and never reads
            // `options.maxRetries`), so the option would be a lie.
            const options: ProviderImagesOptions = {
              apiKey: bearer,
              headers: buildCodexImageHeaders(bearer),
              signal: ac.signal,
            };
            // ── THE ONE generateImages call site (I1) ───────────────────────
            const res = await generateImages(
              opts.model ?? CODEX_IMAGE_MODEL,
              { input: [{ type: "text", text: input.prompt }] },
              options,
            );
            // REUSE the shipped mapper/classifier (base64→buffer; classify a
            // non-stop outcome to an ImageErrorKind + WARN; throw ImageGenError).
            return toImageGenOutput(res, opts.logger);
          } finally {
            if (timer) systemClearTimeout(timer);
          }
        })(),
      );
    },
  };
}
