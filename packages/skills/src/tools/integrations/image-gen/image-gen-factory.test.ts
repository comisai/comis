// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the image-generation provider factory.
 *
 * 185 FOLD: the factory now serves ONLY `fal` (CFG-01 back-compat) — the
 * `openai` path was removed (explicit `openai` routes through the daemon's
 * `openai-images` registered transport, not this skills factory). Verifies fal
 * selection + graceful degradation when FAL_KEY is absent (ok(undefined)), and
 * that any non-`fal` provider (including the now-folded `openai`) hits the
 * error branch.
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

  it("FOLD: `openai` is no longer a factory provider — it hits the error branch (routed by the daemon openai-images transport instead)", () => {
    // 185 FOLD regression guard: the second parallel openai skills adapter was
    // removed. A `provider:"openai"` config (even WITH OPENAI_API_KEY) is no
    // longer served here — the daemon selector routes it through the registered
    // `openai-images` transport. So the factory reports it as unknown.
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
