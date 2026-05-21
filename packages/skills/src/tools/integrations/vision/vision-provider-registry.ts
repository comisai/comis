// SPDX-License-Identifier: Apache-2.0
/**
 * Vision provider registry: Auto-discovers and registers vision providers
 * based on available API keys and configuration.
 *
 * Hosts the Anthropic + OpenAI vision factories (HTTP backends inlined below)
 * and uses the native Gemini adapter for Google.
 *
 * @module
 */

import type {
  VisionProvider,
  VisionRequest,
  VisionResult,
  VisionConfig,
  SecretManager,
  ImageAnalysisOptions,
} from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { createGeminiVisionProvider } from "./gemini-vision-adapter.js";

// ---------------------------------------------------------------------------
// File-private constants
// ---------------------------------------------------------------------------

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_OPENAI_MODEL = "gpt-4o";
const DEFAULT_MAX_FILE_SIZE_MB = 20;
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Fallback image provider order when auto-selecting.
 * First available provider in this list is used.
 */
const AUTO_IMAGE_PROVIDERS: ReadonlyArray<string> = ["openai", "anthropic", "google"];

/**
 * Dependencies for creating a vision provider registry.
 */
export interface VisionRegistryDeps {
  /** Secret manager for API key lookup. */
  readonly secretManager: SecretManager;
  /** Vision configuration (providers, video limits, etc.). */
  readonly config: VisionConfig;
}

// ---------------------------------------------------------------------------
// File-private validation (size, empty-buffer, empty-prompt guards)
// ---------------------------------------------------------------------------

function validateImageInput(image: Buffer, prompt: string): Result<void, Error> {
  const fileSizeMb = image.byteLength / (1024 * 1024);
  if (fileSizeMb > DEFAULT_MAX_FILE_SIZE_MB) {
    return err(
      new Error(
        `Image file size ${fileSizeMb.toFixed(1)}MB exceeds limit of ${DEFAULT_MAX_FILE_SIZE_MB}MB`,
      ),
    );
  }
  if (image.byteLength === 0) {
    return err(new Error("Image buffer is empty"));
  }
  if (!prompt.trim()) {
    return err(new Error("Analysis prompt is empty"));
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// File-private backend HTTP callers
// ---------------------------------------------------------------------------

/**
 * Send image analysis request to Anthropic Messages API.
 */
async function analyzeWithAnthropic(
  image: Buffer,
  prompt: string,
  options: ImageAnalysisOptions,
  config: {
    apiKey: string;
    model: string;
    baseUrl: string;
    maxTokens: number;
  },
): Promise<Result<string, Error>> {
  const base64 = image.toString("base64");

  const response = await fetch(`${config.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": config.apiKey,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: options.mimeType,
                data: base64,
              },
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    return err(new Error(`Anthropic API error (${response.status}): ${body}`));
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
  };

  const textBlock = data.content.find((c) => c.type === "text");
  if (!textBlock?.text) {
    return err(new Error("Anthropic response contained no text content"));
  }

  return ok(textBlock.text);
}

/**
 * Send image analysis request to OpenAI Chat Completions API.
 */
async function analyzeWithOpenAI(
  image: Buffer,
  prompt: string,
  options: ImageAnalysisOptions,
  config: {
    apiKey: string;
    model: string;
    baseUrl: string;
    maxTokens: number;
  },
): Promise<Result<string, Error>> {
  const base64 = image.toString("base64");
  const dataUrl = `data:${options.mimeType};base64,${base64}`;

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: dataUrl },
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    return err(new Error(`OpenAI API error (${response.status}): ${body}`));
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string | null } }>;
  };

  const content = data.choices[0]?.message.content;
  if (!content) {
    return err(new Error("OpenAI response contained no content"));
  }

  return ok(content);
}

// ---------------------------------------------------------------------------
// Public factories (Anthropic + OpenAI vision providers; HTTP backends inlined above)
// ---------------------------------------------------------------------------

/**
 * Create a VisionProvider backed by Anthropic Messages API (Claude).
 *
 * @param apiKey - Anthropic API key.
 * @param model - Optional model override (default: `claude-sonnet-4-5-20250929`).
 */
export function createAnthropicVisionProvider(
  apiKey: string,
  model?: string,
): VisionProvider {
  const resolvedModel = model ?? DEFAULT_ANTHROPIC_MODEL;

  return {
    id: "anthropic",
    capabilities: ["image"],

    async describeImage(req: VisionRequest): Promise<Result<VisionResult, Error>> {
      const validation = validateImageInput(req.image, req.prompt);
      if (!validation.ok) return err(validation.error);

      const maxTokens = req.maxTokens ?? 1024;

      try {
        const result = await analyzeWithAnthropic(
          req.image,
          req.prompt,
          { mimeType: req.mimeType, maxTokens: req.maxTokens },
          {
            apiKey,
            model: resolvedModel,
            baseUrl: ANTHROPIC_BASE_URL,
            maxTokens,
          },
        );
        if (!result.ok) return err(result.error);
        return ok({ text: result.value, provider: "anthropic", model: resolvedModel });
      } catch (error: unknown) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

/**
 * Create a VisionProvider backed by OpenAI Chat Completions API (GPT-4o).
 *
 * @param apiKey - OpenAI API key.
 * @param model - Optional model override (default: `gpt-4o`).
 */
export function createOpenAIVisionProvider(
  apiKey: string,
  model?: string,
): VisionProvider {
  const resolvedModel = model ?? DEFAULT_OPENAI_MODEL;

  return {
    id: "openai",
    capabilities: ["image"],

    async describeImage(req: VisionRequest): Promise<Result<VisionResult, Error>> {
      const validation = validateImageInput(req.image, req.prompt);
      if (!validation.ok) return err(validation.error);

      const maxTokens = req.maxTokens ?? 1024;

      try {
        const result = await analyzeWithOpenAI(
          req.image,
          req.prompt,
          { mimeType: req.mimeType, maxTokens: req.maxTokens },
          {
            apiKey,
            model: resolvedModel,
            baseUrl: OPENAI_BASE_URL,
            maxTokens,
          },
        );
        if (!result.ok) return err(result.error);
        return ok({ text: result.value, provider: "openai", model: resolvedModel });
      } catch (error: unknown) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

/**
 * Create a vision provider registry populated with providers that have
 * available API keys.
 *
 * Auto-registers:
 * - Anthropic (if ANTHROPIC_API_KEY available and "anthropic" in config.providers)
 * - OpenAI (if OPENAI_API_KEY available and "openai" in config.providers)
 * - Google/Gemini (if GOOGLE_API_KEY available and "google" in config.providers)
 *
 * @param deps - Secret manager and vision configuration
 * @returns Map of provider ID to VisionProvider instance
 */
export function createVisionProviderRegistry(
  deps: VisionRegistryDeps,
): Map<string, VisionProvider> {
  const { secretManager, config } = deps;
  const registry = new Map<string, VisionProvider>();
  const providerSet = new Set(config.providers);

  // Anthropic
  if (providerSet.has("anthropic")) {
    const key = secretManager.get("ANTHROPIC_API_KEY");
    if (key) {
      registry.set("anthropic", createAnthropicVisionProvider(key));
    }
  }

  // OpenAI
  if (providerSet.has("openai")) {
    const key = secretManager.get("OPENAI_API_KEY");
    if (key) {
      registry.set("openai", createOpenAIVisionProvider(key));
    }
  }

  // Google / Gemini
  if (providerSet.has("google")) {
    const key = secretManager.get("GOOGLE_API_KEY");
    if (key) {
      registry.set(
        "google",
        createGeminiVisionProvider({
          apiKey: key,
          videoMaxRawBytes: config.videoMaxRawBytes,
          videoMaxBase64Bytes: config.videoMaxBase64Bytes,
          timeoutMs: config.videoTimeoutMs,
        }),
      );
    }
  }

  return registry;
}

/**
 * Select the best vision provider for a given media type.
 *
 * Selection logic:
 * 1. If preferredProvider is set and available with the required capability, use it.
 * 2. For "video": only providers with "video" capability (currently Google).
 * 3. For "image": fallback order ["openai", "anthropic", "google"].
 *
 * Returns undefined if no suitable provider is found (graceful degradation).
 *
 * @param registry - Map of registered vision providers
 * @param mediaType - Type of media to analyze ("image" or "video")
 * @param preferredProvider - Optional preferred provider ID
 * @returns The selected VisionProvider, or undefined
 */
export function selectVisionProvider(
  registry: Map<string, VisionProvider>,
  mediaType: "image" | "video",
  preferredProvider?: string,
): VisionProvider | undefined {
  // Try preferred provider first
  if (preferredProvider) {
    const preferred = registry.get(preferredProvider);
    if (preferred && preferred.capabilities.includes(mediaType)) {
      return preferred;
    }
  }

  // For video: find any provider with video capability
  if (mediaType === "video") {
    for (const provider of registry.values()) {
      if (provider.capabilities.includes("video")) {
        return provider;
      }
    }
    return undefined;
  }

  // For image: use defined fallback order
  for (const id of AUTO_IMAGE_PROVIDERS) {
    const provider = registry.get(id);
    if (provider && provider.capabilities.includes("image")) {
      return provider;
    }
  }

  return undefined;
}
