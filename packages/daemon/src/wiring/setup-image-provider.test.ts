// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the RES-02 image-provider selector (setup-image-provider.ts).
 *
 * The selector decides, per the resolved config + the agent's main provider,
 * between the pi-image-adapter (provider:"auto"/openrouter) and the relegated
 * skills adapter (explicit fal/openai) — and returns an honest-unavailable
 * port (carrying the knob-naming hint) for an image-incapable main, never a
 * misroute or silence (RES-03). Uses pi-ai's REAL registry + a mock
 * SecretManager; never the network.
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerImagesApiProvider,
  type AssistantImages,
} from "@earendil-works/pi-ai";
import type { ImageGenerationConfig, ImageGenerationPort, SecretManager } from "@comis/core";
import { createImageProviderSelector } from "./setup-image-provider.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

/** A SecretManager exposing only the supplied keys. */
function mockSecretManager(keys: Record<string, string>): SecretManager {
  return {
    get: (k: string) => keys[k],
    has: (k: string) => keys[k] !== undefined,
    require: (k: string) => {
      const v = keys[k];
      if (v === undefined) throw new Error(`missing ${k}`);
      return v;
    },
    keys: () => Object.keys(keys),
  };
}

/** A minimal valid ImageGenerationConfig with overridable provider. */
function makeConfig(overrides: Partial<ImageGenerationConfig> = {}): ImageGenerationConfig {
  return {
    provider: "auto",
    safetyChecker: true,
    maxPerHour: 10,
    defaultSize: "1024x1024",
    timeoutMs: 60_000,
    fallbackChain: [],
    ...overrides,
  } as ImageGenerationConfig;
}

/** A legacy (fal/openai) skills adapter stand-in. */
function legacyAdapter(): ImageGenerationPort {
  return { id: "fal", isAvailable: () => true, execute: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Register a fake transport over the built-in openrouter-images api so the
  // pi-adapter path resolves without the network. The built-in is auto-
  // registered by pi-ai on import; re-registering with our fake is idempotent.
  const fakeGen = vi.fn(
    async (): Promise<AssistantImages> =>
      ({
        stopReason: "stop",
        output: [{ type: "image", data: Buffer.from("PNG").toString("base64"), mimeType: "image/png" }],
        model: "black-forest-labs/flux.2-pro",
        provider: "openrouter",
      }) as unknown as AssistantImages,
  );
  registerImagesApiProvider({ api: "openrouter-images", generateImages: fakeGen } as never);
});

describe("createImageProviderSelector", () => {
  it("follows the main provider to the openrouter pi-adapter when provider is auto", () => {
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "auto" }),
      secretManager: mockSecretManager({ OPENROUTER_API_KEY: "sk-or-123" }),
      mainProviderId: "openrouter",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
    });

    const provider = selector();
    expect(provider).toBeDefined();
    // RES-02 follow-main: the pi-adapter id is the resolved provider, NOT "fal".
    expect(provider!.id).toBe("openrouter");
  });

  it("honors an explicit openrouter override over a different main provider", () => {
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "openrouter" }),
      secretManager: mockSecretManager({ OPENROUTER_API_KEY: "sk-or-123" }),
      mainProviderId: "anthropic", // image-incapable main, but explicit wins
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
    });

    const provider = selector();
    expect(provider).toBeDefined();
    expect(provider!.id).toBe("openrouter");
  });

  it("returns an honest-unavailable port for an image-incapable main provider", async () => {
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "auto" }),
      secretManager: mockSecretManager({}), // no keys
      mainProviderId: "anthropic", // image-incapable
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
    });

    const provider = selector();
    // RES-03: NOT a fal/openai fallback, NOT undefined — an unavailable PORT.
    expect(provider).toBeDefined();
    expect(provider!.isAvailable()).toBe(false);
    const result = await provider!.execute({ prompt: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The err carries the knob-naming hint (handler surfaces it via extractImageHint).
      const hint = (result.error as { hint?: string }).hint;
      expect(hint).toBeDefined();
      expect(hint).toContain("integrations.media.imageGeneration.provider");
    }
  });

  it("returns the legacy skills adapter for an explicit fal provider", () => {
    const legacy = legacyAdapter();
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "fal" }),
      secretManager: mockSecretManager({ FAL_KEY: "fal-123" }),
      mainProviderId: "openrouter",
      legacyGetter: () => legacy,
      logger: createMockLogger() as never,
    });

    const provider = selector();
    // Explicit fal/openai → the EXISTING skills adapter (additive legacy path).
    expect(provider).toBe(legacy);
  });

  it("resolves the openrouter key from SecretManager with no image-specific secret (CRED-01)", async () => {
    // ONLY OPENROUTER_API_KEY present — no FAL_KEY / OPENAI_API_KEY.
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "auto" }),
      secretManager: mockSecretManager({ OPENROUTER_API_KEY: "sk-or-456" }),
      mainProviderId: "openrouter",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
    });

    const provider = selector();
    expect(provider).toBeDefined();
    expect(provider!.id).toBe("openrouter");
    // The adapter is usable — the key reached the (fake) transport, proving
    // image creds come from the same store, no image-specific secret.
    const result = await provider!.execute({ prompt: "a cat" });
    expect(result.ok).toBe(true);
  });

  it("returns undefined when image generation config is absent", () => {
    const selector = createImageProviderSelector({
      imageGenConfig: undefined,
      secretManager: mockSecretManager({}),
      mainProviderId: "openrouter",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
    });

    expect(selector()).toBeUndefined();
  });
});

/**
 * Built-but-not-wired guard (the milestone's #1 recurring blocker).
 *
 * Asserts the RES-01 keystone is wired into the LIVE daemon.ts composition
 * root — NOT merely defined where a test imports it. Reads daemon.ts source and
 * proves (1) the accessor delegates to resolveAgentModel (I4 lockstep), and
 * (2) `resolveAgentMainProvider` appears INSIDE the LIVE `imageHandlerDeps`
 * object literal region, and (3) the boot probe wires the selector +
 * registerComisImageProviders. A parallel copy / a stranded accessor would
 * fail this. (The daemon build is the type-level twin: the now-required field
 * forces the literal to supply it.)
 */
describe("RES-01 keystone is wired into the LIVE daemon.ts composition root", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const daemonSrc = readFileSync(resolve(here, "../daemon.ts"), "utf8");

  it("defines resolveAgentMainProvider delegating to the I4 resolveAgentModel", () => {
    expect(daemonSrc).toMatch(/const resolveAgentMainProvider\s*=/);
    // The accessor body calls resolveAgentModel — the EXACT completion-path fn.
    const accessor = daemonSrc.slice(
      daemonSrc.indexOf("const resolveAgentMainProvider ="),
      daemonSrc.indexOf("const resolveAgentMainProvider =") + 400,
    );
    expect(accessor).toContain("resolveAgentModel(");
    expect(accessor).toContain("providerId");
  });

  it("threads resolveAgentMainProvider INTO the live imageHandlerDeps object literal", () => {
    // Locate the imageHandlerDeps construction region and assert the field is
    // inside it (not just somewhere in the file).
    const start = daemonSrc.indexOf("const imageHandlerDeps");
    expect(start).toBeGreaterThan(-1);
    const region = daemonSrc.slice(start, start + 900);
    expect(region).toContain("getChannelAdapter");
    expect(region).toContain("resolveAgentMainProvider");
  });

  it("wires the selector + registerComisImageProviders at the boot probe", () => {
    expect(daemonSrc).toContain("createImageProviderSelector({");
    expect(daemonSrc).toContain("registerComisImageProviders()");
    // The selector follows the DEFAULT agent's resolved main provider.
    expect(daemonSrc).toMatch(/mainProviderId:\s*defaultMain/);
  });
});
