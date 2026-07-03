// SPDX-License-Identifier: Apache-2.0
import type { ImageGenerationPort, ImageGenerationConfig, SecretManager } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { createFalAdapter } from "./fal-adapter.js";

/**
 * Create an image generation provider based on configuration.
 *
 * Returns `ok(undefined)` when the required API key is missing from SecretManager,
 * allowing graceful degradation (image generation disabled rather than erroring).
 *
 * This skills factory serves ONLY the `fal` provider. An explicit `openai` config
 * routes through the daemon's `openai-images` registered pi-ai transport
 * (setup-image-provider.ts), NOT a second skills adapter. Any non-`fal` provider
 * therefore hits the `default` error branch here (the daemon selector resolves it
 * upstream).
 *
 * @param config - Image generation configuration with provider selection
 * @param secretManager - Credential access for API keys
 * @returns The configured fal adapter, undefined if key missing, or error for any non-fal provider
 */
export function createImageGenProvider(
  config: ImageGenerationConfig,
  secretManager: SecretManager,
): Result<ImageGenerationPort | undefined, Error> {
  switch (config.provider) {
    case "fal": {
      const apiKey = secretManager.get("FAL_KEY");
      if (!apiKey) return ok(undefined);
      return ok(createFalAdapter({ apiKey, model: config.model }));
    }

    default:
      return err(new Error(`Unknown image generation provider: ${config.provider as string}`));
  }
}
