// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

/**
 * Input for image generation providers.
 */
export interface ImageGenInput {
  /** Text prompt describing the desired image */
  prompt: string;
  /** Image dimensions (e.g., "1024x1024", "square_hd") */
  size?: string;
  /** Whether to run safety checker on output (default: true) */
  safetyChecker?: boolean;
  /** IN-01: optional reference image (edit/img2img) — base64 + mime, resolved by the handler. */
  referenceImage?: { data: string; mimeType: string };
  /** IN-02/CFG-02: optional model override (validated by the handler against the provider's list). */
  model?: string;
}

/**
 * Output from image generation providers.
 *
 * `costUsd`/`model`/`provider` are OPTIONAL and ADDITIVE (OBS-01/03, Phase 186):
 * the pi-ai adapter (`toImageGenOutput`) maps them from `AssistantImages`
 * (`usage.cost.total`/`model`/`provider`), but the legacy fal/openai skills
 * adapters that also implement `ImageGenerationPort` simply leave them unset —
 * a text-only/legacy return `{ buffer, mimeType }` is still valid.
 */
export interface ImageGenOutput {
  /** Raw image bytes */
  buffer: Buffer;
  /** MIME type of the image (e.g., "image/png") */
  mimeType: string;
  /** OBS-03 — generation cost in USD (pi-ai `Usage.cost.total`); unset when the
   *  provider reports no usage or a legacy adapter does not map it. */
  costUsd?: number;
  /** OBS-01/03 — the model id that produced the image (e.g. "gpt-image-1"). */
  model?: string;
  /** OBS-01/03 — the executing provider id (e.g. "openai", "google"). */
  provider?: string;
}

/**
 * Image generation port — concrete hexagonal boundary for image-generation
 * adapters (OpenAI gpt-image-1, fal.ai, etc.).
 *
 * Inlined the previous `Provider<TInput, TOutput>` generic into this
 * concrete interface: the generic had a single consumer
 * (`ImageGenerationPort`), and the optional `estimateCost` field had zero
 * production callers.
 */
export interface ImageGenerationPort {
  /** Unique provider identifier (e.g., "fal", "openai") */
  readonly id: string;
  /** Whether the provider is currently available (API key present, etc.) */
  isAvailable(): boolean;
  /** Execute the provider with the given input */
  execute(input: ImageGenInput): Promise<Result<ImageGenOutput, Error>>;
}
