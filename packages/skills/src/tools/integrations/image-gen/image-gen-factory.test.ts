// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the image-generation provider factory.
 *
 * The factory serves ONLY `fal` — an explicit `openai` config routes through the
 * daemon's `openai-images` registered transport, not this skills factory. Verifies
 * fal selection + graceful degradation when FAL_KEY is absent (ok(undefined)), and
 * that any non-`fal` provider (including `openai`) hits the error branch.
 */

import { describe, expect, it } from "vitest";

import type { ImageGenerationConfig, SecretManager } from "@comis/core";

import { createImageGenProvider } from "./image-gen-factory.js";

/** Minimal SecretManager fake — only `get` is exercised by the factory. */
function makeSecretManager(secrets: Record<string, string>): SecretManager {
  return {
    get: (key: string): string | undefined => secrets[key],
  } as SecretManager;
}

describe("createImageGenProvider", () => {
  it("returns a fal adapter when FAL_KEY is present", () => {
    const result = createImageGenProvider(
      { provider: "fal" } as ImageGenerationConfig,
      makeSecretManager({ FAL_KEY: "fal-secret" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeDefined();
  });

  it("degrades gracefully (ok(undefined)) when FAL_KEY is missing", () => {
    const result = createImageGenProvider(
      { provider: "fal" } as ImageGenerationConfig,
      makeSecretManager({}),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeUndefined();
  });

  it("`openai` is not a factory provider — it hits the error branch (routed by the daemon openai-images transport instead)", () => {
    // The skills factory does not serve `openai`: a `provider:"openai"` config
    // (even WITH OPENAI_API_KEY) is routed by the daemon selector through the
    // registered `openai-images` transport, so the factory reports it as unknown.
    const result = createImageGenProvider(
      { provider: "openai" } as ImageGenerationConfig,
      makeSecretManager({ OPENAI_API_KEY: "sk-test" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toContain("Unknown image generation provider");
    }
  });

  it("returns an error for an unknown provider", () => {
    const result = createImageGenProvider(
      { provider: "midjourney" } as unknown as ImageGenerationConfig,
      makeSecretManager({}),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toContain("Unknown image generation provider");
    }
  });
});
