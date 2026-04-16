import { describe, it, expect } from "vitest";
import {
  isVisionCapable,
  resolveModelForMessage,
  createImageFallbackChain,
  type ImageRouterParams,
  type ImageFallbackChainConfig,
} from "./image-router.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function model(provider: string, modelId: string, input: string[]) {
  return { provider, modelId, input };
}

const textOnly = model("anthropic", "claude-sonnet-4-5-20250929", ["text"]);
const visionModel = model("openai", "gpt-4o", ["text", "image"]);
const anotherTextOnly = model("google", "gemini-flash", ["text"]);
const anotherVision = model("anthropic", "claude-sonnet-4-5-20250929-v", ["text", "image"]);

// ---------------------------------------------------------------------------
// isVisionCapable
// ---------------------------------------------------------------------------

describe("isVisionCapable", () => {
  it("returns true for model with image in input", () => {
    expect(isVisionCapable({ input: ["text", "image"] })).toBe(true);
  });

  it("returns false for model with text only", () => {
    expect(isVisionCapable({ input: ["text"] })).toBe(false);
  });

  it("returns false for empty input array", () => {
    expect(isVisionCapable({ input: [] })).toBe(false);
  });

  it("returns true when image is the only input", () => {
    expect(isVisionCapable({ input: ["image"] })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveModelForMessage
// ---------------------------------------------------------------------------

describe("resolveModelForMessage", () => {
  it("returns primary with routed=false when no image attachments", () => {
    const params: ImageRouterParams = {
      hasImageAttachments: false,
      primary: textOnly,
      fallbacks: [visionModel],
    };

    const result = resolveModelForMessage(params);

    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-sonnet-4-5-20250929");
    expect(result.routed).toBe(false);
    expect(result.reason).toBe("no images");
  });

  it("returns primary with routed=false when primary supports images", () => {
    const params: ImageRouterParams = {
      hasImageAttachments: true,
      primary: visionModel,
      fallbacks: [],
    };

    const result = resolveModelForMessage(params);

    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-4o");
    expect(result.routed).toBe(false);
    expect(result.reason).toBe("primary supports vision");
  });

  it("routes to fallback when primary lacks vision and fallback has vision", () => {
    const params: ImageRouterParams = {
      hasImageAttachments: true,
      primary: textOnly,
      fallbacks: [visionModel],
    };

    const result = resolveModelForMessage(params);

    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-4o");
    expect(result.routed).toBe(true);
    expect(result.reason).toBe("routed to vision model");
  });

  it("returns primary (graceful degradation) when no fallback has vision", () => {
    const params: ImageRouterParams = {
      hasImageAttachments: true,
      primary: textOnly,
      fallbacks: [anotherTextOnly],
    };

    const result = resolveModelForMessage(params);

    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-sonnet-4-5-20250929");
    expect(result.routed).toBe(false);
    expect(result.reason).toBe("no vision-capable fallback available");
  });

  it("selects the first vision-capable fallback when multiple exist", () => {
    const params: ImageRouterParams = {
      hasImageAttachments: true,
      primary: textOnly,
      fallbacks: [anotherTextOnly, visionModel, anotherVision],
    };

    const result = resolveModelForMessage(params);

    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-4o");
    expect(result.routed).toBe(true);
    expect(result.reason).toBe("routed to vision model");
  });

  it("returns primary when images present but fallbacks list is empty", () => {
    const params: ImageRouterParams = {
      hasImageAttachments: true,
      primary: textOnly,
      fallbacks: [],
    };

    const result = resolveModelForMessage(params);

    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-sonnet-4-5-20250929");
    expect(result.routed).toBe(false);
    expect(result.reason).toBe("no vision-capable fallback available");
  });

  it("does not route when hasImageAttachments is false even with vision fallbacks", () => {
    const params: ImageRouterParams = {
      hasImageAttachments: false,
      primary: textOnly,
      fallbacks: [visionModel],
    };

    const result = resolveModelForMessage(params);

    expect(result.routed).toBe(false);
    expect(result.reason).toBe("no images");
  });
});

// ---------------------------------------------------------------------------
// createImageFallbackChain
// ---------------------------------------------------------------------------

describe("createImageFallbackChain", () => {
  const visionPrimary = model("openai", "gpt-4o", ["text", "image"]);
  const textPrimary = model("anthropic", "claude-sonnet-4-5-20250929", ["text"]);
  const imageFallbackVision = model("google", "gemini-pro-vision", ["text", "image"]);
  const imageFallbackText = model("mistral", "mistral-large", ["text"]);
  const textFallbackVision = model("openai", "gpt-4-turbo", ["text", "image"]);
  const textFallbackText = model("anthropic", "claude-3-haiku", ["text"]);

  describe("resolve", () => {
    it("returns primary when primary is vision-capable", () => {
      const config: ImageFallbackChainConfig = {
        primary: visionPrimary,
        imageFallbacks: [imageFallbackVision],
        textFallbacks: [textFallbackVision],
      };

      const chain = createImageFallbackChain(config);
      const result = chain.resolve();

      expect(result.provider).toBe("openai");
      expect(result.modelId).toBe("gpt-4o");
      expect(result.routed).toBe(false);
      expect(result.reason).toBe("primary supports vision");
    });

    it("routes to first imageFallback when primary is not vision-capable", () => {
      const config: ImageFallbackChainConfig = {
        primary: textPrimary,
        imageFallbacks: [imageFallbackVision],
        textFallbacks: [textFallbackVision],
      };

      const chain = createImageFallbackChain(config);
      const result = chain.resolve();

      expect(result.provider).toBe("google");
      expect(result.modelId).toBe("gemini-pro-vision");
      expect(result.routed).toBe(true);
      expect(result.reason).toBe("routed to image fallback");
    });

    it("skips non-vision imageFallbacks and picks first vision one", () => {
      const config: ImageFallbackChainConfig = {
        primary: textPrimary,
        imageFallbacks: [imageFallbackText, imageFallbackVision],
        textFallbacks: [textFallbackVision],
      };

      const chain = createImageFallbackChain(config);
      const result = chain.resolve();

      expect(result.provider).toBe("google");
      expect(result.modelId).toBe("gemini-pro-vision");
      expect(result.routed).toBe(true);
      expect(result.reason).toBe("routed to image fallback");
    });

    it("falls through to textFallbacks if no imageFallback is vision-capable", () => {
      const config: ImageFallbackChainConfig = {
        primary: textPrimary,
        imageFallbacks: [imageFallbackText],
        textFallbacks: [textFallbackVision],
      };

      const chain = createImageFallbackChain(config);
      const result = chain.resolve();

      expect(result.provider).toBe("openai");
      expect(result.modelId).toBe("gpt-4-turbo");
      expect(result.routed).toBe(true);
      expect(result.reason).toBe("routed to text fallback with vision");
    });

    it("returns primary as last resort when no vision model exists anywhere", () => {
      const config: ImageFallbackChainConfig = {
        primary: textPrimary,
        imageFallbacks: [imageFallbackText],
        textFallbacks: [textFallbackText],
      };

      const chain = createImageFallbackChain(config);
      const result = chain.resolve();

      expect(result.provider).toBe("anthropic");
      expect(result.modelId).toBe("claude-sonnet-4-5-20250929");
      expect(result.routed).toBe(false);
      expect(result.reason).toBe("no vision-capable fallback available");
    });

    it("image fallbacks are checked before text fallbacks (order matters)", () => {
      const config: ImageFallbackChainConfig = {
        primary: textPrimary,
        imageFallbacks: [imageFallbackVision],
        textFallbacks: [textFallbackVision],
      };

      const chain = createImageFallbackChain(config);
      const result = chain.resolve();

      // Should pick imageFallbackVision, not textFallbackVision
      expect(result.provider).toBe("google");
      expect(result.modelId).toBe("gemini-pro-vision");
    });
  });

  describe("getVisionModels", () => {
    it("returns all vision-capable models across all chains", () => {
      const config: ImageFallbackChainConfig = {
        primary: visionPrimary,
        imageFallbacks: [imageFallbackText, imageFallbackVision],
        textFallbacks: [textFallbackText, textFallbackVision],
      };

      const chain = createImageFallbackChain(config);
      const visionModels = chain.getVisionModels();

      expect(visionModels).toHaveLength(3);
      expect(visionModels).toContainEqual({ provider: "openai", modelId: "gpt-4o" });
      expect(visionModels).toContainEqual({ provider: "google", modelId: "gemini-pro-vision" });
      expect(visionModels).toContainEqual({ provider: "openai", modelId: "gpt-4-turbo" });
    });

    it("returns empty array when no models support vision", () => {
      const config: ImageFallbackChainConfig = {
        primary: textPrimary,
        imageFallbacks: [imageFallbackText],
        textFallbacks: [textFallbackText],
      };

      const chain = createImageFallbackChain(config);
      const visionModels = chain.getVisionModels();

      expect(visionModels).toEqual([]);
    });
  });
});
