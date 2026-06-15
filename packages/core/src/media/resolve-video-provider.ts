// SPDX-License-Identifier: Apache-2.0
/**
 * resolveVideoProvider — the pure, I/O-free priority resolver for
 * video-generation provider selection (RES-02/03/04, CAP-01, SEC-04).
 *
 * A 1:1 mirror of `resolveImageProvider` (resolve-image-provider.ts) with the
 * video vocabulary, PLUS the SEC-04 prototype-pollution guard the image resolver
 * lacks (DIVERGENCE 4): `isBlockedObjectKey` rejects `__proto__` / `constructor`
 * / `prototype` BEFORE every `VIDEO_CAPABILITY[...]` index (three sites — the
 * explicit branch, the follow-main branch, and the fallback-chain loop).
 *
 * Purity is preserved by INJECTION: the daemon supplies a `credsAvailable`
 * boolean predicate (it does the credential-store lookup) and an optional
 * `onSkip` reporter. This resolver never performs I/O, never reads the
 * environment, and never imports a secret store — so it is trivially
 * unit-testable with no daemon and no network.
 *
 * Honest-capability invariant (I3 / T-188-03): a video-incapable main provider
 * or absent credentials yields `{ ok: false, errorKind, hint }` — NEVER a silent
 * fall-through to a different paid provider. The `fallbackChain` is consulted
 * ONLY after the follow-main path fails, and each skip is reported.
 *
 * @module
 */

import { VIDEO_CAPABILITY } from "./video-capability.js";
import type { VideoErrorKind } from "./video-error.js";

/**
 * Rejects the three JavaScript object keys that, if used to index a plain object
 * map, read or pollute the prototype chain instead of an own property
 * (`__proto__` → the prototype; `constructor` / `prototype` → built-in members).
 * Apply this BEFORE every `VIDEO_CAPABILITY` / `VIDEO_PRICING` index on a
 * config-/resolution-supplied provider id (SEC-04 / DIVERGENCE 4).
 *
 * Exported because Task 2's pricing estimate and Plan 04's selector reuse the
 * exact same guard (single source of truth — no scattered inline checks).
 */
export function isBlockedObjectKey(k: string): boolean {
  return k === "__proto__" || k === "constructor" || k === "prototype";
}

/**
 * The structural subset of the video-generation selection config this resolver
 * reads. Declared LOCALLY (not imported from the runtime `VideoGenerationConfig`
 * in schema-integrations.ts) so this Wave-1 plan stays decoupled from Plan 02,
 * which adds that schema in the same wave. The resolver only needs these fields.
 */
export type VideoGenSelectionConfig = {
  /** "auto" | "fal" | "google" | "xai" */
  provider: string;
  /** Tool/config-supplied model that overrides the per-backend default. */
  model?: string;
  /** Plan 02 lands the real field; this resolver reads it defensively. */
  fallbackChain?: string[];
};

/**
 * Discriminated result: a concrete selection (with its provenance `source`) or
 * an honest-unavailable carrying a domain `errorKind` + a knob-naming `hint`.
 */
export type VideoProviderSelection =
  | {
      ok: true;
      videoApi: string;
      defaultModel: string;
      model?: string;
      source: "explicit" | "follow-main" | "fallback";
    }
  | { ok: false; errorKind: VideoErrorKind; hint: string };

/** The exact config knob a RES-03 hint must name (success-criterion). */
const PROVIDER_KNOB = "integrations.media.videoGeneration.provider";

function unavailableHint(mainProviderId: string): string {
  return (
    `Main provider "${mainProviderId}" cannot generate video (or its ` +
    `credentials are unavailable). Set ${PROVIDER_KNOB} (e.g. "fal" + ` +
    `FAL_KEY) to enable video generation.`
  );
}

export function resolveVideoProvider(
  cfg: VideoGenSelectionConfig,
  mainProviderId: string,
  credsAvailable: (videoApi: string) => boolean,
  onSkip?: (reason: string) => void,
): VideoProviderSelection {
  // 1. Explicit non-"auto" provider takes priority over follow-main.
  if (cfg.provider !== "auto") {
    // SEC-04: reject a poisoned provider id BEFORE indexing VIDEO_CAPABILITY.
    if (isBlockedObjectKey(cfg.provider)) {
      return { ok: false, errorKind: "unsupported_provider", hint: unavailableHint(cfg.provider) };
    }
    const cap = VIDEO_CAPABILITY[cfg.provider];
    // `fal` (and any explicit provider with no VIDEO_CAPABILITY entry) is an
    // explicit-only backend with no follow-main capability — its concrete
    // adapter path is wired separately in Plan 04. Here it resolves to
    // honest-unavailable; do NOT special-case `fal` into the capability map.
    if (cap && credsAvailable(cap.videoApi)) {
      return { ok: true, ...cap, model: cfg.model, source: "explicit" };
    }
    if (!cap) {
      return {
        ok: false,
        errorKind: "unsupported_provider",
        hint: unavailableHint(cfg.provider),
      };
    }
    // Explicit-but-no-creds.
    return { ok: false, errorKind: "auth_required", hint: unavailableHint(cfg.provider) };
  }

  // 2. provider === "auto": follow the agent's main provider.
  // SEC-04: reject a poisoned resolved main-provider id BEFORE indexing.
  if (isBlockedObjectKey(mainProviderId)) {
    return { ok: false, errorKind: "unsupported_provider", hint: unavailableHint(mainProviderId) };
  }
  const cap = VIDEO_CAPABILITY[mainProviderId];
  if (cap === undefined) {
    // Try the fallback chain before giving up (step 3).
    const fb = tryFallbackChain(
      cfg,
      credsAvailable,
      onSkip,
      `main provider "${mainProviderId}" is video-incapable`,
    );
    if (fb) return fb;
    return {
      ok: false,
      errorKind: "unsupported_provider",
      hint: unavailableHint(mainProviderId),
    };
  }
  if (!credsAvailable(cap.videoApi)) {
    const fb = tryFallbackChain(
      cfg,
      credsAvailable,
      onSkip,
      `credentials for main provider "${mainProviderId}" (${cap.videoApi}) are unavailable`,
    );
    if (fb) return fb;
    return { ok: false, errorKind: "auth_required", hint: unavailableHint(mainProviderId) };
  }
  return { ok: true, ...cap, model: cfg.model, source: "follow-main" };
}

/**
 * 3. Fallback chain (RES-04) — consulted ONLY after follow-main fails. Each
 * entry that cannot serve (blocked key, incapable, or no creds) is reported via
 * `onSkip` with a reason naming it; the first usable entry wins. Returns
 * undefined if the chain is empty or exhausted (the caller emits the
 * honest-unavailable).
 */
function tryFallbackChain(
  cfg: VideoGenSelectionConfig,
  credsAvailable: (videoApi: string) => boolean,
  onSkip: ((reason: string) => void) | undefined,
  followMainSkipReason: string,
): VideoProviderSelection | undefined {
  const chain = cfg.fallbackChain ?? [];
  // Report that follow-main was tried first (it is the reason we are here).
  onSkip?.(`follow-main skipped: ${followMainSkipReason}`);
  for (const p of chain) {
    // SEC-04: reject a poisoned fallback entry BEFORE indexing VIDEO_CAPABILITY.
    if (isBlockedObjectKey(p)) {
      onSkip?.(`fallback "${p}" skipped: blocked object key`);
      continue;
    }
    const cap = VIDEO_CAPABILITY[p];
    if (!cap) {
      onSkip?.(`fallback "${p}" skipped: video-incapable provider`);
      continue;
    }
    if (!credsAvailable(cap.videoApi)) {
      onSkip?.(`fallback "${p}" skipped: credentials (${cap.videoApi}) unavailable`);
      continue;
    }
    return { ok: true, ...cap, model: cfg.model, source: "fallback" };
  }
  return undefined;
}
