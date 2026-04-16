import type { ImageGenerationPort, ImageGenerationConfig, SecretManager } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { createFalAdapter } from "./fal-adapter.js";
import { createOpenAIImageAdapter } from "./openai-adapter.js";

/**
 * Create an image generation provider based on configuration.
 *
 * Returns `ok(undefined)` when the required API key is missing from SecretManager,
 * allowing graceful degradation (image generation disabled rather than erroring).
 *
 * @param config - Image generation configuration with provider selection
 * @param secretManager - Credential access for API keys
 * @returns The configured adapter, undefined if key missing, or error for unknown providers
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

    case "openai": {
      const apiKey = secretManager.get("OPENAI_API_KEY");
      if (!apiKey) return ok(undefined);
      return ok(createOpenAIImageAdapter({ apiKey, model: config.model }));
    }

    default:
      return err(new Error(`Unknown image generation provider: ${config.provider as string}`));
  }
}
