// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEdgeTTSAdapter } from "./edge-tts-adapter.js";

// Mock edge-tts-universal
vi.mock("edge-tts-universal", () => {
  const mockSynthesize = vi.fn();
  const MockEdgeTTS = vi.fn().mockImplementation(function () {
    return { synthesize: mockSynthesize };
  });
  return {
    EdgeTTS: MockEdgeTTS,
    __mockSynthesize: mockSynthesize,
    __MockEdgeTTS: MockEdgeTTS,
  };
});

async function getMocks() {
  const mod = await import("edge-tts-universal");
  const casted = mod as unknown as {
    __mockSynthesize: ReturnType<typeof vi.fn>;
    __MockEdgeTTS: ReturnType<typeof vi.fn>;
  };
  return { mockSynthesize: casted.__mockSynthesize, MockEdgeTTS: casted.__MockEdgeTTS };
}

function createAudioBlob(data: number[]): Blob {
  return new Blob([new Uint8Array(data)], { type: "audio/mpeg" });
}

describe("createEdgeTTSAdapter", () => {
  let mockSynthesize: ReturnType<typeof vi.fn>;
  let MockEdgeTTS: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mocks = await getMocks();
    mockSynthesize = mocks.mockSynthesize;
    MockEdgeTTS = mocks.MockEdgeTTS;
  });

  it("should synthesize text to audio successfully", async () => {
    mockSynthesize.mockResolvedValue({
      audio: createAudioBlob([1, 2, 3, 4]),
    });

    const adapter = createEdgeTTSAdapter({});
    const result = await adapter.synthesize("Hello world");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Buffer.isBuffer(result.value.audio)).toBe(true);
      expect(result.value.audio.byteLength).toBe(4);
      expect(result.value.mimeType).toBe("audio/mpeg");
    }

    expect(MockEdgeTTS).toHaveBeenCalledWith("Hello world", "en-US-AvaMultilingualNeural", {
      rate: "+0%",
      volume: "+0%",
      pitch: "+0Hz",
    });
  });

  it("should reject empty text", async () => {
    const adapter = createEdgeTTSAdapter({});
    const result = await adapter.synthesize("");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("empty");
    }
  });

  it("should reject text exceeding maximum length", async () => {
    const adapter = createEdgeTTSAdapter({});
    const longText = "a".repeat(5001);
    const result = await adapter.synthesize(longText);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("5000");
      expect(result.error.message).toContain("exceeds");
    }
  });

  it("should accept text at exactly maximum length", async () => {
    mockSynthesize.mockResolvedValue({
      audio: createAudioBlob([10, 20]),
    });

    const adapter = createEdgeTTSAdapter({});
    const exactText = "a".repeat(5000);
    const result = await adapter.synthesize(exactText);

    expect(result.ok).toBe(true);
  });

  it("should use custom voice parameter", async () => {
    mockSynthesize.mockResolvedValue({
      audio: createAudioBlob([5, 6]),
    });

    const adapter = createEdgeTTSAdapter({
      defaultVoice: "es-ES-ElviraNeural",
    });
    await adapter.synthesize("Hola");

    expect(MockEdgeTTS).toHaveBeenCalledWith("Hola", "es-ES-ElviraNeural", expect.any(Object));
  });

  it("should use voice from options over default", async () => {
    mockSynthesize.mockResolvedValue({
      audio: createAudioBlob([7, 8]),
    });

    const adapter = createEdgeTTSAdapter({
      defaultVoice: "default-voice",
    });
    await adapter.synthesize("Test", { voice: "override-voice" });

    expect(MockEdgeTTS).toHaveBeenCalledWith("Test", "override-voice", expect.any(Object));
  });

  it("should handle synthesis errors gracefully and sanitize", async () => {
    mockSynthesize.mockRejectedValue(new Error("WebSocket closed"));

    const adapter = createEdgeTTSAdapter({});
    const result = await adapter.synthesize("Hello");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Edge TTS error");
      expect(result.error.message).toContain("WebSocket closed");
    }
  });

  it("should handle non-Error throws and sanitize", async () => {
    mockSynthesize.mockRejectedValue("unexpected error");

    const adapter = createEdgeTTSAdapter({});
    const result = await adapter.synthesize("Hello");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Edge TTS error");
    }
  });

  it("should redact URLs in error messages", async () => {
    mockSynthesize.mockRejectedValue(
      new Error("Connection failed to https://speech.platform.bing.com/consumer/speech/synthesize"),
    );

    const adapter = createEdgeTTSAdapter({});
    const result = await adapter.synthesize("Hello");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Edge TTS error");
      expect(result.error.message).not.toContain("https://speech.platform.bing.com");
      expect(result.error.message).toContain("[URL]");
    }
  });
});
