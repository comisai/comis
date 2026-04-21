// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for vision provider registry: auto-discovery, registration, and selection.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createVisionProviderRegistry,
  selectVisionProvider,
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
