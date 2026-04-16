import type { Result } from "@comis/shared";

// ─── Image Analysis ──────────────────────────────────────────────────

/**
 * Options for image analysis.
 */
export interface ImageAnalysisOptions {
  /** MIME type of the image buffer (e.g. "image/png", "image/jpeg"). */
  readonly mimeType: string;
  /** Maximum tokens in the analysis response. */
  readonly maxTokens?: number;
}

/**
 * ImageAnalysisPort: Hexagonal boundary for multimodal image analysis.
 *
 * Adapters (Anthropic Claude, OpenAI GPT-4o, etc.) implement this
 * interface to analyze images using vision-capable LLMs.
 */
export interface ImageAnalysisPort {
  /**
   * Analyze an image given a prompt.
   *
   * @param image - Raw image data
   * @param prompt - Question or instruction about the image
   * @param options - MIME type and response length configuration
   * @returns Analysis text or an error (e.g. file too large, unsupported format)
   */
  analyze(
    image: Buffer,
    prompt: string,
    options: ImageAnalysisOptions,
  ): Promise<Result<string, Error>>;
}
