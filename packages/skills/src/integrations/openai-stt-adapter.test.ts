import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createOpenAISttAdapter } from "./openai-stt-adapter.js";

describe("createOpenAISttAdapter", () => {
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

  it("should transcribe audio successfully with text and undefined language/durationMs", async () => {
    const fetchMock = mockFetch(200, { text: "Hello world" });

    const adapter = createOpenAISttAdapter({ apiKey: "sk-test" });
    const audio = Buffer.from("fake-audio-data");
    const result = await adapter.transcribe(audio, { mimeType: "audio/ogg" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe("Hello world");
      expect(result.value.language).toBeUndefined();
      expect(result.value.durationMs).toBeUndefined();
    }

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
  });

  it("should reject empty audio buffer", async () => {
    const adapter = createOpenAISttAdapter({ apiKey: "sk-test" });
    const result = await adapter.transcribe(Buffer.alloc(0), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("empty");
    }
  });

  it("should reject oversized audio buffer", async () => {
    const adapter = createOpenAISttAdapter({ apiKey: "sk-test", maxFileSizeMb: 1 });
    const audio = Buffer.alloc(2 * 1024 * 1024);
    const result = await adapter.transcribe(audio, { mimeType: "audio/mp3" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("exceeds limit");
      expect(result.error.message).toContain("1MB");
    }
  });

  it("should return error on HTTP 401", async () => {
    mockFetch(401, "Unauthorized");

    const adapter = createOpenAISttAdapter({ apiKey: "sk-test" });
    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("401");
    }
  });

  it("should return error on HTTP 429 rate limit", async () => {
    mockFetch(429, "Rate limit exceeded");

    const adapter = createOpenAISttAdapter({ apiKey: "sk-test" });
    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("429");
    }
  });

  it("should return descriptive timeout error on AbortError", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    globalThis.fetch = vi.fn().mockRejectedValue(abortError);

    const adapter = createOpenAISttAdapter({ apiKey: "sk-test", timeoutMs: 5000 });
    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("timeout");
      expect(result.error.message).toContain("5000");
    }
  });

  it("should use gpt-4o-mini-transcribe as the default model", async () => {
    const fetchMock = mockFetch(200, { text: "test" });

    const adapter = createOpenAISttAdapter({ apiKey: "sk-test" });
    await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    const formData = fetchMock.mock.calls[0]![1]?.body as FormData;
    expect(formData.get("model")).toBe("gpt-4o-mini-transcribe");
  });

  it("should include custom language and prompt in FormData", async () => {
    const fetchMock = mockFetch(200, { text: "Hola mundo" });

    const adapter = createOpenAISttAdapter({ apiKey: "sk-test" });
    await adapter.transcribe(Buffer.from("audio"), {
      mimeType: "audio/mp3",
      language: "es",
      prompt: "This is Spanish",
    });

    const formData = fetchMock.mock.calls[0]![1]?.body as FormData;
    expect(formData.get("language")).toBe("es");
    expect(formData.get("prompt")).toBe("This is Spanish");
  });

  it("should sanitize API error bodies containing credentials", async () => {
    const secretBody = '{"error":{"message":"Invalid API key: sk-abc123def456ghi789jkl012mno345pqr678","type":"invalid_request_error"}}';
    mockFetch(401, secretBody);

    const adapter = createOpenAISttAdapter({ apiKey: "sk-test" });
    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("OpenAI STT error");
      expect(result.error.message).toContain("401");
      // Raw API key must be redacted
      expect(result.error.message).not.toContain("sk-abc123def456ghi789jkl012mno345pqr678");
      expect(result.error.message).toContain("[REDACTED]");
    }
  });

  it("should truncate long API error bodies", async () => {
    const longBody = "x".repeat(300);
    mockFetch(500, longBody);

    const adapter = createOpenAISttAdapter({ apiKey: "sk-test" });
    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("...");
      expect(result.error.message.length).toBeLessThan(300);
    }
  });

  it("should redact URLs in API error bodies", async () => {
    mockFetch(500, 'Error at https://api.openai.com/v1/internal/debug');

    const adapter = createOpenAISttAdapter({ apiKey: "sk-test" });
    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain("https://api.openai.com");
      expect(result.error.message).toContain("[URL]");
    }
  });

  it("should use response_format json (NOT verbose_json)", async () => {
    const fetchMock = mockFetch(200, { text: "test" });

    const adapter = createOpenAISttAdapter({ apiKey: "sk-test" });
    await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    const formData = fetchMock.mock.calls[0]![1]?.body as FormData;
    expect(formData.get("response_format")).toBe("json");
  });
});
