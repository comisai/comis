// SPDX-License-Identifier: Apache-2.0
/**
 * VIDEO_MODELS + listVideoModelCaps + supportedModes + snapDuration — the
 * per-model video-capability matrix (CAP-02). The single source of truth the
 * IN-02 param validator (Plan 02 `video-handlers.ts`) and the IN-03 dynamic
 * tool description (Plan 03 `video-generate-tool.ts`) both read.
 *
 * Shape mirrors the sibling `video-pricing.ts` (a backend-keyed
 * `Record<string, ...| undefined>` indexed only AFTER the SEC-04
 * `isBlockedObjectKey` guard, with the const kept intra-core and only the
 * accessors on the barrel) and `image-models.ts`'s accessor-export discipline,
 * extended with OpenClaw-style mode-keying (`t2v`/`i2v`/`v2v`) + per-model
 * `byModel` overrides and Hermes's enum-snap-vs-range-clamp duration heuristic.
 *
 * The per-model enums are POINT-IN-TIME — re-verified against the live FAL/Veo/
 * Grok docs 2026-06-15 (carrying the Phase-190 corrections: Grok 480p/720p only
 * + `grok-imagine-video` the only id; Veo 3.0 audio-by-default; FAL
 * `fal-ai/veo3.1/fast`). They drift ~monthly and are overridable by the
 * config/tool `model` arg (the `byModel` overrides cover the cells that differ
 * today, e.g. Veo 2 = 720p-only + no audio). Do NOT treat them as permanent —
 * re-verify at the plan time of any later phase touching this matrix.
 *
 * SEC-04: every `VIDEO_MODELS[backend]` and `modeCaps.byModel[model]` index is
 * preceded by `isBlockedObjectKey` (the prototype-pollution guard reused from
 * `resolve-video-provider.ts`, same as `estimateVideoCostUsd` in
 * `video-pricing.ts`). A poisoned key returns `undefined`/`[]`/the default
 * instead of touching the prototype. The benign
 * `security/detect-object-injection` warning on the guarded dynamic-key reads
 * is the established baseline (same bare-lookup pattern as `image-models.ts` /
 * `resolve-video-provider.ts`) — no suppression directive; the guard is the
 * mitigation.
 *
 * @module
 */

import { isBlockedObjectKey } from "./resolve-video-provider.js";

/**
 * How a backend constrains the requested duration:
 * - `enum` (FAL/Veo): snap to the NEAREST member; ties round half-up.
 * - `range` (Grok): clamp to `[min, max]`.
 */
export type VideoDurations =
  | { kind: "enum"; values: readonly number[] }
  | { kind: "range"; min: number; max: number };

/** The capability record for one (backend, mode[, model]) cell. */
export interface VideoModelCaps {
  durations: VideoDurations;
  resolutions: readonly string[];
  aspectRatios: readonly string[];
  /** Whether the backend produces audio at all (Veo 2 + Grok = false). */
  audio: boolean;
  maxReferenceImages: number;
  /**
   * Pitfall 2 (Veo): resolutions that REQUIRE `durationSecs === 8` (1080p/4k).
   * The IN-02 validator (Plan 02) special-cases this as an honest pre-submit
   * reject ("4k requires duration 8") rather than letting it surface as a
   * provider 4xx. Absent = no cross-field rule.
   */
  requires8sFor?: readonly string[];
}

/** A mode's default caps plus optional per-model overrides (OpenClaw `*ByModel`). */
type ModeCaps = { default: VideoModelCaps; byModel?: Record<string, VideoModelCaps> };

/** A backend's per-mode caps. `v2v` is RESERVED but wired to no backend (deferred). */
type BackendCaps = { t2v?: ModeCaps; i2v?: ModeCaps; v2v?: ModeCaps };

// --- The live values (re-verified 2026-06-15) ---------------------------------

/** Shared FAL t2v/i2v body (durations/resolutions/aspect identical; refs differ). */
const FAL_BASE = {
  durations: { kind: "enum", values: [4, 6, 8] },
  resolutions: ["720p", "1080p", "4k"],
  aspectRatios: ["auto", "16:9", "9:16"],
  audio: true,
} as const;

/** Veo 3.x default (the shipped `veo-3.0-fast-generate-001`): audio-on, refs ≤3, 8s for 1080p/4k. */
const VEO_DEFAULT: VideoModelCaps = {
  durations: { kind: "enum", values: [4, 6, 8] },
  resolutions: ["720p", "1080p", "4k"],
  aspectRatios: ["16:9", "9:16"],
  audio: true,
  maxReferenceImages: 3,
  requires8sFor: ["1080p", "4k"],
};

/** Veo 2 (`veo-2.0-generate-001`) byModel override: 720p-only, silent, no refs. */
const VEO_2_OVERRIDE: VideoModelCaps = {
  durations: { kind: "enum", values: [5, 6, 8] },
  resolutions: ["720p"],
  aspectRatios: ["16:9", "9:16"],
  audio: false,
  maxReferenceImages: 0,
};

/** Grok (`grok-imagine-video`, the only id): duration RANGE (clamp), 480p/720p, no audio. */
const GROK_BASE = {
  durations: { kind: "range", min: 1, max: 15 },
  resolutions: ["480p", "720p"],
  aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
  audio: false,
} as const;

/**
 * The CAP-02 matrix: backend → mode → {default + per-model overrides}. Keyed by
 * the resolved port id (`fal`/`veo`/`grok`) — the only key both the daemon
 * handler (`deps.provider.id`) and the skills tool builder (`ctx.videoGenProvider.id`)
 * share. `v2v` is RESERVED (omitted on every backend → `undefined` on lookup,
 * deferred). Kept intra-core (NOT on the `@comis/core` barrel) — consumed only
 * via the accessors below (`public-export-consumers` gate, Pitfall 6).
 */
export const VIDEO_MODELS: Record<string, BackendCaps | undefined> = {
  fal: {
    t2v: { default: { ...FAL_BASE, maxReferenceImages: 0 } },
    i2v: { default: { ...FAL_BASE, maxReferenceImages: 1 } },
  },
  veo: {
    t2v: {
      default: VEO_DEFAULT,
      byModel: { "veo-2.0-generate-001": VEO_2_OVERRIDE },
    },
    i2v: {
      default: VEO_DEFAULT,
      byModel: { "veo-2.0-generate-001": VEO_2_OVERRIDE },
    },
  },
  grok: {
    t2v: { default: { ...GROK_BASE, maxReferenceImages: 1 } },
    i2v: { default: { ...GROK_BASE, maxReferenceImages: 1 } },
  },
};

/**
 * The caps for a (backend, mode[, model]) cell, or `undefined` when the backend
 * is unknown/blocked or the mode key is absent (CAP-02 (b): an i2v request on a
 * t2v-only backend, or any `v2v` request → the handler rejects with the
 * supported-modes list). A per-model `byModel` override wins over the mode
 * default (CAP-02 (c)). SEC-04 precedes EVERY index.
 */
export function listVideoModelCaps(
  backend: string,
  mode: "t2v" | "i2v" | "v2v",
  model?: string,
): VideoModelCaps | undefined {
  if (isBlockedObjectKey(backend)) return undefined; // SEC-04 (backend index)
  const be = VIDEO_MODELS[backend];
  const modeCaps = be?.[mode];
  if (!modeCaps) return undefined; // CAP-02 (b): mode omitted → undefined
  if (model && !isBlockedObjectKey(model) && modeCaps.byModel?.[model]) {
    return modeCaps.byModel[model]; // CAP-02 (c): override wins (SEC-04 on model)
  }
  return modeCaps.default;
}

/**
 * The modes a backend supports (the present mode keys), `[]` for an
 * unknown/blocked backend. Used to build the IN-02 reject hint (Plan 02) when a
 * requested mode is unsupported. SEC-04 guarded.
 */
export function supportedModes(backend: string): ("t2v" | "i2v" | "v2v")[] {
  if (isBlockedObjectKey(backend)) return [];
  const be = VIDEO_MODELS[backend];
  if (!be) return [];
  return (["t2v", "i2v", "v2v"] as const).filter((m) => be[m] !== undefined);
}

/**
 * Normalize a requested duration to what the backend actually accepts.
 * - range (Grok): CLAMP to `[min, max]`.
 * - enum (FAL/Veo): snap to the NEAREST member; on an EXACT tie (a value
 *   equidistant from two members, e.g. 5 between 4 and 6, or 7 between 6 and 8)
 *   round HALF-UP — pick the HIGHER member. Rationale: a clip slightly longer
 *   than requested is the safer default over slightly shorter. Deterministic.
 */
export function snapDuration(caps: VideoModelCaps, d: number): number {
  // IN-01: fail CLOSED on a non-finite duration (defense-in-depth — upstream Zod
  // normally rejects NaN). For a range cell, Math.min(max, Math.max(min, NaN))
  // would pass NaN straight to the wire; for an enum cell the reduce silently
  // coerces to the seed. Snap to the smallest/min member so a non-finite value
  // never reaches the provider.
  if (!Number.isFinite(d)) {
    return caps.durations.kind === "range" ? caps.durations.min : (caps.durations.values[0] ?? d);
  }
  if (caps.durations.kind === "range") {
    return Math.min(caps.durations.max, Math.max(caps.durations.min, d));
  }
  const vals = caps.durations.values;
  if (vals.length === 0) return d;
  // Scan ascending; pick nearest, and on a tie (|v-d| === |best-d|) take the
  // HIGHER v. Seed with the FIRST member; because vals is ascending, a later
  // equidistant member is the higher one, so `<=` (replace-on-tie) yields
  // round-half-up.
  return vals.reduce(
    (best, v) => (Math.abs(v - d) <= Math.abs(best - d) ? v : best),
    vals[0]!,
  );
}
