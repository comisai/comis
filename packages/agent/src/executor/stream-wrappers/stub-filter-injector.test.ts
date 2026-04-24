// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createStubFilterInjector } from "./stub-filter-injector.js";
import { createMockLogger, createMockStreamFn } from "./__test-helpers.js";

describe("createStubFilterInjector", () => {
  it("filters stubs from top-level params.tools by name (Anthropic/OpenAI/xAI shape)", async () => {
    const logger = createMockLogger();
    const stubNames = new Set(["mcp__yfinance--get_screener", "mcp__yfinance--get_stock"]);
    const wrapper = createStubFilterInjector({ getStubToolNames: () => stubNames }, logger);

    const mockNext = createMockStreamFn();
    const wrappedFn = wrapper(mockNext);

    wrappedFn("model", { systemPrompt: "", messages: [], tools: [] }, {});

    // Extract the enhanced options passed to next
    const enhancedOptions = mockNext.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = enhancedOptions.onPayload as (payload: unknown, model: unknown) => Promise<unknown>;

    const payload = {
      tools: [
        { name: "mcp__yfinance--get_screener", description: "Screen stocks" },
        { name: "read", description: "Read a file" },
        { name: "mcp__yfinance--get_stock", description: "Get stock" },
        { name: "write", description: "Write a file" },
      ],
    };

    const result = await onPayload(payload, { provider: "anthropic" }) as Record<string, unknown>;
    const tools = result.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("read");
    expect(tools[1].name).toBe("write");
  });

  it("filters stubs from nested params.config.tools by name (Google AI Studio shape)", async () => {
    const logger = createMockLogger();
    const stubNames = new Set(["mcp__yfinance--get_screener"]);
    const wrapper = createStubFilterInjector({ getStubToolNames: () => stubNames }, logger);

    const mockNext = createMockStreamFn();
    const wrappedFn = wrapper(mockNext);
    wrappedFn("model", { systemPrompt: "", messages: [], tools: [] }, {});

    const enhancedOptions = mockNext.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = enhancedOptions.onPayload as (payload: unknown, model: unknown) => Promise<unknown>;

    const payload = {
      config: {
        tools: [
          { name: "mcp__yfinance--get_screener", description: "Screen stocks" },
          { name: "read", description: "Read a file" },
        ],
      },
    };

    const result = await onPayload(payload, { provider: "google" }) as Record<string, unknown>;
    const cfg = result.config as Record<string, unknown>;
    const tools = cfg.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("read");
  });

  it("returns params unchanged when stub name set is empty (early return)", async () => {
    const logger = createMockLogger();
    const wrapper = createStubFilterInjector({ getStubToolNames: () => new Set<string>() }, logger);

    const mockNext = createMockStreamFn();
    const wrappedFn = wrapper(mockNext);
    wrappedFn("model", { systemPrompt: "", messages: [], tools: [] }, {});

    const enhancedOptions = mockNext.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = enhancedOptions.onPayload as (payload: unknown, model: unknown) => Promise<unknown>;

    const payload = {
      tools: [
        { name: "read", description: "Read a file" },
        { name: "write", description: "Write a file" },
      ],
    };

    const result = await onPayload(payload, { provider: "anthropic" }) as Record<string, unknown>;
    const tools = result.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(2);
  });

  it("non-stub tools unaffected (remaining length = original - stub count)", async () => {
    const logger = createMockLogger();
    const stubNames = new Set(["stub_a", "stub_b", "stub_c"]);
    const wrapper = createStubFilterInjector({ getStubToolNames: () => stubNames }, logger);

    const mockNext = createMockStreamFn();
    const wrappedFn = wrapper(mockNext);
    wrappedFn("model", { systemPrompt: "", messages: [], tools: [] }, {});

    const enhancedOptions = mockNext.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = enhancedOptions.onPayload as (payload: unknown, model: unknown) => Promise<unknown>;

    const payload = {
      tools: [
        { name: "stub_a", description: "Stub A" },
        { name: "real_1", description: "Real 1" },
        { name: "stub_b", description: "Stub B" },
        { name: "real_2", description: "Real 2" },
        { name: "stub_c", description: "Stub C" },
        { name: "real_3", description: "Real 3" },
      ],
    };

    const result = await onPayload(payload, { provider: "openai" }) as Record<string, unknown>;
    const tools = result.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(3); // 6 original - 3 stubs = 3 remaining
    expect(tools.map(t => t.name)).toEqual(["real_1", "real_2", "real_3"]);
  });

  it("chains correctly with upstream onPayload (receives already-transformed params)", async () => {
    const logger = createMockLogger();
    const stubNames = new Set(["stub_tool"]);
    const wrapper = createStubFilterInjector({ getStubToolNames: () => stubNames }, logger);

    const mockNext = createMockStreamFn();

    // Simulate existing onPayload that adds a field
    const existingOnPayload = vi.fn().mockImplementation((payload: unknown) => {
      const p = payload as Record<string, unknown>;
      return { ...p, injected: true };
    });

    const wrappedFn = wrapper(mockNext);
    wrappedFn("model", { systemPrompt: "", messages: [], tools: [] }, { onPayload: existingOnPayload });

    const enhancedOptions = mockNext.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = enhancedOptions.onPayload as (payload: unknown, model: unknown) => Promise<unknown>;

    const payload = {
      tools: [
        { name: "stub_tool", description: "Stub" },
        { name: "real_tool", description: "Real" },
      ],
    };

    const result = await onPayload(payload, { provider: "anthropic" }) as Record<string, unknown>;

    // Should have upstream's injected field
    expect(result.injected).toBe(true);
    // Should have filtered stub
    const tools = result.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("real_tool");
    // Upstream should have been called
    expect(existingOnPayload).toHaveBeenCalledOnce();
  });

  it("debug log fires only when removed > 0", async () => {
    const logger = createMockLogger();
    const stubNames = new Set(["nonexistent_stub"]);
    const wrapper = createStubFilterInjector({ getStubToolNames: () => stubNames }, logger);

    const mockNext = createMockStreamFn();
    const wrappedFn = wrapper(mockNext);
    wrappedFn("model", { systemPrompt: "", messages: [], tools: [] }, {});

    const enhancedOptions = mockNext.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = enhancedOptions.onPayload as (payload: unknown, model: unknown) => Promise<unknown>;

    // No matching stubs in tools array
    const payload = {
      tools: [
        { name: "read", description: "Read a file" },
      ],
    };

    await onPayload(payload, { provider: "anthropic" });
    expect(logger.debug).not.toHaveBeenCalled();

    // Now test with a matching stub
    const logger2 = createMockLogger();
    const stubNames2 = new Set(["read"]);
    const wrapper2 = createStubFilterInjector({ getStubToolNames: () => stubNames2 }, logger2);
    const mockNext2 = createMockStreamFn();
    const wrappedFn2 = wrapper2(mockNext2);
    wrappedFn2("model", { systemPrompt: "", messages: [], tools: [] }, {});

    const enhancedOptions2 = mockNext2.mock.calls[0][2] as Record<string, unknown>;
    const onPayload2 = enhancedOptions2.onPayload as (payload: unknown, model: unknown) => Promise<unknown>;

    await onPayload2({ tools: [{ name: "read", description: "Read" }] }, { provider: "anthropic" });
    expect(logger2.debug).toHaveBeenCalledOnce();
    expect(logger2.debug).toHaveBeenCalledWith(
      expect.objectContaining({ removed: 1, provider: "anthropic" }),
      expect.any(String),
    );
  });
});
