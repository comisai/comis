// SPDX-License-Identifier: Apache-2.0
/**
 * resolveVisionPath — the pure, I/O-free ladder resolver for the
 * provider-following VISION path.
 *
 * Mirrors the numbered-priority structure of `resolveImageProvider`
 * (packages/core/src/media/resolve-image-provider.ts): a single function,
 * explicit numbered priority, a single discriminated return type, no throws.
 *
 * Purity is preserved by INJECTION: the daemon precomputes every signal this
 * resolver needs — `visionCapable` (via `isVisionCapable(getModel(provider,
 * modelId))`), `mainCredsAvailable` (the credential-store lookup), and
 * `registryAvailable` (whether `selectVisionProvider(registry, mediaKind)` would
 * return a provider) — and supplies an optional `onSkip` reporter. This resolver
 * never performs I/O, never reads the environment, never imports a secret store
 * or the pi-ai catalog — so it is trivially unit-testable with no daemon and no
 * network. It only LABELS which path (`main-vision` / `registry` /
 * `gemini-video` / `unavailable`) the handler must execute; the handler runs the
 * chosen tier (the handler consumes a resolver, never re-derives selection).
 *
 * Honest-capability invariant: a vision-incapable main provider
 * or absent main credentials falls to the registry (which has its OWN keys) or,
 * when nothing can serve, yields `{ ok: false, errorKind, hint }` — NEVER a
 * silent fall-through that bills a different provider. Each skipped tier is
 * reported via `onSkip` (path-logging).
 *
 * The locked ladder ORDER: main-vision FIRST (image only —
 * pi-ai has no video content type, so `mediaKind:"video"` NEVER
 * returns `main-vision`) → registry SECOND → gemini-video THIRD (raw video only)
 * → honest-unavailable LAST. An explicit vision `defaultProvider` overrides
 * main-first (explicit operator config wins).
 *
 * @module
 */

import type { ImageErrorKind } from "./image-error.js";

/**
 * Discriminated result: a concrete vision path (with its `path` provenance
 * label — the "which path" signal) or an honest-unavailable carrying a
 * domain `errorKind` + a knob-naming `hint`.
 */
export type VisionPathSelection =
  | { ok: true; path: "main-vision"; provider: string }
  | { ok: true; path: "registry" }
  | { ok: true; path: "gemini-video" }
  | { ok: false; path: "unavailable"; errorKind: ImageErrorKind; hint: string };

/**
 * The structural input this resolver reads. Every field is a precomputed signal
 * the daemon injects (purity-by-injection) — the resolver does no lookups.
 */
export interface VisionPathInput {
  /** `image` routes through main-vision/registry; `video` is raw-video (Gemini) only. */
  mediaKind: "image" | "video";
  /** The agent's resolved main provider id (for the `main-vision` provenance + hints). */
  mainProviderId: string;
  /** `isVisionCapable(getModel(main, modelId))` — does the main model see images? */
  visionCapable: boolean;
  /** Did the daemon resolve a credential for the main provider (key OR codex OAuth)? */
  mainCredsAvailable: boolean;
  /** Would `selectVisionProvider(registry, mediaKind)` return a provider? */
  registryAvailable: boolean;
  /** `integrations.media.vision.defaultProvider` — when set (non-empty), explicit wins. */
  explicitDefaultProvider?: string;
}

/** The exact config knob an unavailable hint names (the actionable lever). */
const VISION_KNOB = "integrations.media.vision.defaultProvider";

function unavailableHint(mainProviderId: string): string {
  return (
    `No vision provider available for main provider "${mainProviderId}". Either ` +
    `use a vision-capable main model (and set its API key), or configure ` +
    `${VISION_KNOB} (e.g. "openai" + OPENAI_API_KEY / "anthropic" + ` +
    `ANTHROPIC_API_KEY / "google" + GOOGLE_API_KEY) to enable the vision registry.`
  );
}

/**
 * Decide the vision path. Pure: same input → same output, no I/O.
 *
 * @param input precomputed capability/cred/registry signals (the daemon resolves them)
 * @param onSkip optional skip reporter — each non-chosen tier reports its reason
 */
export function resolveVisionPath(
  input: VisionPathInput,
  onSkip?: (reason: string) => void,
): VisionPathSelection {
  const {
    mediaKind,
    mainProviderId,
    visionCapable,
    mainCredsAvailable,
    registryAvailable,
    explicitDefaultProvider,
  } = input;

  // VIDEO: pi-ai has NO video content type — main-vision is N/A.
  // Raw video stays Gemini-only via the registry's video selection.
  if (mediaKind === "video") {
    if (registryAvailable) {
      return { ok: true, path: "gemini-video" };
    }
    return {
      ok: false,
      path: "unavailable",
      errorKind: "unsupported_provider",
      hint: unavailableHint(mainProviderId),
    };
  }

  // IMAGE ladder.
  // 1. Explicit-override: an explicit, non-empty vision
  //    defaultProvider beats main-first — skip main-vision, go to the registry.
  const hasExplicit =
    typeof explicitDefaultProvider === "string" && explicitDefaultProvider.length > 0;
  if (hasExplicit) {
    onSkip?.(`main-vision skipped: explicit defaultProvider "${explicitDefaultProvider}" configured`);
  } else {
    // 2. main-vision FIRST: the main model sees images AND its creds resolve.
    if (visionCapable && mainCredsAvailable) {
      return { ok: true, path: "main-vision", provider: mainProviderId };
    }
    if (!visionCapable) {
      onSkip?.(`main-vision skipped: main provider "${mainProviderId}" is not vision-capable`);
    } else {
      // vision-capable but no creds → registry (it has its OWN keys), never unavailable here.
      onSkip?.(`main-vision skipped: no credentials for main provider "${mainProviderId}"`);
    }
  }

  // 3. registry SECOND.
  if (registryAvailable) {
    return { ok: true, path: "registry" };
  }

  // 4. honest-unavailable LAST. When the ONLY image blocker was missing main
  //    creds (the main model COULD see images) and no registry can serve, the
  //    actionable error is auth_required; otherwise the path is unsupported.
  const onlyBlockerWasMainCreds = !hasExplicit && visionCapable && !mainCredsAvailable;
  return {
    ok: false,
    path: "unavailable",
    errorKind: onlyBlockerWasMainCreds ? "auth_required" : "unsupported_provider",
    hint: unavailableHint(mainProviderId),
  };
}
