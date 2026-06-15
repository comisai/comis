// SPDX-License-Identifier: Apache-2.0
/**
 * Video-provider SELECTION (RES-01/RES-02/RES-03, Phase 188 / Plan 04).
 *
 * `createVideoProviderSelector` returns a lazy getter (read-on-use at boot —
 * mirrors `createImageProviderSelector` in setup-image-provider.ts) that, per the
 * resolved config + the agent's main provider, decides between:
 *   - the Plan-03 skills FAL adapter (explicit `provider:"fal"`, via the
 *     `legacyGetter` → `createVideoGenProvider`); or
 *   - the follow-main SELECTION via the Plan-01 `resolveVideoProvider` (one
 *     source of truth), resolving creds from the SAME `SecretManager` the main
 *     provider uses (CRED-01 — no video-specific secret); for `auto`+`google`→veo
 *     / `auto`+`xai`→grok the selection RESOLVES but the live Veo/Grok adapters
 *     land in Phase 190, so this returns an honest-unavailable port whose hint
 *     names Phase 190 (exactly image's "not yet wired (lands in a later phase)"
 *     L198-206 template); or
 *   - an honest-unavailable port (carrying the resolver's knob-naming hint) for a
 *     video-incapable main (RES-03) — NEVER a misroute to a different paid
 *     provider, NEVER silence.
 *
 * The selector selects ONCE here (one source of truth — `resolveVideoProvider`);
 * the handler NEVER re-derives selection (the RES-01 keystone / the v2.20
 * keyless-summarizer two-source firewall). It reads creds via `SecretManager`
 * only, never the raw environment.
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
  type SecretManager,
  type VideoErrorKind,
  type VideoGenerationConfig,
  type VideoGenerationPort,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { err, type Result } from "@comis/shared";

/**
 * A port whose every method returns a classified `VideoGenError` Result err —
 * the RES-03 honest-unavailable carrier. The agent gets a hint (naming the
 * binding config knob, or "Phase 190" for veo/grok), not silence.
 * `isAvailable()` is `false` so callers that probe it know it cannot serve.
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
      // CRED-01: video creds resolve from the SAME SecretManager the main
      // provider uses. veo → GOOGLE_API_KEY; grok → XAI_API_KEY; every other
      // (explicit fal etc.) → FAL_KEY. A Google-only agent with no FAL_KEY
      // resolves available on its existing GOOGLE_API_KEY (the design thesis).
      (videoApi) => {
        if (videoApi === "veo") return deps.secretManager.get("GOOGLE_API_KEY") !== undefined;
        if (videoApi === "grok") return deps.secretManager.get("XAI_API_KEY") !== undefined;
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

    // The follow-main SELECTION resolved (veo for google, grok for xai). Phase
    // 188 has NO live Veo/Grok adapter yet — return the honest-unavailable
    // "lands in Phase 190" port (exactly image's L198-206 not-yet-wired
    // template). Phase 190 flips THIS branch to build the live adapters. The
    // selection is still computed (RES-02 proven), it just has no transport yet.
    if (sel.videoApi === "veo" || sel.videoApi === "grok") {
      return makeUnavailableVideoPort(
        "unsupported_provider",
        `Native ${sel.videoApi} video lands in Phase 190. Use provider:"fal" + ` +
          `FAL_KEY, or set integrations.media.videoGeneration.provider.`,
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
