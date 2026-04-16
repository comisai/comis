import { describe, it, expect } from "vitest";
import {
  ProviderEntrySchema,
  ProvidersConfigSchema,
  UserModelSchema,
  ModelCostSchema,
} from "./schema-providers.js";
import { ModelCompatConfigSchema } from "../domain/model-compat.js";
import { ProviderCapabilitiesSchema } from "../domain/provider-capabilities.js";

// ---------------------------------------------------------------------------
// ModelCompatConfigSchema
// ---------------------------------------------------------------------------

describe("ModelCompatConfigSchema", () => {
  it("parses empty object (all fields optional)", () => {
    const result = ModelCompatConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.supportsTools).toBeUndefined();
      expect(result.data.toolSchemaProfile).toBeUndefined();
      expect(result.data.toolCallArgumentsEncoding).toBeUndefined();
      expect(result.data.nativeWebSearchTool).toBeUndefined();
    }
  });

  it("parses valid full config", () => {
    const result = ModelCompatConfigSchema.safeParse({
      supportsTools: true,
      toolSchemaProfile: "xai",
      toolCallArgumentsEncoding: "html-entities",
      nativeWebSearchTool: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.supportsTools).toBe(true);
      expect(result.data.toolSchemaProfile).toBe("xai");
      expect(result.data.toolCallArgumentsEncoding).toBe("html-entities");
      expect(result.data.nativeWebSearchTool).toBe(false);
    }
  });

  it("rejects unknown fields (z.strictObject enforcement)", () => {
    const result = ModelCompatConfigSchema.safeParse({
      supportsTools: true,
      unknownField: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid enum values", () => {
    const result = ModelCompatConfigSchema.safeParse({
      toolSchemaProfile: "invalid",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ProviderCapabilitiesSchema
// ---------------------------------------------------------------------------

describe("ProviderCapabilitiesSchema", () => {
  it("parses empty object and produces correct defaults", () => {
    const result = ProviderCapabilitiesSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.providerFamily).toBe("default");
      expect(result.data.dropThinkingBlockModelHints).toEqual([]);
      expect(result.data.transcriptToolCallIdMode).toBe("default");
      expect(result.data.transcriptToolCallIdModelHints).toEqual([]);
    }
  });

  it("parses full override", () => {
    const result = ProviderCapabilitiesSchema.safeParse({
      providerFamily: "anthropic",
      dropThinkingBlockModelHints: ["claude"],
      transcriptToolCallIdMode: "strict9",
      transcriptToolCallIdModelHints: ["mistral"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.providerFamily).toBe("anthropic");
      expect(result.data.dropThinkingBlockModelHints).toEqual(["claude"]);
      expect(result.data.transcriptToolCallIdMode).toBe("strict9");
      expect(result.data.transcriptToolCallIdModelHints).toEqual(["mistral"]);
    }
  });

  it("rejects unknown fields", () => {
    const result = ProviderCapabilitiesSchema.safeParse({
      providerFamily: "default",
      unknownField: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid providerFamily enum", () => {
    const result = ProviderCapabilitiesSchema.safeParse({
      providerFamily: "azure",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UserModelSchema
// ---------------------------------------------------------------------------

describe("UserModelSchema", () => {
  it("parses minimal config with correct defaults", () => {
    const result = UserModelSchema.safeParse({ id: "test-model" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("test-model");
      expect(result.data.reasoning).toBe(false);
      expect(result.data.input).toEqual(["text"]);
      expect(result.data.name).toBeUndefined();
      expect(result.data.contextWindow).toBeUndefined();
      expect(result.data.maxTokens).toBeUndefined();
      expect(result.data.cost).toBeUndefined();
      expect(result.data.comisCompat).toBeUndefined();
      expect(result.data.sdkCompat).toBeUndefined();
    }
  });

  it("parses full config with comisCompat and sdkCompat", () => {
    const result = UserModelSchema.safeParse({
      id: "my-custom-model",
      name: "My Custom Model",
      reasoning: true,
      contextWindow: 128_000,
      maxTokens: 8192,
      input: ["text", "image"],
      cost: { input: 3.0, output: 15.0 },
      comisCompat: { supportsTools: true, toolSchemaProfile: "xai" },
      sdkCompat: { streamOptions: { includeUsage: true } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reasoning).toBe(true);
      expect(result.data.contextWindow).toBe(128_000);
      expect(result.data.comisCompat?.supportsTools).toBe(true);
      expect(result.data.sdkCompat?.streamOptions).toEqual({ includeUsage: true });
    }
  });

  it("rejects empty id string", () => {
    const result = UserModelSchema.safeParse({ id: "" });
    expect(result.success).toBe(false);
  });

  it("sdkCompat accepts arbitrary keys (z.record loose validation)", () => {
    const result = UserModelSchema.safeParse({
      id: "test",
      sdkCompat: { anyKey: "anyValue", nested: { deep: true } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sdkCompat?.anyKey).toBe("anyValue");
    }
  });

  it("comisCompat rejects unknown fields (strict)", () => {
    const result = UserModelSchema.safeParse({
      id: "test",
      comisCompat: { supportsTools: true, unknownField: true },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ModelCostSchema
// ---------------------------------------------------------------------------

describe("ModelCostSchema", () => {
  it("parses empty object (all fields optional)", () => {
    const result = ModelCostSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("parses full cost entry", () => {
    const result = ModelCostSchema.safeParse({
      input: 3.0,
      output: 15.0,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.input).toBe(3.0);
      expect(result.data.output).toBe(15.0);
      expect(result.data.cacheRead).toBe(0.3);
      expect(result.data.cacheWrite).toBe(3.75);
    }
  });

  it("rejects negative cost values", () => {
    const result = ModelCostSchema.safeParse({ input: -1 });
    expect(result.success).toBe(false);
  });

  it("accepts zero cost (free models)", () => {
    const result = ModelCostSchema.safeParse({ input: 0, output: 0 });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ProviderEntrySchema (extended)
// ---------------------------------------------------------------------------

describe("ProviderEntrySchema (extended)", () => {
  it("parses existing minimal config -- backward compatibility", () => {
    const result = ProviderEntrySchema.safeParse({ type: "openai" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("openai");
      expect(result.data.enabled).toBe(true);
      expect(result.data.timeoutMs).toBe(120_000);
    }
  });

  it("capabilities defaults to empty ProviderCapabilities (with all defaults)", () => {
    const result = ProviderEntrySchema.safeParse({ type: "openai" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toBeDefined();
      expect(result.data.capabilities.providerFamily).toBe("default");
      expect(result.data.capabilities.dropThinkingBlockModelHints).toEqual([]);
      expect(result.data.capabilities.transcriptToolCallIdMode).toBe("default");
      expect(result.data.capabilities.transcriptToolCallIdModelHints).toEqual([]);
    }
  });

  it("models defaults to empty array", () => {
    const result = ProviderEntrySchema.safeParse({ type: "openai" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.models).toEqual([]);
    }
  });

  it("parses full config with capabilities and models array", () => {
    const result = ProviderEntrySchema.safeParse({
      type: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyName: "deepseek-key",
      capabilities: {
        providerFamily: "openai",
        transcriptToolCallIdMode: "strict9",
        transcriptToolCallIdModelHints: ["deepseek-chat"],
      },
      models: [
        { id: "deepseek-chat", reasoning: false },
        { id: "deepseek-reasoner", reasoning: true, contextWindow: 64_000 },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities.providerFamily).toBe("openai");
      expect(result.data.models).toHaveLength(2);
      expect(result.data.models[1].reasoning).toBe(true);
      expect(result.data.models[1].contextWindow).toBe(64_000);
    }
  });

  it("rejects unknown capabilities fields (strict)", () => {
    const result = ProviderEntrySchema.safeParse({
      type: "openai",
      capabilities: { providerFamily: "openai", unknownField: true },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ProvidersConfigSchema
// ---------------------------------------------------------------------------

describe("ProvidersConfigSchema", () => {
  it("accepts provider entries with custom string keys", () => {
    const result = ProvidersConfigSchema.safeParse({
      entries: {
        anthropic: { type: "anthropic" },
        openai: { type: "openai" },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.entries)).toEqual(["anthropic", "openai"]);
    }
  });

  it("full integration: nested provider with capabilities + models", () => {
    const result = ProvidersConfigSchema.safeParse({
      entries: {
        deepseek: {
          type: "deepseek",
          capabilities: {
            providerFamily: "openai",
            dropThinkingBlockModelHints: ["deepseek-reasoner"],
          },
          models: [
            {
              id: "deepseek-reasoner",
              reasoning: true,
              contextWindow: 64_000,
              maxTokens: 8192,
              input: ["text"],
              cost: { input: 0.55, output: 2.19 },
              comisCompat: { supportsTools: false },
            },
          ],
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const ds = result.data.entries.deepseek;
      expect(ds.capabilities.dropThinkingBlockModelHints).toEqual(["deepseek-reasoner"]);
      expect(ds.models).toHaveLength(1);
      expect(ds.models[0].comisCompat?.supportsTools).toBe(false);
    }
  });
});
