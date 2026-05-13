// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createGroqSttAdapter } from "./groq-stt-adapter.js";

describe("createGroqSttAdapter", () => {
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

  it("should transcribe audio successfully with text, language, and durationMs", async () => {
    const fetchMock = mockFetch(200, {
      text: "Hello world",
      language: "english",
      duration: 3.5,
    });

    const adapter = createGroqSttAdapter({ apiKey: "gsk-test" });
    const audio = Buffer.from("fake-audio-data");
    const result = await adapter.transcribe(audio, { mimeType: "audio/ogg" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe("Hello world");
      expect(result.value.language).toBe("english");
      expect(result.value.durationMs).toBe(3500);
    }

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("should convert duration seconds to milliseconds correctly", async () => {
    mockFetch(200, { text: "test", duration: 12.345 });

    const adapter = createGroqSttAdapter({ apiKey: "gsk-test" });
    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.durationMs).toBe(12345);
    }
  });

  it("should return undefined language when missing from response", async () => {
    mockFetch(200, { text: "test" });

    const adapter = createGroqSttAdapter({ apiKey: "gsk-test" });
    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe("test");
      expect(result.value.language).toBeUndefined();
      expect(result.value.durationMs).toBeUndefined();
    }
  });

  it("should reject empty audio buffer", async () => {
    const adapter = createGroqSttAdapter({ apiKey: "gsk-test" });
    const result = await adapter.transcribe(Buffer.alloc(0), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("empty");
    }
  });

  it("should reject oversized audio buffer", async () => {
    const adapter = createGroqSttAdapter({ apiKey: "gsk-test", maxFileSizeMb: 1 });
    const audio = Buffer.alloc(2 * 1024 * 1024);
    const result = await adapter.transcribe(audio, { mimeType: "audio/mp3" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("exceeds limit");
      expect(result.error.message).toContain("1MB");
    }
  });

  it("should return error on HTTP failure", async () => {
    mockFetch(500, "Internal Server Error");

    const adapter = createGroqSttAdapter({ apiKey: "gsk-test" });
    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("500");
    }
  });

  it("should return descriptive timeout error on AbortError", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    globalThis.fetch = vi.fn().mockRejectedValue(abortError);

    const adapter = createGroqSttAdapter({ apiKey: "gsk-test", timeoutMs: 3000 });
    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("timeout");
      expect(result.error.message).toContain("3000");
    }
  });

  it("should use whisper-large-v3-turbo as the default model", async () => {
    const fetchMock = mockFetch(200, { text: "test" });

    const adapter = createGroqSttAdapter({ apiKey: "gsk-test" });
    await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    const formData = fetchMock.mock.calls[0]![1]?.body as FormData;
    expect(formData.get("model")).toBe("whisper-large-v3-turbo");
  });

  it("should use Groq base URL by default (not OpenAI)", async () => {
    const fetchMock = mockFetch(200, { text: "test" });

    const adapter = createGroqSttAdapter({ apiKey: "gsk-test" });
    await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
  });

  it("should sanitize API error bodies containing credentials", async () => {
    const secretBody = '{"error":"Invalid key gsk-abc123def456ghi789jkl012mno345pqr678"}';
    mockFetch(401, secretBody);

    const adapter = createGroqSttAdapter({ apiKey: "gsk-test" });
    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Groq STT error");
      expect(result.error.message).toContain("401");
      expect(result.error.message).not.toContain("gsk-abc123def456ghi789jkl012mno345pqr678");
      expect(result.error.message).toContain("[REDACTED]");
    }
  });

  it("should redact URLs in API error bodies", async () => {
    mockFetch(500, 'Failed at https://api.groq.com/internal/endpoint');

    const adapter = createGroqSttAdapter({ apiKey: "gsk-test" });
    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain("https://api.groq.com");
      expect(result.error.message).toContain("[URL]");
    }
  });

  it("should use response_format verbose_json (NOT json)", async () => {
    const fetchMock = mockFetch(200, { text: "test" });

    const adapter = createGroqSttAdapter({ apiKey: "gsk-test" });
    await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    const formData = fetchMock.mock.calls[0]![1]?.body as FormData;
    expect(formData.get("response_format")).toBe("verbose_json");
  });
});
