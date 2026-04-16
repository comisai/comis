import type { ImageAnalysisPort, ImageAnalysisOptions } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";

/**
 * Supported multimodal LLM providers.
 */
export type MultimodalProvider = "anthropic" | "openai";

/**
 * Configuration for the multimodal image analyzer.
 */
export interface MultimodalAnalyzerConfig {
  /** API key for the provider. */
  readonly apiKey: string;
  /** Provider to use (default: "anthropic"). */
  readonly provider?: MultimodalProvider;
  /** Model to use. Defaults vary by provider. */
  readonly model?: string;
  /** Maximum file size in megabytes (default: 20). */
  readonly maxFileSizeMb?: number;
  /** API base URL override. */
  readonly baseUrl?: string;
}

const DEFAULT_PROVIDER: MultimodalProvider = "anthropic";
const DEFAULT_MAX_FILE_SIZE_MB = 20;

const DEFAULT_MODELS: Record<MultimodalProvider, string> = {
  anthropic: "claude-sonnet-4-5-20250929",
  openai: "gpt-4o",
};

const DEFAULT_BASE_URLS: Record<MultimodalProvider, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
};

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

/**
 * Create a multimodal image analysis adapter.
 *
 * Supports Anthropic (default) and OpenAI providers.
 * Uses direct fetch() calls, validates file size before processing.
 */
export function createMultimodalAnalyzer(config: MultimodalAnalyzerConfig): ImageAnalysisPort {
  const provider = config.provider ?? DEFAULT_PROVIDER;
  const model = config.model ?? DEFAULT_MODELS[provider];
  const maxFileSizeMb = config.maxFileSizeMb ?? DEFAULT_MAX_FILE_SIZE_MB;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URLS[provider];

  return {
    async analyze(
      image: Buffer,
      prompt: string,
      options: ImageAnalysisOptions,
    ): Promise<Result<string, Error>> {
      // Validate file size before processing
      const fileSizeMb = image.byteLength / (1024 * 1024);
      if (fileSizeMb > maxFileSizeMb) {
        return err(
          new Error(
            `Image file size ${fileSizeMb.toFixed(1)}MB exceeds limit of ${maxFileSizeMb}MB`,
          ),
        );
      }

      if (image.byteLength === 0) {
        return err(new Error("Image buffer is empty"));
      }

      if (!prompt.trim()) {
        return err(new Error("Analysis prompt is empty"));
      }

      const maxTokens = options.maxTokens ?? 1024;

      try {
        const providerConfig = { apiKey: config.apiKey, model, baseUrl, maxTokens };

        if (provider === "anthropic") {
          return await analyzeWithAnthropic(image, prompt, options, providerConfig);
        }
        return await analyzeWithOpenAI(image, prompt, options, providerConfig);
      } catch (error: unknown) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
