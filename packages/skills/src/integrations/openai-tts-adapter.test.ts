import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createOpenAITTSAdapter } from "./openai-tts-adapter.js";

describe("createOpenAITTSAdapter", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(status: number, body?: ArrayBuffer | string) {
    const arrayBuffer =
      body instanceof ArrayBuffer ? body : new TextEncoder().encode(body ?? "audio-data").buffer;

    const fn = vi.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(typeof body === "string" ? body : "error"),
      arrayBuffer: () => Promise.resolve(arrayBuffer),
    } as Response);
    globalThis.fetch = fn;
    return fn;
  }

  it("should synthesize text to audio successfully", async () => {
    const audioData = new Uint8Array([1, 2, 3, 4]).buffer;
    const fetchMock = mockFetch(200, audioData);

    const adapter = createOpenAITTSAdapter({ apiKey: "sk-test" });
    const result = await adapter.synthesize("Hello world");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Buffer.isBuffer(result.value.audio)).toBe(true);
      expect(result.value.audio.byteLength).toBe(4);
      expect(result.value.mimeType).toBe("audio/mpeg");
    }

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect(init?.method).toBe("POST");

    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe("tts-1");
    expect(body.input).toBe("Hello world");
    expect(body.voice).toBe("alloy");
    expect(body.response_format).toBe("mp3");
    expect(body.speed).toBe(1.0);
  });

  it("should reject empty text", async () => {
    const adapter = createOpenAITTSAdapter({ apiKey: "sk-test" });
    const result = await adapter.synthesize("");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("empty");
    }
  });

  it("should reject text exceeding maximum length", async () => {
    const adapter = createOpenAITTSAdapter({ apiKey: "sk-test" });
    const longText = "a".repeat(4097);
    const result = await adapter.synthesize(longText);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("4096");
      expect(result.error.message).toContain("exceeds");
    }
  });

  it("should reject invalid speed values", async () => {
    const adapter = createOpenAITTSAdapter({ apiKey: "sk-test" });

    const tooSlow = await adapter.synthesize("Hello", { speed: 0.1 });
    expect(tooSlow.ok).toBe(false);
    if (!tooSlow.ok) {
      expect(tooSlow.error.message).toContain("out of range");
    }

    const tooFast = await adapter.synthesize("Hello", { speed: 5.0 });
    expect(tooFast.ok).toBe(false);
    if (!tooFast.ok) {
      expect(tooFast.error.message).toContain("out of range");
    }
  });

  it("should accept text at exactly maximum length", async () => {
    mockFetch(200);

    const adapter = createOpenAITTSAdapter({ apiKey: "sk-test" });
    const exactText = "a".repeat(4096);
    const result = await adapter.synthesize(exactText);

    expect(result.ok).toBe(true);
  });

  it("should use custom voice and format", async () => {
    const fetchMock = mockFetch(200);

    const adapter = createOpenAITTSAdapter({ apiKey: "sk-test" });
    const result = await adapter.synthesize("Test", {
      voice: "nova",
      format: "opus",
      speed: 1.5,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mimeType).toBe("audio/opus");
    }

    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(body.voice).toBe("nova");
    expect(body.response_format).toBe("opus");
    expect(body.speed).toBe(1.5);
  });

  it("should handle API errors gracefully", async () => {
    mockFetch(500, "Internal server error");

    const adapter = createOpenAITTSAdapter({ apiKey: "sk-test" });
    const result = await adapter.synthesize("Hello");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("500");
    }
  });

  it("should sanitize API error bodies containing credentials", async () => {
    mockFetch(401, '{"error":"Invalid key sk-abc123def456ghi789jkl012mno345pqr678"}');

    const adapter = createOpenAITTSAdapter({ apiKey: "sk-test" });
    const result = await adapter.synthesize("Hello");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("OpenAI TTS error");
      expect(result.error.message).toContain("401");
      expect(result.error.message).not.toContain("sk-abc123def456ghi789jkl012mno345pqr678");
      expect(result.error.message).toContain("[REDACTED]");
    }
  });

  it("should redact URLs in TTS API error bodies", async () => {
    mockFetch(500, 'Error at https://api.openai.com/v1/internal');

    const adapter = createOpenAITTSAdapter({ apiKey: "sk-test" });
    const result = await adapter.synthesize("Hello");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain("https://api.openai.com");
      expect(result.error.message).toContain("[URL]");
    }
  });

  it("should handle network errors", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

    const adapter = createOpenAITTSAdapter({ apiKey: "sk-test" });
    const result = await adapter.synthesize("Hello");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Connection refused");
    }
  });

  it("should use custom base URL and model", async () => {
    const fetchMock = mockFetch(200);

    const adapter = createOpenAITTSAdapter({
      apiKey: "sk-test",
      baseUrl: "https://custom.api.com/v1",
      model: "tts-1-hd",
    });
    await adapter.synthesize("Hello");

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://custom.api.com/v1/audio/speech");

    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(body.model).toBe("tts-1-hd");
  });

  it("should map format to correct MIME types", async () => {
    const formats: Record<string, string> = {
      mp3: "audio/mpeg",
      opus: "audio/opus",
      aac: "audio/aac",
      flac: "audio/flac",
      wav: "audio/wav",
    };

    for (const [format, expectedMime] of Object.entries(formats)) {
      mockFetch(200);
      const adapter = createOpenAITTSAdapter({ apiKey: "sk-test" });
      const result = await adapter.synthesize("Hi", { format });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.mimeType).toBe(expectedMime);
      }
    }
  });
});
