import { describe, it, expect } from "vitest";
import { normalizeModelCompat } from "./model-compat.js";

describe("normalizeModelCompat - xAI auto-detection", () => {
  it("sets xAI compat flags for xai provider", () => {
    const result = normalizeModelCompat({ provider: "xai", id: "grok-3" });
    expect(result).toEqual({
      toolSchemaProfile: "xai",
      nativeWebSearchTool: true,
      toolCallArgumentsEncoding: "html-entities",
    });
  });

  it("overrides user comisCompat for xai provider", () => {
    const result = normalizeModelCompat({
      provider: "xai",
      id: "grok-2",
      comisCompat: {
        toolSchemaProfile: "default",
        nativeWebSearchTool: false,
      },
    });
    expect(result).toEqual({
      toolSchemaProfile: "xai",
      nativeWebSearchTool: true,
      toolCallArgumentsEncoding: "html-entities",
    });
  });

  it("preserves user supportsTools field for xai", () => {
    const result = normalizeModelCompat({
      provider: "xai",
      id: "grok-3",
      comisCompat: { supportsTools: false },
    });
    expect(result).toEqual({
      supportsTools: false,
      toolSchemaProfile: "xai",
      nativeWebSearchTool: true,
      toolCallArgumentsEncoding: "html-entities",
    });
  });
});

describe("normalizeModelCompat - non-xAI passthrough", () => {
  it("returns comisCompat unchanged for anthropic provider", () => {
    const compat = { supportsTools: true } as const;
    const result = normalizeModelCompat({
      provider: "anthropic",
      id: "claude-sonnet-4",
      comisCompat: compat,
    });
    expect(result).toEqual({ supportsTools: true });
  });

  it("returns undefined for non-xAI provider without comisCompat", () => {
    const result = normalizeModelCompat({ provider: "openai", id: "gpt-4o" });
    expect(result).toBeUndefined();
  });

  it("returns undefined for unknown provider without comisCompat", () => {
    const result = normalizeModelCompat({ provider: "some-custom", id: "model-x" });
    expect(result).toBeUndefined();
  });
});
