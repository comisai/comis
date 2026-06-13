// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { resolveModelFamily, isProviderModelChimera } from "./model-family.js";

describe("resolveModelFamily — coarse family classification", () => {
  for (const [id, family] of [
    ["claude-opus-4-8", "anthropic"],
    ["claude-sonnet-4-6", "anthropic"],
    ["gpt-4o", "openai"],
    ["o3-mini", "openai"],
    ["gemini-2.5-pro", "google"],
    ["gemma4:latest", "google"],
    ["qwen3.6:35b", "qwen"],
    ["llama-3.3-70b", "meta"],
    ["mistral-large", "mistral"],
    ["deepseek-r1:8b", "deepseek"],
    ["grok-2", "xai"],
    ["some-unlabelled-model", "unknown"],
  ] as const) {
    it(`classifies "${id}" as ${family}`, () => {
      expect(resolveModelFamily(id)).toBe(family);
    });
  }
});

describe("isProviderModelChimera — native provider vs foreign model family (ffe11736)", () => {
  it("FLAGS the ffe11736 shape: provider=anthropic + a qwen model ref", () => {
    expect(isProviderModelChimera("anthropic", "qwen3.6:35b")).toBe(true);
  });

  it("FLAGS provider=openai + a claude model ref", () => {
    expect(isProviderModelChimera("openai", "claude-opus-4-8")).toBe(true);
  });

  it("does NOT flag a coherent native pairing (anthropic + claude)", () => {
    expect(isProviderModelChimera("anthropic", "claude-sonnet-4-6")).toBe(false);
  });

  it("does NOT flag a GATEWAY provider serving any family (ollama + qwen)", () => {
    // Gateways legitimately serve many families — never a chimera.
    expect(isProviderModelChimera("ollama", "qwen3.6:35b")).toBe(false);
    expect(isProviderModelChimera("openrouter", "claude-opus-4-8")).toBe(false);
    expect(isProviderModelChimera("amazon-bedrock", "llama-3.3-70b")).toBe(false);
  });

  it("does NOT flag a native provider with an UNKNOWN model family (conservative — no false positive)", () => {
    expect(isProviderModelChimera("anthropic", "some-custom-finetune")).toBe(false);
  });

  it("is case-insensitive on the provider id", () => {
    expect(isProviderModelChimera("Anthropic", "qwen3.6:35b")).toBe(true);
  });
});
