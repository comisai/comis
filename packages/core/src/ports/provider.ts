import type { Result } from "@comis/shared";

/**
 * Unified provider interface for external service integrations.
 *
 * Generic over input and output types to support diverse provider
 * categories (image generation, TTS, transcription, etc.).
 *
 * @template TInput - Provider-specific request payload
 * @template TOutput - Provider-specific response payload
 */
export interface Provider<TInput, TOutput> {
  /** Unique provider identifier (e.g., "fal", "openai") */
  readonly id: string;
  /** Whether the provider is currently available (API key present, etc.) */
  isAvailable(): boolean;
  /** Execute the provider with the given input */
  execute(input: TInput): Promise<Result<TOutput, Error>>;
  /** Optional cost estimation for the given input */
  estimateCost?(input: TInput): number | undefined;
}

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
}

/**
 * Output from image generation providers.
 */
export interface ImageGenOutput {
  /** Raw image bytes */
  buffer: Buffer;
  /** MIME type of the image (e.g., "image/png") */
  mimeType: string;
}

/**
 * Image generation port -- specialized Provider for image generation.
 */
export type ImageGenerationPort = Provider<ImageGenInput, ImageGenOutput>;
