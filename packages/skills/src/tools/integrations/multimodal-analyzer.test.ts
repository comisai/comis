// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMultimodalAnalyzer } from "./multimodal-analyzer.js";

describe("createMultimodalAnalyzer", () => {
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

  const testImage = Buffer.from("fake-image-data");
  const testPrompt = "What is in this image?";
  const testOptions = { mimeType: "image/png" };

  // ─── Anthropic provider tests ───────────────────────────────────────

  describe("Anthropic provider (default)", () => {
    it("should analyze image successfully", async () => {
      const fetchMock = mockFetch(200, {
        content: [{ type: "text", text: "A cat sitting on a mat" }],
      });

      const analyzer = createMultimodalAnalyzer({ apiKey: "sk-ant-test" });
      const result = await analyzer.analyze(testImage, testPrompt, testOptions);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("A cat sitting on a mat");
      }

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect(init?.method).toBe("POST");

      const headers = init?.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("sk-ant-test");
      expect(headers["anthropic-version"]).toBe("2023-06-01");

      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe("claude-sonnet-4-5-20250929");
      expect(body.messages[0].content[0].type).toBe("image");
      expect(body.messages[0].content[0].source.type).toBe("base64");
      expect(body.messages[0].content[0].source.media_type).toBe("image/png");
      expect(body.messages[0].content[1].text).toBe(testPrompt);
    });

    it("should handle missing text in response", async () => {
      mockFetch(200, { content: [{ type: "tool_use" }] });

      const analyzer = createMultimodalAnalyzer({ apiKey: "sk-test" });
      const result = await analyzer.analyze(testImage, testPrompt, testOptions);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("no text content");
      }
    });
  });

  // ─── OpenAI provider tests ─────────────────────────────────────────

  describe("OpenAI provider", () => {
    it("should analyze image successfully", async () => {
      const fetchMock = mockFetch(200, {
        choices: [{ message: { content: "A dog playing fetch" } }],
      });

      const analyzer = createMultimodalAnalyzer({
        apiKey: "sk-test",
        provider: "openai",
      });
      const result = await analyzer.analyze(testImage, testPrompt, testOptions);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("A dog playing fetch");
      }

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://api.openai.com/v1/chat/completions");

      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sk-test");

      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe("gpt-4o");
      expect(body.messages[0].content[0].type).toBe("image_url");
      expect(body.messages[0].content[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    });

    it("should handle empty choices in response", async () => {
      mockFetch(200, { choices: [{ message: { content: null } }] });

      const analyzer = createMultimodalAnalyzer({
        apiKey: "sk-test",
        provider: "openai",
      });
      const result = await analyzer.analyze(testImage, testPrompt, testOptions);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("no content");
      }
    });
  });

  // ─── Common validation tests ────────────────────────────────────────

  describe("validation", () => {
    it("should reject files exceeding size limit", async () => {
      const analyzer = createMultimodalAnalyzer({
        apiKey: "sk-test",
        maxFileSizeMb: 1,
      });
      const largeImage = Buffer.alloc(2 * 1024 * 1024);
      const result = await analyzer.analyze(largeImage, testPrompt, testOptions);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("exceeds limit");
        expect(result.error.message).toContain("1MB");
      }
    });

    it("should reject empty image buffer", async () => {
      const analyzer = createMultimodalAnalyzer({ apiKey: "sk-test" });
      const result = await analyzer.analyze(Buffer.alloc(0), testPrompt, testOptions);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("empty");
      }
    });

    it("should reject empty prompt", async () => {
      const analyzer = createMultimodalAnalyzer({ apiKey: "sk-test" });
      const result = await analyzer.analyze(testImage, "  ", testOptions);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("prompt is empty");
      }
    });

    it("should use custom maxTokens", async () => {
      const fetchMock = mockFetch(200, {
        content: [{ type: "text", text: "result" }],
      });

      const analyzer = createMultimodalAnalyzer({ apiKey: "sk-test" });
      await analyzer.analyze(testImage, testPrompt, {
        mimeType: "image/jpeg",
        maxTokens: 2048,
      });

      const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
      expect(body.max_tokens).toBe(2048);
    });
  });

  // ─── Error handling tests ──────────────────────────────────────────

  describe("error handling", () => {
    it("should handle API errors gracefully", async () => {
      mockFetch(403, "Forbidden");

      const analyzer = createMultimodalAnalyzer({ apiKey: "sk-test" });
      const result = await analyzer.analyze(testImage, testPrompt, testOptions);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("403");
      }
    });

    it("should handle network errors", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("DNS resolution failed"));

      const analyzer = createMultimodalAnalyzer({ apiKey: "sk-test" });
      const result = await analyzer.analyze(testImage, testPrompt, testOptions);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("DNS resolution failed");
      }
    });

    it("should use custom base URL", async () => {
      const fetchMock = mockFetch(200, {
        content: [{ type: "text", text: "custom" }],
      });

      const analyzer = createMultimodalAnalyzer({
        apiKey: "sk-test",
        baseUrl: "https://proxy.example.com/v1",
      });
      await analyzer.analyze(testImage, testPrompt, testOptions);

      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://proxy.example.com/v1/messages");
    });

    it("should use custom model", async () => {
      const fetchMock = mockFetch(200, {
        content: [{ type: "text", text: "result" }],
      });

      const analyzer = createMultimodalAnalyzer({
        apiKey: "sk-test",
        model: "claude-opus-4-20250514",
      });
      await analyzer.analyze(testImage, testPrompt, testOptions);

      const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
      expect(body.model).toBe("claude-opus-4-20250514");
    });
  });
});
