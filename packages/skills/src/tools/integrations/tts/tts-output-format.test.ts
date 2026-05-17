// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { resolveOutputFormat, inferMimeType } from "./tts-output-format.js";

// ---------------------------------------------------------------------------
// resolveOutputFormat
// ---------------------------------------------------------------------------

describe("resolveOutputFormat", () => {
  it("returns mp3 default when no channel and no overrides", () => {
    const fmt = resolveOutputFormat(undefined);
    expect(fmt.openai).toBe("mp3");
    expect(fmt.extension).toBe(".mp3");
    expect(fmt.voiceCompatible).toBe(false);
  });

  it("returns opus for telegram channel (CHANNEL_DEFAULTS)", () => {
    const fmt = resolveOutputFormat("telegram");
    expect(fmt.openai).toBe("opus");
    expect(fmt.extension).toBe(".opus");
    expect(fmt.voiceCompatible).toBe(true);
  });

  it("returns mp3 for discord channel", () => {
    const fmt = resolveOutputFormat("discord");
    expect(fmt.openai).toBe("mp3");
    expect(fmt.extension).toBe(".mp3");
  });

  it("applies channel-specific outputFormats override", () => {
    const fmt = resolveOutputFormat("telegram", { telegram: "wav" });
    expect(fmt.openai).toBe("wav");
    expect(fmt.extension).toBe(".wav");
    expect(fmt.voiceCompatible).toBe(false);
  });

  it("applies default outputFormats override when no channel", () => {
    const fmt = resolveOutputFormat(undefined, { default: "aac" });
    expect(fmt.openai).toBe("aac");
    expect(fmt.extension).toBe(".aac");
  });

  it("falls back to mp3 for unknown format name", () => {
    const fmt = resolveOutputFormat("telegram", { telegram: "unknown_format" });
    // FORMAT_MAP["unknown_format"] is undefined -> falls back to DEFAULT_FORMAT (mp3)
    expect(fmt.openai).toBe("mp3");
    expect(fmt.extension).toBe(".mp3");
  });

  it("falls back to mp3 for channel not in CHANNEL_DEFAULTS and no overrides", () => {
    const fmt = resolveOutputFormat("sms");
    expect(fmt.openai).toBe("mp3");
    expect(fmt.extension).toBe(".mp3");
  });

  it("returns correct shape with all expected fields", () => {
    const fmt = resolveOutputFormat("telegram");
    expect(fmt).toHaveProperty("openai");
    expect(fmt).toHaveProperty("elevenlabs");
    expect(fmt).toHaveProperty("edge");
    expect(fmt).toHaveProperty("extension");
    expect(fmt).toHaveProperty("voiceCompatible");
  });

  it("opus format has voiceCompatible=true and extension .opus", () => {
    const fmt = resolveOutputFormat("telegram");
    expect(fmt.voiceCompatible).toBe(true);
    expect(fmt.extension).toBe(".opus");
  });

  it("mp3 format has voiceCompatible=false and extension .mp3", () => {
    const fmt = resolveOutputFormat("discord");
    expect(fmt.voiceCompatible).toBe(false);
    expect(fmt.extension).toBe(".mp3");
  });

  it("uses outputFormats.default as fallback when channel has no override and is unknown", () => {
    const fmt = resolveOutputFormat("sms", { default: "wav" });
    expect(fmt.openai).toBe("wav");
    expect(fmt.extension).toBe(".wav");
  });
});

// ---------------------------------------------------------------------------
// inferMimeType
// ---------------------------------------------------------------------------

describe("inferMimeType", () => {
  it('infers MIME type "audio/opus" from ".opus" extension per inferMimeType contract', () => {
    expect(inferMimeType(".opus")).toBe("audio/opus");
  });

  it('infers MIME type "audio/opus" from ".ogg" extension per inferMimeType contract', () => {
    expect(inferMimeType(".ogg")).toBe("audio/opus");
  });

  it('infers MIME type "audio/mpeg" from ".mp3" extension per inferMimeType contract', () => {
    expect(inferMimeType(".mp3")).toBe("audio/mpeg");
  });

  it('infers MIME type "audio/wav" from ".wav" extension per inferMimeType contract', () => {
    expect(inferMimeType(".wav")).toBe("audio/wav");
  });

  it('infers MIME type "audio/aac" from ".aac" extension per inferMimeType contract', () => {
    expect(inferMimeType(".aac")).toBe("audio/aac");
  });

  it('infers MIME type "audio/flac" from ".flac" extension per inferMimeType contract', () => {
    expect(inferMimeType(".flac")).toBe("audio/flac");
  });

  it('infers MIME type "audio/pcm" from ".pcm" extension per inferMimeType contract', () => {
    expect(inferMimeType(".pcm")).toBe("audio/pcm");
  });

  it('"mp3" (without dot) -> "audio/mpeg"', () => {
    expect(inferMimeType("mp3")).toBe("audio/mpeg");
  });

  it('unknown extension -> "audio/mpeg" (default)', () => {
    expect(inferMimeType(".xyz")).toBe("audio/mpeg");
  });
});
