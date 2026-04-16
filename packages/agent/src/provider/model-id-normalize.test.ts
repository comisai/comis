import { describe, it, expect } from "vitest";
import { normalizeModelId } from "./model-id-normalize.js";

describe("normalizeModelId - Anthropic shortcuts", () => {
  it('"sonnet" resolves to a claude-sonnet-4-* model', () => {
    const result = normalizeModelId("anthropic", "sonnet");
    expect(result.normalized).toBe(true);
    expect(result.modelId).toMatch(/^claude-sonnet-4/);
  });

  it('"opus" resolves to a claude-opus-4-* model', () => {
    const result = normalizeModelId("anthropic", "opus");
    expect(result.normalized).toBe(true);
    expect(result.modelId).toMatch(/^claude-opus-4/);
  });

  it('"haiku" resolves to a claude-haiku-4-* model', () => {
    const result = normalizeModelId("anthropic", "haiku");
    expect(result.normalized).toBe(true);
    expect(result.modelId).toMatch(/^claude-haiku-4/);
  });

  it("is case insensitive", () => {
    const result = normalizeModelId("anthropic", "SONNET");
    expect(result.normalized).toBe(true);
    expect(result.modelId).toMatch(/^claude-sonnet-4/);
  });

  it("is whitespace tolerant", () => {
    const result = normalizeModelId("anthropic", " sonnet ");
    expect(result.normalized).toBe(true);
    expect(result.modelId).toMatch(/^claude-sonnet-4/);
  });
});

describe("normalizeModelId - OpenAI shortcuts", () => {
  it('"gpt4" resolves to gpt-4o (not gpt-4o-mini)', () => {
    const result = normalizeModelId("openai", "gpt4");
    expect(result.normalized).toBe(true);
    expect(result.modelId).toBe("gpt-4o");
  });

  it('"gpt4-mini" resolves to a gpt-4o-mini model', () => {
    const result = normalizeModelId("openai", "gpt4-mini");
    expect(result.normalized).toBe(true);
    expect(result.modelId).toBe("gpt-4o-mini");
  });

  it('"o3" resolves to "o3" (not o3-mini or o3-pro)', () => {
    const result = normalizeModelId("openai", "o3");
    expect(result.normalized).toBe(true);
    expect(result.modelId).toBe("o3");
  });

  it('"o3-mini" resolves to a model starting with o3-mini', () => {
    const result = normalizeModelId("openai", "o3-mini");
    expect(result.normalized).toBe(true);
    expect(result.modelId).toMatch(/^o3-mini/);
  });

  it('"o4-mini" resolves to a model starting with o4-mini', () => {
    const result = normalizeModelId("openai", "o4-mini");
    expect(result.normalized).toBe(true);
    expect(result.modelId).toMatch(/^o4-mini/);
  });
});

describe("normalizeModelId - Google shortcuts", () => {
  it('"gemini-pro" resolves to a gemini-3-pro* model', () => {
    const result = normalizeModelId("google", "gemini-pro");
    expect(result.normalized).toBe(true);
    expect(result.modelId).toMatch(/^gemini-3-pro/);
  });

  it('"gemini-flash" resolves to a gemini-3-flash* model', () => {
    const result = normalizeModelId("google", "gemini-flash");
    expect(result.normalized).toBe(true);
    expect(result.modelId).toMatch(/^gemini-3-flash/);
  });
});

describe("normalizeModelId - xAI shortcuts", () => {
  it('"grok" resolves to a grok-4* model', () => {
    const result = normalizeModelId("xai", "grok");
    expect(result.normalized).toBe(true);
    expect(result.modelId).toMatch(/^grok-4/);
  });
});

describe("normalizeModelId - unknown passthrough", () => {
  it("unknown alias for known provider passes through unchanged", () => {
    const result = normalizeModelId("anthropic", "nonexistent");
    expect(result.normalized).toBe(false);
    expect(result.modelId).toBe("nonexistent");
  });

  it("unknown provider passes through entirely", () => {
    const result = normalizeModelId("ollama", "llama3");
    expect(result.normalized).toBe(false);
    expect(result.modelId).toBe("llama3");
  });

  it("exact model IDs pass through unchanged", () => {
    const result = normalizeModelId("anthropic", "claude-opus-4-6");
    expect(result.normalized).toBe(false);
    expect(result.modelId).toBe("claude-opus-4-6");
  });
});
