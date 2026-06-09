// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createConfigResolver, resolveBreakpointStrategy } from "./config-resolver.js";
import type { ConfigResolverConfig } from "./config-resolver.js";
import { createMockLogger, createMockStreamFn, makeContext } from "./__test-helpers/index.js";

describe("createConfigResolver", () => {
  let logger: ReturnType<typeof createMockLogger>;
  let base: ReturnType<typeof createMockStreamFn>;

  function makeModel(provider: string, overrides?: { reasoning?: boolean }) {
    return {
      id: "test-model",
      name: "Test Model",
      api: "anthropic-messages",
      provider,
      baseUrl: "https://api.example.com",
      reasoning: overrides?.reasoning ?? false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } as any;
  }

  beforeEach(() => {
    logger = createMockLogger();
    base = createMockStreamFn();
  });

  it("injects maxTokens into options", () => {
    const config: ConfigResolverConfig = { maxTokens: 4096 };
    const wrapper = createConfigResolver(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("openai");
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const calledOptions = base.mock.calls[0][2];
    expect(calledOptions.maxTokens).toBe(4096);
  });

  it("injects temperature into options", () => {
    const config: ConfigResolverConfig = { temperature: 0.7 };
    const wrapper = createConfigResolver(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("openai");
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const calledOptions = base.mock.calls[0][2];
    expect(calledOptions.temperature).toBe(0.7);
  });

  it("skips temperature for reasoning models", () => {
    const config: ConfigResolverConfig = { temperature: 0.7 };
    const wrapper = createConfigResolver(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("openai", { reasoning: true });
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const calledOptions = base.mock.calls[0][2];
    expect(calledOptions.temperature).toBeUndefined();
  });

  it("injects cacheRetention for Anthropic provider", () => {
    const config: ConfigResolverConfig = { cacheRetention: "long" };
    const wrapper = createConfigResolver(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("anthropic");
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const calledOptions = base.mock.calls[0][2];
    expect(calledOptions.cacheRetention).toBe("long");
  });

  it("does NOT default cacheRetention when not configured (schema provides default)", () => {
    const config: ConfigResolverConfig = {};
    const wrapper = createConfigResolver(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("anthropic");
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const calledOptions = base.mock.calls[0][2];
    // cacheRetention not set in config -> not injected (schema layer provides defaults)
    expect(calledOptions.cacheRetention).toBeUndefined();
  });

  it("does NOT inject cacheRetention for non-Anthropic providers", () => {
    const config: ConfigResolverConfig = { maxTokens: 2048 };
    const wrapper = createConfigResolver(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("openai");
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const calledOptions = base.mock.calls[0][2];
    expect(calledOptions.cacheRetention).toBeUndefined();
    expect(calledOptions.maxTokens).toBe(2048);
  });

  it("config values override existing options (operator override)", () => {
    const config: ConfigResolverConfig = { maxTokens: 4096, temperature: 0.3 };
    const wrapper = createConfigResolver(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("openai");
    const context = makeContext([]);
    const existingOptions = { maxTokens: 8192, temperature: 1.0, signal: undefined };

    wrappedFn(model, context, existingOptions);

    const calledOptions = base.mock.calls[0][2];
    expect(calledOptions.maxTokens).toBe(4096);
    expect(calledOptions.temperature).toBe(0.3);
  });

  it("skips injection when no config values set and provider is not Anthropic", () => {
    const config: ConfigResolverConfig = {};
    const wrapper = createConfigResolver(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("openai");
    const context = makeContext([]);
    const options = { signal: undefined };

    wrappedFn(model, context, options);

    // Should pass options through unchanged (same reference)
    expect(base.mock.calls[0][2]).toBe(options);
  });

  it('logs "injected" when params are applied', () => {
    const config: ConfigResolverConfig = { maxTokens: 4096 };
    const wrapper = createConfigResolver(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("openai");
    const context = makeContext([]);

    wrappedFn(model, context, {});

    expect(logger.debug).toHaveBeenCalledWith(
      {
        wrapperName: "configResolver",
        provider: "openai",
        injected: ["maxTokens"],
      },
      "Config params injected",
    );
  });

  it('logs "skipped" when no params to inject', () => {
    const config: ConfigResolverConfig = {};
    const wrapper = createConfigResolver(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("openai");
    const context = makeContext([]);

    wrappedFn(model, context, {});

    expect(logger.debug).toHaveBeenCalledWith(
      {
        wrapperName: "configResolver",
        provider: "openai",
        skipped: true,
      },
      "Config resolution skipped",
    );
  });

  it("resolves dynamic cacheRetention getter for Anthropic", () => {
    const config: ConfigResolverConfig = {
      cacheRetention: () => "short",
    };
    const wrapper = createConfigResolver(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("anthropic");
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const calledOptions = base.mock.calls[0][2];
    expect(calledOptions.cacheRetention).toBe("short");
  });

  it("getter returning undefined does NOT inject cacheRetention (schema provides default)", () => {
    const config: ConfigResolverConfig = {
      cacheRetention: () => undefined,
    };
    const wrapper = createConfigResolver(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("anthropic");
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const calledOptions = base.mock.calls[0][2];
    expect(calledOptions.cacheRetention).toBeUndefined();
  });

  it("returns a named function for logging in composeStreamWrappers", () => {
    const config: ConfigResolverConfig = {};
    const wrapper = createConfigResolver(config, logger);
    expect(wrapper.name).toBe("configResolver");
  });
});


describe("Phase 166 CWF-02: dynamic max_tokens clamp", () => {
  it("CWF-02-G: clamps max_tokens to remaining room when assembled tokens provided", async () => {
    // assembledInputTokens=30000, effectiveWindow=32768, configuredMax=8192
    // remainingRoom = max(768, 32768 - 30000) = max(768, 2768) = 2768
    // dynamicMax = min(8192, 2768) = 2768
    const resolver = createConfigResolver({
      maxTokens: 8192,
      getAssembledInputTokens: () => 30_000,
      getEffectiveWindow: () => 32_768,
      getOutputHeadroom: () => 768,
    }, createMockLogger());
    let capturedOptions: Record<string, unknown> = {};
    const wrappedFn = resolver((_m, _c, opts) => { capturedOptions = opts as Record<string, unknown>; return Promise.resolve(undefined as unknown as never); });
    await wrappedFn({} as never, {} as never, {});
    expect(capturedOptions.maxTokens).toBe(2_768);  // EXACT pin
  });

  it("CWF-02-G: max_tokens = remaining room when no configuredMax", async () => {
    // assembledInputTokens=30000, effectiveWindow=32768, no configuredMax
    // dynamicMax = max(768, 32768-30000) = 2768
    const resolver = createConfigResolver({
      getAssembledInputTokens: () => 30_000,
      getEffectiveWindow: () => 32_768,
      getOutputHeadroom: () => 768,
    }, createMockLogger());
    let capturedOptions: Record<string, unknown> = {};
    const wrappedFn = resolver((_m, _c, opts) => { capturedOptions = opts as Record<string, unknown>; return Promise.resolve(undefined as unknown as never); });
    await wrappedFn({} as never, {} as never, {});
    expect(capturedOptions.maxTokens).toBe(2_768);
  });

  it("CWF-02-G: configuredMax wins when remaining room is larger", async () => {
    // assembledInputTokens=1000, effectiveWindow=32768, configuredMax=8192
    // remainingRoom = 32768-1000=31768; dynamicMax = min(8192, 31768) = 8192
    const resolver = createConfigResolver({
      maxTokens: 8192,
      getAssembledInputTokens: () => 1_000,
      getEffectiveWindow: () => 32_768,
      getOutputHeadroom: () => 768,
    }, createMockLogger());
    let capturedOptions: Record<string, unknown> = {};
    const wrappedFn = resolver((_m, _c, opts) => { capturedOptions = opts as Record<string, unknown>; return Promise.resolve(undefined as unknown as never); });
    await wrappedFn({} as never, {} as never, {});
    expect(capturedOptions.maxTokens).toBe(8_192);
  });

  it("CWF-02-H CHARACTERIZATION: frontier/mid — max_tokens byte-identical when no dynamic info", async () => {
    // When getAssembledInputTokens is absent → falls back to static config.maxTokens
    // Pin EXACT value: config.maxTokens = 8192 → injected.maxTokens = 8192 (unchanged)
    const resolver = createConfigResolver({ maxTokens: 8_192 }, createMockLogger());
    let capturedOptions: Record<string, unknown> = {};
    const wrappedFn = resolver((_m, _c, opts) => { capturedOptions = opts as Record<string, unknown>; return Promise.resolve(undefined as unknown as never); });
    await wrappedFn({} as never, {} as never, {});
    expect(capturedOptions.maxTokens).toBe(8_192);  // EXACT pin — byte-identical
  });

  it("floor guard: max_tokens never below MIN_VISIBLE_OUTPUT_TOKENS (768) even on extreme pressure", async () => {
    // assembledInputTokens=32767, effectiveWindow=32768 → remaining=1; floor clamp to 768
    const resolver = createConfigResolver({
      getAssembledInputTokens: () => 32_767,
      getEffectiveWindow: () => 32_768,
      getOutputHeadroom: () => 768,
    }, createMockLogger());
    let capturedOptions: Record<string, unknown> = {};
    const wrappedFn = resolver((_m, _c, opts) => { capturedOptions = opts as Record<string, unknown>; return Promise.resolve(undefined as unknown as never); });
    await wrappedFn({} as never, {} as never, {});
    expect(capturedOptions.maxTokens).toBe(768);  // floor applied
  });

  it("effectiveWindow=Infinity guard: dynamic clamp skipped → static maxTokens (frontier path)", async () => {
    // When effectiveWindow is Infinity the condition effectiveWindow < Infinity is false → static fallback
    const resolver = createConfigResolver({
      maxTokens: 8_192,
      getAssembledInputTokens: () => 1_000,
      getEffectiveWindow: () => Infinity,
      getOutputHeadroom: () => 768,
    }, createMockLogger());
    let capturedOptions: Record<string, unknown> = {};
    const wrappedFn = resolver((_m, _c, opts) => { capturedOptions = opts as Record<string, unknown>; return Promise.resolve(undefined as unknown as never); });
    await wrappedFn({} as never, {} as never, {});
    expect(capturedOptions.maxTokens).toBe(8_192);  // static path taken
  });

  it("guard: assembledInputTokens=0 → falls through to static maxTokens", async () => {
    // Guard: assembledInputTokensRef.current > 0 is false → static fallback
    const resolver = createConfigResolver({
      maxTokens: 8_192,
      getAssembledInputTokens: () => 0,
      getEffectiveWindow: () => 32_768,
      getOutputHeadroom: () => 768,
    }, createMockLogger());
    let capturedOptions: Record<string, unknown> = {};
    const wrappedFn = resolver((_m, _c, opts) => { capturedOptions = opts as Record<string, unknown>; return Promise.resolve(undefined as unknown as never); });
    await wrappedFn({} as never, {} as never, {});
    expect(capturedOptions.maxTokens).toBe(8_192);  // static path taken (guard: assembled > 0 fails)
  });
});

describe("resolveBreakpointStrategy", () => {
  it("resolves 'auto' to 'multi-zone' for all providers (W11)", () => {
    expect(resolveBreakpointStrategy("auto", "anthropic")).toBe("multi-zone");
  });

  it("resolves 'auto' to 'multi-zone' for amazon-bedrock", () => {
    expect(resolveBreakpointStrategy("auto", "amazon-bedrock")).toBe("multi-zone");
  });

  it("respects explicit 'single' override regardless of provider", () => {
    expect(resolveBreakpointStrategy("single", "amazon-bedrock")).toBe("single");
  });

  it("respects explicit 'multi-zone' override regardless of provider", () => {
    expect(resolveBreakpointStrategy("multi-zone", "anthropic")).toBe("multi-zone");
  });

  it("treats undefined as 'auto' (resolves by provider)", () => {
    expect(resolveBreakpointStrategy(undefined, "anthropic")).toBe("multi-zone");
    expect(resolveBreakpointStrategy(undefined, "amazon-bedrock")).toBe("multi-zone");
  });
});
