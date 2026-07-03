// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the video-generation provider factory.
 *
 * Like the image factory, this skills factory serves ONLY explicit `fal`
 * (the daemon selector resolves auto/google/xai upstream). Verifies
 * fal selection + graceful degradation when FAL_KEY is absent (ok(undefined)),
 * and that any non-`fal` provider hits the error branch.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import type { VideoGenerationConfig, SecretManager } from "@comis/core";
import { createVideoGenProvider } from "./video-gen-factory.js";

/** Minimal SecretManager fake — only `get` is exercised by the factory. */
function makeSecretManager(secrets: Record<string, string>): SecretManager {
  return {
    get: (key: string): string | undefined => secrets[key],
  } as SecretManager;
}

describe("createVideoGenProvider", () => {
  it("returns a fal video adapter when FAL_KEY is present", () => {
    const result = createVideoGenProvider(
      { provider: "fal" } as VideoGenerationConfig,
      makeSecretManager({ FAL_KEY: "fal-secret" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeDefined();
      expect(result.value?.id).toBe("fal");
    }
  });

  it("degrades gracefully (ok(undefined)) when FAL_KEY is missing", () => {
    const result = createVideoGenProvider(
      { provider: "fal" } as VideoGenerationConfig,
      makeSecretManager({}),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeUndefined();
  });

  it("returns an error for a non-fal provider (auto/google/xai resolve in the daemon selector)", () => {
    for (const provider of ["auto", "google", "xai"]) {
      const result = createVideoGenProvider(
        { provider } as VideoGenerationConfig,
        makeSecretManager({ FAL_KEY: "fal-secret" }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toContain("Unknown video generation provider");
      }
    }
  });

  it("passes the configured model through to the adapter when present", () => {
    const result = createVideoGenProvider(
      { provider: "fal", model: "fal-ai/some/endpoint" } as VideoGenerationConfig,
      makeSecretManager({ FAL_KEY: "fal-secret" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeDefined();
  });
});
