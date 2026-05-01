// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for resolveOperationModel(): 5-level priority chain resolution.
 *
 * Groups tests by priority level and auxiliary resolution logic.
 */

import { describe, it, expect } from "vitest";
import { getModels } from "@mariozechner/pi-ai";
import type { ModelOperationType, OperationModelEntry, OperationModels } from "@comis/core";
import { resolveOperationModel, resolveProviderFamily } from "./operation-model-resolver.js";
import type { OperationModelResolution } from "./operation-model-resolver.js";
import { resolveOperationDefaults } from "./operation-model-defaults.js";

function totalCost(m: { cost?: { input?: number; output?: number } }): number {
  return (m.cost?.input ?? 0) + (m.cost?.output ?? 0);
}

/** Utility: build base params with overrides for concise test setup. */
function baseParams(overrides?: Partial<Parameters<typeof resolveOperationModel>[0]>) {
  return {
    operationType: "heartbeat" as ModelOperationType,
    agentProvider: "anthropic",
    agentModel: "claude-sonnet-4-5-20250929",
    operationModels: {} as OperationModels,
    providerFamily: "anthropic",
    agentPromptTimeoutMs: 180_000,
    ...overrides,
  };
}

describe("Level 1: invocationOverride", () => {
  it("returns the invocation override model with source cron_job_override", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "cron",
        invocationOverride: "anthropic:claude-haiku-4-5",
      }),
    );
    expect(result.model).toBe("anthropic:claude-haiku-4-5");
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-haiku-4-5");
    expect(result.source).toBe("cron_job_override");
  });

  it("returns agent primary when invocationOverride is 'primary'", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "cron",
        invocationOverride: "primary",
      }),
    );
    expect(result.model).toBe("anthropic:claude-sonnet-4-5-20250929");
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-sonnet-4-5-20250929");
    expect(result.source).toBe("cron_job_override");
  });

  it("extracts provider and modelId correctly from provider:modelId format", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "cron",
        invocationOverride: "openai:gpt-4o-mini",
      }),
    );
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-4o-mini");
  });
});

describe("Level 2: explicit config", () => {
  it("returns explicit config value with source explicit_config", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "cron",
        operationModels: { cron: { model: "openai:gpt-4o" } } as OperationModels,
      }),
    );
    expect(result.model).toBe("openai:gpt-4o");
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-4o");
    expect(result.source).toBe("explicit_config");
  });

  it("returns agent primary when config value is 'primary'", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "heartbeat",
        operationModels: { heartbeat: { model: "primary" } } as OperationModels,
      }),
    );
    expect(result.model).toBe("anthropic:claude-sonnet-4-5-20250929");
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-sonnet-4-5-20250929");
    expect(result.source).toBe("explicit_config");
  });

  it("runs normalizeModelId on config shortcut values", () => {
    // "sonnet" should resolve via normalizeModelId to a full model ID
    const result = resolveOperationModel(
      baseParams({
        operationType: "cron",
        operationModels: { cron: { model: "anthropic:sonnet" } } as OperationModels,
      }),
    );
    expect(result.source).toBe("explicit_config");
    expect(result.provider).toBe("anthropic");
    // normalizeModelId should resolve "sonnet" to a full claude-sonnet-* ID
    expect(result.modelId).toMatch(/^claude-sonnet-/);
  });
});

describe("Level 3: parent inherited", () => {
  it("returns parent model for subagent operations", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "subagent",
        parentModel: "anthropic:claude-opus-4-20250514",
      }),
    );
    expect(result.model).toBe("anthropic:claude-opus-4-20250514");
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-opus-4-20250514");
    expect(result.source).toBe("parent_inherited");
  });

  it("ignores parentModel for non-subagent operations", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "cron",
        parentModel: "anthropic:claude-opus-4-20250514",
      }),
    );
    // Should NOT be parent_inherited -- should fall through to family default or agent primary
    expect(result.source).not.toBe("parent_inherited");
  });
});

describe("Level 4: family default (catalog-derived)", () => {
  // Behavioral assertions: pinning literal model IDs would re-introduce
  // the staleness problem the catalog-derived resolver was designed to fix.
  // Tests assert the resolved model exists in the provider's catalog and
  // matches the cost-tier ranking produced by resolveOperationDefaults.

  it("returns the catalog fast-tier model for anthropic heartbeat", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "heartbeat",
        providerFamily: "anthropic",
      }),
    );
    const expected = resolveOperationDefaults("anthropic").fast;
    expect(result.modelId).toBe(expected);
    expect(result.source).toBe("family_default");
    // Resolved model must be a real Anthropic catalog entry.
    expect(getModels("anthropic").find((m) => m.id === result.modelId)).toBeDefined();
  });

  it("returns the catalog mid-tier model for anthropic cron", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "cron",
        providerFamily: "anthropic",
      }),
    );
    const expected = resolveOperationDefaults("anthropic").mid;
    expect(result.modelId).toBe(expected);
    expect(result.source).toBe("family_default");
  });

  it("returns the catalog fast-tier model for google heartbeat", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "heartbeat",
        agentProvider: "google",
        providerFamily: "google",
      }),
    );
    const expected = resolveOperationDefaults("google").fast;
    expect(result.modelId).toBe(expected);
    expect(result.source).toBe("family_default");
    expect(getModels("google").find((m) => m.id === result.modelId)).toBeDefined();
  });

  it("returns the catalog mid-tier model for google cron", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "cron",
        agentProvider: "google",
        agentModel: "gemini-3.1-pro",
        providerFamily: "google",
      }),
    );
    const expected = resolveOperationDefaults("google").mid;
    expect(result.modelId).toBe(expected);
    expect(result.source).toBe("family_default");
  });

  it("returns the catalog mid-tier model for openai cron", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "cron",
        agentProvider: "openai",
        agentModel: "gpt-5.4-mini",
        providerFamily: "openai",
      }),
    );
    const expected = resolveOperationDefaults("openai").mid;
    expect(result.modelId).toBe(expected);
    expect(result.source).toBe("family_default");
    expect(getModels("openai").find((m) => m.id === result.modelId)).toBeDefined();
  });

  it("returns the catalog fast-tier model for openai heartbeat", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "heartbeat",
        agentProvider: "openai",
        agentModel: "gpt-5.4",
        providerFamily: "openai",
      }),
    );
    const expected = resolveOperationDefaults("openai").fast;
    expect(result.modelId).toBe(expected);
    expect(result.source).toBe("family_default");
  });

  it("routes openrouter cron to an OpenRouter model (not Anthropic) — Phase 2 bugfix guard", () => {
    // The motivating bug: switching primary to OpenRouter should NOT route
    // background tiers to Claude. This test pins the closure of that bug.
    const result = resolveOperationModel(
      baseParams({
        operationType: "cron",
        agentProvider: "openrouter",
        agentModel: "qwen/qwen3-coder",
        providerFamily: "openrouter",
      }),
    );
    expect(result.source).toBe("family_default");
    expect(result.provider).toBe("openrouter");
    expect(result.modelId).not.toMatch(/^claude-/);
    expect(getModels("openrouter").find((m) => m.id === result.modelId)).toBeDefined();
  });

  it("routes openrouter heartbeat to an OpenRouter model (not Anthropic)", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "heartbeat",
        agentProvider: "openrouter",
        agentModel: "qwen/qwen3-coder",
        providerFamily: "openrouter",
      }),
    );
    expect(result.source).toBe("family_default");
    expect(result.provider).toBe("openrouter");
    expect(result.modelId).not.toMatch(/^claude-/);
  });

  it("fast-tier total cost <= mid-tier total cost (ranking property holds via resolver)", () => {
    // Verifies ranking flows correctly through the resolver, not just the
    // standalone resolveOperationDefaults helper.
    for (const provider of ["anthropic", "openai", "openrouter"] as const) {
      const fast = resolveOperationModel(
        baseParams({
          operationType: "heartbeat",
          agentProvider: provider,
          providerFamily: provider,
        }),
      );
      const mid = resolveOperationModel(
        baseParams({
          operationType: "cron",
          agentProvider: provider,
          providerFamily: provider,
        }),
      );
      const fastModel = getModels(provider).find((m) => m.id === fast.modelId)!;
      const midModel = getModels(provider).find((m) => m.id === mid.modelId)!;
      expect(totalCost(fastModel)).toBeLessThanOrEqual(totalCost(midModel));
    }
  });

  it("returns agent primary for interactive type (tier is primary, skips defaults)", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "interactive",
        providerFamily: "anthropic",
      }),
    );
    expect(result.model).toBe("anthropic:claude-sonnet-4-5-20250929");
    expect(result.source).toBe("agent_primary");
  });
});

describe("Level 5: agent primary", () => {
  it("falls back to agent primary for non-native provider family (custom YAML provider)", () => {
    // Ollama is not in the pi-ai catalog (it's a custom YAML provider type),
    // so resolveOperationDefaults("ollama") returns {} -> Level 5 fallback.
    const result = resolveOperationModel(
      baseParams({
        operationType: "heartbeat",
        agentProvider: "ollama",
        agentModel: "llama3:8b",
        providerFamily: "ollama",
      }),
    );
    expect(result.model).toBe("ollama:llama3:8b");
    expect(result.source).toBe("agent_primary");
  });

  it("returns agent primary for interactive with no config", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "interactive",
      }),
    );
    expect(result.model).toBe("anthropic:claude-sonnet-4-5-20250929");
    expect(result.source).toBe("agent_primary");
  });

  it("returns agent primary for subagent when no parentModel (tier is primary)", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "subagent",
        agentProvider: "openai",
        agentModel: "gpt-5.4-nano",
        providerFamily: "openai",
      }),
    );
    expect(result.model).toBe("openai:gpt-5.4-nano");
    expect(result.source).toBe("agent_primary");
  });
});

describe("timeout resolution", () => {
  it("uses explicit timeout from operationModels when set", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "cron",
        operationModels: { cron: { timeout: 200_000 } } as OperationModels,
      }),
    );
    expect(result.timeoutMs).toBe(200_000);
  });

  it("uses OPERATION_TIMEOUT_DEFAULTS when no explicit timeout", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "heartbeat",
      }),
    );
    expect(result.timeoutMs).toBe(60_000);
  });

  it("falls back to agentPromptTimeoutMs for interactive with no explicit timeout", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "interactive",
        agentPromptTimeoutMs: 200_000,
      }),
    );
    expect(result.timeoutMs).toBe(200_000);
  });

  it("falls back to 180000 when no timeout source available", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "interactive",
        agentPromptTimeoutMs: undefined,
      }),
    );
    expect(result.timeoutMs).toBe(180_000);
  });
});

describe("cache retention", () => {
  it("includes cacheRetention from OPERATION_CACHE_DEFAULTS for heartbeat", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "heartbeat",
      }),
    );
    expect(result.cacheRetention).toBe("none");
  });

  it("includes cacheRetention short for condensation", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "condensation",
      }),
    );
    expect(result.cacheRetention).toBe("short");
  });

  it("has no cacheRetention override for interactive operations", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "interactive",
      }),
    );
    expect(result.cacheRetention).toBeUndefined();
  });

  it("includes cacheRetention short for cron operations", () => {
    const result = resolveOperationModel(
      baseParams({
        operationType: "cron",
      }),
    );
    expect(result.cacheRetention).toBe("short");
  });
});

describe("resolveProviderFamily", () => {
  it("returns 'anthropic' for 'anthropic'", () => {
    expect(resolveProviderFamily("anthropic")).toBe("anthropic");
  });

  it("returns 'openai' for 'openai'", () => {
    expect(resolveProviderFamily("openai")).toBe("openai");
  });

  it("returns 'google' for 'google'", () => {
    expect(resolveProviderFamily("google")).toBe("google");
  });

  it("strips -bedrock suffix: 'anthropic-bedrock' -> 'anthropic'", () => {
    expect(resolveProviderFamily("anthropic-bedrock")).toBe("anthropic");
  });

  it("strips -vertex suffix: 'google-vertex' -> 'google'", () => {
    expect(resolveProviderFamily("google-vertex")).toBe("google");
  });

  it("passes through unknown providers unchanged: 'xai' -> 'xai'", () => {
    expect(resolveProviderFamily("xai")).toBe("xai");
  });
});
