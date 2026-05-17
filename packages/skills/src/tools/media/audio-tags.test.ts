// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AudioMetadata } from "./audio-tags.js";

// ---------------------------------------------------------------------------
// Mock music-metadata for field-mapping tests
// ---------------------------------------------------------------------------
const mockParseBuffer = vi.fn();

vi.mock("music-metadata", () => ({
  parseBuffer: mockParseBuffer,
}));

// Import AFTER mock is registered
const { extractAudioMetadata } = await import("./audio-tags.js");

// ---------------------------------------------------------------------------
// Real parsing — error cases
// ---------------------------------------------------------------------------
describe("extractAudioMetadata — error handling", () => {
  beforeEach(() => {
    // Force real failure by rejecting
    mockParseBuffer.mockRejectedValue(new Error("Not a supported audio format"));
  });

  it("returns err Result for an empty buffer", async () => {
    const result = await extractAudioMetadata(Buffer.alloc(0));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it("returns err Result for random bytes", async () => {
    const result = await extractAudioMetadata(
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it("result always has .ok property (Result shape)", async () => {
    const result = await extractAudioMetadata(Buffer.alloc(0));

    expect(result).toHaveProperty("ok");
    expect(typeof result.ok).toBe("boolean");
  });

  it("wraps non-Error thrown values in Error", async () => {
    mockParseBuffer.mockRejectedValue("string error");

    const result = await extractAudioMetadata(Buffer.alloc(0));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe("string error");
    }
  });
});

// ---------------------------------------------------------------------------
// Field mapping — mock-based
// ---------------------------------------------------------------------------
describe("extractAudioMetadata — field mapping", () => {
  beforeEach(() => {
    mockParseBuffer.mockReset();
  });

  it("maps all music-metadata fields to AudioMetadata", async () => {
    mockParseBuffer.mockResolvedValue({
      common: {
        title: "Test Song",
        artist: "Test Artist",
        album: "Test Album",
        year: 2024,
        genre: ["Rock"],
      },
      format: {
        duration: 180.5,
        bitrate: 320_000,
        sampleRate: 44_100,
        numberOfChannels: 2,
        container: "MPEG",
        lossless: false,
      },
    });

    const result = await extractAudioMetadata(Buffer.alloc(1));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const meta: AudioMetadata = result.value;
    expect(meta.title).toBe("Test Song");
    expect(meta.artist).toBe("Test Artist");
    expect(meta.album).toBe("Test Album");
    expect(meta.year).toBe(2024);
    expect(meta.genre).toBe("Rock");
    expect(meta.durationMs).toBe(180_500);
    expect(meta.bitrate).toBe(320_000);
    expect(meta.sampleRate).toBe(44_100);
    expect(meta.channels).toBe(2);
    expect(meta.format).toBe("MPEG");
    expect(meta.lossless).toBe(false);
  });

  it("takes first genre from array", async () => {
    mockParseBuffer.mockResolvedValue({
      common: { genre: ["Jazz", "Blues"] },
      format: {},
    });

    const result = await extractAudioMetadata(Buffer.alloc(1));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.genre).toBe("Jazz");
    }
  });

  it("handles partial metadata (sparse tags)", async () => {
    mockParseBuffer.mockResolvedValue({
      common: { title: "Sparse Track" },
      format: { sampleRate: 48_000 },
    });

    const result = await extractAudioMetadata(Buffer.alloc(1));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.title).toBe("Sparse Track");
    expect(result.value.artist).toBeUndefined();
    expect(result.value.album).toBeUndefined();
    expect(result.value.year).toBeUndefined();
    expect(result.value.genre).toBeUndefined();
    expect(result.value.durationMs).toBeUndefined();
    expect(result.value.bitrate).toBeUndefined();
    expect(result.value.sampleRate).toBe(48_000);
    expect(result.value.channels).toBeUndefined();
    expect(result.value.format).toBeUndefined();
    expect(result.value.lossless).toBeUndefined();
  });

  it("converts duration from seconds to milliseconds (rounded)", async () => {
    mockParseBuffer.mockResolvedValue({
      common: {},
      format: { duration: 3.1415 },
    });

    const result = await extractAudioMetadata(Buffer.alloc(1));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.durationMs).toBe(3142);
    }
  });

  it("passes mimeType to parseBuffer", async () => {
    mockParseBuffer.mockResolvedValue({
      common: {},
      format: {},
    });

    await extractAudioMetadata(Buffer.alloc(1), "audio/ogg");

    expect(mockParseBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      { mimeType: "audio/ogg" },
    );
  });

  it("handles undefined genre array", async () => {
    mockParseBuffer.mockResolvedValue({
      common: { title: "No Genre" },
      format: {},
    });

    const result = await extractAudioMetadata(Buffer.alloc(1));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.genre).toBeUndefined();
    }
  });

  it("handles empty genre array", async () => {
    mockParseBuffer.mockResolvedValue({
      common: { genre: [] },
      format: {},
    });

    const result = await extractAudioMetadata(Buffer.alloc(1));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.genre).toBeUndefined();
    }
  });
});
