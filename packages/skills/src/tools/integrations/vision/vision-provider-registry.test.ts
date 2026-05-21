// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for vision provider registry: auto-discovery, registration, and selection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createVisionProviderRegistry,
  selectVisionProvider,
  createAnthropicVisionProvider,
  createOpenAIVisionProvider,
} from "./vision-provider-registry.js";
import type { VisionProvider, VisionConfig, SecretManager } from "@comis/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSecretManager(keys: Record<string, string>): SecretManager {
  return {
    get: (name: string) => keys[name] ?? undefined,
    redact: (text: string) => text,
    has: (name: string) => name in keys,
  } as unknown as SecretManager;
}

function makeConfig(overrides: Partial<VisionConfig> = {}): VisionConfig {
  return {
    enabled: true,
    providers: ["openai", "anthropic", "google"],
    videoMaxBase64Bytes: 70_000_000,
    videoMaxRawBytes: 50_000_000,
    imageMaxFileSizeMb: 20,
    scopeRules: [],
    defaultScopeAction: "allow",
    ...overrides,
  } as VisionConfig;
}

// ---------------------------------------------------------------------------
// createVisionProviderRegistry
// ---------------------------------------------------------------------------

describe("createVisionProviderRegistry", () => {
  it("registers only providers with available API keys", () => {
    const sm = makeSecretManager({ OPENAI_API_KEY: "sk-test-openai" });
    const config = makeConfig();

    const registry = createVisionProviderRegistry({ secretManager: sm, config });

    expect(registry.size).toBe(1);
    expect(registry.has("openai")).toBe(true);
    expect(registry.has("anthropic")).toBe(false);
    expect(registry.has("google")).toBe(false);
  });

  it("registers all three providers when all keys present", () => {
    const sm = makeSecretManager({
      OPENAI_API_KEY: "sk-test",
      ANTHROPIC_API_KEY: "sk-ant-test",
      GOOGLE_API_KEY: "goog-test",
    });
    const config = makeConfig();

    const registry = createVisionProviderRegistry({ secretManager: sm, config });

    expect(registry.size).toBe(3);
    expect(registry.has("openai")).toBe(true);
    expect(registry.has("anthropic")).toBe(true);
    expect(registry.has("google")).toBe(true);
  });

  it("registers no providers when no keys are available", () => {
    const sm = makeSecretManager({});
    const config = makeConfig();

    const registry = createVisionProviderRegistry({ secretManager: sm, config });

    expect(registry.size).toBe(0);
  });

  it("respects provider list in config", () => {
    const sm = makeSecretManager({
      OPENAI_API_KEY: "sk-test",
      ANTHROPIC_API_KEY: "sk-ant-test",
      GOOGLE_API_KEY: "goog-test",
    });
    // Only allow openai in providers
    const config = makeConfig({ providers: ["openai"] });

    const registry = createVisionProviderRegistry({ secretManager: sm, config });

    expect(registry.size).toBe(1);
    expect(registry.has("openai")).toBe(true);
    expect(registry.has("anthropic")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// selectVisionProvider
// ---------------------------------------------------------------------------

describe("selectVisionProvider", () => {
  function makeProvider(id: string, caps: Array<"image" | "video">): VisionProvider {
    return {
      id,
      capabilities: caps,
      describeImage: vi.fn(),
      describeVideo: vi.fn(),
    };
  }

  it("returns preferred provider when available", () => {
    const registry = new Map<string, VisionProvider>();
    const anthropic = makeProvider("anthropic", ["image"]);
    const openai = makeProvider("openai", ["image"]);
    registry.set("anthropic", anthropic);
    registry.set("openai", openai);

    const result = selectVisionProvider(registry, "image", "anthropic");

    expect(result).toBe(anthropic);
  });

  it("falls back through priority order for image", () => {
    const registry = new Map<string, VisionProvider>();
    // No openai, so fallback order should reach anthropic
    const anthropic = makeProvider("anthropic", ["image"]);
    const google = makeProvider("google", ["image", "video"]);
    registry.set("anthropic", anthropic);
    registry.set("google", google);

    const result = selectVisionProvider(registry, "image");

    // Fallback order is openai -> anthropic -> google; openai absent, so anthropic
    expect(result).toBe(anthropic);
  });

  it("returns google for video (only video-capable provider)", () => {
    const registry = new Map<string, VisionProvider>();
    const openai = makeProvider("openai", ["image"]);
    const google = makeProvider("google", ["image", "video"]);
    registry.set("openai", openai);
    registry.set("google", google);

    const result = selectVisionProvider(registry, "video");

    expect(result).toBe(google);
  });

  it("returns undefined when no provider available", () => {
    const registry = new Map<string, VisionProvider>();

    const result = selectVisionProvider(registry, "image");

    expect(result).toBeUndefined();
  });

  it("returns undefined when preferred provider lacks required capability", () => {
    const registry = new Map<string, VisionProvider>();
    const openai = makeProvider("openai", ["image"]); // no video
    registry.set("openai", openai);

    const result = selectVisionProvider(registry, "video", "openai");

    // openai cannot do video, and no other provider has video capability
    expect(result).toBeUndefined();
  });

  it("wraps existing multimodal analyzers as VisionProvider with image capability", () => {
    const sm = makeSecretManager({ ANTHROPIC_API_KEY: "sk-ant-test" });
    const config = makeConfig({ providers: ["anthropic"] });

    const registry = createVisionProviderRegistry({ secretManager: sm, config });
    const provider = registry.get("anthropic");

    expect(provider).toBeDefined();
    expect(provider!.id).toBe("anthropic");
    expect(provider!.capabilities).toContain("image");
    expect(typeof provider!.describeImage).toBe("function");
  });

  it("google provider has both image and video capabilities", () => {
    const sm = makeSecretManager({ GOOGLE_API_KEY: "goog-test" });
    const config = makeConfig({ providers: ["google"] });

    const registry = createVisionProviderRegistry({ secretManager: sm, config });
    const provider = registry.get("google");

    expect(provider).toBeDefined();
    expect(provider!.capabilities).toContain("image");
    expect(provider!.capabilities).toContain("video");
  });
});

// ---------------------------------------------------------------------------
// createAnthropicVisionProvider — inlined factory (post-multimodal-analyzer)
// ---------------------------------------------------------------------------

describe("createAnthropicVisionProvider", () => {
  const apiKey = "sk-ant-test";
  const validImage = Buffer.from("fake-image-data");
  const validReq = {
    image: validImage,
    prompt: "Describe this image",
    mimeType: "image/png",
  };
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
      text: () =>
        Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
      json: () => Promise.resolve(body),
    } as Response);
    globalThis.fetch = fn;
    return fn;
  }

  it("returns VisionProvider with id=anthropic and capabilities=[image]", () => {
    const provider = createAnthropicVisionProvider(apiKey);
    expect(provider.id).toBe("anthropic");
    expect(provider.capabilities).toEqual(["image"]);
    expect(typeof provider.describeImage).toBe("function");
  });

  it("uses default model claude-sonnet-4-5-20250929", async () => {
    const fetchMock = mockFetch(200, {
      content: [{ type: "text", text: "A cat sitting on a mat" }],
    });

    const provider = createAnthropicVisionProvider(apiKey);
    const result = await provider.describeImage(validReq);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.model).toBe("claude-sonnet-4-5-20250929");
      expect(result.value.provider).toBe("anthropic");
      expect(result.value.text).toBe("A cat sitting on a mat");
    }

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(apiKey);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe("claude-sonnet-4-5-20250929");
    expect(body.messages[0].content[0].type).toBe("image");
    expect(body.messages[0].content[0].source.type).toBe("base64");
    expect(body.messages[0].content[0].source.media_type).toBe("image/png");
    expect(body.messages[0].content[1].text).toBe("Describe this image");
  });

  it("custom model overrides default", async () => {
    const fetchMock = mockFetch(200, {
      content: [{ type: "text", text: "ok" }],
    });

    const provider = createAnthropicVisionProvider(apiKey, "claude-opus-4-20250514");
    const result = await provider.describeImage(validReq);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.model).toBe("claude-opus-4-20250514");
    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(body.model).toBe("claude-opus-4-20250514");
  });

  it("returns Result.err on file size > 20MB", async () => {
    const huge = Buffer.alloc(21 * 1024 * 1024, 0xff);
    const provider = createAnthropicVisionProvider(apiKey);
    const result = await provider.describeImage({ ...validReq, image: huge });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/exceeds limit of 20MB/);
    }
  });

  it("returns Result.err on empty image buffer", async () => {
    const provider = createAnthropicVisionProvider(apiKey);
    const result = await provider.describeImage({ ...validReq, image: Buffer.alloc(0) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Image buffer is empty");
    }
  });

  it("returns Result.err on empty prompt", async () => {
    const provider = createAnthropicVisionProvider(apiKey);
    const result = await provider.describeImage({ ...validReq, prompt: "   " });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Analysis prompt is empty");
    }
  });

  it("propagates HTTP 401 as Result.err", async () => {
    mockFetch(401, "Unauthorized");
    const provider = createAnthropicVisionProvider(apiKey);
    const result = await provider.describeImage(validReq);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/Anthropic API error \(401\)/);
    }
  });

  it("propagates HTTP 500 as Result.err", async () => {
    mockFetch(500, "Server error");
    const provider = createAnthropicVisionProvider(apiKey);
    const result = await provider.describeImage(validReq);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/Anthropic API error \(500\)/);
    }
  });

  it("returns Result.err when Anthropic response contains no text block", async () => {
    mockFetch(200, { content: [{ type: "tool_use" }] });
    const provider = createAnthropicVisionProvider(apiKey);
    const result = await provider.describeImage(validReq);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("no text content");
    }
  });

  it("handles network errors gracefully (caught in try/catch)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("DNS resolution failed"));
    const provider = createAnthropicVisionProvider(apiKey);
    const result = await provider.describeImage(validReq);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("DNS resolution failed");
    }
  });

  it("passes maxTokens through to request body", async () => {
    const fetchMock = mockFetch(200, {
      content: [{ type: "text", text: "ok" }],
    });
    const provider = createAnthropicVisionProvider(apiKey);
    await provider.describeImage({ ...validReq, maxTokens: 2048 });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(body.max_tokens).toBe(2048);
  });
});

// ---------------------------------------------------------------------------
// createOpenAIVisionProvider — inlined factory (post-multimodal-analyzer)
// ---------------------------------------------------------------------------

describe("createOpenAIVisionProvider", () => {
  const apiKey = "sk-openai-test";
  const validImage = Buffer.from("fake-image-data");
  const validReq = {
    image: validImage,
    prompt: "What is in this image?",
    mimeType: "image/png",
  };
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
      text: () =>
        Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
      json: () => Promise.resolve(body),
    } as Response);
    globalThis.fetch = fn;
    return fn;
  }

  it("returns VisionProvider with id=openai and capabilities=[image]", () => {
    const provider = createOpenAIVisionProvider(apiKey);
    expect(provider.id).toBe("openai");
    expect(provider.capabilities).toEqual(["image"]);
    expect(typeof provider.describeImage).toBe("function");
  });

  it("uses default model gpt-4o", async () => {
    const fetchMock = mockFetch(200, {
      choices: [{ message: { content: "A dog playing fetch" } }],
    });

    const provider = createOpenAIVisionProvider(apiKey);
    const result = await provider.describeImage(validReq);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.model).toBe("gpt-4o");
      expect(result.value.provider).toBe("openai");
      expect(result.value.text).toBe("A dog playing fetch");
    }

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${apiKey}`);
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe("gpt-4o");
    expect(body.messages[0].content[0].type).toBe("image_url");
    expect(body.messages[0].content[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(body.messages[0].content[1].text).toBe("What is in this image?");
  });

  it("custom model overrides default", async () => {
    const fetchMock = mockFetch(200, {
      choices: [{ message: { content: "ok" } }],
    });

    const provider = createOpenAIVisionProvider(apiKey, "gpt-4o-mini");
    const result = await provider.describeImage(validReq);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.model).toBe("gpt-4o-mini");
    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(body.model).toBe("gpt-4o-mini");
  });

  it("returns Result.err on file size > 20MB", async () => {
    const huge = Buffer.alloc(21 * 1024 * 1024, 0xff);
    const provider = createOpenAIVisionProvider(apiKey);
    const result = await provider.describeImage({ ...validReq, image: huge });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/exceeds limit of 20MB/);
    }
  });

  it("returns Result.err on empty image buffer", async () => {
    const provider = createOpenAIVisionProvider(apiKey);
    const result = await provider.describeImage({ ...validReq, image: Buffer.alloc(0) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Image buffer is empty");
    }
  });

  it("returns Result.err on empty prompt", async () => {
    const provider = createOpenAIVisionProvider(apiKey);
    const result = await provider.describeImage({ ...validReq, prompt: "   " });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Analysis prompt is empty");
    }
  });

  it("propagates HTTP 401 as Result.err", async () => {
    mockFetch(401, "Unauthorized");
    const provider = createOpenAIVisionProvider(apiKey);
    const result = await provider.describeImage(validReq);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/OpenAI API error \(401\)/);
    }
  });

  it("propagates HTTP 500 as Result.err", async () => {
    mockFetch(500, "Server error");
    const provider = createOpenAIVisionProvider(apiKey);
    const result = await provider.describeImage(validReq);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/OpenAI API error \(500\)/);
    }
  });

  it("returns Result.err when OpenAI response contains no content", async () => {
    mockFetch(200, { choices: [{ message: { content: null } }] });
    const provider = createOpenAIVisionProvider(apiKey);
    const result = await provider.describeImage(validReq);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("no content");
    }
  });

  it("handles network errors gracefully (caught in try/catch)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("DNS resolution failed"));
    const provider = createOpenAIVisionProvider(apiKey);
    const result = await provider.describeImage(validReq);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("DNS resolution failed");
    }
  });

  it("passes maxTokens through to request body", async () => {
    const fetchMock = mockFetch(200, {
      choices: [{ message: { content: "ok" } }],
    });
    const provider = createOpenAIVisionProvider(apiKey);
    await provider.describeImage({ ...validReq, maxTokens: 2048 });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(body.max_tokens).toBe(2048);
  });
});
