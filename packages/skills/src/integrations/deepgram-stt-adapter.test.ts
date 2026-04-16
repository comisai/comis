import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDeepgramSttAdapter } from "./deepgram-stt-adapter.js";

describe("createDeepgramSttAdapter", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(status: number, body: unknown) {
    const fn = vi.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
      json: () => Promise.resolve(body),
    } as Response);
    globalThis.fetch = fn;
    return fn;
  }

  const deepgramSuccessResponse = {
    metadata: { duration: 3.5 },
    results: {
      channels: [
        {
          detected_language: "en",
          alternatives: [
            { transcript: "Hello world", confidence: 0.99 },
          ],
        },
      ],
    },
  };

  it("should transcribe audio successfully with text, detected language, and durationMs", async () => {
    const fetchMock = mockFetch(200, deepgramSuccessResponse);

    const adapter = createDeepgramSttAdapter({ apiKey: "dg-test" });
    const audio = Buffer.from("fake-audio-data");
    const result = await adapter.transcribe(audio, { mimeType: "audio/ogg" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe("Hello world");
      expect(result.value.language).toBe("en");
      expect(result.value.durationMs).toBe(3500);
    }

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("should use Token auth header (NOT Bearer)", async () => {
    const fetchMock = mockFetch(200, deepgramSuccessResponse);

    const adapter = createDeepgramSttAdapter({ apiKey: "dg-test-key" });
    await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    const headers = fetchMock.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Token dg-test-key");
    expect(headers["Authorization"]).not.toContain("Bearer");
  });

  it("should set Content-Type to the audio MIME type (NOT multipart/form-data)", async () => {
    const fetchMock = mockFetch(200, deepgramSuccessResponse);

    const adapter = createDeepgramSttAdapter({ apiKey: "dg-test" });
    await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    const headers = fetchMock.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("audio/ogg");
  });

  it("should send raw Buffer body (NOT FormData)", async () => {
    const fetchMock = mockFetch(200, deepgramSuccessResponse);

    const adapter = createDeepgramSttAdapter({ apiKey: "dg-test" });
    const audioBuffer = Buffer.from("raw-audio-bytes");
    await adapter.transcribe(audioBuffer, { mimeType: "audio/wav" });

    const body = fetchMock.mock.calls[0]![1]?.body;
    expect(body).toBeInstanceOf(Uint8Array);
    expect(body).not.toBeInstanceOf(FormData);
  });

  it("should include model, smart_format, and detect_language query params in URL", async () => {
    const fetchMock = mockFetch(200, deepgramSuccessResponse);

    const adapter = createDeepgramSttAdapter({ apiKey: "dg-test" });
    await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("model=nova-3");
    expect(url).toContain("smart_format=true");
    expect(url).toContain("detect_language=true");
  });

  it("should replace detect_language with language param when options.language is set", async () => {
    const fetchMock = mockFetch(200, deepgramSuccessResponse);

    const adapter = createDeepgramSttAdapter({ apiKey: "dg-test" });
    await adapter.transcribe(Buffer.from("audio"), {
      mimeType: "audio/ogg",
      language: "es",
    });

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("language=es");
    expect(url).not.toContain("detect_language=true");
  });

  it("should return graceful defaults for deeply nested response with missing fields", async () => {
    mockFetch(200, {});

    const adapter = createDeepgramSttAdapter({ apiKey: "dg-test" });
    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe("");
      expect(result.value.language).toBeUndefined();
      expect(result.value.durationMs).toBeUndefined();
    }
  });

  it("should reject empty audio buffer", async () => {
    const adapter = createDeepgramSttAdapter({ apiKey: "dg-test" });
    const result = await adapter.transcribe(Buffer.alloc(0), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("empty");
    }
  });

  it("should reject oversized audio buffer", async () => {
    const adapter = createDeepgramSttAdapter({ apiKey: "dg-test", maxFileSizeMb: 1 });
    const audio = Buffer.alloc(2 * 1024 * 1024);
    const result = await adapter.transcribe(audio, { mimeType: "audio/mp3" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("exceeds limit");
      expect(result.error.message).toContain("1MB");
    }
  });

  it("should return error on HTTP failure", async () => {
    mockFetch(403, "Forbidden");

    const adapter = createDeepgramSttAdapter({ apiKey: "dg-test" });
    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("403");
    }
  });

  it("should return descriptive timeout error on AbortError", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    globalThis.fetch = vi.fn().mockRejectedValue(abortError);

    const adapter = createDeepgramSttAdapter({ apiKey: "dg-test", timeoutMs: 8000 });
    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("timeout");
      expect(result.error.message).toContain("8000");
    }
  });

  it("should sanitize API error bodies containing credentials", async () => {
    const secretBody = '{"error":"Unauthorized: token dg-abc123def456ghi789jkl012mno345pqr678"}';
    mockFetch(401, secretBody);

    const adapter = createDeepgramSttAdapter({ apiKey: "dg-test" });
    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Deepgram STT error");
      expect(result.error.message).toContain("401");
      expect(result.error.message).not.toContain("dg-abc123def456ghi789jkl012mno345pqr678");
      expect(result.error.message).toContain("[REDACTED]");
    }
  });

  it("should redact URLs in API error bodies", async () => {
    mockFetch(500, 'Internal error at https://api.deepgram.com/v1/listen');

    const adapter = createDeepgramSttAdapter({ apiKey: "dg-test" });
    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain("https://api.deepgram.com");
      expect(result.error.message).toContain("[URL]");
    }
  });

  it("should use nova-3 as the default model", async () => {
    const fetchMock = mockFetch(200, deepgramSuccessResponse);

    const adapter = createDeepgramSttAdapter({ apiKey: "dg-test" });
    await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("model=nova-3");
  });
});
