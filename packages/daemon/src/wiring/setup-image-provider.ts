// SPDX-License-Identifier: Apache-2.0
/**
 * Image-provider SELECTION (RES-02/RES-03/CRED-01).
 *
 * `createImageProviderSelector` returns a lazy getter (read-on-use at boot —
 * mirrors `createImageGenProviderFactory` in setup-media.ts) that, per the
 * resolved config + the agent's main provider, decides between:
 *   - the Plan-03 pi-image-adapter (provider:"auto" / pi-ai-backed providers),
 *     following the main provider via the Plan-01 `resolveImageProvider` and
 *     resolving the key from the SAME `SecretManager` the main provider uses
 *     (CRED-01 — no image-specific secret); or
 *   - the relegated skills adapter (explicit `fal`/`openai`, additive legacy
 *     path); or
 *   - an honest-unavailable port (carrying the knob-naming hint) for an
 *     image-incapable main (RES-03) — NEVER a misroute to a different paid
 *     provider, NEVER silence.
 *
 * The selector NEVER reads the raw environment (creds via `SecretManager`
 * only) and NEVER re-derives selection in the handler (RES-01 keystone: one
 * source of truth — `resolveImageProvider`).
 *
 * Placement: `@comis/daemon` (pi-ai is a daemon dep, not a skills one). Kept in
 * a dedicated file (not folded into setup-media.ts) so the skills-only
 * setup-media module gains no pi-ai / core-media import edge.
 *
 * @module
 */

import { getImageModel, getImageModels } from "@earendil-works/pi-ai";
import {
  resolveImageProvider,
  type ImageErrorKind,
  type ImageGenerationConfig,
  type ImageGenerationPort,
  type OAuthTokenManager,
  type SecretManager,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { err, type Result } from "@comis/shared";
import {
  createPiImageAdapter,
  resolveImageApiKey,
  ImageGenError,
} from "../api/pi-image-adapter.js";
import { createCodexImageAdapter, CODEX_IMAGE_MODEL } from "../api/codex-image-adapter.js";
import { OPENAI_IMAGE_MODEL } from "../api/openai-images-transport.js";
import { GOOGLE_IMAGE_MODEL } from "../api/google-images-transport.js";

/**
 * A port whose `execute()` always returns a classified `ImageGenError` Result
 * err — the RES-03 honest-unavailable carrier. The agent gets a hint (naming
 * the binding config knob), not silence. `isAvailable()` is `false` so callers
 * that probe it know it cannot serve.
 */
export function makeUnavailableImagePort(
  errorKind: ImageErrorKind,
  hint: string,
  logger: ComisLogger,
): ImageGenerationPort {
  return {
    id: "unavailable",
    isAvailable: () => false,
    execute: (): Promise<Result<never, Error>> => {
      logger.debug(
        { imageErrorKind: errorKind, hint, step: "image_unavailable" },
        "Image generation unavailable for the resolved provider",
      );
      return Promise.resolve(
        err(new ImageGenError(hint, { imageErrorKind: errorKind, hint })),
      );
    },
  };
}

/**
 * Build the lazy image-provider selector. Returns a getter that reads the
 * config + `secretManager` on use; in practice the daemon invokes it ONCE at
 * boot (`daemon.ts` `getImageGenProvider()`), and the handler then holds that
 * boot-built adapter instance — so key rotation requires a daemon restart to
 * take effect (NOT live per-request; IN-01 183-REVIEW). Returns `undefined`
 * only when image generation is unconfigured (`imageGenConfig` absent) — an
 * image-incapable main yields an unavailable PORT (RES-03), never `undefined`,
 * so the handler is still constructed and surfaces the hint.
 */
export function createImageProviderSelector(deps: {
  imageGenConfig: ImageGenerationConfig | undefined;
  secretManager: SecretManager;
  /** Resolved at boot for the DEFAULT agent (the common case for Phase 183). */
  mainProviderId: string;
  /** The existing skills fal/openai getter (createImageGenGetter). */
  legacyGetter: () => ImageGenerationPort | undefined;
  logger: ComisLogger;
  /**
   * The DEFAULT agent's OAuthTokenManager (184). The codex credential is OAuth,
   * not a SecretManager env key — so codex availability + the per-call bearer
   * resolve through this manager, NOT `resolveImageApiKey`. Surfaced from
   * setupAgents → buildImageGenBundle (the composition-root threading gap).
   * Absent (undefined) → codex is honest-unavailable (never a crash).
   */
  oauthManager?: OAuthTokenManager;
  /** The DEFAULT agent's `Record<provider, profileId>` map (for getApiKey). */
  oauthProfiles?: Record<string, string>;
  /**
   * STORE-AWARE Codex availability, resolved ONCE by the async caller
   * (`buildImageGenBundle` via `oauthManager.hasStoredCredentials("openai-codex")`)
   * and passed in as a sync snapshot — so the selector + the pure resolver stay
   * synchronous. This is the AUTHORITATIVE Codex gate: it sees a logged-in
   * profile in the PERSISTED store even when the in-memory cache is cold at boot
   * (encrypted-store mode), which the sync `hasCredentials` could not — the bug
   * that froze a Codex agent's image generation unavailable despite text working.
   * When omitted (callers/tests that don't pre-resolve it) the gate falls back to
   * the sync `oauthManager.hasCredentials` (the pre-fix behavior).
   */
  codexCredentialsAvailable?: boolean;
  /**
   * The agent's resolved CHAT model id (e.g. "gpt-5.5") for the follow-main
   * Codex path. The Codex Responses endpoint rejects the image-API model id
   * "gpt-image-1" with HTTP 400 ("returned a non-image response" — verified live)
   * — it needs a valid CHAT model with `image_generation` as a TOOL. Threaded
   * from buildImageGenBundle (the SAME resolveAgentModel the completion path
   * uses) into the codex adapter's request model. Absent ⇒ the legacy
   * CODEX_IMAGE_MODEL default (back-compat for callers/tests).
   */
  codexChatModelId?: string;
}): () => ImageGenerationPort | undefined {
  return () => {
    const cfg = deps.imageGenConfig;
    if (!cfg) return undefined;

    // Explicit fal → the relegated skills adapter (additive legacy path,
    // CFG-01 back-compat). 185 FOLD: `openai` is NO LONGER a legacy provider —
    // it now resolves via the resolver path below (IMAGE_CAPABILITY["openai"] =
    // "openai-images") → the Task-2 selector branch (the registered transport),
    // eliminating the second parallel openai surface (design §5).
    if (cfg.provider === "fal") {
      return deps.legacyGetter();
    }

    // auto / openrouter / openai-codex / google → the pi-ai path via the
    // Plan-01 resolver (one source of truth; creds via SecretManager closure).
    const sel = resolveImageProvider(
      cfg,
      deps.mainProviderId,
      // CRED-01: codex availability is the OAuth credential (the bearer is
      // OAuth, not a SecretManager env key) — so a Codex-only agent with NO
      // FAL_KEY/OPENAI_API_KEY resolves available. The AUTHORITATIVE gate is the
      // store-aware `codexCredentialsAvailable` flag, pre-resolved by the async
      // caller (buildImageGenBundle) via `hasStoredCredentials("openai-codex")`
      // — it sees a logged-in profile in the PERSISTED store even when the
      // in-memory cache is cold at boot (encrypted-store mode), the bug the sync
      // cache-only `hasCredentials` caused (a Codex agent's images froze
      // unavailable for the daemon's life despite text working). Falls back to
      // the sync `hasCredentials` ONLY when the flag was not pre-resolved
      // (callers/tests). Absent manager + no flag → false (honest-unavailable,
      // never a crash). Every other api stays the SecretManager env-key check.
      (imagesApi) =>
        imagesApi === "openai-codex-images"
          ? (deps.codexCredentialsAvailable ??
            deps.oauthManager?.hasCredentials("openai-codex") ??
            false)
          : resolveImageApiKey(imagesApi, deps.secretManager) !== undefined,
      // WR-04 (183-REVIEW): the once-per-resolution follow-main skip is the
      // load-bearing "why did images go unavailable" evidence — promote it to
      // INFO so it is visible at the default log level (§2.7). Per-fallback-
      // entry skips stay DEBUG (they only matter when a chain is configured).
      (reason) =>
        reason.startsWith("follow-main skipped:")
          ? deps.logger.info({ reason, step: "image_follow_main_skip" }, "Image follow-main resolution skipped")
          : deps.logger.debug({ reason, step: "image_fallback_skip" }, "Image fallback entry skipped"),
    );

    if (!sel.ok) {
      // RES-03 honest-unavailable: a port that surfaces the err (handler hint).
      return makeUnavailableImagePort(sel.errorKind, sel.hint, deps.logger);
    }

    // 184: the Codex (ChatGPT-login) per-call-bearer adapter. Keyed EXACTLY on
    // the codex images api — `openai-images`/`google-images` fall through to the
    // not-yet-wired guard below (they land in 185, no scope creep).
    if (sel.imagesApi === "openai-codex-images") {
      // By construction `sel.imagesApi === "openai-codex-images"` is `ok` only
      // when credsAvailable returned true, which requires a present manager
      // (hasCredentials === true). The defensive guard makes that explicit (and
      // keeps the adapter's required `oauthManager` honest) rather than a `!`.
      if (!deps.oauthManager) {
        return makeUnavailableImagePort(
          "auth_required",
          `Codex image generation requires a logged-in "openai-codex" OAuth ` +
            `profile. Run "comis auth login --provider openai-codex", or set ` +
            `integrations.media.imageGeneration.provider.`,
          deps.logger,
        );
      }
      return createCodexImageAdapter({
        oauthManager: deps.oauthManager,
        oauthProfiles: deps.oauthProfiles,
        // Use the agent's CHAT model (e.g. "gpt-5.5") for the Codex Responses
        // request — the endpoint 400s on the image-API model id "gpt-image-1"
        // (verified live); image_generation is a TOOL, not the top-level model.
        // Falls back to CODEX_IMAGE_MODEL when the chat model is not threaded.
        model: deps.codexChatModelId
          ? { ...CODEX_IMAGE_MODEL, id: deps.codexChatModelId }
          : CODEX_IMAGE_MODEL,
        timeoutMs: cfg.timeoutMs,
        logger: deps.logger,
        // Store-aware availability snapshot → the adapter's isAvailable() (so it
        // doesn't fall back to the cold-cache-only hasCredentials).
        credentialsAvailable: deps.codexCredentialsAvailable,
      });
    }

    // 185 (PRV-01/02 — the WIRING KEYSTONE): the openai / google native
    // transports (registered in registerComisImageProviders()). UNLIKE codex,
    // their credential is a STATIC env key (OPENAI_API_KEY / GOOGLE_API_KEY via
    // the FIXED resolveImageApiKey — CRED-01), resolved once at boot — so the
    // generic createPiImageAdapter (which does the generateImages dispatch +
    // mapping) is the right adapter, NOT a per-call-bearer one. The hand-built
    // ImagesModel literal carries the api/provider/default-id; sel.model (the
    // tool/config override) wins over the default when present (IN-02). Keyed
    // EXACTLY on these two apis — every other api still falls through to the
    // honest-unavailable guard below (no misroute).
    if (sel.imagesApi === "openai-images" || sel.imagesApi === "google-images") {
      const apiKey = resolveImageApiKey(sel.imagesApi, deps.secretManager);
      const model = sel.imagesApi === "openai-images" ? OPENAI_IMAGE_MODEL : GOOGLE_IMAGE_MODEL;
      return createPiImageAdapter({
        model: sel.model ? { ...model, id: sel.model } : model,
        apiKey,
        timeoutMs: cfg.timeoutMs,
        logger: deps.logger,
      });
    }

    // Phase 183 wires the built-in openrouter catalog; 184/185 wired
    // codex/openai/google above. Any REMAINING custom transport lands in a later
    // phase — until then, surface an honest-unavailable naming the opt-in path
    // (not a misroute).
    if (sel.imagesApi !== "openrouter-images") {
      return makeUnavailableImagePort(
        "unsupported_provider",
        `Image provider "${sel.imagesApi}" is not yet wired (lands in a later phase). ` +
          `Use provider:"openrouter" + OPENROUTER_API_KEY, or set ` +
          `integrations.media.imageGeneration.provider.`,
        deps.logger,
      );
    }

    const apiKey = resolveImageApiKey(sel.imagesApi, deps.secretManager);
    const model = resolveOpenRouterModel(sel.model ?? sel.defaultModel, deps.logger);
    return createPiImageAdapter({
      model,
      apiKey,
      timeoutMs: cfg.timeoutMs,
      // maxRetries omitted — the adapter's `maxRetries ?? 1` default is the
      // single source of truth (IN-02 183-REVIEW: avoid a duplicated magic 1).
      logger: deps.logger,
    });
  };
}

/**
 * Resolve a runtime model-id string to a built-in openrouter `ImagesModel`.
 *
 * `getImageModel` is typed with a `keyof IMAGE_MODELS["openrouter"]` literal
 * constraint, which a runtime `string` cannot satisfy — so look the id up in
 * the catalog (`getImageModels`) and fall back to the first catalog model when
 * the requested id is not present. The built-in openrouter catalog always has
 * at least one model (Phase 183 default `black-forest-labs/flux.2-pro`).
 *
 * WR-02 (183-REVIEW): when the configured/tool model is NOT in the catalog the
 * fallback would otherwise be a SILENT misroute — the operator's explicit
 * choice discarded with no signal. Emit a WARN naming the unresolved id, the
 * fallback, the binding knob, and an `errorKind` so the substitution is
 * observable at the default log level (§2.7 anti-silent-misroute).
 */
function resolveOpenRouterModel(
  modelId: string,
  logger: ComisLogger,
): ReturnType<typeof getImageModel> {
  const models = getImageModels("openrouter");
  const match = models.find((m) => m.id === modelId);
  if (!match) {
    logger.warn(
      {
        requestedModel: modelId,
        fallbackModel: models[0]?.id,
        errorKind: "config" as const,
        hint: "Set integrations.media.imageGeneration.model to a model in the openrouter image catalog.",
        step: "image_model_substituted",
      },
      "Configured image model not found in catalog; falling back to first catalog model",
    );
  }
  // `as` narrows the union element to the concrete return type; both are an
  // ImagesModel over the openrouter image apis — assignable at the call site.
  return (match ?? models[0]) as ReturnType<typeof getImageModel>;
}
