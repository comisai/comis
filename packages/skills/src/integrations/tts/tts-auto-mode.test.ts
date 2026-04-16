/**
 * Tests for TTS auto mode decision logic.
 */

import { describe, it, expect } from "vitest";
import { shouldAutoTts, type AutoTtsConfig, type AutoTtsContext } from "./tts-auto-mode.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(mode: AutoTtsConfig["autoMode"]): AutoTtsConfig {
  return {
    autoMode: mode,
    tagPattern: "\\[\\[tts(?::[^\\]]*)?\\]\\]",
  };
}

function makeContext(overrides: Partial<AutoTtsContext> = {}): AutoTtsContext {
  return {
    responseText: "Hello, world!",
    hasInboundAudio: false,
    hasMediaUrl: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// off mode
// ---------------------------------------------------------------------------

describe("shouldAutoTts - off mode", () => {
  it("always returns false regardless of input", () => {
    const config = makeConfig("off");

    expect(shouldAutoTts(config, makeContext()).shouldSynthesize).toBe(false);
    expect(shouldAutoTts(config, makeContext({ hasInboundAudio: true })).shouldSynthesize).toBe(false);
    expect(shouldAutoTts(config, makeContext({ responseText: "[[tts]] Hi" })).shouldSynthesize).toBe(false);
  });

  it("returns false even with media URL", () => {
    const config = makeConfig("off");
    const result = shouldAutoTts(config, makeContext({ hasMediaUrl: true }));
    expect(result.shouldSynthesize).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// always mode
// ---------------------------------------------------------------------------

describe("shouldAutoTts - always mode", () => {
  it("returns true for normal text response", () => {
    const config = makeConfig("always");
    const result = shouldAutoTts(config, makeContext());
    expect(result.shouldSynthesize).toBe(true);
  });

  it("returns false when response has media URL", () => {
    const config = makeConfig("always");
    const result = shouldAutoTts(config, makeContext({ hasMediaUrl: true }));
    expect(result.shouldSynthesize).toBe(false);
  });

  it("returns true even when inbound has audio", () => {
    const config = makeConfig("always");
    const result = shouldAutoTts(config, makeContext({ hasInboundAudio: true }));
    expect(result.shouldSynthesize).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// inbound mode
// ---------------------------------------------------------------------------

describe("shouldAutoTts - inbound mode", () => {
  it("returns true when inbound has audio (voice message reply)", () => {
    const config = makeConfig("inbound");
    const result = shouldAutoTts(config, makeContext({ hasInboundAudio: true }));
    expect(result.shouldSynthesize).toBe(true);
  });

  it("returns false when no inbound audio (text message)", () => {
    const config = makeConfig("inbound");
    const result = shouldAutoTts(config, makeContext({ hasInboundAudio: false }));
    expect(result.shouldSynthesize).toBe(false);
  });

  it("returns false when inbound audio but response has media", () => {
    const config = makeConfig("inbound");
    const result = shouldAutoTts(config, makeContext({ hasInboundAudio: true, hasMediaUrl: true }));
    expect(result.shouldSynthesize).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tagged mode
// ---------------------------------------------------------------------------

describe("shouldAutoTts - tagged mode", () => {
  it("returns true when text has [[tts]] tag and strips it", () => {
    const config = makeConfig("tagged");
    const result = shouldAutoTts(config, makeContext({ responseText: "Hello [[tts]] world" }));

    expect(result.shouldSynthesize).toBe(true);
    expect(result.strippedText).toBe("Hello  world");
  });

  it("returns true with parameterized tag [[tts:voice=nova]]", () => {
    const config = makeConfig("tagged");
    const result = shouldAutoTts(config, makeContext({ responseText: "[[tts:voice=nova]] Hello!" }));

    expect(result.shouldSynthesize).toBe(true);
    expect(result.strippedText).toBe("Hello!");
  });

  it("returns false when no tag present", () => {
    const config = makeConfig("tagged");
    const result = shouldAutoTts(config, makeContext({ responseText: "Plain text response" }));

    expect(result.shouldSynthesize).toBe(false);
    expect(result.strippedText).toBeUndefined();
  });

  it("strips multiple TTS tags from text", () => {
    const config = makeConfig("tagged");
    const result = shouldAutoTts(config, makeContext({
      responseText: "[[tts]] First part [[tts:voice=nova]] second part",
    }));

    expect(result.shouldSynthesize).toBe(true);
    expect(result.strippedText).toBe("First part  second part");
  });
});
