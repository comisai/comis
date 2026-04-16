/**
 * Tests for TTS directive parsing and stripping.
 */

import { describe, it, expect } from "vitest";
import { parseTtsDirective, stripTtsDirectives } from "./tts-directive-parser.js";

// ---------------------------------------------------------------------------
// parseTtsDirective
// ---------------------------------------------------------------------------

describe("parseTtsDirective", () => {
  it("parses empty [[tts]] directive", () => {
    const result = parseTtsDirective("Hello [[tts]] world");

    expect(result.directive).toBeDefined();
    expect(result.directive).not.toBeNull();
    // Empty directive object (no voice/provider/format/speed)
    expect(result.directive!.voice).toBeUndefined();
    expect(result.directive!.provider).toBeUndefined();
    expect(result.directive!.format).toBeUndefined();
    expect(result.directive!.speed).toBeUndefined();
    expect(result.cleanText).toBe("Hello  world");
  });

  it("parses [[tts:voice=nova]]", () => {
    const result = parseTtsDirective("Say this [[tts:voice=nova]] out loud");

    expect(result.directive).not.toBeNull();
    expect(result.directive!.voice).toBe("nova");
    expect(result.cleanText).toBe("Say this  out loud");
  });

  it("parses multiple params [[tts:voice=nova provider=openai format=opus speed=1.5]]", () => {
    const result = parseTtsDirective("[[tts:voice=nova provider=openai format=opus speed=1.5]] Hello!");

    expect(result.directive).not.toBeNull();
    expect(result.directive!.voice).toBe("nova");
    expect(result.directive!.provider).toBe("openai");
    expect(result.directive!.format).toBe("opus");
    expect(result.directive!.speed).toBe(1.5);
    expect(result.cleanText).toBe("Hello!");
  });

  it("strips directive from text", () => {
    const result = parseTtsDirective("Hello [[tts:voice=nova]] world");

    expect(result.cleanText).toBe("Hello  world");
  });

  it("returns null directive when no tag found", () => {
    const result = parseTtsDirective("No directive here");

    expect(result.directive).toBeNull();
    expect(result.cleanText).toBe("No directive here");
  });

  it("handles malformed directives gracefully", () => {
    // Malformed params should be silently ignored
    const result = parseTtsDirective("[[tts:invalid_key=value unknown=stuff]] Hello");

    // "invalid_key" and "unknown" are not recognized keys, silently ignored
    expect(result.directive).not.toBeNull();
    expect(result.cleanText).toBe("Hello");
  });

  it("validates provider against allowed values", () => {
    const result = parseTtsDirective("[[tts:provider=invalid_provider]] Hello");

    expect(result.directive).not.toBeNull();
    // Invalid provider silently ignored
    expect(result.directive!.provider).toBeUndefined();
  });

  it("ignores negative speed values", () => {
    const result = parseTtsDirective("[[tts:speed=-1.5]] Hello");

    expect(result.directive).not.toBeNull();
    expect(result.directive!.speed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// stripTtsDirectives
// ---------------------------------------------------------------------------

describe("stripTtsDirectives", () => {
  it("removes all directives from text", () => {
    const text = "First [[tts]] middle [[tts:voice=nova]] end";
    const result = stripTtsDirectives(text);

    expect(result).toBe("First  middle  end");
  });

  it("returns unchanged text when no directives", () => {
    const text = "No directives here";
    const result = stripTtsDirectives(text);

    expect(result).toBe("No directives here");
  });

  it("handles text with only a directive", () => {
    const result = stripTtsDirectives("[[tts]]");
    expect(result).toBe("");
  });
});
