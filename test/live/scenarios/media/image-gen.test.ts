// SPDX-License-Identifier: Apache-2.0
/**
 * MEDIA-04 — image generation + autoMode delivery decisions.
 *
 * `autoMode` is the TTS auto-mode (TtsAutoModeSchema — the ONLY `autoMode` in config;
 * design line 343 / MEDIA-04). Its decision function `shouldAutoTts` (from @comis/skills)
 * is pure and keyless — the four modes' voice/text delivery decisions are fully assertable
 * in the sandbox, including the "always + media-response ⇒ deliver the image, don't voice
 * it over" interaction. For `fal`, `createImageGenProvider` returns ok(undefined) when the
 * key is absent — the sandbox-honest "image-gen disabled" path. Since the 185 FOLD (v2.23)
 * `openai` is no longer a skills-factory provider (it routes through the daemon's `openai-images`
 * registered pi-ai transport), so a `provider:"openai"` config hits the factory's error branch.
 * Real "draw X"→image lives behind COMIS_LIVE via the image.* RPC.
 *
 * Stage-A (always runs): autoMode + image-gen provider constants.
 * Stage-B (always runs, no daemon): shouldAutoTts delivery decisions ×4 (incl. always+media
 *   and tagged-strip) + createImageGenProvider key-gating (fal ⇒ ok(undefined); openai folded
 *   out in the 185 FOLD ⇒ err).
 * Stage-C (it.skip, COMIS_LIVE + keys): real {fal,openai} "draw X" → delivered image.
 *
 * There is NO media:image_generated event and NO image-gen autoMode — assertions are on
 * shouldAutoTts return values + the createImageGenProvider Result.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { shouldAutoTts, createImageGenProvider } from "@comis/skills";
import type { SecretManager, ImageGenerationConfig } from "@comis/core";
import { buildCredentialRegistry } from "../../credentials.js";

const isLive = !!process.env["COMIS_LIVE"];

const AUTOMODE_VALUES = ["off", "always", "inbound", "tagged"] as const;
const IMAGE_GEN_PROVIDERS = ["fal", "openai"] as const;
const TAG = "\\[\\[tts(?::.*?)?\\]\\]";

// ---------------------------------------------------------------------------
// Stage-A — constants (no key, no daemon)
// ---------------------------------------------------------------------------

describe("IMAGE-GEN Stage-A — autoMode + provider constants (no COMIS_LIVE)", () => {
  it("AUTOMODE_VALUES covers all four modes", () => {
    expect(AUTOMODE_VALUES.length).toBe(4);
    expect(AUTOMODE_VALUES).toContain("off");
    expect(AUTOMODE_VALUES).toContain("always");
    expect(AUTOMODE_VALUES).toContain("inbound");
    expect(AUTOMODE_VALUES).toContain("tagged");
  });

  it("IMAGE_GEN_PROVIDERS covers fal and openai", () => {
    expect(IMAGE_GEN_PROVIDERS).toContain("fal");
    expect(IMAGE_GEN_PROVIDERS).toContain("openai");
  });
});

// ---------------------------------------------------------------------------
// Stage-B — shouldAutoTts delivery decisions ×4 + image-gen key-gating
// ---------------------------------------------------------------------------

describe("IMAGE-GEN Stage-B — autoMode delivery decisions + image-gen key-gating (no COMIS_LIVE, deterministic)", () => {
  it("autoMode off ⇒ never synthesize (text delivery)", () => {
    expect(
      shouldAutoTts(
        { autoMode: "off", tagPattern: TAG },
        { responseText: "here you go", hasInboundAudio: true, hasMediaUrl: false },
      ).shouldSynthesize,
    ).toBe(false);
  });

  it("autoMode always with no media ⇒ synthesize (voice delivery)", () => {
    expect(
      shouldAutoTts(
        { autoMode: "always", tagPattern: TAG },
        { responseText: "here you go", hasInboundAudio: false, hasMediaUrl: false },
      ).shouldSynthesize,
    ).toBe(true);
  });

  it("autoMode always WITH a media response ⇒ does NOT voice it over (the image is delivered as the image)", () => {
    // The image-gen × autoMode interaction: a "draw X" response carries media, so even
    // autoMode=always declines TTS — the generated image is delivered, not voiced over.
    expect(
      shouldAutoTts(
        { autoMode: "always", tagPattern: TAG },
        { responseText: "here is your drawing", hasInboundAudio: false, hasMediaUrl: true },
      ).shouldSynthesize,
    ).toBe(false);
  });

  it("autoMode inbound ⇒ synthesize only when inbound audio present and no media", () => {
    expect(
      shouldAutoTts(
        { autoMode: "inbound", tagPattern: TAG },
        { responseText: "ok", hasInboundAudio: true, hasMediaUrl: false },
      ).shouldSynthesize,
    ).toBe(true);
    expect(
      shouldAutoTts(
        { autoMode: "inbound", tagPattern: TAG },
        { responseText: "ok", hasInboundAudio: false, hasMediaUrl: false },
      ).shouldSynthesize,
    ).toBe(false);
    expect(
      shouldAutoTts(
        { autoMode: "inbound", tagPattern: TAG },
        { responseText: "ok", hasInboundAudio: true, hasMediaUrl: true },
      ).shouldSynthesize,
    ).toBe(false);
  });

  it("autoMode tagged ⇒ synthesize only when the [[tts]] directive is present, stripping the tag", () => {
    const tagged = shouldAutoTts(
      { autoMode: "tagged", tagPattern: TAG },
      { responseText: "read this aloud [[tts]]", hasInboundAudio: false, hasMediaUrl: false },
    );
    expect(tagged.shouldSynthesize).toBe(true);
    expect(tagged.strippedText).toBe("read this aloud");
    expect(
      shouldAutoTts(
        { autoMode: "tagged", tagPattern: TAG },
        { responseText: "no directive", hasInboundAudio: false, hasMediaUrl: false },
      ).shouldSynthesize,
    ).toBe(false);
  });

  it("createImageGenProvider key-gates fal to ok(undefined) when no key; openai is folded out (185 FOLD) ⇒ err", () => {
    const secretManager = { get: () => undefined } as unknown as SecretManager;

    // fal: the legacy skills factory still serves it — no FAL_KEY ⇒ graceful ok(undefined).
    const falResult = createImageGenProvider(
      { provider: "fal" } as unknown as ImageGenerationConfig,
      secretManager,
    );
    expect(falResult.ok).toBe(true);
    if (falResult.ok) expect(falResult.value).toBeUndefined();

    // openai: removed from this factory in the 185 FOLD (v2.23) — explicit `openai` now routes
    // through the daemon's `openai-images` registered pi-ai transport, so the skills factory
    // reports it as an unknown provider (err), not ok(undefined).
    const openaiResult = createImageGenProvider(
      { provider: "openai" } as unknown as ImageGenerationConfig,
      secretManager,
    );
    expect(openaiResult.ok).toBe(false);
    if (!openaiResult.ok) expect(openaiResult.error.message).toContain("Unknown image generation provider");
  });
});

// ---------------------------------------------------------------------------
// Stage-C — real "draw X" → delivered image (COMIS_LIVE + keys, operator-run)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("IMAGE-GEN Stage-C — real draw-X → delivered image (COMIS_LIVE)", () => {
  it("credential registry exposes a skip verdict for image-gen(fal) (string | null)", () => {
    const verdict = buildCredentialRegistry().getSkipVerdict("image-gen(fal)");
    expect(verdict === null || typeof verdict === "string").toBe(true);
  });

  for (const provider of IMAGE_GEN_PROVIDERS) {
    it.skip(
      `image-gen(${provider}): "draw a red circle" → delivered image attachment (deferred to COMIS_LIVE operator run; credential-gated via image-gen(${provider}), skip≠fail)`,
      () => {
        // Stage-C (operator): boot daemon with buildMediaConfig({ imageGenProvider:provider });
        // creds.getSkipVerdict("image-gen("+provider+")") to skip-not-fail; sendTurn("draw a red circle");
        // agent dispatches the image-gen tool (image.* RPC); assert driver.getEcho().getSentMessages()
        // contains an attachment of type "image". Cheapest-viable: smallest image size.
      },
    );
  }
});
