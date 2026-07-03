// SPDX-License-Identifier: Apache-2.0
/**
 * MEDIA-03 — vision certification.
 *
 * `selectVisionProvider(registry, mediaType, preferredProvider?)` (from @comis/skills)
 * is the real, pure capability-routing function. Building a Map<string,VisionProvider>
 * of fake providers with declared `capabilities` lets us assert the exact routing
 * decision — fallback routing when the primary lacks vision — with no key,
 * no daemon. `createVisionProviderRegistry` proves the sandbox-honest path: no keys ⇒
 * empty registry ⇒ graceful degradation (undefined, no throw).
 *
 * Stage-A (always runs): selectVisionProvider routing (preferred-lacks-capability
 *   fallthrough, image order, video-only, graceful undefined).
 * Stage-B (always runs, no daemon): createVisionProviderRegistry key-gating ⇒ empty
 *   registry ⇒ selectVisionProvider undefined.
 * Stage-C (it.skip, COMIS_LIVE + keys): real image-in analysis {openai,anthropic,google}
 *   + Gemini video.
 *
 * There is NO media:image_analyzed event — assertions are on return values / Map size,
 * never on invented events.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { selectVisionProvider, createVisionProviderRegistry } from "@comis/skills";
import type { VisionProvider, SecretManager, VisionConfig } from "@comis/core";
import { err } from "@comis/shared";
import { buildCredentialRegistry } from "../../credentials.js";

const isLive = !!process.env["COMIS_LIVE"];

const VISION_PROVIDERS = ["openai", "anthropic", "google"] as const;

/** Build a fake VisionProvider with the given id + capabilities (routing only reads .capabilities). */
function vp(id: string, caps: Array<"image" | "video">): VisionProvider {
  return {
    id,
    capabilities: caps,
    describeImage: vi.fn(async () => err(new Error("routing-test-only"))),
    describeVideo: vi.fn(async () => err(new Error("routing-test-only"))),
  } as VisionProvider;
}

/** A minimal VisionConfig with all defaults (providers = openai/anthropic/google). */
function minimalVisionConfig(): VisionConfig {
  return {
    enabled: true,
    providers: ["openai", "anthropic", "google"],
    videoMaxBase64Bytes: 70_000_000,
    videoMaxRawBytes: 50_000_000,
    videoTimeoutMs: 120_000,
    videoMaxDescriptionChars: 500,
    imageMaxFileSizeMb: 20,
    scopeRules: [],
    defaultScopeAction: "allow",
  } as unknown as VisionConfig;
}

// ---------------------------------------------------------------------------
// Stage-A — selectVisionProvider pure-function routing (no key, no daemon)
// ---------------------------------------------------------------------------

describe("VISION Stage-A — selectVisionProvider capability routing (no COMIS_LIVE)", () => {
  it("prefers the preferred provider when it has the requested capability", () => {
    const reg = new Map<string, VisionProvider>([["openai", vp("openai", ["image"])]]);
    expect(selectVisionProvider(reg, "image", "openai")?.id).toBe("openai");
  });

  it("preferred provider LACKING the capability ⇒ falls through to the openai→anthropic→google order", () => {
    const reg = new Map<string, VisionProvider>([
      ["openai", vp("openai", ["image"])],
      ["anthropic", vp("anthropic", ["image"])],
    ]);
    // "nonexistent" is not registered ⇒ falls through; openai precedes anthropic in AUTO_IMAGE_PROVIDERS.
    expect(selectVisionProvider(reg, "image", "nonexistent")?.id).toBe("openai");
  });

  it("image fallback order: with openai absent, anthropic is chosen before google", () => {
    const reg = new Map<string, VisionProvider>([
      ["anthropic", vp("anthropic", ["image"])],
      ["google", vp("google", ["image"])],
    ]);
    expect(selectVisionProvider(reg, "image")?.id).toBe("anthropic");
  });

  it("video routes only to a video-capable provider (google here)", () => {
    const reg = new Map<string, VisionProvider>([
      ["openai", vp("openai", ["image"])],
      ["google", vp("google", ["image", "video"])],
    ]);
    expect(selectVisionProvider(reg, "video")?.id).toBe("google");
  });

  it("preferred provider lacking the requested mediaType is skipped (video falls to a video-capable provider)", () => {
    const reg = new Map<string, VisionProvider>([
      ["google", vp("google", ["image", "video"])],
      ["openai", vp("openai", ["image"])],
    ]);
    // openai is preferred but lacks "video" ⇒ ignored; google (video-capable) is selected.
    expect(selectVisionProvider(reg, "video", "openai")?.id).toBe("google");
  });

  it("returns undefined (graceful degradation, no throw) when no provider has the required capability", () => {
    const reg = new Map<string, VisionProvider>([["openai", vp("openai", ["image"])]]);
    expect(selectVisionProvider(reg, "video")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stage-B — createVisionProviderRegistry key-gating (sandbox-honest degradation)
// ---------------------------------------------------------------------------

describe("VISION Stage-B — registry key-gating ⇒ graceful degradation (no COMIS_LIVE)", () => {
  it("no vision keys present ⇒ empty registry even when config lists all three providers ⇒ selectVisionProvider undefined", () => {
    const secretManager = { get: () => undefined } as unknown as SecretManager;
    const registry = createVisionProviderRegistry({ secretManager, config: minimalVisionConfig() });

    // No ANTHROPIC/OPENAI/GOOGLE key ⇒ nothing registered.
    expect(registry.size).toBe(0);
    // Empty registry ⇒ routing degrades gracefully to undefined (the real keyless runtime path).
    expect(selectVisionProvider(registry, "image")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stage-C — real image/video analysis (COMIS_LIVE + keys, operator-run)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("VISION Stage-C — real image-in analysis + Gemini video (COMIS_LIVE)", () => {
  it("credential registry exposes a skip verdict for vision(openai) (string | null)", () => {
    const verdict = buildCredentialRegistry().getSkipVerdict("vision(openai)");
    expect(verdict === null || typeof verdict === "string").toBe(true);
  });

  for (const provider of VISION_PROVIDERS) {
    it.skip(
      `vision(${provider}): real image-in analysis returns a correct description (deferred to COMIS_LIVE operator run; credential-gated via vision(${provider}), skip≠fail)`,
      () => {
        // Stage-C (operator): boot daemon with buildMediaConfig({ visionProviders:[provider] });
        // creds.getSkipVerdict("vision("+provider+")") to skip-not-fail; driver.sendImage(tinyImageBase64);
        // assert driver.getEcho().getSentMessages() contains a vision description + an INFO line with durationMs.
      },
    );
  }

  it.skip(
    "Gemini video: real video-in description (deferred to COMIS_LIVE operator run; credential-gated via vision-video(google))",
    () => {
      // Stage-C (operator): vision-video(google) gate; inject a tiny video; assert a description is returned.
    },
  );
});
