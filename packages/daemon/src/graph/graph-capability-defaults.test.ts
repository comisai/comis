// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { resolveGraphConcurrencyDefaults } from "./graph-capability-defaults.js";

describe("resolveGraphConcurrencyDefaults", () => {
  it("small model (ollama/qwen) returns maxConcurrency=2", () => {
    const result = resolveGraphConcurrencyDefaults({ provider: "ollama", modelId: "qwen3:latest" });
    expect(result.maxConcurrency).toBe(2);
  });

  it("nano model returns maxConcurrency=2", () => {
    // Use capabilityOverride to force nano class reliably, independent of provider heuristics
    const result = resolveGraphConcurrencyDefaults(
      { provider: "ollama", modelId: "qwen3:latest" },
      "nano",
    );
    expect(result.maxConcurrency).toBe(2);
  });

  it("frontier model (anthropic/claude) returns maxConcurrency=4", () => {
    const result = resolveGraphConcurrencyDefaults({
      provider: "anthropic",
      modelId: "claude-opus-4-5-20251101",
    });
    expect(result.maxConcurrency).toBe(4);
  });

  it("mid model returns maxConcurrency=4", () => {
    // Use capabilityOverride to force mid class reliably
    const result = resolveGraphConcurrencyDefaults(
      { provider: "ollama", modelId: "qwen3:latest" },
      "mid",
    );
    expect(result.maxConcurrency).toBe(4);
  });

  it("explicit capabilityOverride=frontier on local model returns maxConcurrency=4", () => {
    // Override beats model-derived class: ollama/qwen would be small, but frontier override → 4
    const result = resolveGraphConcurrencyDefaults(
      { provider: "ollama", modelId: "qwen3:latest" },
      "frontier",
    );
    expect(result.maxConcurrency).toBe(4);
  });

  it("explicit capabilityOverride=small on anthropic model returns maxConcurrency=2", () => {
    // Override beats model-derived class: anthropic/claude would be frontier, but small override → 2
    const result = resolveGraphConcurrencyDefaults(
      { provider: "anthropic", modelId: "claude-opus-4-5-20251101" },
      "small",
    );
    expect(result.maxConcurrency).toBe(2);
  });
});
