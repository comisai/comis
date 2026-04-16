/**
 * Image-aware model routing: selects a vision-capable model when the
 * incoming message contains image attachments.
 *
 * Provides two levels of routing:
 * - `resolveModelForMessage()`: Simple primary/fallback routing for messages
 * - `createImageFallbackChain()`: Dedicated image fallback chain
 *   with separate image-specific and text fallback lists
 *
 * Uses a minimal `{ input: string[] }` interface so the functions
 * remain pure and easily testable without importing the full pi-ai
 * Model type.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Parameters for resolving which model to use for a message. */
export interface ImageRouterParams {
  /** Whether the incoming message has image attachments */
  hasImageAttachments: boolean;
  /** Primary model with input capabilities */
  primary: { provider: string; modelId: string; input: string[] };
  /** Fallback models with input capabilities */
  fallbacks: Array<{ provider: string; modelId: string; input: string[] }>;
}

/** Result of image-aware model resolution. */
export interface ImageRouterResult {
  /** The selected model's provider */
  provider: string;
  /** The selected model's ID */
  modelId: string;
  /** Whether the model was changed from the primary */
  routed: boolean;
  /** Human-readable reason for the routing decision */
  reason: string;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Check whether a model supports image/vision input.
 *
 * Accepts a minimal interface `{ input: string[] }` so callers don't
 * need to provide the full pi-ai Model type.
 */
export function isVisionCapable(model: { input: string[] }): boolean {
  return model.input.includes("image");
}

/**
 * Resolve which model to use for a given message, taking image
 * attachments into account.
 *
 * Logic:
 * 1. No image attachments -> return primary (no routing needed).
 * 2. Primary supports images -> return primary.
 * 3. Search fallbacks for the first vision-capable model.
 * 4. No vision-capable fallback -> return primary (graceful degradation).
 */
export function resolveModelForMessage(params: ImageRouterParams): ImageRouterResult {
  const { hasImageAttachments, primary, fallbacks } = params;

  if (!hasImageAttachments) {
    return {
      provider: primary.provider,
      modelId: primary.modelId,
      routed: false,
      reason: "no images",
    };
  }

  if (isVisionCapable(primary)) {
    return {
      provider: primary.provider,
      modelId: primary.modelId,
      routed: false,
      reason: "primary supports vision",
    };
  }

  const visionFallback = fallbacks.find(isVisionCapable);

  if (visionFallback) {
    return {
      provider: visionFallback.provider,
      modelId: visionFallback.modelId,
      routed: true,
      reason: "routed to vision model",
    };
  }

  return {
    provider: primary.provider,
    modelId: primary.modelId,
    routed: false,
    reason: "no vision-capable fallback available",
  };
}

// ---------------------------------------------------------------------------
// Image Fallback Chain
// ---------------------------------------------------------------------------

/** Configuration for an image-specific fallback chain. */
export interface ImageFallbackChainConfig {
  /** Primary model to use for image tasks (must be vision-capable) */
  primary: { provider: string; modelId: string; input: string[] };
  /** Dedicated fallback models for image tasks -- separate from text fallback chain */
  imageFallbacks: Array<{ provider: string; modelId: string; input: string[] }>;
  /** Text fallback chain (used only when NO vision model is available in imageFallbacks) */
  textFallbacks: Array<{ provider: string; modelId: string; input: string[] }>;
}

/** Image fallback chain for routing image-bearing messages. */
export interface ImageFallbackChain {
  /**
   * Resolve which model to use for an image-bearing message.
   * Priority:
   * 1. Primary (if vision-capable)
   * 2. First vision-capable model in imageFallbacks
   * 3. First vision-capable model in textFallbacks (last resort)
   * 4. Primary (graceful degradation -- will likely fail, but avoids silent drop)
   */
  resolve(): ImageRouterResult;
  /** Get all vision-capable models across both chains */
  getVisionModels(): Array<{ provider: string; modelId: string }>;
}

/**
 * Create a dedicated image fallback chain with separate image and text
 * fallback lists.
 *
 * This enables more sophisticated image routing,
 * complementing the simpler `resolveModelForMessage()`.
 */
export function createImageFallbackChain(config: ImageFallbackChainConfig): ImageFallbackChain {
  const { primary, imageFallbacks, textFallbacks } = config;

  return {
    resolve(): ImageRouterResult {
      // 1. Primary supports vision
      if (isVisionCapable(primary)) {
        return {
          provider: primary.provider,
          modelId: primary.modelId,
          routed: false,
          reason: "primary supports vision",
        };
      }

      // 2. First vision-capable model in imageFallbacks
      const imageVision = imageFallbacks.find(isVisionCapable);
      if (imageVision) {
        return {
          provider: imageVision.provider,
          modelId: imageVision.modelId,
          routed: true,
          reason: "routed to image fallback",
        };
      }

      // 3. First vision-capable model in textFallbacks
      const textVision = textFallbacks.find(isVisionCapable);
      if (textVision) {
        return {
          provider: textVision.provider,
          modelId: textVision.modelId,
          routed: true,
          reason: "routed to text fallback with vision",
        };
      }

      // 4. Primary (graceful degradation)
      return {
        provider: primary.provider,
        modelId: primary.modelId,
        routed: false,
        reason: "no vision-capable fallback available",
      };
    },

    getVisionModels(): Array<{ provider: string; modelId: string }> {
      const all = [primary, ...imageFallbacks, ...textFallbacks];
      return all
        .filter(isVisionCapable)
        .map((m) => ({ provider: m.provider, modelId: m.modelId }));
    },
  };
}
