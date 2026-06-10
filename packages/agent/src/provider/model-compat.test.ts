// SPDX-License-Identifier: Apache-2.0
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

describe("normalizeModelCompat - gbnf auto-detection", () => {
  it("auto-selects gbnf profile for providerType ollama with no user comisCompat", () => {
    const result = normalizeModelCompat({
      provider: "my-local",
      id: "qwen3.6:35b",
      providerType: "ollama",
    });
    expect(result).toEqual({ toolSchemaProfile: "gbnf" });
  });

  it("preserves user comisCompat fields via spread when auto-selecting gbnf", () => {
    const result = normalizeModelCompat({
      provider: "my-local",
      id: "m",
      providerType: "ollama",
      comisCompat: { supportsTools: true },
    });
    expect(result).toEqual({ supportsTools: true, toolSchemaProfile: "gbnf" });
  });

  it("explicit user toolSchemaProfile wins over the ollama gbnf auto-detect (operator escape hatch)", () => {
    // The deliberate INVERSE of the xai force-override: gbnf is a compat
    // DEFAULT, so an explicit user value (e.g. "default") is returned untouched.
    const result = normalizeModelCompat({
      provider: "my-local",
      id: "m",
      providerType: "ollama",
      comisCompat: { toolSchemaProfile: "default" },
    });
    expect(result).toEqual({ toolSchemaProfile: "default" });
  });

  it("returns an explicit gbnf opt-in as-is on a non-ollama provider (LM Studio/llama.cpp/vLLM path)", () => {
    // Explicit opt-in needs no providerType -- GBNF-01's zero-new-config-keys path.
    const result = normalizeModelCompat({
      provider: "my-lmstudio",
      id: "m",
      comisCompat: { toolSchemaProfile: "gbnf" },
    });
    expect(result).toEqual({ toolSchemaProfile: "gbnf" });
  });
});

describe("normalizeModelCompat - custom-keyed xAI (generalized gate)", () => {
  it("applies the full xai profile when providerType is xai under a custom provider key", () => {
    // RED pre-patch: detection was name-only (provider === "xai"), so a
    // custom-keyed xAI provider ("my-xai", type "xai") got NO profile.
    const result = normalizeModelCompat({
      provider: "my-xai",
      id: "grok-3",
      providerType: "xai",
    });
    expect(result).toEqual({
      toolSchemaProfile: "xai",
      nativeWebSearchTool: true,
      toolCallArgumentsEncoding: "html-entities",
    });
  });

  it("regression: name-only xai provider without providerType keeps the full xai profile", () => {
    const result = normalizeModelCompat({ provider: "xai", id: "grok-3" });
    expect(result).toEqual({
      toolSchemaProfile: "xai",
      nativeWebSearchTool: true,
      toolCallArgumentsEncoding: "html-entities",
    });
  });

  it("regression: xai force-override still beats an explicit user toolSchemaProfile", () => {
    // Existing doctrine pinned: xAI's API requirements are non-negotiable.
    const result = normalizeModelCompat({
      provider: "xai",
      id: "grok-3",
      comisCompat: { toolSchemaProfile: "default" },
    });
    expect(result?.toolSchemaProfile).toBe("xai");
  });
});

describe("normalizeModelCompat - D-08 baseUrl never consulted", () => {
  it("ignores an ollama-looking baseUrl when no providerType is declared", () => {
    // Detection keys ONLY on declared config type / explicit profile -- a
    // provider must not self-elect into a profile via its endpoint (D-08).
    const result = normalizeModelCompat({
      provider: "p",
      id: "m",
      baseUrl: "http://localhost:11434",
    });
    expect(result).toBeUndefined();
  });
});
