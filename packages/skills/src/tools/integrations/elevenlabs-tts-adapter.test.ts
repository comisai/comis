// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElevenLabsTTSAdapter } from "./elevenlabs-tts-adapter.js";

// Mock the ElevenLabs SDK
vi.mock("@elevenlabs/elevenlabs-js", () => {
  const mockConvert = vi.fn();
  return {
    ElevenLabsClient: vi.fn().mockImplementation(function () {
      return { textToSpeech: { convert: mockConvert } };
    }),
    __mockConvert: mockConvert,
  };
});

// Helper to get the mock convert function
async function getMockConvert() {
  const mod = await import("@elevenlabs/elevenlabs-js");
  return (mod as unknown as { __mockConvert: ReturnType<typeof vi.fn> }).__mockConvert;
}

// Helper to create an async iterable from chunks (simulates Readable stream)
function createAsyncIterable(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < chunks.length) {
            return { value: chunks[index++]!, done: false };
          }
          return { value: undefined, done: true as const };
        },
      };
    },
  };
}

describe("createElevenLabsTTSAdapter", () => {
  let mockConvert: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockConvert = await getMockConvert();
  });

  it("should synthesize text to audio successfully", async () => {
    const audioData = new Uint8Array([1, 2, 3, 4]);
    mockConvert.mockResolvedValue(createAsyncIterable([audioData]));

    const adapter = createElevenLabsTTSAdapter({ apiKey: "test-key" });
    const result = await adapter.synthesize("Hello world");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Buffer.isBuffer(result.value.audio)).toBe(true);
      expect(result.value.audio.byteLength).toBe(4);
      expect(result.value.mimeType).toBe("audio/mpeg");
    }

    expect(mockConvert).toHaveBeenCalledWith("Xb7hH8MSUJpSbSDYk0k2", {
      text: "Hello world",
      modelId: "eleven_multilingual_v2",
      outputFormat: "mp3_44100_128",
    });
  });

  it("should reject empty text", async () => {
    const adapter = createElevenLabsTTSAdapter({ apiKey: "test-key" });
    const result = await adapter.synthesize("");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("empty");
    }
  });

  it("should reject text exceeding maximum length", async () => {
    const adapter = createElevenLabsTTSAdapter({ apiKey: "test-key" });
    const longText = "a".repeat(5001);
    const result = await adapter.synthesize(longText);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("5000");
      expect(result.error.message).toContain("exceeds");
    }
  });

  it("should accept text at exactly maximum length", async () => {
    const audioData = new Uint8Array([10, 20]);
    mockConvert.mockResolvedValue(createAsyncIterable([audioData]));

    const adapter = createElevenLabsTTSAdapter({ apiKey: "test-key" });
    const exactText = "a".repeat(5000);
    const result = await adapter.synthesize(exactText);

    expect(result.ok).toBe(true);
  });

  it("should use custom voice and model", async () => {
    const audioData = new Uint8Array([5, 6]);
    mockConvert.mockResolvedValue(createAsyncIterable([audioData]));

    const adapter = createElevenLabsTTSAdapter({
      apiKey: "test-key",
      modelId: "eleven_turbo_v2_5",
      defaultVoice: "custom-voice-id",
    });
    await adapter.synthesize("Test");

    expect(mockConvert).toHaveBeenCalledWith("custom-voice-id", {
      text: "Test",
      modelId: "eleven_turbo_v2_5",
      outputFormat: "mp3_44100_128",
    });
  });

  it("should use voice from options over default", async () => {
    const audioData = new Uint8Array([7, 8]);
    mockConvert.mockResolvedValue(createAsyncIterable([audioData]));

    const adapter = createElevenLabsTTSAdapter({
      apiKey: "test-key",
      defaultVoice: "default-voice",
    });
    await adapter.synthesize("Test", { voice: "override-voice" });

    expect(mockConvert).toHaveBeenCalledWith(
      "override-voice",
      expect.objectContaining({ text: "Test" }),
    );
  });

  it("should handle API errors gracefully and sanitize", async () => {
    mockConvert.mockRejectedValue(new Error("API rate limit exceeded"));

    const adapter = createElevenLabsTTSAdapter({ apiKey: "test-key" });
    const result = await adapter.synthesize("Hello");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("ElevenLabs TTS error");
    }
  });

  it("should handle non-Error throws and sanitize", async () => {
    mockConvert.mockRejectedValue("unexpected string error");

    const adapter = createElevenLabsTTSAdapter({ apiKey: "test-key" });
    const result = await adapter.synthesize("Hello");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("ElevenLabs TTS error");
    }
  });

  it("should redact credentials in SDK error messages", async () => {
    mockConvert.mockRejectedValue(
      new Error("Authentication failed for key sk-abc123def456ghi789jkl012mno345pqr678 at https://api.elevenlabs.io/v1"),
    );

    const adapter = createElevenLabsTTSAdapter({ apiKey: "test-key" });
    const result = await adapter.synthesize("Hello");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("ElevenLabs TTS error");
      expect(result.error.message).not.toContain("sk-abc123def456ghi789jkl012mno345pqr678");
      expect(result.error.message).not.toContain("https://api.elevenlabs.io");
      expect(result.error.message).toContain("[REDACTED]");
      expect(result.error.message).toContain("[URL]");
    }
  });

  it("should consume multiple stream chunks", async () => {
    const chunk1 = new Uint8Array([1, 2]);
    const chunk2 = new Uint8Array([3, 4]);
    const chunk3 = new Uint8Array([5, 6]);
    mockConvert.mockResolvedValue(createAsyncIterable([chunk1, chunk2, chunk3]));

    const adapter = createElevenLabsTTSAdapter({ apiKey: "test-key" });
    const result = await adapter.synthesize("Hello world");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.audio.byteLength).toBe(6);
      expect([...result.value.audio]).toEqual([1, 2, 3, 4, 5, 6]);
    }
  });
});
