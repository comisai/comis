// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for gemini-vision-adapter: Gemini API image and video analysis.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createGeminiVisionProvider } from "./gemini-vision-adapter.js";

// ---------------------------------------------------------------------------
// Mock video-handler for describeVideo path
// ---------------------------------------------------------------------------

const mockEncodeVideoForApi = vi.fn();
vi.mock("./video-handler.js", () => ({
  encodeVideoForApi: (...args: unknown[]) => mockEncodeVideoForApi(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function geminiResponse(text: string, tokens = 42) {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { totalTokenCount: tokens },
  };
}

function mockFetchOk(data: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

function mockFetchError(status: number, body: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(body),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  mockEncodeVideoForApi.mockReset();
});

// ---------------------------------------------------------------------------
// describeImage
// ---------------------------------------------------------------------------

describe("describeImage", () => {
  it("returns ok with text, provider, model, and tokensUsed on success", async () => {
    vi.stubGlobal("fetch", mockFetchOk(geminiResponse("A cat", 42)));
    const provider = createGeminiVisionProvider({ apiKey: "test-key" });

    const result = await provider.describeImage({
      image: Buffer.from("fake-image-data"),
      prompt: "What is this?",
      mimeType: "image/png",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe("A cat");
    expect(result.value.provider).toBe("google");
    expect(result.value.model).toBe("gemini-2.5-flash");
    expect(result.value.tokensUsed).toBe(42);
  });

  it("returns err for empty image buffer without calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const provider = createGeminiVisionProvider({ apiKey: "test-key" });

    const result = await provider.describeImage({
      image: Buffer.alloc(0),
      prompt: "Describe",
      mimeType: "image/jpeg",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("Image buffer is empty");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns err on non-200 API response", async () => {
    vi.stubGlobal("fetch", mockFetchError(400, "Bad Request"));
    const provider = createGeminiVisionProvider({ apiKey: "test-key" });

    const result = await provider.describeImage({
      image: Buffer.from("data"),
      prompt: "Describe",
      mimeType: "image/png",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("Gemini API error (400): Bad Request");
  });

  it("returns err when response has no text content", async () => {
    const noText = {
      candidates: [{ content: { parts: [{}] } }],
      usageMetadata: { totalTokenCount: 10 },
    };
    vi.stubGlobal("fetch", mockFetchOk(noText));
    const provider = createGeminiVisionProvider({ apiKey: "test-key" });

    const result = await provider.describeImage({
      image: Buffer.from("data"),
      prompt: "Describe",
      mimeType: "image/png",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("Gemini response contained no text content");
  });

  it("returns err wrapping Error on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network timeout")));
    const provider = createGeminiVisionProvider({ apiKey: "test-key" });

    const result = await provider.describeImage({
      image: Buffer.from("data"),
      prompt: "Describe",
      mimeType: "image/png",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("Network timeout");
  });

  it("returns err wrapping string on non-Error throw", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("string error"));
    const provider = createGeminiVisionProvider({ apiKey: "test-key" });

    const result = await provider.describeImage({
      image: Buffer.from("data"),
      prompt: "Describe",
      mimeType: "image/png",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("string error");
  });

  it("sends correct request body structure", async () => {
    const fetchSpy = mockFetchOk(geminiResponse("result"));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = createGeminiVisionProvider({ apiKey: "test-key" });

    const imageData = Buffer.from("test-image");
    await provider.describeImage({
      image: imageData,
      prompt: "Describe this image",
      mimeType: "image/png",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0];

    // URL
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );

    // Headers
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(options.headers["x-goog-api-key"]).toBe("test-key");

    // Body
    const body = JSON.parse(options.body);
    expect(body.contents[0].parts[0].inline_data.mime_type).toBe("image/png");
    expect(body.contents[0].parts[0].inline_data.data).toBe(imageData.toString("base64"));
    expect(body.contents[0].parts[1].text).toBe("Describe this image");
    expect(body.generationConfig.maxOutputTokens).toBe(1024); // DEFAULT_MAX_TOKENS
  });

  it("uses custom model and baseUrl in endpoint construction", async () => {
    const fetchSpy = mockFetchOk(geminiResponse("result"));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = createGeminiVisionProvider({
      apiKey: "test-key",
      model: "gemini-1.5-pro",
      baseUrl: "https://custom.api.example.com/v2",
    });

    await provider.describeImage({
      image: Buffer.from("data"),
      prompt: "Describe",
      mimeType: "image/png",
    });

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://custom.api.example.com/v2/models/gemini-1.5-pro:generateContent");
  });

  it("uses custom maxTokens from request", async () => {
    const fetchSpy = mockFetchOk(geminiResponse("result"));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = createGeminiVisionProvider({ apiKey: "test-key" });

    await provider.describeImage({
      image: Buffer.from("data"),
      prompt: "Describe",
      mimeType: "image/png",
      maxTokens: 2048,
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.generationConfig.maxOutputTokens).toBe(2048);
  });

  it("returns correct model in result when custom model is set", async () => {
    vi.stubGlobal("fetch", mockFetchOk(geminiResponse("desc", 10)));
    const provider = createGeminiVisionProvider({
      apiKey: "test-key",
      model: "gemini-1.5-pro",
    });

    const result = await provider.describeImage({
      image: Buffer.from("data"),
      prompt: "Describe",
      mimeType: "image/png",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model).toBe("gemini-1.5-pro");
  });
});

// ---------------------------------------------------------------------------
// describeVideo
// ---------------------------------------------------------------------------

describe("describeVideo", () => {
  it("returns ok when video encoding and API call succeed", async () => {
    mockEncodeVideoForApi.mockReturnValue({
      ok: true,
      value: { base64: "dmlkZW8=", estimatedSize: 100 },
    });
    vi.stubGlobal("fetch", mockFetchOk(geminiResponse("A dog running", 55)));

    const provider = createGeminiVisionProvider({ apiKey: "test-key" });

    const result = await provider.describeVideo!({
      video: Buffer.from("video-data"),
      prompt: "What happens?",
      mimeType: "video/mp4",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe("A dog running");
    expect(result.value.provider).toBe("google");
    expect(result.value.tokensUsed).toBe(55);
  });

  it("returns err for empty video buffer without calling encodeVideoForApi", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const provider = createGeminiVisionProvider({ apiKey: "test-key" });

    const result = await provider.describeVideo!({
      video: Buffer.alloc(0),
      prompt: "Describe",
      mimeType: "video/mp4",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("Video buffer is empty");
    expect(mockEncodeVideoForApi).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns err from encodeVideoForApi without calling fetch", async () => {
    mockEncodeVideoForApi.mockReturnValue({
      ok: false,
      error: new Error("Video raw size 100 bytes exceeds limit of 50 bytes"),
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const provider = createGeminiVisionProvider({ apiKey: "test-key" });

    const result = await provider.describeVideo!({
      video: Buffer.from("oversized-video"),
      prompt: "Describe",
      mimeType: "video/mp4",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("exceeds limit");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns err on API error response for video", async () => {
    mockEncodeVideoForApi.mockReturnValue({
      ok: true,
      value: { base64: "dmlkZW8=", estimatedSize: 100 },
    });
    vi.stubGlobal("fetch", mockFetchError(500, "Internal Server Error"));
    const provider = createGeminiVisionProvider({ apiKey: "test-key" });

    const result = await provider.describeVideo!({
      video: Buffer.from("video-data"),
      prompt: "Describe",
      mimeType: "video/mp4",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("Gemini API error (500): Internal Server Error");
  });

  it("includes video base64 from encodeVideoForApi in request body", async () => {
    mockEncodeVideoForApi.mockReturnValue({
      ok: true,
      value: { base64: "encoded-video-base64", estimatedSize: 200 },
    });
    const fetchSpy = mockFetchOk(geminiResponse("result"));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = createGeminiVisionProvider({ apiKey: "test-key" });

    await provider.describeVideo!({
      video: Buffer.from("video-data"),
      prompt: "Describe video",
      mimeType: "video/mp4",
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.contents[0].parts[0].inline_data.data).toBe("encoded-video-base64");
    expect(body.contents[0].parts[0].inline_data.mime_type).toBe("video/mp4");
    expect(body.contents[0].parts[1].text).toBe("Describe video");
  });

  it("passes configured video size limits to encodeVideoForApi", async () => {
    mockEncodeVideoForApi.mockReturnValue({
      ok: true,
      value: { base64: "data", estimatedSize: 50 },
    });
    vi.stubGlobal("fetch", mockFetchOk(geminiResponse("result")));

    const provider = createGeminiVisionProvider({
      apiKey: "test-key",
      videoMaxRawBytes: 25_000_000,
      videoMaxBase64Bytes: 35_000_000,
    });

    await provider.describeVideo!({
      video: Buffer.from("video"),
      prompt: "Describe",
      mimeType: "video/mp4",
    });

    expect(mockEncodeVideoForApi).toHaveBeenCalledWith(
      expect.any(Buffer),
      35_000_000,  // maxBase64Bytes
      25_000_000,  // maxRawBytes
    );
  });
});

// ---------------------------------------------------------------------------
// Provider metadata and config defaults
// ---------------------------------------------------------------------------

describe("createGeminiVisionProvider", () => {
  it("has id 'google' and both image and video capabilities", () => {
    const provider = createGeminiVisionProvider({ apiKey: "test-key" });

    expect(provider.id).toBe("google");
    expect(provider.capabilities).toContain("image");
    expect(provider.capabilities).toContain("video");
  });

  it("defaults to gemini-2.5-flash model", async () => {
    vi.stubGlobal("fetch", mockFetchOk(geminiResponse("result")));
    const provider = createGeminiVisionProvider({ apiKey: "test-key" });

    const result = await provider.describeImage({
      image: Buffer.from("data"),
      prompt: "Describe",
      mimeType: "image/png",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model).toBe("gemini-2.5-flash");
  });

  it("defaults to standard Gemini API base URL", async () => {
    const fetchSpy = mockFetchOk(geminiResponse("result"));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = createGeminiVisionProvider({ apiKey: "test-key" });

    await provider.describeImage({
      image: Buffer.from("data"),
      prompt: "Describe",
      mimeType: "image/png",
    });

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain("generativelanguage.googleapis.com/v1beta");
  });

  it("handles response with missing usageMetadata gracefully", async () => {
    const responseNoTokens = {
      candidates: [{ content: { parts: [{ text: "Something" }] } }],
    };
    vi.stubGlobal("fetch", mockFetchOk(responseNoTokens));
    const provider = createGeminiVisionProvider({ apiKey: "test-key" });

    const result = await provider.describeImage({
      image: Buffer.from("data"),
      prompt: "Describe",
      mimeType: "image/png",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe("Something");
    expect(result.value.tokensUsed).toBeUndefined();
  });
});
