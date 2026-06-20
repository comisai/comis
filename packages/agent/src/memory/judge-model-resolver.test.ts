// SPDX-License-Identifier: Apache-2.0
//
// Learning-gap (LOCAL re-test 2026-06-20): the verified-learning judge seams
// (outcome / correction / usefulness) resolved their model via pi-ai's global
// `getModel`, which only knows the built-in catalog (anthropic/openai/google/…).
// Custom YAML providers (ollama, lm-studio, vLLM, …) are registered on the
// daemon's ModelRegistry INSTANCE — invisible to the global `getModel` — so on a
// keyless/local deployment the judge logged "model not found" and SKIPPED every
// time: the verified-learning judge half was DEAD for local models. resolveJudgeModel
// adds a config-backed construction path: catalog hit first, else build an
// openai-completions Model from the provided baseUrl spec.
import { describe, it, expect } from "vitest";
import { resolveJudgeModel } from "./judge-model-resolver.js";

describe("resolveJudgeModel", () => {
  it("returns the pi-ai catalog model for a built-in provider (anthropic) — unchanged path", () => {
    const m = resolveJudgeModel("anthropic", "claude-haiku-4-5-20251001");
    expect(m).toBeDefined();
    expect(m!.provider).toBe("anthropic");
  });

  it("returns undefined for an unknown provider when NO custom spec is supplied (the old skip)", () => {
    expect(resolveJudgeModel("ollama", "qwen3.6:35b")).toBeUndefined();
  });

  it("constructs an openai-completions Model from the custom spec when the catalog misses (ollama)", () => {
    const m = resolveJudgeModel("ollama", "qwen3.6:35b", {
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    expect(m).toBeDefined();
    expect(m!.provider).toBe("ollama");
    expect(m!.id).toBe("qwen3.6:35b");
    expect(m!.api).toBe("openai-completions");
    expect(m!.baseUrl).toBe("http://127.0.0.1:11434/v1");
    // Judge calls are tiny + bounded; defaults are sane and cost is zero (keyless).
    expect(m!.cost.input).toBe(0);
    expect(m!.contextWindow).toBeGreaterThan(0);
    expect(m!.maxTokens).toBeGreaterThan(0);
  });

  it("honors reasoning/contextWindow/maxTokens overrides in the spec", () => {
    const m = resolveJudgeModel("ollama", "qwen3.6:35b", {
      baseUrl: "http://127.0.0.1:11434/v1",
      reasoning: true,
      contextWindow: 65536,
      maxTokens: 8192,
    });
    expect(m!.reasoning).toBe(true);
    expect(m!.contextWindow).toBe(65536);
    expect(m!.maxTokens).toBe(8192);
  });

  it("prefers the catalog over the custom spec when both could apply (built-in provider)", () => {
    const m = resolveJudgeModel("anthropic", "claude-haiku-4-5-20251001", {
      baseUrl: "http://example/v1",
    });
    // A real catalog model has a non-custom baseUrl (anthropic endpoint), never the spec's.
    expect(m).toBeDefined();
    expect(m!.baseUrl).not.toBe("http://example/v1");
  });
});
