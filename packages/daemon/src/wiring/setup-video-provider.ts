// SPDX-License-Identifier: Apache-2.0
/**
 * Video-provider SELECTION (RES-01/RES-02/RES-03/CRED-01, Phase 188 + 190).
 *
 * `createVideoProviderSelector` returns a lazy getter (read-on-use at boot —
 * mirrors `createImageProviderSelector` in setup-image-provider.ts) that, per the
 * resolved config + the agent's main provider, decides between:
 *   - the skills FAL adapter (explicit `provider:"fal"`, via the `legacyGetter` →
 *     `createVideoGenProvider`); or
 *   - the follow-main LIVE adapter via the Plan-01 `resolveVideoProvider` (one
 *     source of truth), resolving creds from the SAME `SecretManager`/
 *     `OAuthTokenManager` the main provider uses (CRED-01 — no video-specific
 *     secret, I9): `auto`+`google`→`createVeoVideoAdapter` (GOOGLE_API_KEY,
 *     static-key) / `auto`+`xai`→`createGrokVideoAdapter` (XAI_API_KEY key-primary,
 *     with a defensive forward-looking SuperGrok-OAuth branch — A1: no xAI OAuth
 *     provider is registered yet, so key-auth is the proven path); or
 *   - an honest-unavailable port (carrying the resolver's knob-naming hint) for a
 *     video-incapable main (RES-03), or for a capable main with no credential —
 *     NEVER a misroute to a different paid provider, NEVER silence.
 *
 * The selector selects ONCE here (one source of truth — `resolveVideoProvider`);
 * the handler NEVER re-derives selection (the RES-01 keystone / the v2.20
 * keyless-summarizer two-source firewall). It reads creds via `SecretManager` /
 * the `OAuthTokenManager`, never the raw environment.
 *
 * Placement: `@comis/daemon` (the boot selector is daemon-side; the FAL adapter
 * itself lives in `@comis/skills` where `@fal-ai/client` is the dep — no phantom
 * dep edge into the daemon).
 *
 * @module
 */

import {
  resolveVideoProvider,
  VideoGenError,
  type OAuthTokenManager,
  type SecretManager,
  type VideoErrorKind,
  type VideoGenerationConfig,
  type VideoGenerationPort,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { err, type Result } from "@comis/shared";
import { createVeoVideoAdapter } from "../api/veo-adapter.js";
import { createGrokVideoAdapter, XAI_OAUTH_PROVIDER_ID } from "../api/grok-adapter.js";

/**
 * A port whose every method returns a classified `VideoGenError` Result err —
 * the RES-03 honest-unavailable carrier. The agent gets a hint (naming the
 * binding config knob, or the missing credential for a capable main), not
 * silence. `isAvailable()` is `false` so callers that probe it know it cannot serve.
 */
export function makeUnavailableVideoPort(
  errorKind: VideoErrorKind,
  hint: string,
  logger: ComisLogger,
): VideoGenerationPort {
  const fail = (): Promise<Result<never, Error>> => {
    logger.debug(
      { videoErrorKind: errorKind, hint, step: "video_unavailable" },
      "Video generation unavailable for the resolved provider",
    );
    return Promise.resolve(err(new VideoGenError(hint, { videoErrorKind: errorKind, hint })));
  };
  return {
    id: "unavailable",
    isAvailable: () => false,
    submit: fail,
    poll: fail,
    fetchResult: fail,
    execute: fail,
  };
}

/**
 * Build the lazy video-provider selector. Returns a getter that reads the config
 * + `secretManager` on use; in practice the daemon invokes it ONCE at boot
 * (`buildVideoGenBundle`), and the handler then holds that boot-built port — so
 * key rotation requires a daemon restart to take effect (NOT live per-request;
 * parity with the image selector). Returns `undefined` only when video generation
 * is unconfigured (`videoGenConfig` absent) — a video-incapable main yields an
 * unavailable PORT (RES-03), never `undefined`, so the handler is still
 * constructed and surfaces the hint.
 */
export function createVideoProviderSelector(deps: {
  videoGenConfig: VideoGenerationConfig | undefined;
  secretManager: SecretManager;
  /** Resolved at boot for the DEFAULT agent (the common case for Phase 188). */
  mainProviderId: string;
  /** The skills `createVideoGenProvider` getter (explicit `fal` path). */
  legacyGetter: () => VideoGenerationPort | undefined;
  logger: ComisLogger;
  /**
   * The DEFAULT agent's OAuthTokenManager (190 / CRED-01). The Grok video path
   * resolves a SuperGrok OAuth bearer through this manager when no XAI_API_KEY is
   * present. Surfaced from setupAgents → buildVideoGenBundle (the buildImageGenBundle
   * precedent). Absent → grok is key-only (honest-unavailable without a key, never a
   * crash). A1: no xAI OAuth provider is registered yet, so this branch is
   * forward-looking; key-auth is the proven primary.
   */
  oauthManager?: OAuthTokenManager;
  /** The DEFAULT agent's `Record<provider, profileId>` map (for getApiKey). */
  oauthProfiles?: Record<string, string>;
}): () => VideoGenerationPort | undefined {
  return () => {
    const cfg = deps.videoGenConfig;
    if (!cfg) return undefined;

    // Explicit `fal` → the skills FAL queue adapter (the Plan-03 factory). Its
    // concrete adapter path is wired separately; the resolver below treats `fal`
    // as honest-unavailable by design (explicit-only, no follow-main capability).
    if (cfg.provider === "fal") {
      return deps.legacyGetter();
    }

    // auto / google / xai → the follow-main path via the Plan-01 resolver (one
    // source of truth; creds via the SecretManager closure — CRED-01).
    const sel = resolveVideoProvider(
      cfg,
      deps.mainProviderId,
      // CRED-01: video creds resolve from the SAME SecretManager/OAuthTokenManager
      // the main provider uses. veo → GOOGLE_API_KEY; grok → XAI_API_KEY OR a
      // SuperGrok OAuth bearer (mirrors image's codex key-or-OAuth credsAvailable
      // at setup-image-provider.ts:128-131); every other (explicit fal etc.) →
      // FAL_KEY. A Google-only agent with no FAL_KEY resolves available on its
      // existing GOOGLE_API_KEY (the design thesis — no video-specific secret, I9).
      (videoApi) => {
        if (videoApi === "veo") return deps.secretManager.get("GOOGLE_API_KEY") !== undefined;
        if (videoApi === "grok")
          return (
            deps.secretManager.get("XAI_API_KEY") !== undefined ||
            // IN-02: gate on the adapter's exported provider-id constant (single
            // source of truth) — never a bare "xai" literal that could drift.
            (deps.oauthManager?.hasCredentials(XAI_OAUTH_PROVIDER_ID) ?? false)
          );
        return deps.secretManager.get("FAL_KEY") !== undefined;
      },
      // The once-per-resolution follow-main skip is the load-bearing "why did
      // video go unavailable" evidence — promote it to INFO so it is visible at
      // the default log level (§2.7). Per-fallback-entry skips stay DEBUG.
      (reason) =>
        reason.startsWith("follow-main skipped:")
          ? deps.logger.info({ reason, step: "video_follow_main_skip" }, "Video follow-main resolution skipped")
          : deps.logger.debug({ reason, step: "video_fallback_skip" }, "Video fallback entry skipped"),
    );

    if (!sel.ok) {
      // RES-03 honest-unavailable: a port that surfaces the resolver's err (the
      // handler forwards its knob-naming hint). e.g. a video-incapable main
      // (openai) or explicit-but-no-creds.
      return makeUnavailableVideoPort(sel.errorKind, sel.hint, deps.logger);
    }

    // VEO = the STATIC-KEY case (exactly like setup-image-provider.ts:183-192
    // google-images). CRED-01: the SAME GOOGLE_API_KEY the completion + image
    // paths use — no video-specific secret (I9). credsAvailable above already
    // gated on GOOGLE_API_KEY, so `ok` implies a present key; the defensive guard
    // keeps the adapter's required `apiKey: string` honest rather than a `!`.
    if (sel.videoApi === "veo") {
      const apiKey = deps.secretManager.get("GOOGLE_API_KEY");
      if (!apiKey) {
        return makeUnavailableVideoPort(
          "auth_required",
          `Veo video requires the GOOGLE_API_KEY secret (the same key the ` +
            `completion path uses). Set it, or set integrations.media.videoGeneration.provider.`,
          deps.logger,
        );
      }
      return createVeoVideoAdapter({
        apiKey,
        model: sel.model ?? sel.defaultModel,
        logger: deps.logger,
      });
    }

    // GROK = the KEY-OR-OAUTH case (mirrors image's codex branch). The key is the
    // PROVEN primary (XAI_API_KEY Bearer); the OAuth branch is built defensively
    // codex-shaped so CRED-01's key-or-OAuth contract holds structurally, but it
    // is forward-looking — A1: no xAI/SuperGrok OAuth provider is registered in
    // the codebase today, so `hasCredentials("xai")` no-ops, and GROK is NEVER
    // blocked on it. The adapter resolves the bearer (the selector never reads a
    // raw key into a log; the adapter's SEC tests prove the bearer is leak-free).
    if (sel.videoApi === "grok") {
      const apiKey = deps.secretManager.get("XAI_API_KEY");
      if (apiKey) {
        return createGrokVideoAdapter({
          apiKey,
          model: sel.model ?? sel.defaultModel,
          logger: deps.logger,
        });
      }
      if (deps.oauthManager?.hasCredentials(XAI_OAUTH_PROVIDER_ID)) {
        // Forward-looking (A1) — activates if/when an xAI OAuth provider exists.
        // IN-02: same exported constant as the adapter resolves (no literal drift).
        return createGrokVideoAdapter({
          oauthManager: deps.oauthManager,
          oauthProfiles: deps.oauthProfiles,
          model: sel.model ?? sel.defaultModel,
          logger: deps.logger,
        });
      }
      return makeUnavailableVideoPort(
        "auth_required",
        `Grok video requires the XAI_API_KEY secret (or a SuperGrok login). Set ` +
          `it, or set integrations.media.videoGeneration.provider.`,
        deps.logger,
      );
    }

    // Any other resolved backend has no wiring yet — honest-unavailable naming
    // the opt-in path (never a misroute).
    return makeUnavailableVideoPort(
      "unsupported_provider",
      `Video provider "${sel.videoApi}" is not yet wired. Use provider:"fal" + ` +
        `FAL_KEY, or set integrations.media.videoGeneration.provider.`,
      deps.logger,
    );
  };
}
