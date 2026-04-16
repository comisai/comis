import { describe, it, expect } from "vitest";
import {
  BudgetConfigSchema,
  CircuitBreakerConfigSchema,
  ModelRoutesSchema,
  FallbackModelSchema,
  AuthProfileSchema,
  ModelFailoverConfigSchema,
  PromptTimeoutConfigSchema,
  OperationModelsSchema,
  OperationModelEntrySchema,
} from "./schema-agent.js";

describe("BudgetConfigSchema", () => {
  it("parses valid input with all fields", () => {
    const result = BudgetConfigSchema.safeParse({
      perExecution: 50_000,
      perHour: 200_000,
      perDay: 1_000_000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.perExecution).toBe(50_000);
      expect(result.data.perHour).toBe(200_000);
      expect(result.data.perDay).toBe(1_000_000);
    }
  });

  it("applies correct defaults for empty object", () => {
    const result = BudgetConfigSchema.parse({});
    expect(result.perExecution).toBe(2_000_000);
    expect(result.perHour).toBe(10_000_000);
    expect(result.perDay).toBe(100_000_000);
  });

  it("rejects negative values", () => {
    const result = BudgetConfigSchema.safeParse({ perExecution: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects zero values", () => {
    const result = BudgetConfigSchema.safeParse({ perHour: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer values", () => {
    const result = BudgetConfigSchema.safeParse({ perDay: 1.5 });
    expect(result.success).toBe(false);
  });
});

describe("CircuitBreakerConfigSchema", () => {
  it("parses valid input", () => {
    const result = CircuitBreakerConfigSchema.safeParse({
      failureThreshold: 3,
      resetTimeoutMs: 30_000,
      halfOpenTimeoutMs: 15_000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.failureThreshold).toBe(3);
      expect(result.data.resetTimeoutMs).toBe(30_000);
      expect(result.data.halfOpenTimeoutMs).toBe(15_000);
    }
  });

  it("applies defaults for empty object", () => {
    const result = CircuitBreakerConfigSchema.parse({});
    expect(result.failureThreshold).toBe(5);
    expect(result.resetTimeoutMs).toBe(60_000);
    expect(result.halfOpenTimeoutMs).toBe(30_000);
  });

  it("rejects negative failureThreshold", () => {
    const result = CircuitBreakerConfigSchema.safeParse({ failureThreshold: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects zero resetTimeoutMs", () => {
    const result = CircuitBreakerConfigSchema.safeParse({ resetTimeoutMs: 0 });
    expect(result.success).toBe(false);
  });
});

describe("ModelRoutesSchema", () => {
  it("parses valid route mappings", () => {
    const result = ModelRoutesSchema.safeParse({
      default: "claude-sonnet-4-5-20250929",
      summarization: "claude-haiku-3",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.default).toBe("claude-sonnet-4-5-20250929");
      expect(result.data.summarization).toBe("claude-haiku-3");
    }
  });

  it("defaults to empty object", () => {
    const result = ModelRoutesSchema.parse(undefined);
    expect(result).toEqual({});
  });

  it("allows empty object", () => {
    const result = ModelRoutesSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({});
    }
  });

  it("rejects empty string for default key", () => {
    const result = ModelRoutesSchema.safeParse({ default: "" });
    expect(result.success).toBe(false);
  });
});

describe("FallbackModelSchema", () => {
  it("parses valid fallback configuration", () => {
    const result = FallbackModelSchema.safeParse({
      provider: "openai",
      modelId: "gpt-4o",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("openai");
      expect(result.data.modelId).toBe("gpt-4o");
    }
  });

  it("requires provider field", () => {
    const result = FallbackModelSchema.safeParse({ modelId: "gpt-4o" });
    expect(result.success).toBe(false);
  });

  it("requires modelId field", () => {
    const result = FallbackModelSchema.safeParse({ provider: "openai" });
    expect(result.success).toBe(false);
  });

  it("rejects empty provider string", () => {
    const result = FallbackModelSchema.safeParse({ provider: "", modelId: "gpt-4o" });
    expect(result.success).toBe(false);
  });
});

describe("AuthProfileSchema", () => {
  it("parses valid auth profile entries", () => {
    const result = AuthProfileSchema.safeParse({
      keyName: "ANTHROPIC_API_KEY_2",
      provider: "anthropic",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.keyName).toBe("ANTHROPIC_API_KEY_2");
      expect(result.data.provider).toBe("anthropic");
    }
  });

  it("requires keyName field", () => {
    const result = AuthProfileSchema.safeParse({ provider: "anthropic" });
    expect(result.success).toBe(false);
  });

  it("requires provider field", () => {
    const result = AuthProfileSchema.safeParse({ keyName: "ANTHROPIC_API_KEY_2" });
    expect(result.success).toBe(false);
  });

  it("rejects empty keyName string", () => {
    const result = AuthProfileSchema.safeParse({ keyName: "", provider: "anthropic" });
    expect(result.success).toBe(false);
  });
});

describe("ModelFailoverConfigSchema", () => {
  it("parses valid failover config with all fields", () => {
    const result = ModelFailoverConfigSchema.safeParse({
      fallbackModels: [{ provider: "openai", modelId: "gpt-4o" }],
      authProfiles: [{ keyName: "KEY_2", provider: "anthropic" }],
      allowedModels: ["claude-sonnet-4-5-20250929", "gpt-4o"],
      maxAttempts: 3,
      cooldownInitialMs: 30_000,
      cooldownMultiplier: 2,
      cooldownCapMs: 1_800_000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fallbackModels).toHaveLength(1);
      expect(result.data.authProfiles).toHaveLength(1);
      expect(result.data.allowedModels).toHaveLength(2);
      expect(result.data.maxAttempts).toBe(3);
      expect(result.data.cooldownMultiplier).toBe(2);
    }
  });

  it("applies defaults for empty object", () => {
    const result = ModelFailoverConfigSchema.parse({});
    expect(result.fallbackModels).toEqual([]);
    expect(result.authProfiles).toEqual([]);
    expect(result.allowedModels).toEqual([]);
    expect(result.maxAttempts).toBe(6);
    expect(result.cooldownInitialMs).toBe(60_000);
    expect(result.cooldownMultiplier).toBe(5);
    expect(result.cooldownCapMs).toBe(3_600_000);
  });

  it("rejects negative maxAttempts", () => {
    const result = ModelFailoverConfigSchema.safeParse({ maxAttempts: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects zero cooldownInitialMs", () => {
    const result = ModelFailoverConfigSchema.safeParse({ cooldownInitialMs: 0 });
    expect(result.success).toBe(false);
  });

  it("round-trip: parse then re-parse produces identical result", () => {
    const first = ModelFailoverConfigSchema.parse({
      fallbackModels: [{ provider: "openai", modelId: "gpt-4o" }],
      maxAttempts: 4,
    });
    const second = ModelFailoverConfigSchema.parse(first);
    expect(second).toEqual(first);
  });
});

describe("PromptTimeoutConfigSchema", () => {
  it("applies defaults for empty object", () => {
    const result = PromptTimeoutConfigSchema.parse({});
    expect(result.promptTimeoutMs).toBe(180_000);
    expect(result.retryPromptTimeoutMs).toBe(60_000);
  });

  it("rejects negative values", () => {
    const result = PromptTimeoutConfigSchema.safeParse({ promptTimeoutMs: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects zero values", () => {
    const result = PromptTimeoutConfigSchema.safeParse({ promptTimeoutMs: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer values", () => {
    const result = PromptTimeoutConfigSchema.safeParse({ promptTimeoutMs: 1.5 });
    expect(result.success).toBe(false);
  });

  it("accepts custom positive integers", () => {
    const result = PromptTimeoutConfigSchema.safeParse({
      promptTimeoutMs: 300_000,
      retryPromptTimeoutMs: 120_000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.promptTimeoutMs).toBe(300_000);
      expect(result.data.retryPromptTimeoutMs).toBe(120_000);
    }
  });
});

describe("OperationModelEntrySchema", () => {
  it("parses entry with model and timeout", () => {
    const result = OperationModelEntrySchema.parse({
      model: "anthropic:claude-haiku-4-5",
      timeout: 150_000,
    });
    expect(result.model).toBe("anthropic:claude-haiku-4-5");
    expect(result.timeout).toBe(150_000);
  });

  it("accepts model-only entry", () => {
    const result = OperationModelEntrySchema.parse({ model: "primary" });
    expect(result.model).toBe("primary");
    expect(result.timeout).toBeUndefined();
  });

  it("accepts timeout-only entry", () => {
    const result = OperationModelEntrySchema.parse({ timeout: 120_000 });
    expect(result.model).toBeUndefined();
    expect(result.timeout).toBe(120_000);
  });

  it("rejects typo keys (z.strictObject on entry)", () => {
    const result = OperationModelEntrySchema.safeParse({ modle: "typo" });
    expect(result.success).toBe(false);
  });
});

describe("OperationModelsSchema", () => {
  it("defaults to empty object when not provided", () => {
    const result = OperationModelsSchema.parse(undefined);
    expect(result).toEqual({});
  });

  it("parses empty object (all fields optional)", () => {
    const result = OperationModelsSchema.parse({});
    expect(result).toEqual({});
  });

  it("parses a valid nested operationModels block with model and timeout", () => {
    const result = OperationModelsSchema.parse({
      cron: { model: "anthropic:claude-haiku-4-5", timeout: 150_000 },
    });
    expect(result.cron?.model).toBe("anthropic:claude-haiku-4-5");
    expect(result.cron?.timeout).toBe(150_000);
  });

  it("accepts 'primary' keyword as a nested model value", () => {
    const result = OperationModelsSchema.parse({
      heartbeat: { model: "primary" },
    });
    expect(result.heartbeat?.model).toBe("primary");
  });

  it("rejects unknown keys at outer level (z.strictObject behavior)", () => {
    const result = OperationModelsSchema.safeParse({ interactive: { model: "model" } });
    expect(result.success).toBe(false);
  });

  it("accepts timeout-only entry without model", () => {
    const result = OperationModelsSchema.parse({
      cron: { timeout: 120_000 },
    });
    expect(result.cron?.timeout).toBe(120_000);
    expect(result.cron?.model).toBeUndefined();
  });

  it("rejects legacy flat model string (cron: string)", () => {
    const result = OperationModelsSchema.safeParse({
      cron: "anthropic:claude-haiku-4-5",
    });
    expect(result.success).toBe(false);
  });

  it("rejects legacy flat timeout keys (cronTimeout)", () => {
    const result = OperationModelsSchema.safeParse({
      cronTimeout: 150_000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects typo inside entry (z.strictObject on entry)", () => {
    const result = OperationModelsSchema.safeParse({
      cron: { modle: "typo" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid timeout (negative value)", () => {
    const result = OperationModelsSchema.safeParse({
      cron: { timeout: -1 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero timeout", () => {
    const result = OperationModelsSchema.safeParse({
      cron: { timeout: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer timeout", () => {
    const result = OperationModelsSchema.safeParse({
      heartbeat: { timeout: 1.5 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty string model", () => {
    const result = OperationModelsSchema.safeParse({
      cron: { model: "" },
    });
    expect(result.success).toBe(false);
  });

  it("parses all 6 entries correctly", () => {
    const input = {
      cron: { model: "anthropic:claude-haiku-4-5", timeout: 150_000 },
      heartbeat: { model: "anthropic:claude-haiku-4-5", timeout: 60_000 },
      subagent: { model: "primary", timeout: 180_000 },
      compaction: { model: "anthropic:claude-haiku-4-5", timeout: 60_000 },
      taskExtraction: { model: "anthropic:claude-haiku-4-5", timeout: 30_000 },
      condensation: { model: "anthropic:claude-haiku-4-5", timeout: 45_000 },
    };
    const result = OperationModelsSchema.parse(input);
    expect(result).toEqual(input);
  });
});
