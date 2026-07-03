// SPDX-License-Identifier: Apache-2.0
/**
 * resolveImageProvider — the pure, I/O-free priority resolver for
 * image-generation provider selection.
 *
 * Mirrors the numbered-priority structure of `resolveWorkspaceDir`
 * (packages/core/src/workspace/workspace-resolver.ts) and the logic of the
 * completion path's `resolveAgentModel`: a single function, explicit numbered
 * priority, a single discriminated return type, no throws.
 *
 * Purity is preserved by INJECTION: the daemon supplies a `credsAvailable`
 * boolean predicate (it does the credential-store lookup) and an optional
 * `onSkip` reporter. This resolver never performs I/O, never reads the
 * environment, and never imports a secret store — so it is trivially
 * unit-testable with no daemon and no network.
 *
 * Honest-capability invariant: an image-incapable main provider
 * or absent credentials yields `{ ok: false, errorKind, hint }` — NEVER a
 * silent fall-through to a different paid provider. The `fallbackChain` is
 * consulted ONLY after the follow-main path fails, and each skip is reported.
 *
 * @module
 */

import { IMAGE_CAPABILITY } from "./image-capability.js";
import type { ImageErrorKind } from "./image-error.js";

/**
 * The structural subset of the image-generation selection config this resolver
 * reads. Declared LOCALLY (not imported from the runtime
 * `ImageGenerationConfig` in schema-integrations.ts) to keep this pure
 * resolver decoupled from the runtime config schema. The resolver only needs
 * these three fields.
 */
export type ImageGenSelectionConfig = {
  /** "auto" | "fal" | "openai" | "openai-codex" | "google" | "openrouter" */
  provider: string;
  /** Tool/config-supplied model that overrides the per-provider default. */
  model?: string;
  /** Defined by the runtime schema; this resolver reads it defensively. */
  fallbackChain?: string[];
};

/**
 * Discriminated result: a concrete selection (with its provenance `source`) or
 * an honest-unavailable carrying a domain `errorKind` + a knob-naming `hint`.
 */
export type ImageProviderSelection =
  | {
      ok: true;
      imagesApi: string;
      defaultModel: string;
      model?: string;
      source: "explicit" | "follow-main" | "fallback";
    }
  | { ok: false; errorKind: ImageErrorKind; hint: string };

/** The exact config knob every honest-unavailable hint must name. */
const PROVIDER_KNOB = "integrations.media.imageGeneration.provider";

function unavailableHint(mainProviderId: string): string {
  return (
    `Main provider "${mainProviderId}" cannot generate images (or its ` +
    `credentials are unavailable). Set ${PROVIDER_KNOB} (e.g. "openrouter" + ` +
    `OPENROUTER_API_KEY) to enable images.`
  );
}

export function resolveImageProvider(
  cfg: ImageGenSelectionConfig,
  mainProviderId: string,
  credsAvailable: (imagesApi: string) => boolean,
  onSkip?: (reason: string) => void,
): ImageProviderSelection {
  // 1. Explicit non-"auto" provider takes priority over follow-main.
  if (cfg.provider !== "auto") {
    const cap = IMAGE_CAPABILITY[cfg.provider];
    // `fal` (and any explicit provider with no IMAGE_CAPABILITY entry) is an
    // explicit-only backend with no follow-main capability — its concrete
    // adapter path is wired separately in the daemon. Here it resolves
    // to honest-unavailable; do NOT special-case `fal` into the capability map.
    if (cap && credsAvailable(cap.imagesApi)) {
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
  const cap = IMAGE_CAPABILITY[mainProviderId];
  if (cap === undefined) {
    // Try the fallback chain before giving up (step 3).
    const fb = tryFallbackChain(cfg, credsAvailable, onSkip, `main provider "${mainProviderId}" is image-incapable`);
    if (fb) return fb;
    return {
      ok: false,
      errorKind: "unsupported_provider",
      hint: unavailableHint(mainProviderId),
    };
  }
  if (!credsAvailable(cap.imagesApi)) {
    const fb = tryFallbackChain(
      cfg,
      credsAvailable,
      onSkip,
      `credentials for main provider "${mainProviderId}" (${cap.imagesApi}) are unavailable`,
    );
    if (fb) return fb;
    return { ok: false, errorKind: "auth_required", hint: unavailableHint(mainProviderId) };
  }
  return { ok: true, ...cap, model: cfg.model, source: "follow-main" };
}

/**
 * 3. Fallback chain — consulted ONLY after follow-main fails. Each
 * entry that cannot serve (incapable or no creds) is reported via `onSkip` with
 * a reason naming it; the first usable entry wins. Returns undefined if the
 * chain is empty or exhausted (the caller emits the honest-unavailable).
 */
function tryFallbackChain(
  cfg: ImageGenSelectionConfig,
  credsAvailable: (imagesApi: string) => boolean,
  onSkip: ((reason: string) => void) | undefined,
  followMainSkipReason: string,
): ImageProviderSelection | undefined {
  const chain = cfg.fallbackChain ?? [];
  // Report that follow-main was tried first (it is the reason we are here).
  onSkip?.(`follow-main skipped: ${followMainSkipReason}`);
  for (const p of chain) {
    const cap = IMAGE_CAPABILITY[p];
    if (!cap) {
      onSkip?.(`fallback "${p}" skipped: image-incapable provider`);
      continue;
    }
    if (!credsAvailable(cap.imagesApi)) {
      onSkip?.(`fallback "${p}" skipped: credentials (${cap.imagesApi}) unavailable`);
      continue;
    }
    return { ok: true, ...cap, model: cfg.model, source: "fallback" };
  }
  return undefined;
}
