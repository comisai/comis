// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { estimateVideoCostUsd, VIDEO_PRICING } from "./video-pricing.js";

/**
 * estimateVideoCostUsd is a PURE worst-case cost estimate (SEC-02 / I6): a video
 * clip is already rendering once submitted, so the ceiling must be checked
 * pre-submit against a conservative duration × per-second estimate. Audio and 4k
 * raise the rate. Per-second rates live in ONE table (VIDEO_PRICING) and are
 * point-in-time (re-verify ~monthly) — overridable, not permanent.
 */
describe("estimateVideoCostUsd", () => {
  it("returns a positive duration × per-second estimate for the base case", () => {
    const est = estimateVideoCostUsd("fal", "fal-ai/veo3.1/fast", {
      durationSecs: 8,
      resolution: "720p",
      audio: false,
    });
    // fal base rate is $0.10/s → 8s ≈ $0.80.
    expect(est).toBeGreaterThan(0);
    expect(est).toBeCloseTo(0.8, 5);
  });

  it("raises the estimate when audio is requested", () => {
    const noAudio = estimateVideoCostUsd("fal", undefined, {
      durationSecs: 8,
      resolution: "720p",
      audio: false,
    });
    const withAudio = estimateVideoCostUsd("fal", undefined, {
      durationSecs: 8,
      resolution: "720p",
      audio: true,
    });
    expect(withAudio).toBeGreaterThan(noAudio);
  });

  it("raises the estimate at 4k resolution above 720p", () => {
    const at720 = estimateVideoCostUsd("fal", undefined, {
      durationSecs: 8,
      resolution: "720p",
      audio: false,
    });
    const at4k = estimateVideoCostUsd("fal", undefined, {
      durationSecs: 8,
      resolution: "4k",
      audio: false,
    });
    expect(at4k).toBeGreaterThan(at720);
  });

  it("estimates the native veo 720p rate (audio-off) at the documented per-second rate", () => {
    // Native Veo 3.0 Fast: $0.10/s @720p (audio-off), audio INCLUDED in base.
    const est = estimateVideoCostUsd("veo", undefined, {
      durationSecs: 8,
      resolution: "720p",
      audio: false,
    });
    expect(est).toBeCloseTo(0.8, 5);
  });

  it("applies the veo 4k multiplier above the 720p rate", () => {
    const at720 = estimateVideoCostUsd("veo", undefined, {
      durationSecs: 8,
      resolution: "720p",
      audio: false,
    });
    const at4k = estimateVideoCostUsd("veo", undefined, {
      durationSecs: 8,
      resolution: "4k",
      audio: false,
    });
    // fourKMultiplier: 3 → 8s × $0.10 × 3 = $2.40.
    expect(at4k).toBeCloseTo(2.4, 5);
    expect(at4k).toBeGreaterThan(at720);
  });

  it("keeps an audio=true veo estimate conservatively HIGH (audio surcharge ceiling)", () => {
    // Native Veo 3.x bills audio in-base, so audioPerSecond is a conservative
    // over-estimate ceiling (Pitfall 4) — the audio estimate must exceed the
    // audio-off estimate so the pre-submit ceiling is never under-counted.
    const audioOff = estimateVideoCostUsd("veo", undefined, {
      durationSecs: 8,
      resolution: "720p",
      audio: false,
    });
    const audioOn = estimateVideoCostUsd("veo", undefined, {
      durationSecs: 8,
      resolution: "720p",
      audio: true,
    });
    // audioPerSecond: 0.15 → 8s × $0.15 = $1.20 (the conservative ceiling).
    expect(audioOn).toBeCloseTo(1.2, 5);
    expect(audioOn).toBeGreaterThan(audioOff);
  });

  it("estimates the grok backend at the conservative refined per-second rate", () => {
    // Conservative worst-case 0.07/s; the actual is reconciled from
    // cost_in_usd_ticks by the Grok adapter (Plan 02).
    const est = estimateVideoCostUsd("grok", undefined, { durationSecs: 6 });
    expect(est).toBeCloseTo(0.42, 5);
  });

  it("leaves the fal estimate UNCHANGED (the proven baseline — non-regression)", () => {
    // fal must stay byte-identical: $0.10/s base, $0.15/s audio, 3× @4k.
    expect(estimateVideoCostUsd("fal", undefined, { durationSecs: 8, resolution: "720p", audio: false })).toBeCloseTo(
      0.8,
      5,
    );
    expect(estimateVideoCostUsd("fal", undefined, { durationSecs: 8, resolution: "720p", audio: true })).toBeCloseTo(
      1.2,
      5,
    );
    expect(estimateVideoCostUsd("fal", undefined, { durationSecs: 8, resolution: "4k", audio: false })).toBeCloseTo(
      2.4,
      5,
    );
    expect(VIDEO_PRICING.fal).toEqual({ perSecond: 0.1, audioPerSecond: 0.15, fourKMultiplier: 3 });
  });

  it("clamps a negative or zero duration to a non-negative estimate", () => {
    expect(estimateVideoCostUsd("fal", undefined, { durationSecs: -3 })).toBe(0);
    expect(estimateVideoCostUsd("fal", undefined, { durationSecs: 0 })).toBe(0);
  });

  it("falls back to the fal rate for an unknown provider/api key", () => {
    const known = estimateVideoCostUsd("fal", undefined, { durationSecs: 8 });
    const unknown = estimateVideoCostUsd("totally-unknown", undefined, { durationSecs: 8 });
    expect(unknown).toBe(known);
  });

  // SEC-04: the pricing estimate must NEVER index VIDEO_PRICING with a poisoned
  // key (defense-in-depth — the resolver also guards, but the estimate is a
  // second untrusted-id index site that DIVERGENCE 4 covers).
  it("never indexes VIDEO_PRICING with a prototype-pollution key (SEC-04)", () => {
    const safe = estimateVideoCostUsd("fal", undefined, { durationSecs: 8 });
    // A poisoned key must fall back to the fal rate, never read a planted
    // prototype property — so the estimate is identical to the fal estimate.
    expect(estimateVideoCostUsd("__proto__", undefined, { durationSecs: 8 })).toBe(safe);
    expect(estimateVideoCostUsd("constructor", undefined, { durationSecs: 8 })).toBe(safe);
    expect(estimateVideoCostUsd("prototype", undefined, { durationSecs: 8 })).toBe(safe);
  });

  it("exposes a fal entry in the single pricing table", () => {
    expect(VIDEO_PRICING.fal?.perSecond).toBeGreaterThan(0);
  });
});
