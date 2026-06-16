// SPDX-License-Identifier: Apache-2.0
/**
 * Video-generation provider factory (mirrors the image-gen factory).
 *
 * This legacy skills factory serves ONLY explicit `fal` (CFG-01 explicit-config
 * back-compat). The `auto`/`google`/`xai` selection modes are resolved by the
 * daemon's video-provider selector upstream (Plan 04) — they are NOT served by a
 * second skills adapter — so any non-`fal` provider hits the `default` error
 * branch here.
 *
 * Returns `ok(undefined)` when FAL_KEY is missing so the daemon can degrade
 * gracefully (video generation disabled rather than a hard error).
 *
 * @module
 */
import type { VideoGenerationPort, VideoGenerationConfig, SecretManager } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { createFalVideoAdapter } from "./fal-adapter.js";

/**
 * Create a video generation provider based on configuration.
 *
 * @param config - Video generation configuration with provider selection
 * @param secretManager - Credential access for API keys (FAL_KEY)
 * @returns The configured fal adapter, undefined if key missing, or error for any non-fal provider
 */
export function createVideoGenProvider(
  config: VideoGenerationConfig,
  secretManager: SecretManager,
): Result<VideoGenerationPort | undefined, Error> {
  switch (config.provider) {
    case "fal": {
      const apiKey = secretManager.get("FAL_KEY");
      if (!apiKey) return ok(undefined);
      return ok(createFalVideoAdapter({ apiKey, model: config.model }));
    }

    default:
      return err(new Error(`Unknown video generation provider: ${config.provider as string}`));
  }
}
