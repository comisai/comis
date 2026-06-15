// SPDX-License-Identifier: Apache-2.0
/**
 * estimateVideoCostUsd + VIDEO_PRICING — the pure worst-case pre-submit cost
 * estimate (SEC-02 / I6). A video clip is ALREADY rendering once submitted, so
 * the `maxCostPerHourUsd` ceiling cannot wait for the actual cost — it must be
 * gated against a conservative estimate computed BEFORE the provider call. Audio
 * and 4k raise the per-second rate (worst-case upper bound). The handler
 * reconciles the actual cost (when the provider reports it) after completion.
 *
 * There is NO image analog: image cost is reported post-hoc by pi-ai, never
 * pre-estimated (the image cost limiter's `canSpend(agentId)` takes no estimate).
 *
 * Per-second USD rates live in ONE table and are POINT-IN-TIME — verified
 * against the v2.24 design §5e / §15 and the FAL catalog at plan time
 * (2026-06-15): Veo 3.1 Fast $0.10/s (audio-off) · $0.15/s (audio-on) @720/1080p;
 * $0.30–$0.35/s @4k. They drift ~monthly and are overridable by config; do NOT
 * treat them as permanent. Re-verify at the plan time of the phase wiring the
 * live adapter.
 *
 * @module
 */

import { isBlockedObjectKey } from "./resolve-video-provider.js";

/** Per-second USD rates by backend (worst-case for the estimate). */
export const VIDEO_PRICING: Record<
  string,
  { perSecond: number; audioPerSecond?: number; fourKMultiplier?: number } | undefined
> = {
  // FAL-hosted Veo 3.1 Fast: $0.10/s, $0.15/s with audio, ~$0.30/s @4k (3×).
  fal: { perSecond: 0.1, audioPerSecond: 0.15, fourKMultiplier: 3 },
  // Native Veo backend mirrors the FAL-hosted Veo rate (refined Phase 190).
  veo: { perSecond: 0.1, audioPerSecond: 0.15, fourKMultiplier: 3 },
  // xAI Grok Imagine — placeholder until the live-verified pricing lands Phase 190.
  grok: { perSecond: 0.1 },
};

/**
 * Worst-case dollar estimate for a render: `max(0, durationSecs) × per-second
 * rate`, where the rate uses the audio surcharge when audio is requested and is
 * multiplied for 4k. An unknown (or prototype-pollution — SEC-04) provider id
 * falls back to the `fal` rate so the estimate is always conservative and the
 * pricing table is never indexed with a poisoned key.
 */
export function estimateVideoCostUsd(
  providerOrApi: string,
  _model: string | undefined,
  opts: { durationSecs: number; resolution?: string; audio?: boolean },
): number {
  // SEC-04: never index VIDEO_PRICING with a poisoned key (defense-in-depth —
  // the resolver guards too; this is the second untrusted-id index site).
  const key = isBlockedObjectKey(providerOrApi) ? "" : providerOrApi;
  const p = VIDEO_PRICING[key] ?? VIDEO_PRICING.fal;
  // VIDEO_PRICING.fal is statically present, but narrow defensively.
  if (!p) return 0;
  const base = opts.audio && p.audioPerSecond ? p.audioPerSecond : p.perSecond;
  const rate = opts.resolution === "4k" && p.fourKMultiplier ? base * p.fourKMultiplier : base;
  return Math.max(0, opts.durationSecs) * rate;
}
