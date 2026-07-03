// SPDX-License-Identifier: Apache-2.0
/**
 * estimateVideoCostUsd + VIDEO_PRICING — the pure worst-case pre-submit cost
 * estimate. A video clip is ALREADY rendering once submitted, so
 * the `maxCostPerHourUsd` ceiling cannot wait for the actual cost — it must be
 * gated against a conservative estimate computed BEFORE the provider call. Audio
 * and 4k raise the per-second rate (worst-case upper bound). The handler
 * reconciles the actual cost (when the provider reports it) after completion.
 *
 * There is NO image analog: image cost is reported post-hoc by pi-ai, never
 * pre-estimated (the image cost limiter's `canSpend(agentId)` takes no estimate).
 *
 * Per-second USD rates live in ONE table and are POINT-IN-TIME — re-verified
 * against the live provider docs 2026-06-15: FAL-hosted Veo 3.1 Fast $0.10/s (audio-off) · $0.15/s
 * (audio-on) @720/1080p · ~$0.30/s @4k; NATIVE Veo 3.0 Fast $0.10/s @720p ·
 * $0.12/s @1080p · $0.30/s @4k with audio INCLUDED in the base (no surcharge —
 * Veo 3.x GA generates audio by default); xAI Grok Imagine ~$0.05–$0.07/s @720p
 * (sources disagree → conservative $0.07; the ACTUAL is reconciled from
 * `cost_in_usd_ticks` by the Grok adapter). They drift ~monthly and are
 * overridable by config; do NOT treat them as permanent. Re-verify against the
 * provider docs before any change touching the live adapters.
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
  // Native Veo 3.0 Fast (live-verified 2026-06-15): $0.10/s @720p, $0.12/s
  // @1080p, $0.30/s @4k (3×). Audio is INCLUDED in the base for Veo 3.x GA (no
  // surcharge) — `audioPerSecond: 0.15` is kept as a CONSERVATIVE over-estimate
  // ceiling for the pre-submit gate: it can only over-count, never
  // under-count, so an audio render is never under-gated. The actual Veo cost is
  // the estimate (rate × duration) — GenerateVideosResponse reports no usage/cost.
  veo: { perSecond: 0.1, audioPerSecond: 0.15, fourKMultiplier: 3 },
  // xAI Grok Imagine (live-verified 2026-06-15): conservative worst-case
  // $0.07/s @720p (sources disagree on $0.05–$0.07; no single authoritative
  // per-second number in the API docs). The ACTUAL cost is reconciled from the
  // done payload's `cost_in_usd_ticks` (/1e10) by the Grok adapter.
  grok: { perSecond: 0.07 },
};

/**
 * Worst-case dollar estimate for a render: `max(0, durationSecs) × per-second
 * rate`, where the rate uses the audio surcharge when audio is requested and is
 * multiplied for 4k. An unknown (or prototype-pollution) provider id
 * falls back to the `fal` rate so the estimate is always conservative and the
 * pricing table is never indexed with a poisoned key.
 */
export function estimateVideoCostUsd(
  providerOrApi: string,
  _model: string | undefined,
  opts: { durationSecs: number; resolution?: string; audio?: boolean },
): number {
  // Never index VIDEO_PRICING with a poisoned key (defense-in-depth —
  // the resolver guards too; this is the second untrusted-id index site).
  const key = isBlockedObjectKey(providerOrApi) ? "" : providerOrApi;
  const p = VIDEO_PRICING[key] ?? VIDEO_PRICING.fal;
  // VIDEO_PRICING.fal is statically present, but narrow defensively.
  if (!p) return 0;
  const base = opts.audio && p.audioPerSecond ? p.audioPerSecond : p.perSecond;
  const rate = opts.resolution === "4k" && p.fourKMultiplier ? base * p.fourKMultiplier : base;
  return Math.max(0, opts.durationSecs) * rate;
}
