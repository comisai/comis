import type { Result } from "@comis/shared";

// ─── Vision (Multi-provider) ────────────────────────────────────────

/**
 * Request payload for image vision analysis.
 */
export interface VisionRequest {
  /** Raw image data. */
  readonly image: Buffer;
  /** Question or instruction about the image. */
  readonly prompt: string;
  /** MIME type of the image (e.g. "image/png", "image/jpeg"). */
  readonly mimeType: string;
  /** Maximum tokens in the response. */
  readonly maxTokens?: number;
}

/**
 * Request payload for video vision analysis.
 */
export interface VideoRequest {
  /** Raw video data. */
  readonly video: Buffer;
  /** Question or instruction about the video. */
  readonly prompt: string;
  /** MIME type of the video (e.g. "video/mp4", "video/webm"). */
  readonly mimeType: string;
  /** Maximum tokens in the response. */
  readonly maxTokens?: number;
}

/**
 * Result of a vision analysis (image or video).
 */
export interface VisionResult {
  /** Analysis text. */
  readonly text: string;
  /** Provider that produced the result (e.g. "openai", "anthropic", "google"). */
  readonly provider: string;
  /** Model used for analysis. */
  readonly model: string;
  /** Tokens used (if available from the provider). */
  readonly tokensUsed?: number;
}

/**
 * VisionProvider: Multi-capability vision analysis provider.
 *
 * Each provider declares which media types it supports (image, video, or both).
 * The registry uses capabilities to route requests to the right provider.
 */
export interface VisionProvider {
  /** Unique provider identifier (e.g. "openai", "anthropic", "google"). */
  readonly id: string;
  /** Media types this provider can analyze. */
  readonly capabilities: ReadonlyArray<"image" | "video">;
  /** Analyze an image. */
  describeImage(req: VisionRequest): Promise<Result<VisionResult, Error>>;
  /** Analyze a video (optional — only providers with "video" capability). */
  describeVideo?(req: VideoRequest): Promise<Result<VisionResult, Error>>;
}
