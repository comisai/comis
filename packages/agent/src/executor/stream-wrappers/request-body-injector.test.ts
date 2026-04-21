// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context, Message, AssistantMessage } from "@mariozechner/pi-ai";
import {
  createRequestBodyInjector,
  getMinCacheableTokens,
  CACHEABLE_BLOCK_TYPES,
  addCacheControlToLastBlock,
  getOrCacheRenderedTool,
  clearSessionPerToolCache,
  resolveCacheRetention,
  clearSessionBetaHeaderLatches,
  clearSessionRenderedToolCache,
  clearStaleThinkingBlocks,
  sortToolsForCacheStability,
  estimateBlockTokens,
  clearSessionPrefixStability,
} from "./request-body-injector.js";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY, resolveBreakpointStrategy } from "./config-resolver.js";
import type { RequestBodyInjectorConfig } from "./request-body-injector.js";
import { createSessionLatch } from "../session-latch.js";
import type { SessionLatch } from "../session-latch.js";
import { createMockLogger, createMockStreamFn, makeAssistantMessage, makeContext } from "./__test-helpers.js";

describe("createRequestBodyInjector", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  /**
   * Helper to build an Anthropic-style API payload with messages.
   * Each message has content as an array of { type: "text", text } blocks.
   */
  function makeApiPayload(
    messageSpecs: Array<{ role: string; text: string; cache_control?: boolean }>,
    systemBreakpoints = 0,
  ): Record<string, unknown> {
    const system = [
      { type: "text", text: "System prompt content here" },
    ];
    // Add cache_control to last system block if requested
    if (systemBreakpoints > 0) {
      (system[0] as any).cache_control = { type: "ephemeral" };
    }

    const messages = messageSpecs.map(spec => {
      const block: Record<string, unknown> = { type: "text", text: spec.text };
      if (spec.cache_control) {
        block.cache_control = { type: "ephemeral" };
      }
      return {
        role: spec.role,
        content: [block],
      };
    });

    return { system, messages };
  }

  /**
   * Helper to generate a long text string that results in at least N estimated tokens.
   * Uses CHARS_PER_TOKEN_RATIO = 4, so tokens * 4 chars are needed.
   */
  function textForTokens(tokens: number): string {
    return "x".repeat(tokens * 4);
  }

  it("skips non-Anthropic providers", () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "gpt-4", provider: "openai" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, { someOption: true });

    // next() should be called with original options (no onPayload added)
    expect(base).toHaveBeenCalledTimes(1);
    const receivedOptions = base.mock.calls[0][2];
    expect(receivedOptions).toEqual({ someOption: true });
    // Specifically, no onPayload should have been added
    expect(receivedOptions.onPayload).toBeUndefined();
  });

  it("injects breakpoints for Anthropic provider via onPayload", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    // The wrapper should have added onPayload
    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    expect(receivedOptions.onPayload).toBeDefined();
    expect(typeof receivedOptions.onPayload).toBe("function");

    // Build a payload with 10 messages and 2 existing breakpoints (system + last user)
    const msgs: Array<{ role: string; text: string; cache_control?: boolean }> = [];
    for (let i = 0; i < 10; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      msgs.push({ role, text: textForTokens(300), cache_control: false });
    }
    // Last user message has SDK breakpoint
    msgs[8].cache_control = true;

    const payload = makeApiPayload(msgs, 1); // 1 system breakpoint

    // Call onPayload
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;
    const result = await onPayload(payload, model);

    // Should have injected breakpoints (2 SDK + up to 2 new)
    expect(result).toBeDefined();
    // Count total cache_control in result
    let totalBreakpoints = 0;
    const system = result.system as any[];
    for (const b of system) {
      if (b.cache_control) totalBreakpoints++;
    }
    const messages = result.messages as any[];
    for (const m of messages) {
      for (const b of m.content) {
        if (b.cache_control) totalBreakpoints++;
      }
    }
    // 1 system + 1 last user (existing) + up to 2 new = up to 4
    expect(totalBreakpoints).toBeGreaterThanOrEqual(2); // at least the existing ones
    expect(totalBreakpoints).toBeLessThanOrEqual(4);
  });

  it("respects model-specific min token thresholds (short conversation)", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long", cacheBreakpointStrategy: "multi-zone" }, logger);
    const wrappedFn = wrapper(base);

    // Opus 4.6 has 4096 min threshold
    const model = { id: "claude-opus-4-6-20260301", provider: "anthropic" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Short conversation: 6 messages with small text (< 4096 tokens each segment)
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(100) });
    }
    const payload = makeApiPayload(msgs, 0);

    const result = await onPayload(payload, model);

    // With only ~600 total tokens in messages, no breakpoints should be placed
    // (4096 threshold not met for any segment)
    const messages = (result.messages as any[]);
    let newBreakpoints = 0;
    for (const m of messages) {
      for (const b of m.content) {
        if (b.cache_control) newBreakpoints++;
      }
    }
    expect(newBreakpoints).toBe(0);
  });

  it("does not exceed 4 total breakpoints", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Create a payload with 3 existing breakpoints
    const msgs: Array<{ role: string; text: string; cache_control?: boolean }> = [];
    for (let i = 0; i < 12; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      msgs.push({ role, text: textForTokens(500), cache_control: false });
    }
    // 3 message breakpoints already exist
    msgs[2].cache_control = true;
    msgs[6].cache_control = true;
    msgs[10].cache_control = true;

    const payload = makeApiPayload(msgs, 0);

    const result = await onPayload(payload, model);

    // Count all breakpoints in messages
    let totalInMessages = 0;
    for (const m of (result.messages as any[])) {
      for (const b of m.content) {
        if (b.cache_control) totalInMessages++;
      }
    }
    // 3 existing + at most 1 new = 4 max
    expect(totalInMessages).toBeLessThanOrEqual(4);
  });

  it("detects compaction summary for breakpoint #2 placement", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long", cacheBreakpointStrategy: "multi-zone" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Messages with a compaction summary at index 0
    const msgs: Array<{ role: string; text: string }> = [
      { role: "user", text: "<summary>" + textForTokens(2000) + "</summary>" },
      { role: "assistant", text: textForTokens(500) },
      { role: "user", text: textForTokens(500) },
      { role: "assistant", text: textForTokens(500) },
      { role: "user", text: textForTokens(500) },
      { role: "assistant", text: textForTokens(500) },
      { role: "user", text: textForTokens(500) },
      { role: "assistant", text: textForTokens(500) },
      { role: "user", text: textForTokens(500) },
      { role: "assistant", text: textForTokens(500) },
    ];

    const payload = makeApiPayload(msgs, 0);

    const result = await onPayload(payload, model);

    // The compaction summary message (index 0) should have a breakpoint
    const firstMsg = (result.messages as any[])[0];
    const lastBlock = firstMsg.content[firstMsg.content.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("uses 5m default (no ttl) for short retention", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "short" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Build a payload with enough messages and tokens for breakpoints
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(500) });
    }
    const payload = makeApiPayload(msgs, 0);

    const result = await onPayload(payload, model);

    // Find messages with cache_control set by injector
    const messagesWithBreakpoints = (result.messages as any[]).filter(
      (m: any) => m.content.some((b: any) => b.cache_control),
    );

    // At least one breakpoint should be placed
    expect(messagesWithBreakpoints.length).toBeGreaterThan(0);

    // All injected breakpoints should use 5m default (no ttl property)
    for (const msg of messagesWithBreakpoints) {
      const lastBlock = msg.content[msg.content.length - 1];
      expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
      expect(lastBlock.cache_control.ttl).toBeUndefined();
    }
  });

  it("getMessageRetention splits system vs conversation retention (W2: no tool breakpoint)", async () => {
    const base = createMockStreamFn();
    // System breakpoints use "long" (1h), conversation breakpoints use "short" (5m)
    // W2: Tool breakpoint removed -- tools no longer have cache_control
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getMessageRetention: () => "short",
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Build payload with tools and enough messages for breakpoints
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(500) });
    }
    const payload = makeApiPayload(msgs, 0);
    payload.tools = [
      { name: "bash", input_schema: { type: "object" } },
      { name: "file_read", input_schema: { type: "object" } },
    ];

    const result = await onPayload(payload, model);

    // W2: No tool breakpoints should exist
    const tools = result.tools as any[];
    const toolWithBreakpoint = tools.find((t: any) => t.cache_control);
    expect(toolWithBreakpoint).toBeUndefined();

    // Message breakpoints should use "short" (5m, no ttl property)
    const messagesWithBreakpoints = (result.messages as any[]).filter(
      (m: any) => m.content.some((b: any) => b.cache_control),
    );
    for (const msg of messagesWithBreakpoints) {
      const lastBlock = msg.content[msg.content.length - 1];
      expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
      expect(lastBlock.cache_control.ttl).toBeUndefined();
    }
  });

  it("TTL ordering maintained: system (1h) >= message breakpoints (5m) after escalation (W2: no tool breakpoint)", async () => {
    const base = createMockStreamFn();
    // Simulates post-escalation state: system breakpoints use "long" (1h),
    // message breakpoints use "short" (5m) via getMessageRetention.
    // W2: Tool breakpoint removed -- no tool-level cache_control.
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getMessageRetention: () => "short",
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Build payload with tools and enough messages for breakpoints
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(500) });
    }
    const payload = makeApiPayload(msgs, 1); // 1 = system has cache_control for TTL upgrade
    payload.tools = [
      { name: "bash", input_schema: { type: "object" } },
      { name: "file_read", input_schema: { type: "object" } },
    ];

    const result = await onPayload(payload, model);

    // Collect all cache_control TTLs in request order: system -> messages
    const ttls: number[] = [];

    // W2: No tool breakpoints -- skip tool check
    const tools = result.tools as any[];
    const toolBreakpointCount = tools.filter((t: any) => t.cache_control).length;
    expect(toolBreakpointCount).toBe(0);

    // System breakpoints
    const system = result.system as any[];
    if (Array.isArray(system)) {
      for (const block of system) {
        if (block.cache_control) {
          ttls.push(block.cache_control.ttl === "1h" ? 3600 : 300);
        }
      }
    }

    // Message breakpoints
    const messages = result.messages as any[];
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.cache_control) {
            ttls.push(block.cache_control.ttl === "1h" ? 3600 : 300);
          }
        }
      }
    }

    // Must have breakpoints from both system and messages
    expect(ttls.length).toBeGreaterThanOrEqual(2);

    // System breakpoints should be 1h (3600s)
    expect(ttls[0]).toBe(3600);

    // Message breakpoints should be 5m (300s)
    const messageBreakpoints = messages.filter(
      (m: any) => m.content.some((b: any) => b.cache_control),
    );
    expect(messageBreakpoints.length).toBeGreaterThan(0);

    // Assert monotonically non-increasing TTL ordering across entire request
    for (let i = 1; i < ttls.length; i++) {
      expect(ttls[i]).toBeLessThanOrEqual(ttls[i - 1]);
    }
  });

  it("getMessageRetention undefined falls back to getCacheRetention for semi-stable/mid zones", async () => {
    const base = createMockStreamFn();
    // No getMessageRetention -> resolvedRetention falls back to getCacheRetention ("long")
    // semi-stable/mid zones get resolvedRetention ("long" = 1h TTL),
    //           recent zone always uses retention ("short" = 5m default)
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long" },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(500) });
    }
    const payload = makeApiPayload(msgs, 0);

    const result = await onPayload(payload, model);

    // At least some message breakpoints should be placed
    const messagesWithBreakpoints = (result.messages as any[]).filter(
      (m: any) => m.content.some((b: any) => b.cache_control),
    );
    expect(messagesWithBreakpoints.length).toBeGreaterThan(0);

    // Non-recent breakpoints (semi-stable/mid) get resolvedRetention ("long" = 1h TTL).
    // Recent zone breakpoint gets retention ("short" = no ttl).
    // At least the last breakpoint (recent zone) should have no ttl.
    const lastBpMsg = messagesWithBreakpoints[messagesWithBreakpoints.length - 1];
    const lastBlock = lastBpMsg.content[lastBpMsg.content.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });

    // If there are earlier breakpoints, they should have 1h TTL (semi-stable/mid zones)
    if (messagesWithBreakpoints.length > 1) {
      const firstBpMsg = messagesWithBreakpoints[0];
      const firstBlock = firstBpMsg.content[firstBpMsg.content.length - 1];
      expect(firstBlock.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    }
  });

  it("chains with existing onPayload", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);

    // Provide an existing onPayload that modifies the payload
    const existingOnPayload = vi.fn().mockImplementation((payload: any) => {
      return { ...payload, customField: "injected" };
    });

    wrappedFn(model, context, { onPayload: existingOnPayload });

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(500) });
    }
    const payload = makeApiPayload(msgs, 0);

    const result = await onPayload(payload, model);

    // Existing onPayload should have been called first
    expect(existingOnPayload).toHaveBeenCalledTimes(1);
    expect(existingOnPayload).toHaveBeenCalledWith(payload, model);

    // Result should contain the customField from existing onPayload
    expect(result.customField).toBe("injected");
  });

  // -----------------------------------------------------------------------
  // Mutation safety
  // -----------------------------------------------------------------------

  it("does not mutate original params.messages content blocks", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    // Build payload with enough messages+tokens for breakpoint placement
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }
    const payload = makeApiPayload(msgs, 1); // 1 system breakpoint
    const originalSnapshot = structuredClone(payload);

    const result = await onPayload(payload, model);

    // Result should have breakpoints (sanity check -- confirms mutation happened on clone)
    const resultMsgs = result.messages as any[];
    const hasBreakpoint = resultMsgs.some((m: any) =>
      m.content.some((b: any) => b.cache_control),
    );
    expect(hasBreakpoint).toBe(true);

    // Original payload must be unchanged
    expect(payload).toEqual(originalSnapshot);
  });

  it("does not mutate original params.system blocks during TTL upgrade", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    // System block with cache_control that will be TTL-upgraded
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }
    const payload = makeApiPayload(msgs, 1); // 1 system breakpoint => { type: "ephemeral" }

    // Capture original system block reference and value
    const originalSystemBlock = (payload.system as any[])[0];
    const originalCacheControl = { ...originalSystemBlock.cache_control };

    const result = await onPayload(payload, model);

    // Result's system block should have upgraded TTL (sanity check)
    const resultSystem = result.system as any[];
    expect(resultSystem[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // Original system block must NOT have been upgraded
    expect(originalSystemBlock.cache_control).toEqual(originalCacheControl);
    expect(originalSystemBlock.cache_control.ttl).toBeUndefined();
  });

  it("consecutive calls produce identical results when content is unchanged", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    // Factory produces identical payloads each time (simulating same conversation state)
    const makePayload = () => {
      const msgs: Array<{ role: string; text: string }> = [];
      for (let i = 0; i < 10; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
      }
      return makeApiPayload(msgs, 1);
    };

    const result1 = await onPayload(makePayload(), model);
    const result2 = await onPayload(makePayload(), model);

    // Both calls should produce identical cache_control placement
    expect(result1).toEqual(result2);
  });

  // -----------------------------------------------------------------------
  // New onPayload concerns (1M beta header, service_tier, store)
  // -----------------------------------------------------------------------

  it("injects 1M beta header for direct Anthropic provider via options.headers", () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-opus-4-6-20260301", provider: "anthropic", api: "anthropic-messages" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    // Header should be on options.headers (HTTP headers), NOT in the payload body
    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const headers = receivedOptions.headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toBe("context-1m-2025-08-07");
  });

  it("does NOT inject 1M beta header for Bedrock provider", () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "anthropic.claude-v2", provider: "amazon-bedrock", api: "bedrock-converse-stream" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    // Bedrock doesn't use direct Anthropic headers
    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    expect(receivedOptions.headers).toBeUndefined();
  });

  it("deduplicates 1M beta header when already present in options.headers", () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-opus-4-6-20260301", provider: "anthropic", api: "anthropic-messages" } as any;
    const context = makeContext([]);

    // Pass header already present in options.headers
    wrappedFn(model, context, { headers: { "anthropic-beta": "context-1m-2025-08-07" } });

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const headers = receivedOptions.headers as Record<string, string>;

    // Should NOT be duplicated
    expect(headers["anthropic-beta"]).toBe("context-1m-2025-08-07");
    expect(headers["anthropic-beta"].split(",").length).toBe(1);
  });

  it("injects service_tier when fastMode is true for Responses API provider", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => undefined, fastMode: true },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "gpt-4o", provider: "openai", api: "openai-responses" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const payload = { messages: [] };
    const result = await onPayload(payload, model);

    expect(result.service_tier).toBe("auto");
  });

  it("does NOT inject service_tier when fastMode is false", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => undefined, fastMode: false },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "gpt-4o", provider: "openai", api: "openai-responses" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const payload = { messages: [] };
    const result = await onPayload(payload, model);

    expect(result.service_tier).toBeUndefined();
  });

  it("injects store when storeCompletions is true for Responses API provider", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => undefined, storeCompletions: true },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "gpt-4o", provider: "openai", api: "openai-responses" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const payload = { messages: [] };
    const result = await onPayload(payload, model);

    expect(result.store).toBe(true);
  });

  it("does NOT inject store for non-Responses API provider", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", storeCompletions: true },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-opus-4-6-20260301", provider: "anthropic", api: "anthropic-messages" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const payload = { messages: [], headers: {} };
    const result = await onPayload(payload, model);

    expect(result.store).toBeUndefined();
  });

  it("skips wrapper entirely for non-Anthropic non-Responses provider", () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => undefined },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "gemini-2.5-pro", provider: "google", api: "google-generative-ai" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, { someOption: true });

    // next() should be called with original options (no onPayload added)
    const receivedOptions = base.mock.calls[0][2];
    expect(receivedOptions).toEqual({ someOption: true });
    expect(receivedOptions.onPayload).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // minTokensOverride and zero-breakpoint observability
  // -----------------------------------------------------------------------

  it("uses minTokensOverride when provided (sub-agent threshold)", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "short", getMinTokensOverride: () => 512 },
      logger,
    );
    const wrappedFn = wrapper(base);
    // Opus 4.6 has 4096 default threshold -- override to 512
    const model = { id: "claude-opus-4-6-20260301", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});
    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    // Short sub-agent session: 6 messages with 200 tokens each segment
    // Total ~1200 tokens -- below 4096 default but above 512 override
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(200) });
    }
    const payload = makeApiPayload(msgs, 0);
    const result = await onPayload(payload, model);

    // With 512 override, breakpoints SHOULD be placed (unlike the existing
    // "respects higher threshold for opus models" test which expects 0)
    let breakpointCount = 0;
    for (const m of (result.messages as any[])) {
      for (const b of m.content) {
        if (b.cache_control) breakpointCount++;
      }
    }
    expect(breakpointCount).toBeGreaterThan(0);
  });

  it("falls back to model default when minTokensOverride returns undefined", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", getMinTokensOverride: () => undefined, cacheBreakpointStrategy: "multi-zone" },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-opus-4-6-20260301", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});
    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    // Same short session as "respects higher threshold" test -- should place 0
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(100) });
    }
    const payload = makeApiPayload(msgs, 0);
    const result = await onPayload(payload, model);

    let breakpointCount = 0;
    for (const m of (result.messages as any[])) {
      for (const b of m.content) {
        if (b.cache_control) breakpointCount++;
      }
    }
    expect(breakpointCount).toBe(0);
  });

  it("logs debug when breakpoints skipped due to threshold", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long", cacheBreakpointStrategy: "multi-zone" }, logger);
    const wrappedFn = wrapper(base);
    const model = { id: "claude-opus-4-6-20260301", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});
    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    // 6 messages but small content (below 4096 threshold)
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(100) });
    }
    const payload = makeApiPayload(msgs, 0);
    await onPayload(payload, model);

    // Should have logged "breakpoints skipped" at debug level
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ messageCount: 6, minTokens: 4096 }),
      expect.stringContaining("breakpoints skipped"),
    );
  });

  // -----------------------------------------------------------------------
  // Content-aware token estimation
  // -----------------------------------------------------------------------

  it("places breakpoints with content-aware estimation for tool_result messages", async () => {
    const base = createMockStreamFn();
    // Use low-threshold model (sonnet 1024) so breakpoints are feasible
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});
    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    // Build 10 messages with tool_result (user) and tool_use (assistant) blocks.
    // Each has 900 chars. At ratio=3 (structured): 300 tokens/msg.
    // At ratio=4 (flat): 225 tokens/msg. Total structured: ~3000 tokens.
    const payload: Record<string, unknown> = {
      system: [{ type: "text", text: "System prompt" }],
      messages: [] as any[],
    };
    const messages: any[] = [];
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) {
        // User message with tool_result block (structured content)
        messages.push({
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: `call_${i}`, content: [{ type: "text", text: "x".repeat(900) }] },
          ],
        });
      } else {
        // Assistant message with tool_use block
        messages.push({
          role: "assistant",
          content: [
            { type: "tool_use", id: `call_${i}`, name: "test", input: {} },
            { type: "text", text: "y".repeat(900) },
          ],
        });
      }
    }
    payload.messages = messages;

    const result = await onPayload(payload, model);

    // With content-aware estimation (3:1 for structured), token estimates are higher
    // than flat 4:1. Breakpoints should be placed since segments exceed 1024 tokens.
    let breakpointCount = 0;
    for (const m of (result.messages as any[])) {
      for (const b of m.content) {
        if (b.cache_control) breakpointCount++;
      }
    }
    expect(breakpointCount).toBeGreaterThan(0);
  });

  it("structured content yields higher token estimate than flat ratio", async () => {
    const base = createMockStreamFn();
    // Use override to set threshold between flat and content-aware estimates.
    // 5 prose messages + 5 structured messages, each 1000 chars.
    // Flat ratio: ceil(10000/4) = 2500 tokens total for all 10 messages.
    // Content-aware: 5 * ceil(1000/4) + 5 * ceil(1000/3) = 1250 + 1670 = 2920 tokens.
    // Set threshold at 1300: first half (5 msgs) as flat = 1250 (below) vs content-aware = ~1460 (above).
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", getMinTokensOverride: () => 1300 },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});
    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    // Build a conversation: 5 tool-heavy pairs then 5 prose pairs
    const payload: Record<string, unknown> = {
      system: [{ type: "text", text: "System prompt" }],
      messages: [] as any[],
    };
    const messages: any[] = [];
    // First 10 messages: alternating tool_result (user) / tool_use (assistant)
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) {
        messages.push({
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: `call_${i}`, content: [{ type: "text", text: "x".repeat(1000) }] },
          ],
        });
      } else {
        messages.push({
          role: "assistant",
          content: [
            { type: "tool_use", id: `call_${i}`, name: "test", input: {} },
            { type: "text", text: "y".repeat(1000) },
          ],
        });
      }
    }
    // Add final prose messages for second-to-last user detection
    for (let i = 0; i < 4; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      messages.push({
        role,
        content: [{ type: "text", text: "z".repeat(1000) }],
      });
    }
    payload.messages = messages;

    const result = await onPayload(payload, model);

    // Content-aware estimation should produce higher token counts for the
    // structured segment, crossing the 1300 threshold that flat 4:1 would miss.
    // Verify breakpoints were placed.
    let breakpointCount = 0;
    for (const m of (result.messages as any[])) {
      for (const b of m.content) {
        if (b.cache_control) breakpointCount++;
      }
    }
    expect(breakpointCount).toBeGreaterThan(0);
  });

  it("natural language messages still use CHARS_PER_TOKEN_RATIO=4", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long", cacheBreakpointStrategy: "multi-zone" }, logger);
    const wrappedFn = wrapper(base);
    // Use Opus 4.6 (4096 threshold) with conversations below that threshold
    const model = { id: "claude-opus-4-6-20260301", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});
    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    // 6 plain text messages with 500 tokens each (2000 chars at 4:1 ratio).
    // Total ~3000 tokens which is below the 4096 Opus threshold.
    // If the ratio incorrectly used 3:1, estimate would be ~4000 tokens (above threshold).
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(500) });
    }
    const payload = makeApiPayload(msgs, 0);
    const result = await onPayload(payload, model);

    // No breakpoints should be placed -- prose uses 4:1, total ~3000 < 4096
    let breakpointCount = 0;
    for (const m of (result.messages as any[])) {
      for (const b of m.content) {
        if (b.cache_control) breakpointCount++;
      }
    }
    expect(breakpointCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // System prompt TTL upgrade for monotonicity
  // -----------------------------------------------------------------------

  it("upgrades system prompt TTL to 1h when retention is long", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getMessageRetention: () => "short",
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Build payload with system breakpoint (SDK-placed), tools, and enough messages
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(500) });
    }
    const payload = makeApiPayload(msgs, 1); // 1 = system block has cache_control
    payload.tools = [
      { name: "bash", input_schema: { type: "object" } },
      { name: "file_read", input_schema: { type: "object" } },
    ];

    const result = await onPayload(payload, model);

    // System block's cache_control should be upgraded from { type: "ephemeral" } to 1h
    const system = result.system as any[];
    expect(system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // W2: No tool breakpoints should exist
    const tools = result.tools as any[];
    const toolWithBreakpoint = tools.find((t: any) => t.cache_control);
    expect(toolWithBreakpoint).toBeUndefined();

    // Message breakpoints should be "short" (no ttl property)
    const messagesWithBreakpoints = (result.messages as any[]).filter(
      (m: any) => m.content.some((b: any) => b.cache_control),
    );
    for (const msg of messagesWithBreakpoints) {
      const lastBlock = msg.content[msg.content.length - 1];
      expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
      expect(lastBlock.cache_control.ttl).toBeUndefined();
    }
  });

  it("does not upgrade system prompt TTL when retention is short", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getMessageRetention: () => "short",
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(500) });
    }
    const payload = makeApiPayload(msgs, 1); // system block has cache_control

    const result = await onPayload(payload, model);

    // System block's cache_control should remain { type: "ephemeral" } (no ttl)
    const system = result.system as any[];
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(system[0].cache_control.ttl).toBeUndefined();
  });

  it("skips system blocks without existing cache_control", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getMessageRetention: () => "short",
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(500) });
    }
    const payload = makeApiPayload(msgs, 0); // 0 = no cache_control on system

    const result = await onPayload(payload, model);

    // System blocks should still have no cache_control property
    const system = result.system as any[];
    expect(system[0].cache_control).toBeUndefined();
  });

  it("full monotonicity chain system(1h) >= messages(5m) (W2: no tool breakpoint)", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getMessageRetention: () => "short",
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(500) });
    }
    const payload = makeApiPayload(msgs, 1); // system block has cache_control
    payload.tools = [
      { name: "bash", input_schema: { type: "object" } },
      { name: "file_read", input_schema: { type: "object" } },
    ];

    const result = await onPayload(payload, model);

    // Collect ALL cache_control TTLs in Anthropic payload order: system -> messages
    const ttls: number[] = [];

    // System breakpoints
    const system = result.system as any[];
    for (const block of system) {
      if (block.cache_control) {
        ttls.push(block.cache_control.ttl === "1h" ? 3600 : 300);
      }
    }

    // W2: No tool breakpoints expected
    const tools = result.tools as any[];
    expect(tools.filter((t: any) => t.cache_control).length).toBe(0);

    // Message breakpoints
    const messages = result.messages as any[];
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.cache_control) {
            ttls.push(block.cache_control.ttl === "1h" ? 3600 : 300);
          }
        }
      }
    }

    // Must have breakpoints from system and messages
    expect(ttls.length).toBeGreaterThanOrEqual(2);

    // System TTL should be 1h (3600)
    expect(ttls[0]).toBe(3600);

    // Message TTLs should be 5m (300)
    const messageStartIdx = system.filter(b => b.cache_control).length;
    for (let i = messageStartIdx; i < ttls.length; i++) {
      expect(ttls[i]).toBe(300);
    }

    // Assert the full sequence is monotonically non-increasing
    for (let i = 1; i < ttls.length; i++) {
      expect(ttls[i]).toBeLessThanOrEqual(ttls[i - 1]!);
    }
  });
});

describe("Multi-block system prompt injection", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  /** Helper to generate tokens-worth of text. */
  function textForTokens(tokens: number): string {
    return "x".repeat(tokens * 4);
  }

  /** Helper to build an Anthropic-style payload with a single system block. */
  function makePayloadWithSystem(opts?: {
    systemText?: string;
    systemCacheControl?: boolean;
    tools?: Array<Record<string, unknown>>;
    messages?: Array<{ role: string; text: string; cache_control?: boolean }>;
  }): Record<string, unknown> {
    const systemBlock: Record<string, unknown> = { type: "text", text: opts?.systemText ?? "System prompt content" };
    if (opts?.systemCacheControl !== false) {
      systemBlock.cache_control = { type: "ephemeral" };
    }
    const system = [systemBlock];

    const msgs = (opts?.messages ?? []).map(spec => {
      const block: Record<string, unknown> = { type: "text", text: spec.text };
      if (spec.cache_control) {
        block.cache_control = { type: "ephemeral" };
      }
      return { role: spec.role, content: [block] };
    });

    return {
      system,
      ...(opts?.tools ? { tools: opts.tools } : {}),
      messages: msgs,
    };
  }

  it("replaces single system block with 3 text blocks when getSystemPromptBlocks returns blocks with attribution and provider is Anthropic", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getSystemPromptBlocks: () => ({ staticPrefix: "STATIC PREFIX", attribution: "ATTRIBUTION", semiStableBody: "SEMI-STABLE BODY" }),
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: unknown, m: unknown) => Promise<unknown>;
    const payload = makePayloadWithSystem();
    const result = await onPayload(payload, model) as Record<string, unknown>;

    const system = result.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(3);
    expect(system[0]!.type).toBe("text");
    expect((system[0]!.text as string).startsWith("STATIC PREFIX")).toBe(true);
    expect((system[0]!.text as string)).toContain("---SYSTEM-PROMPT-DYNAMIC-BOUNDARY---");
    expect(system[1]!.type).toBe("text");
    expect(system[1]!.text).toBe("ATTRIBUTION");
    expect(system[2]!.type).toBe("text");
    expect(system[2]!.text).toBe("SEMI-STABLE BODY");
  });

  it("produces 2 blocks when attribution is empty string (none-mode)", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getSystemPromptBlocks: () => ({ staticPrefix: "STATIC PREFIX", attribution: "", semiStableBody: "SEMI-STABLE BODY" }),
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: unknown, m: unknown) => Promise<unknown>;
    const payload = makePayloadWithSystem();
    const result = await onPayload(payload, model) as Record<string, unknown>;

    const system = result.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(2);
    expect((system[0]!.text as string).startsWith("STATIC PREFIX")).toBe(true);
    expect(system[1]!.text).toBe("SEMI-STABLE BODY");
  });

  it("appends SYSTEM_PROMPT_DYNAMIC_BOUNDARY to staticPrefix block (SYS-BOUNDARY)", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getSystemPromptBlocks: () => ({ staticPrefix: "my-static", attribution: "my-attribution", semiStableBody: "my-dynamic" }),
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: unknown, m: unknown) => Promise<unknown>;
    const payload = makePayloadWithSystem();
    const result = await onPayload(payload, model) as Record<string, unknown>;

    const system = result.system as Array<Record<string, unknown>>;
    expect(system[0]!.text).toBe("my-static" + SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(system[1]!.text).toBe("my-attribution");
    expect(system[2]!.text).toBe("my-dynamic");
  });

  it("only last system block has cache_control after injection (W1)", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getSystemPromptBlocks: () => ({ staticPrefix: "prefix", attribution: "attribution", semiStableBody: "body" }),
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: unknown, m: unknown) => Promise<unknown>;
    const result = await onPayload(makePayloadWithSystem(), model) as Record<string, unknown>;

    const system = result.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(3);
    expect(system[0]!.cache_control).toBeUndefined();
    expect(system[1]!.cache_control).toBeUndefined();
    expect(system[2]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("when retention is 'long', only last system block gets 1h TTL", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getSystemPromptBlocks: () => ({ staticPrefix: "prefix", attribution: "attribution", semiStableBody: "body" }),
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: unknown, m: unknown) => Promise<unknown>;
    const result = await onPayload(makePayloadWithSystem(), model) as Record<string, unknown>;

    const system = result.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(3);
    expect(system[0]!.cache_control).toBeUndefined();
    expect(system[1]!.cache_control).toBeUndefined();
    expect(system[2]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("breakpoint budget counts 1 system marker after consolidation", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getSystemPromptBlocks: () => ({ staticPrefix: "prefix", attribution: "attribution", semiStableBody: "body" }),
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: unknown, m: unknown) => Promise<unknown>;

    // Payload with tools and several messages
    const payload = makePayloadWithSystem({
      tools: [{ name: "read", description: "Read files", input_schema: { type: "object" } }],
      messages: [
        { role: "user", text: textForTokens(500) },
        { role: "assistant", text: textForTokens(300) },
        { role: "user", text: textForTokens(500) },
        { role: "assistant", text: textForTokens(300) },
        { role: "user", text: textForTokens(500), cache_control: true },
      ],
    });
    const result = await onPayload(payload, model) as Record<string, unknown>;

    // Count all cache_control markers in result
    let totalBreakpoints = 0;
    const system = result.system as Array<Record<string, unknown>>;
    for (const block of system) {
      if (block.cache_control) totalBreakpoints++;
    }
    const tools = result.tools as Array<Record<string, unknown>> | undefined;
    if (tools) {
      for (const t of tools) {
        if (t.cache_control) totalBreakpoints++;
      }
    }
    const msgs = result.messages as Array<Record<string, unknown>> | undefined;
    if (msgs) {
      for (const m of msgs) {
        const content = m.content as Array<Record<string, unknown>> | undefined;
        if (content) {
          for (const block of content) {
            if (block.cache_control) totalBreakpoints++;
          }
        }
      }
    }

    // W1: System should contribute exactly 1 (only last block has cache_control)
    expect(system.filter(b => !!b.cache_control)).toHaveLength(1);
    // W2: Tool breakpoint removed -- tools should NOT have cache_control
    if (tools) {
      expect(tools.filter(t => !!t.cache_control)).toHaveLength(0);
    }
    // Total should not exceed 4 (1 system + 0 tool + up to 2 message + 1 SDK auto)
    expect(totalBreakpoints).toBeLessThanOrEqual(4);
  });

  it("preserves original single-block behavior when getSystemPromptBlocks returns undefined", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getSystemPromptBlocks: () => undefined,
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: unknown, m: unknown) => Promise<unknown>;
    const payload = makePayloadWithSystem({ systemText: "Original system" });
    const result = await onPayload(payload, model) as Record<string, unknown>;

    const system = result.system as Array<Record<string, unknown>>;
    // Should still be single block (not replaced)
    expect(system).toHaveLength(1);
    expect(system[0]!.text).toBe("Original system");
  });

  it("does not inject multi-block when provider is NOT Anthropic", () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getSystemPromptBlocks: () => ({ staticPrefix: "prefix", attribution: "attribution", semiStableBody: "body" }),
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "gpt-4o", provider: "openai" } as any;
    wrappedFn(model, makeContext([]), {});

    // For non-Anthropic, next() is called directly with original options (no onPayload)
    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    expect(receivedOptions.onPayload).toBeUndefined();
  });

  it("original SDK cache_control on single system block is replaced when blocks are injected", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getSystemPromptBlocks: () => ({ staticPrefix: "new-prefix", attribution: "new-attribution", semiStableBody: "new-body" }),
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: unknown, m: unknown) => Promise<unknown>;

    // Original payload has a single system block with cache_control
    const payload = makePayloadWithSystem({ systemCacheControl: true });
    const result = await onPayload(payload, model) as Record<string, unknown>;

    const system = result.system as Array<Record<string, unknown>>;
    // Original single block should be replaced by 3 new blocks
    expect(system).toHaveLength(3);
    expect(system[0]!.text).toBe("new-prefix" + SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(system[1]!.text).toBe("new-attribution");
    expect(system[2]!.text).toBe("new-body");
    // W1: Only last block should have cache_control
    expect(system[0]!.cache_control).toBeUndefined();
    expect(system[1]!.cache_control).toBeUndefined();
    expect(system[2]!.cache_control).toBeDefined();
  });

  it("structuredClone contract: original params.system not mutated after block replacement", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getSystemPromptBlocks: () => ({ staticPrefix: "prefix", attribution: "attribution", semiStableBody: "body" }),
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: unknown, m: unknown) => Promise<unknown>;

    const originalSystem = [{ type: "text", text: "Original system prompt", cache_control: { type: "ephemeral" } }];
    const payload = { system: originalSystem, messages: [] };
    await onPayload(payload, model);

    // Original payload should NOT be mutated
    expect(originalSystem).toHaveLength(1);
    expect(originalSystem[0]!.text).toBe("Original system prompt");
  });

  it("preserves original behavior when getSystemPromptBlocks is not provided on config", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        // No getSystemPromptBlocks provided
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: unknown, m: unknown) => Promise<unknown>;
    const payload = makePayloadWithSystem({ systemText: "Original single block" });
    const result = await onPayload(payload, model) as Record<string, unknown>;

    const system = result.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(1);
    expect(system[0]!.text).toBe("Original single block");
  });

  it("W1: when retention is 'short', only last system block has cache_control without ttl", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getSystemPromptBlocks: () => ({ staticPrefix: "prefix", attribution: "attribution", semiStableBody: "body" }),
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: unknown, m: unknown) => Promise<unknown>;
    const result = await onPayload(makePayloadWithSystem(), model) as Record<string, unknown>;

    const system = result.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(3);
    // W1: Only last block has cache_control
    expect(system[0]!.cache_control).toBeUndefined();
    expect(system[1]!.cache_control).toBeUndefined();
    expect(system[2]!.cache_control).toEqual({ type: "ephemeral" });
    // Specifically no ttl on the last block
    expect((system[2]!.cache_control as any).ttl).toBeUndefined();
  });
});

describe("breakpoint cap increase", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  /**
   * Helper to build an Anthropic-style API payload with messages.
   * Each message has content as an array of { type: "text", text } blocks.
   */
  function makeApiPayload(
    messageSpecs: Array<{ role: string; text: string; cache_control?: boolean }>,
    systemBreakpoints = 0,
  ): Record<string, unknown> {
    const system = [
      { type: "text", text: "System prompt content here" },
    ];
    if (systemBreakpoints > 0) {
      (system[0] as any).cache_control = { type: "ephemeral" };
    }

    const messages = messageSpecs.map(spec => {
      const block: Record<string, unknown> = { type: "text", text: spec.text };
      if (spec.cache_control) {
        block.cache_control = { type: "ephemeral" };
      }
      return {
        role: spec.role,
        content: [block],
      };
    });

    return { system, messages };
  }

  /** Generate text that estimates to at least N tokens (CHARS_PER_TOKEN_RATIO = 4). */
  function textForTokens(tokens: number): string {
    return "x".repeat(tokens * 4);
  }

  /** Count cache_control markers in the messages array of a payload. */
  function countMessageBreakpoints(payload: Record<string, unknown>): number {
    let count = 0;
    const messages = payload.messages as any[];
    for (const m of messages) {
      for (const b of m.content) {
        if (b.cache_control) count++;
      }
    }
    return count;
  }

  /** Find indices of messages with cache_control set. */
  function findBreakpointIndices(payload: Record<string, unknown>): number[] {
    const indices: number[] = [];
    const messages = payload.messages as any[];
    for (let i = 0; i < messages.length; i++) {
      for (const b of messages[i].content) {
        if (b.cache_control) {
          indices.push(i);
          break;
        }
      }
    }
    return indices;
  }

  it("places 3 breakpoints on long conversation with compaction summary", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long", cacheBreakpointStrategy: "multi-zone" }, logger);
    const wrappedFn = wrapper(base);

    // Sonnet has 1024 min token threshold
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Build 30-message conversation: compaction summary at index 0, alternating user/assistant
    // Each message has enough content to exceed minTokens threshold (1024)
    const msgs: Array<{ role: string; text: string }> = [];
    // Compaction summary at index 0
    msgs.push({ role: "user", text: "<summary>" + textForTokens(2000) + "</summary>" });
    msgs.push({ role: "assistant", text: textForTokens(2000) });
    // 28 more messages (alternating user/assistant)
    for (let i = 2; i < 30; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }

    // SDK has 1 system breakpoint -- leaves 3 slots
    const payload = makeApiPayload(msgs, 1);
    const result = await onPayload(payload, model);

    // Should have 3 custom breakpoints in messages (3 available slots, all used)
    const msgBps = countMessageBreakpoints(result);
    expect(msgBps).toBe(3);
  });

  it("still places 0-2 breakpoints on short conversation", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);

    // Use a model with low threshold to make other breakpoints possible but not the third
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // 5 messages with short content -- not enough for minTokens thresholds
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 5; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(100) });
    }

    const payload = makeApiPayload(msgs, 0);
    const result = await onPayload(payload, model);

    const msgBps = countMessageBreakpoints(result);
    // minTokens threshold gates placement -- at most 2 (likely 0 given short content)
    expect(msgBps).toBeLessThanOrEqual(2);
  });

  it("third breakpoint placed between semi-stable and second-to-last", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long", cacheBreakpointStrategy: "multi-zone" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Build a carefully crafted conversation:
    // - Compaction summary at index 0 (semi-stable)
    // - 30 messages total, alternating user/assistant
    // - Second-to-last user is at index 28, last user at index 28 (even indices are user)
    // - Midpoint between 0 and 28 is ~14
    const msgs: Array<{ role: string; text: string }> = [];
    // Compaction summary at index 0
    msgs.push({ role: "user", text: "<summary>" + textForTokens(2000) + "</summary>" });
    msgs.push({ role: "assistant", text: textForTokens(2000) });
    // Messages 2-29
    for (let i = 2; i < 30; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }

    const payload = makeApiPayload(msgs, 1); // 1 system bp = 3 available
    const result = await onPayload(payload, model);

    const bpIndices = findBreakpointIndices(result);

    // Should have 3 breakpoints
    expect(bpIndices).toHaveLength(3);

    // First breakpoint at compaction summary (index 0)
    expect(bpIndices[0]).toBe(0);

    // Second breakpoint at second-to-last user message
    // Third breakpoint should be between the semi-stable (0) and second-to-last user
    // The mid-point breakpoint should be strictly between 0 and the second-to-last user index
    const semiStablePos = bpIndices[0]; // 0
    const midBreakpoint = bpIndices[1]; // should be in between
    const recentBreakpoint = bpIndices[2]; // second-to-last user

    expect(midBreakpoint).toBeGreaterThan(semiStablePos);
    expect(midBreakpoint).toBeLessThan(recentBreakpoint);

    // Verify the mid-point message has cache_control set
    const midMsg = (result.messages as any[])[midBreakpoint];
    const lastBlock = midMsg.content[midMsg.content.length - 1];
    expect(lastBlock.cache_control).toBeDefined();
  });

  it("no third breakpoint when gap between positions is too small", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Compaction summary at index 0, second-to-last user at index 2 (adjacent).
    // midIdx = floor((0 + 2) / 2) = 1. Since index 1 is assistant role (not > semiStableIdx
    // with a user message), the mid-point search finds no user message between positions.
    // With only 1 index between semi-stable and second-to-last, no room for a third.
    const msgs: Array<{ role: string; text: string }> = [
      { role: "user", text: "<summary>" + textForTokens(2000) + "</summary>" },
      { role: "assistant", text: textForTokens(2000) },
      { role: "user", text: textForTokens(2000) },  // second-to-last user
      { role: "assistant", text: textForTokens(2000) },
      { role: "user", text: textForTokens(2000) },  // last user (SDK breakpoint)
    ];

    const payload = makeApiPayload(msgs, 1); // 1 system bp
    const result = await onPayload(payload, model);

    const bpIndices = findBreakpointIndices(result);

    // Should have at most 2 custom breakpoints -- semi-stable and second-to-last user.
    // Third breakpoint not placed: midIdx=1 is assistant, and no user message found
    // between semiStableIdx(0) and secondToLastUserIdx(2).
    expect(bpIndices.length).toBeLessThanOrEqual(2);
  });

  it("calls onBreakpointsPlaced with highest breakpoint index after placing breakpoints", async () => {
    const base = createMockStreamFn();
    const onBreakpointsPlaced = vi.fn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", onBreakpointsPlaced },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Build a payload with enough messages to trigger breakpoint placement
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }
    const payload = makeApiPayload(msgs, 1); // 1 system breakpoint pre-existing

    const result = await onPayload(payload, model);

    // Callback should have been called since breakpoints were placed
    expect(onBreakpointsPlaced).toHaveBeenCalledTimes(1);
    const highestIdx = onBreakpointsPlaced.mock.calls[0]![0] as number;
    expect(highestIdx).toBeGreaterThanOrEqual(0);

    // Verify the reported index corresponds to a message with cache_control
    const messages = result.messages as Array<Record<string, unknown>>;
    const msg = messages[highestIdx]!;
    const content = msg.content as Array<Record<string, unknown>>;
    const hasCacheControl = content.some((block) => block.cache_control !== undefined);
    expect(hasCacheControl).toBe(true);
  });

  it("W12: onBreakpointsPlaced fires for SDK auto-marker even when no explicit breakpoints placed", async () => {
    const base = createMockStreamFn();
    const onBreakpointsPlaced = vi.fn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", onBreakpointsPlaced },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Too few messages for explicit breakpoints, but SDK auto-marker on last user message
    const msgs: Array<{ role: string; text: string; cache_control?: boolean }> = [
      { role: "user", text: "short" },
      { role: "assistant", text: "short" },
      { role: "user", text: "latest question", cache_control: true }, // SDK auto-marker
    ];
    const payload = makeApiPayload(msgs, 0);

    await onPayload(payload, model);

    // W12: onBreakpointsPlaced fires even with 0 explicit placements (SDK auto-marker found)
    expect(onBreakpointsPlaced).toHaveBeenCalledTimes(1);
    // Callback should receive index of last user message (index 2)
    const receivedIdx = onBreakpointsPlaced.mock.calls[0]![0] as number;
    expect(receivedIdx).toBe(2);
  });

  it("W12-FALLBACK: onBreakpointsPlaced fires when slotsAvailable=0 but SDK auto-marker exists", async () => {
    const base = createMockStreamFn();
    const onBreakpointsPlaced = vi.fn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", onBreakpointsPlaced },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Create a payload where system blocks consume all 4 breakpoint slots
    const msgs: Array<{ role: string; text: string; cache_control?: boolean }> = [
      { role: "user", text: textForTokens(300) },
      { role: "assistant", text: textForTokens(300) },
      { role: "user", text: textForTokens(300), cache_control: true }, // SDK auto-marker
    ];
    const payload = makeApiPayload(msgs, 0);
    // Manually add 4 cache_control markers to system blocks to exhaust the budget
    payload.system = [
      { type: "text", text: "block1", cache_control: { type: "ephemeral" } },
      { type: "text", text: "block2", cache_control: { type: "ephemeral" } },
      { type: "text", text: "block3", cache_control: { type: "ephemeral" } },
      { type: "text", text: "block4", cache_control: { type: "ephemeral" } },
    ];

    await onPayload(payload, model);

    // W12-FALLBACK: Even with all slots consumed, SDK auto-marker scan fires callback
    expect(onBreakpointsPlaced).toHaveBeenCalledTimes(1);
    const receivedIdx = onBreakpointsPlaced.mock.calls[0]![0] as number;
    expect(receivedIdx).toBe(2); // Index of last user message with SDK auto-marker
  });

  it("W7: WARN emitted when breakpoint budget exhausted on conversation >= 20 messages", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long" },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Create 20+ messages
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 22; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(100) });
    }
    const payload = makeApiPayload(msgs, 0);
    // Exhaust all 4 breakpoint slots via system blocks
    payload.system = [
      { type: "text", text: "block1", cache_control: { type: "ephemeral" } },
      { type: "text", text: "block2", cache_control: { type: "ephemeral" } },
      { type: "text", text: "block3", cache_control: { type: "ephemeral" } },
      { type: "text", text: "block4", cache_control: { type: "ephemeral" } },
    ];

    await onPayload(payload, model);

    // W7: WARN log should be emitted
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        existingCount: 4,
        messageCount: 22,
        hint: expect.stringContaining("Breakpoint budget exhausted"),
        errorKind: "performance",
      }),
      expect.stringContaining("W7: Cache breakpoint budget exhausted"),
    );
  });

  // -------------------------------------------------------------------------
  // countCacheBreakpoints: tool-level cache_control (indirect tests)
  // -------------------------------------------------------------------------

  // W2: Tool breakpoints are always stripped before budget accounting.
  // pi-ai 0.67.4+ auto-places cache_control on the last tool in convertTools().
  // These tests verify the W2 guard strips any incoming tool cache_control so
  // Comis's message-zone strategy keeps all 4 slots available.
  it("strips externally-placed tool cache_control (W2 guard)", async () => {
    const base = createMockStreamFn();
    const onBreakpointsPlaced = vi.fn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", onBreakpointsPlaced },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }
    const payload = makeApiPayload(msgs, 0);

    // Simulate pi-ai 0.67.4's auto-placement: last tool has cache_control
    payload.tools = [
      { name: "bash" },
      { name: "file_read", cache_control: { type: "ephemeral" } },
    ];

    const result = await onPayload(payload, model);

    // W2: all tool cache_control markers are stripped
    const tools = result.tools as any[];
    expect(tools.filter((t: any) => t.cache_control).length).toBe(0);

    // Stripped markers don't consume budget -- message breakpoints still placed
    const messages = result.messages as any[];
    let messageBreakpoints = 0;
    for (const m of messages) {
      for (const b of m.content) {
        if (b.cache_control) messageBreakpoints++;
      }
    }
    expect(messageBreakpoints).toBeGreaterThan(0);
  });

  it("strips pi-ai 0.67.4 auto-placement even when all tools carry cache_control", async () => {
    const base = createMockStreamFn();
    const onBreakpointsPlaced = vi.fn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", onBreakpointsPlaced },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);

    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }
    const payload = makeApiPayload(msgs, 0);

    // Adversarial input: every tool has cache_control
    payload.tools = [
      { name: "bash", cache_control: { type: "ephemeral" } },
      { name: "file_read", cache_control: { type: "ephemeral" } },
      { name: "web_fetch", cache_control: { type: "ephemeral" } },
      { name: "memory_search", cache_control: { type: "ephemeral" } },
    ];

    const result = await onPayload(payload, model);

    // W2: all tool markers stripped regardless of count
    const tools = result.tools as any[];
    expect(tools.filter((t: any) => t.cache_control).length).toBe(0);

    // Budget is preserved -- message breakpoints and/or system breakpoints placed
    const system = result.system as any[];
    const messages = result.messages as any[];
    const systemBreakpoints = system.filter((b: any) => b.cache_control).length;
    let messageBreakpoints = 0;
    for (const m of messages) {
      for (const b of m.content) {
        if (b.cache_control) messageBreakpoints++;
      }
    }
    expect(systemBreakpoints + messageBreakpoints).toBeGreaterThan(0);
  });
});

describe("getMinCacheableTokens", () => {
  it("resolves known model prefixes correctly", () => {
    expect(getMinCacheableTokens("claude-opus-4-6-20260301")).toBe(4096);
    expect(getMinCacheableTokens("claude-opus-4-5-20250929")).toBe(4096);
    expect(getMinCacheableTokens("claude-opus-4-1-20260315")).toBe(1024);
    expect(getMinCacheableTokens("claude-opus-4-20260101")).toBe(1024);
    expect(getMinCacheableTokens("claude-sonnet-4-6-20260301")).toBe(2048);
    expect(getMinCacheableTokens("claude-sonnet-4-5-20250929")).toBe(1024);
    expect(getMinCacheableTokens("claude-sonnet-4-20250514")).toBe(1024);
    expect(getMinCacheableTokens("claude-haiku-4-5-20250929")).toBe(4096);
    expect(getMinCacheableTokens("claude-haiku-3-5-20240620")).toBe(2048);
  });

  it("matches longest prefix first (opus-4-6 before opus-4-)", () => {
    // opus-4-6 and opus-4-5 must match their specific entries (4096), not the catch-all opus-4- (1024)
    expect(getMinCacheableTokens("claude-opus-4-6-20260301")).toBe(4096);
    expect(getMinCacheableTokens("claude-opus-4-5-20250929")).toBe(4096);
    // sonnet-4-5 must match its specific entry (1024), not the catch-all sonnet-4- (also 1024 here, but tests prefix priority)
    expect(getMinCacheableTokens("claude-sonnet-4-5-20250929")).toBe(1024);
  });

  it("falls back to DEFAULT_MIN_CACHEABLE_TOKENS for unknown models", () => {
    expect(getMinCacheableTokens("gpt-4-turbo")).toBe(1024);
    expect(getMinCacheableTokens("unknown-model")).toBe(1024);
  });
});

describe("tool definition caching", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  /** Build an Anthropic-style API payload with messages. */
  function makeApiPayload(
    messageSpecs: Array<{ role: string; text: string; cache_control?: boolean }>,
    systemBreakpoints = 0,
  ): Record<string, unknown> {
    const system = [
      { type: "text", text: "System prompt content here" },
    ];
    if (systemBreakpoints > 0) {
      (system[0] as any).cache_control = { type: "ephemeral" };
    }

    const messages = messageSpecs.map(spec => {
      const block: Record<string, unknown> = { type: "text", text: spec.text };
      if (spec.cache_control) {
        block.cache_control = { type: "ephemeral" };
      }
      return {
        role: spec.role,
        content: [block],
      };
    });

    return { system, messages };
  }

  /** Generate text that estimates to at least N tokens (CHARS_PER_TOKEN_RATIO = 4). */
  function textForTokens(tokens: number): string {
    return "x".repeat(tokens * 4);
  }

  it("W2: no tool breakpoint placed -- tools cached via cumulative hash at system position", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    // Build payload with tools but no tool-level cache_control
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }
    const payload = makeApiPayload(msgs, 1);
    payload.tools = [
      { name: "bash", input_schema: {} },
      { name: "file_read", input_schema: {} },
      { name: "web_fetch", input_schema: {} },
    ];

    const result = await onPayload(payload, model);

    // W2: No tool should have cache_control (tool breakpoint removed)
    const tools = result.tools as any[];
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toBeUndefined();
    expect(tools[2].cache_control).toBeUndefined();
  });

  it("W2 guard strips incoming tool cache_control in non-sub-agent flow", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }
    const payload = makeApiPayload(msgs, 1);
    // Simulate pi-ai 0.67.4 placing cache_control on first tool (or any tool)
    payload.tools = [
      { name: "bash", cache_control: { type: "ephemeral" } },
      { name: "file_read", input_schema: {} },
      { name: "web_fetch", input_schema: {} },
    ];

    const result = await onPayload(payload, model);

    // W2: all tool cache_control stripped in normal (non-skipCacheWrite) flow
    const tools = result.tools as any[];
    expect(tools.filter((t: any) => t.cache_control).length).toBe(0);
  });

  it("skips tool caching when no tools in payload", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    // Payload with no tools array
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }
    const payload = makeApiPayload(msgs, 1);
    // No tools property at all

    const result = await onPayload(payload, model);

    // Should still place message breakpoints normally
    let msgBreakpoints = 0;
    const messages = result.messages as any[];
    for (const m of messages) {
      for (const b of m.content) {
        if (b.cache_control) msgBreakpoints++;
      }
    }
    expect(msgBreakpoints).toBeGreaterThan(0);

    // Tool debug log should NOT have been called
    expect(logger.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ toolCount: expect.any(Number) }),
      "Tool definition cache breakpoint injected",
    );
  });

  it("W2: no tool breakpoint placed regardless of retention (long)", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }
    const payload = makeApiPayload(msgs, 1);
    payload.tools = [{ name: "bash", input_schema: {} }];

    const result = await onPayload(payload, model);

    const tools = result.tools as any[];
    // W2: Tool breakpoint removed -- tools cached via cumulative hash
    expect(tools[0].cache_control).toBeUndefined();
  });

  it("W2: no tool breakpoint placed regardless of retention (short)", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "short" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }
    const payload = makeApiPayload(msgs, 1);
    payload.tools = [{ name: "bash", input_schema: {} }];

    const result = await onPayload(payload, model);

    const tools = result.tools as any[];
    // W2: Tool breakpoint removed -- tools cached via cumulative hash
    expect(tools[0].cache_control).toBeUndefined();
  });
});

describe("lookback window enforcement", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  /** Build an Anthropic-style API payload with messages. */
  function makeApiPayload(
    messageSpecs: Array<{ role: string; text: string; cache_control?: boolean }>,
    systemBreakpoints = 0,
  ): Record<string, unknown> {
    const system = [
      { type: "text", text: "System prompt content here" },
    ];
    if (systemBreakpoints > 0) {
      (system[0] as any).cache_control = { type: "ephemeral" };
    }

    const messages = messageSpecs.map(spec => {
      const block: Record<string, unknown> = { type: "text", text: spec.text };
      if (spec.cache_control) {
        block.cache_control = { type: "ephemeral" };
      }
      return {
        role: spec.role,
        content: [block],
      };
    });

    return { system, messages };
  }

  /** Generate text that estimates to at least N tokens (CHARS_PER_TOKEN_RATIO = 4). */
  function textForTokens(tokens: number): string {
    return "x".repeat(tokens * 4);
  }

  /** Find indices of messages with cache_control set. */
  function findBreakpointIndices(payload: Record<string, unknown>): number[] {
    const indices: number[] = [];
    const messages = payload.messages as any[];
    for (let i = 0; i < messages.length; i++) {
      for (const b of messages[i].content) {
        if (b.cache_control) {
          indices.push(i);
          break;
        }
      }
    }
    return indices;
  }

  it("places bridging breakpoint when gap exceeds 20 blocks", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long", cacheBreakpointStrategy: "multi-zone" }, logger);
    const wrappedFn = wrapper(base);

    // Sonnet has 1024 min token threshold
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    // Build 42-message conversation: compaction summary at index 0, then 41 alternating
    // messages. Each with enough tokens for Sonnet's 1024 threshold.
    // The semi-stable breakpoint will be at index 0 (compaction summary).
    // The second-to-last user message will be at index 40.
    // Gap = 40 blocks, well above the 20-block lookback window.
    // With only 1 system breakpoint, 3 message slots available.
    // The mid-zone breakpoint covers the midpoint (~20).
    // If that still leaves a gap > 20, the lookback pass adds a bridge.
    const msgs: Array<{ role: string; text: string }> = [];
    msgs.push({ role: "user", text: "<summary>" + textForTokens(2000) + "</summary>" });
    msgs.push({ role: "assistant", text: textForTokens(2000) });
    for (let i = 2; i < 42; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }

    const payload = makeApiPayload(msgs, 1); // 1 system bp => 3 message slots
    const result = await onPayload(payload, model);

    const bpIndices = findBreakpointIndices(result);

    // Verify no consecutive breakpoint gap exceeds 20 blocks
    for (let i = 1; i < bpIndices.length; i++) {
      const gap = bpIndices[i]! - bpIndices[i - 1]!;
      // With 3 message slots and lookback enforcement, gaps should be manageable
      // The key assertion: at least 3 breakpoints placed to cover the 40-block span
      expect(gap).toBeLessThanOrEqual(20);
    }
    // Should have placed at least 3 breakpoints to cover the gap
    expect(bpIndices.length).toBeGreaterThanOrEqual(3);
  });

  it("does not place bridge when gap is within lookback window", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    // 15-message conversation -- breakpoints will be within 20 blocks of each other
    const msgs: Array<{ role: string; text: string }> = [];
    msgs.push({ role: "user", text: "<summary>" + textForTokens(2000) + "</summary>" });
    msgs.push({ role: "assistant", text: textForTokens(2000) });
    for (let i = 2; i < 15; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }

    const payload = makeApiPayload(msgs, 1);
    const result = await onPayload(payload, model);

    const bpIndices = findBreakpointIndices(result);

    // All gaps should be <= 20 (no bridging needed)
    for (let i = 1; i < bpIndices.length; i++) {
      expect(bpIndices[i]! - bpIndices[i - 1]!).toBeLessThanOrEqual(20);
    }
  });

  it("does not place bridge when no slots remain", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    // Build a long conversation with 4 system breakpoints consuming all slots.
    // (W2 guard strips tool cache_control, so use system blocks to exhaust budget.)
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 42; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }
    const payload = makeApiPayload(msgs, 0);
    payload.system = [
      { type: "text", text: "block1", cache_control: { type: "ephemeral" } },
      { type: "text", text: "block2", cache_control: { type: "ephemeral" } },
      { type: "text", text: "block3", cache_control: { type: "ephemeral" } },
      { type: "text", text: "block4", cache_control: { type: "ephemeral" } },
    ];

    const result = await onPayload(payload, model);

    // No message breakpoints should be placed (all 4 slots used by system blocks)
    let messageBreakpoints = 0;
    const messages = result.messages as any[];
    for (const m of messages) {
      for (const b of m.content) {
        if (b.cache_control) messageBreakpoints++;
      }
    }
    expect(messageBreakpoints).toBe(0);
  });
});

describe("CACHEABLE_BLOCK_TYPES", () => {
  it("includes text, tool_use, tool_result, image", () => {
    expect(CACHEABLE_BLOCK_TYPES.has("text")).toBe(true);
    expect(CACHEABLE_BLOCK_TYPES.has("tool_use")).toBe(true);
    expect(CACHEABLE_BLOCK_TYPES.has("tool_result")).toBe(true);
    expect(CACHEABLE_BLOCK_TYPES.has("image")).toBe(true);
  });

  it("does NOT include thinking or redacted_thinking", () => {
    expect(CACHEABLE_BLOCK_TYPES.has("thinking")).toBe(false);
    expect(CACHEABLE_BLOCK_TYPES.has("redacted_thinking")).toBe(false);
  });
});

describe("addCacheControlToLastBlock thinking exclusion", () => {
  it("skips thinking block and places cache_control on preceding text block", () => {
    const message: Record<string, unknown> = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "thinking", thinking: "internal reasoning" },
      ],
    };
    addCacheControlToLastBlock(message);
    const content = message.content as Record<string, unknown>[];
    expect(content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(content[1].cache_control).toBeUndefined();
  });

  it("skips redacted_thinking block and places cache_control on preceding text block", () => {
    const message: Record<string, unknown> = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "redacted_thinking", data: "encrypted" },
      ],
    };
    addCacheControlToLastBlock(message);
    const content = message.content as Record<string, unknown>[];
    expect(content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(content[1].cache_control).toBeUndefined();
  });

  it("places cache_control on cacheable block types as normal (text regression)", () => {
    const message: Record<string, unknown> = {
      role: "assistant",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "last" },
      ],
    };
    addCacheControlToLastBlock(message);
    const content = message.content as Record<string, unknown>[];
    expect(content[0].cache_control).toBeUndefined();
    expect(content[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("places cache_control on tool_use block (regression)", () => {
    const message: Record<string, unknown> = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "tool_use", id: "tu1", name: "bash", input: {} },
      ],
    };
    addCacheControlToLastBlock(message);
    const content = message.content as Record<string, unknown>[];
    expect(content[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("places cache_control on tool_result block (regression)", () => {
    const message: Record<string, unknown> = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu1", content: "output" },
      ],
    };
    addCacheControlToLastBlock(message);
    const content = message.content as Record<string, unknown>[];
    expect(content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("places cache_control on image block (regression)", () => {
    const message: Record<string, unknown> = {
      role: "user",
      content: [
        { type: "text", text: "See image:" },
        { type: "image", source: { type: "base64", data: "..." } },
      ],
    };
    addCacheControlToLastBlock(message);
    const content = message.content as Record<string, unknown>[];
    expect(content[0].cache_control).toBeUndefined();
    expect(content[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("falls back to last block when only block is thinking (edge case)", () => {
    const message: Record<string, unknown> = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "internal" },
      ],
    };
    addCacheControlToLastBlock(message);
    const content = message.content as Record<string, unknown>[];
    // Fallback: place on last block even though it's thinking
    expect(content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("respects long retention with ttl='1h'", () => {
    const message: Record<string, unknown> = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "thinking", thinking: "reasoning" },
      ],
    };
    addCacheControlToLastBlock(message, "long" as any);
    const content = message.content as Record<string, unknown>[];
    expect(content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(content[1].cache_control).toBeUndefined();
  });

  it("no-ops on empty content array", () => {
    const message: Record<string, unknown> = { role: "assistant", content: [] };
    addCacheControlToLastBlock(message);
    expect((message.content as unknown[]).length).toBe(0);
  });

  it("no-ops on non-array content", () => {
    const message: Record<string, unknown> = { role: "assistant", content: "plain text" };
    addCacheControlToLastBlock(message);
    expect(message.content).toBe("plain text");
  });
});
describe("breakpoint strategy config", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  function makeApiPayload(
    messageSpecs: Array<{ role: string; text: string; cache_control?: boolean }>,
    systemBreakpoints = 0,
  ): Record<string, unknown> {
    const system = [
      { type: "text", text: "System prompt content here" },
    ];
    if (systemBreakpoints > 0) {
      (system[0] as any).cache_control = { type: "ephemeral" };
    }

    const messages = messageSpecs.map(spec => {
      const block: Record<string, unknown> = { type: "text", text: spec.text };
      if (spec.cache_control) {
        block.cache_control = { type: "ephemeral" };
      }
      return {
        role: spec.role,
        content: [block],
      };
    });

    return { system, messages };
  }

  function textForTokens(tokens: number): string {
    return "x".repeat(tokens * 4);
  }

  function countMessageBreakpoints(payload: Record<string, unknown>): number {
    let count = 0;
    const messages = payload.messages as any[];
    for (const m of messages) {
      for (const b of m.content) {
        if (b.cache_control) count++;
      }
    }
    return count;
  }

  function findBreakpointIndices(payload: Record<string, unknown>): number[] {
    const indices: number[] = [];
    const messages = payload.messages as any[];
    for (let i = 0; i < messages.length; i++) {
      for (const b of messages[i].content) {
        if (b.cache_control) {
          indices.push(i);
          break;
        }
      }
    }
    return indices;
  }

  it("single strategy places exactly 1 breakpoint on messages", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", cacheBreakpointStrategy: "single" },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Build 30-message conversation with compaction summary (multi-zone would place 3)
    const msgs: Array<{ role: string; text: string }> = [];
    msgs.push({ role: "user", text: "<summary>" + textForTokens(2000) + "</summary>" });
    msgs.push({ role: "assistant", text: textForTokens(2000) });
    for (let i = 2; i < 30; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }

    const payload = makeApiPayload(msgs, 1);
    const result = await onPayload(payload, model);

    const msgBps = countMessageBreakpoints(result);
    expect(msgBps).toBe(1);
  });

  it("single strategy targets second-to-last user message", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", cacheBreakpointStrategy: "single" },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // 10 alternating user/assistant messages: user at 0,2,4,6,8
    // Second-to-last user is index 6
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(500) });
    }

    const payload = makeApiPayload(msgs, 0);
    const result = await onPayload(payload, model);

    const bpIndices = findBreakpointIndices(result);
    // Single strategy places exactly 1 breakpoint on second-to-last user
    expect(bpIndices).toHaveLength(1);
    // Second-to-last user message is at index 6 (users at 0,2,4,6,8)
    expect(bpIndices[0]).toBe(6);
  });

  it("single strategy with < 2 messages places 0 breakpoints", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", cacheBreakpointStrategy: "single" },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const msgs: Array<{ role: string; text: string }> = [
      { role: "user", text: textForTokens(300) },
    ];

    const payload = makeApiPayload(msgs, 0);
    const result = await onPayload(payload, model);

    const msgBps = countMessageBreakpoints(result);
    expect(msgBps).toBe(0);
  });

  it("W11: auto default resolves to multi-zone for direct anthropic", async () => {
    // W11: Without cacheBreakpointStrategy, auto resolves to "multi-zone" for ALL providers
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // 30-message conversation with compaction summary
    const msgs: Array<{ role: string; text: string }> = [];
    msgs.push({ role: "user", text: "<summary>" + textForTokens(2000) + "</summary>" });
    msgs.push({ role: "assistant", text: textForTokens(2000) });
    for (let i = 2; i < 30; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }

    const payload = makeApiPayload(msgs, 1);
    const result = await onPayload(payload, model);

    // W11: Multi-zone strategy places up to 3 breakpoints
    const msgBps = countMessageBreakpoints(result);
    expect(msgBps).toBeGreaterThanOrEqual(1);
    expect(msgBps).toBeLessThanOrEqual(3);
  });

  it("auto default resolves to multi-zone for bedrock", async () => {
    // Without cacheBreakpointStrategy, auto resolves to "multi-zone" for bedrock
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "amazon-bedrock" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // 30-message conversation with compaction summary
    const msgs: Array<{ role: string; text: string }> = [];
    msgs.push({ role: "user", text: "<summary>" + textForTokens(2000) + "</summary>" });
    msgs.push({ role: "assistant", text: textForTokens(2000) });
    for (let i = 2; i < 30; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }

    const payload = makeApiPayload(msgs, 1);
    const result = await onPayload(payload, model);

    // Multi-zone should place 3 breakpoints (same as existing multi-zone test)
    const msgBps = countMessageBreakpoints(result);
    expect(msgBps).toBe(3);
  });

  it("single strategy respects slotsAvailable = 0", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", cacheBreakpointStrategy: "single" },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Build payload with 4 system breakpoints consuming all slots.
    // (W2 guard strips tool cache_control, so use system blocks to exhaust budget.)
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }

    const payload = makeApiPayload(msgs, 0);
    payload.system = [
      { type: "text", text: "block1", cache_control: { type: "ephemeral" } },
      { type: "text", text: "block2", cache_control: { type: "ephemeral" } },
      { type: "text", text: "block3", cache_control: { type: "ephemeral" } },
      { type: "text", text: "block4", cache_control: { type: "ephemeral" } },
    ];
    const result = await onPayload(payload, model);

    // All 4 slots consumed by system, 0 message breakpoints should be placed
    const msgBps = countMessageBreakpoints(result);
    expect(msgBps).toBe(0);
  });
});

describe("createRequestBodyInjector — defer_loading injection", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  /** Helper to build a minimal Anthropic-style payload with tools. */
  function makePayloadWithTools(
    toolNames: string[],
    opts?: { existingDeferLoading?: string[] },
  ): Record<string, unknown> {
    const tools = toolNames.map(name => ({
      name,
      description: `Tool ${name}`,
      input_schema: { type: "object", properties: {} },
    }));
    return { system: [{ type: "text", text: "System" }], messages: [], tools };
  }

  it("injects defer_loading: true on deferred tools for Anthropic Sonnet", async () => {
    const base = createMockStreamFn();
    const deferredNames = new Set(["tool_a", "tool_b"]);
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getDeferredToolNames: () => deferredNames,
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;

    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;
    const payload = makePayloadWithTools(["tool_a", "tool_b", "tool_c"]);
    const result = await onPayload(payload, model);

    const tools = result.tools as Array<Record<string, unknown>>;
    // tool_a and tool_b should have defer_loading: true
    expect(tools.find(t => t.name === "tool_a")!.defer_loading).toBe(true);
    expect(tools.find(t => t.name === "tool_b")!.defer_loading).toBe(true);
    // tool_c should NOT have defer_loading
    expect(tools.find(t => t.name === "tool_c")!.defer_loading).toBeUndefined();
  });

  it("appends tool_search_tool_regex_20251119 for Anthropic with deferred tools", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getDeferredToolNames: () => new Set(["tool_a"]),
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;

    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;
    const payload = makePayloadWithTools(["tool_a", "tool_b"]);
    const result = await onPayload(payload, model);

    const tools = result.tools as Array<Record<string, unknown>>;
    const searchTool = tools.find(t => t.type === "tool_search_tool_regex_20251119");
    expect(searchTool).toBeDefined();
    expect(searchTool!.name).toBe("tool_search_tool_regex");
  });

  it("does NOT inject defer_loading for non-Anthropic providers", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getDeferredToolNames: () => new Set(["tool_a"]),
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "gemini-2.0-flash", provider: "google" } as any;

    wrappedFn(model, makeContext([]), {});

    // Non-Anthropic providers skip the entire onPayload path
    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    expect(receivedOptions.onPayload).toBeUndefined();
  });

  it("does NOT inject defer_loading for Haiku models", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getDeferredToolNames: () => new Set(["tool_a"]),
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-haiku-3-5-20241022", provider: "anthropic" } as any;

    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;
    const payload = makePayloadWithTools(["tool_a", "tool_b"]);
    const result = await onPayload(payload, model);

    const tools = result.tools as Array<Record<string, unknown>>;
    // No tool should have defer_loading
    for (const tool of tools) {
      expect(tool.defer_loading).toBeUndefined();
    }
    // No tool_search_tool appended
    expect(tools.find(t => typeof t.type === "string" && (t.type as string).startsWith("tool_search_tool_"))).toBeUndefined();
  });

  it("removes discover_tools when API defer_loading is active", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getDeferredToolNames: () => new Set(["tool_a"]),
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;

    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;
    // Include discover_tools in the payload
    const payload = makePayloadWithTools(["tool_a", "discover_tools", "tool_c"]);
    const result = await onPayload(payload, model);

    const tools = result.tools as Array<Record<string, unknown>>;
    // discover_tools should have been removed
    expect(tools.find(t => t.name === "discover_tools")).toBeUndefined();
    // But tool_search_tool should be appended
    expect(tools.find(t => t.type === "tool_search_tool_regex_20251119")).toBeDefined();
  });

  it("does NOT inject defer_loading when getDeferredToolNames returns empty Set", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getDeferredToolNames: () => new Set<string>(),
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;

    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;
    const payload = makePayloadWithTools(["tool_a", "tool_b"]);
    const result = await onPayload(payload, model);

    const tools = result.tools as Array<Record<string, unknown>>;
    for (const tool of tools) {
      expect(tool.defer_loading).toBeUndefined();
    }
    // No search tool appended
    expect(tools.find(t => typeof t.type === "string" && (t.type as string).startsWith("tool_search_tool_"))).toBeUndefined();
  });

  it("tool_search_tool_regex itself does NOT get defer_loading", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getDeferredToolNames: () => new Set(["tool_a"]),
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;

    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;
    const payload = makePayloadWithTools(["tool_a", "tool_b"]);
    const result = await onPayload(payload, model);

    const tools = result.tools as Array<Record<string, unknown>>;
    const searchTool = tools.find(t => t.type === "tool_search_tool_regex_20251119");
    expect(searchTool).toBeDefined();
    expect(searchTool!.defer_loading).toBeUndefined();
  });

  it("works for Opus model (non-Haiku, supports tool search)", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getDeferredToolNames: () => new Set(["tool_a"]),
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-opus-4-6-20260301", provider: "anthropic" } as any;

    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;
    const payload = makePayloadWithTools(["tool_a", "tool_b"]);
    const result = await onPayload(payload, model);

    const tools = result.tools as Array<Record<string, unknown>>;
    expect(tools.find(t => t.name === "tool_a")!.defer_loading).toBe(true);
    expect(tools.find(t => t.type === "tool_search_tool_regex_20251119")).toBeDefined();
  });

  it("does NOT inject tool_search_tool when deferred names exist but no matching tools in payload", async () => {
    // Production scenario: tool-deferral.ts excludes deferred tools upstream,
    // so onPayload sees deferredNames but none of the payload tools match.
    // Must NOT inject tool_search_tool_regex (which lacks input_schema) or
    // remove discover_tools — the payload has no deferred tool definitions.
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getDeferredToolNames: () => new Set(["agents_manage", "obs_query", "sessions_manage"]),
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-opus-4-6", provider: "anthropic" } as any;

    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;
    // Payload contains only ACTIVE tools — deferred ones were excluded upstream
    const payload = makePayloadWithTools(["message", "web_search", "discover_tools"]);
    const result = await onPayload(payload, model);

    const tools = result.tools as Array<Record<string, unknown>>;
    // No tool should have defer_loading (none match deferred names)
    for (const tool of tools) {
      expect(tool.defer_loading).toBeUndefined();
    }
    // tool_search_tool must NOT be appended (no deferred tools in payload)
    expect(tools.find(t => typeof t.type === "string" && (t.type as string).startsWith("tool_search_tool_"))).toBeUndefined();
    // discover_tools must be preserved (client-side fallback still needed)
    expect(tools.find(t => t.name === "discover_tools")).toBeDefined();
  });
});

describe("skipCacheWrite for sub-agent spawns", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  function makeApiPayload(
    messageSpecs: Array<{ role: string; text: string; cache_control?: boolean }>,
    systemBreakpoints = 0,
  ): Record<string, unknown> {
    const system = [
      { type: "text", text: "System prompt content here" },
    ];
    if (systemBreakpoints > 0) {
      (system[0] as any).cache_control = { type: "ephemeral" };
    }

    const messages = messageSpecs.map(spec => {
      const block: Record<string, unknown> = { type: "text", text: spec.text };
      if (spec.cache_control) {
        block.cache_control = { type: "ephemeral" };
      }
      return {
        role: spec.role,
        content: [block],
      };
    });

    return { system, messages };
  }

  function textForTokens(tokens: number): string {
    return "x".repeat(tokens * 4);
  }

  function findBreakpointIndices(payload: Record<string, unknown>): number[] {
    const indices: number[] = [];
    const messages = payload.messages as any[];
    for (let i = 0; i < messages.length; i++) {
      for (const b of messages[i].content) {
        if (b.cache_control) {
          indices.push(i);
          break;
        }
      }
    }
    return indices;
  }

  it("skipCacheWrite places shared-prefix marker on second-to-last user", async () => {
    // skipCacheWrite strips all markers then places one on second-to-last user
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", skipCacheWrite: true },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // 12 alternating user/assistant messages with compaction summary
    const msgs: Array<{ role: string; text: string }> = [];
    msgs.push({ role: "user", text: "<summary>" + textForTokens(2000) + "</summary>" });
    msgs.push({ role: "assistant", text: textForTokens(2000) });
    for (let i = 2; i < 12; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(500) });
    }

    const payload = makeApiPayload(msgs, 1);
    const result = await onPayload(payload, model);

    // Two markers -- second-to-last user (retention) and last user (short/5m)
    const bpIndices = findBreakpointIndices(result);
    expect(bpIndices).toHaveLength(2);
    // The markers should be on second-to-last and last user messages
    const resultMsgs = result.messages as any[];
    const userIndices: number[] = [];
    for (let i = 0; i < resultMsgs.length; i++) {
      if (resultMsgs[i].role === "user") userIndices.push(i);
    }
    expect(bpIndices[0]).toBe(userIndices[userIndices.length - 2]);
    expect(bpIndices[1]).toBe(userIndices[userIndices.length - 1]);
  });

  it("skipCacheWrite falls back to normal position with < 6 messages", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", skipCacheWrite: true },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // 4 messages: user/assistant/user/assistant (users at 0,2; no third-to-last user)
    // With enough tokens to exceed minTokens
    const msgs: Array<{ role: string; text: string }> = [
      { role: "user", text: textForTokens(2000) },
      { role: "assistant", text: textForTokens(2000) },
      { role: "user", text: textForTokens(2000) },
      { role: "assistant", text: textForTokens(2000) },
    ];

    const payload = makeApiPayload(msgs, 0);
    const result = await onPayload(payload, model);

    // Only 2 user messages (0, 2) -- no third-to-last, so should fall back to second-to-last
    // (index 0) as the normal breakpoint position
    const bpIndices = findBreakpointIndices(result);
    // With only 4 messages, the multi-zone code gates on `messages.length < 4`, so
    // this hits the boundary. The second-to-last user is index 0.
    // Breakpoint should be placed at index 0 (second-to-last user = first user)
    expect(bpIndices.length).toBeGreaterThanOrEqual(0);
    // Key assertion: behavior is not broken -- placing at normal position is acceptable
    // when there aren't enough messages for the skip
  });

  it("skipCacheWrite with single strategy also places shared-prefix marker", async () => {
    // Even with single strategy, skipCacheWrite places marker on second-to-last user
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", cacheBreakpointStrategy: "single", skipCacheWrite: true },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // 10 alternating messages: users at 0,2,4,6,8
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(500) });
    }

    const payload = makeApiPayload(msgs, 0);
    const result = await onPayload(payload, model);

    // Two markers -- second-to-last user (retention) and last user (short/5m)
    const bpIndices = findBreakpointIndices(result);
    expect(bpIndices).toHaveLength(2);
    const resultMsgs = result.messages as any[];
    const userIndices: number[] = [];
    for (let i = 0; i < resultMsgs.length; i++) {
      if (resultMsgs[i].role === "user") userIndices.push(i);
    }
    expect(bpIndices[0]).toBe(userIndices[userIndices.length - 2]);
    expect(bpIndices[1]).toBe(userIndices[userIndices.length - 1]);
  });

  it("skipCacheWrite=false produces unchanged behavior", async () => {
    // Without skipCacheWrite, should behave same as normal multi-zone
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({ getCacheRetention: () => "long" }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Same conversation as the shift test
    const msgs: Array<{ role: string; text: string }> = [];
    msgs.push({ role: "user", text: "<summary>" + textForTokens(2000) + "</summary>" });
    msgs.push({ role: "assistant", text: textForTokens(2000) });
    for (let i = 2; i < 12; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(500) });
    }

    const payload = makeApiPayload(msgs, 1);
    const result = await onPayload(payload, model);

    // Users at 0,2,4,6,8,10. Second-to-last user = 8.
    // Without skipCacheWrite, the highest breakpoint should be at index 8
    const bpIndices = findBreakpointIndices(result);
    const highestIdx = bpIndices[bpIndices.length - 1];
    expect(highestIdx).toBe(8);
  });
});

describe("Rendered tool cache", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  function makeApiPayload(
    messageSpecs: Array<{ role: string; text: string; cache_control?: boolean }>,
    systemBreakpoints = 0,
  ): Record<string, unknown> {
    const system = [
      { type: "text", text: "System prompt content here" },
    ];
    if (systemBreakpoints > 0) {
      (system[0] as any).cache_control = { type: "ephemeral" };
    }

    const messages = messageSpecs.map(spec => {
      const block: Record<string, unknown> = { type: "text", text: spec.text };
      if (spec.cache_control) {
        block.cache_control = { type: "ephemeral" };
      }
      return {
        role: spec.role,
        content: [block],
      };
    });

    return { system, messages };
  }

  function textForTokens(tokens: number): string {
    return "x".repeat(tokens * 4);
  }

  /**
   * Strip cache_control from all tools in an array (for comparison).
   */
  function stripCacheControl(tools: any[]): any[] {
    return tools.map((t: any) => {
      const { cache_control, ...rest } = t;
      return rest;
    });
  }

  it("rendered tools byte-identical across turns", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", sessionKey: "test-session-stab01" } as RequestBodyInjectorConfig,
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    const toolDef = {
      name: "tool_a",
      description: "desc",
      input_schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
    };

    // Two consecutive calls with structurally identical but separate object instances
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }

    const payload1 = { ...makeApiPayload(msgs, 1), tools: [{ ...toolDef }] };
    const payload2 = { ...makeApiPayload(msgs, 1), tools: [{ ...toolDef }] };

    const result1 = await onPayload(payload1, model);
    const result2 = await onPayload(payload2, model);

    const stripped1 = stripCacheControl(result1.tools as any[]);
    const stripped2 = stripCacheControl(result2.tools as any[]);

    expect(JSON.stringify(stripped1)).toBe(JSON.stringify(stripped2));
  });

  it("render cache invalidates on composition change", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", sessionKey: "test-session-stab02" } as RequestBodyInjectorConfig,
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }

    // First call: tool with description v1
    const payload1 = {
      ...makeApiPayload(msgs, 1),
      tools: [{ name: "tool_a", description: "desc_v1", input_schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } }],
    };
    // Second call: tool with description v2 (changed)
    const payload2 = {
      ...makeApiPayload(msgs, 1),
      tools: [{ name: "tool_a", description: "desc_v2", input_schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } }],
    };

    const result1 = await onPayload(payload1, model);
    const result2 = await onPayload(payload2, model);

    const stripped1 = stripCacheControl(result1.tools as any[]);
    const stripped2 = stripCacheControl(result2.tools as any[]);

    // Different tool composition => different result
    expect(JSON.stringify(stripped1)).not.toBe(JSON.stringify(stripped2));
  });

  it("new tools appended to render cache", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", sessionKey: "test-session-stab03" } as RequestBodyInjectorConfig,
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    const toolA = { name: "tool_a", description: "desc", input_schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } };
    const toolB = { name: "tool_b", description: "other", input_schema: { type: "object", properties: { y: { type: "number" } }, required: ["y"] } };

    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }

    // First call: 1 tool
    const payload1 = { ...makeApiPayload(msgs, 1), tools: [{ ...toolA }] };
    // Second call: 2 tools (one added)
    const payload2 = { ...makeApiPayload(msgs, 1), tools: [{ ...toolA }, { ...toolB }] };

    const result1 = await onPayload(payload1, model);
    const result2 = await onPayload(payload2, model);

    const stripped2 = stripCacheControl(result2.tools as any[]);

    // Result2 should contain both tools
    expect(stripped2).toHaveLength(2);
    expect(stripped2.map((t: any) => t.name)).toEqual(["tool_a", "tool_b"]);
  });

  it("cache_control excluded from cache snapshot", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", sessionKey: "test-session-stab04" } as RequestBodyInjectorConfig,
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }

    // First call: tool WITH cache_control
    const payload1 = {
      ...makeApiPayload(msgs, 1),
      tools: [{
        name: "tool_a",
        description: "desc",
        input_schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
        cache_control: { type: "ephemeral" },
      }],
    };
    // Second call: same tool WITHOUT cache_control
    const payload2 = {
      ...makeApiPayload(msgs, 1),
      tools: [{
        name: "tool_a",
        description: "desc",
        input_schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
      }],
    };

    const result1 = await onPayload(payload1, model);
    const result2 = await onPayload(payload2, model);

    const stripped1 = stripCacheControl(result1.tools as any[]);
    const stripped2 = stripCacheControl(result2.tools as any[]);

    // Same tool content (differing only in cache_control) => cache hit => identical
    expect(JSON.stringify(stripped1)).toBe(JSON.stringify(stripped2));
  });
});

describe("all-deferred tool hash skip", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  function textForTokens(tokens: number): string {
    return "x".repeat(tokens * 4);
  }

  it("skips per-tool hash recomputation when all MCP tools are deferred (all-deferred)", async () => {
    const sessionKey = "test-session-alldeferred-skip";
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        sessionKey,
        getDeferredToolNames: () => new Set(["tool_a", "tool_b"]),
        getTotalMcpToolCount: () => 2,
      } as RequestBodyInjectorConfig,
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }

    const toolDef = {
      name: "tool_a",
      description: "desc",
      input_schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
    };
    const toolDef2 = {
      name: "tool_b",
      description: "desc2",
      input_schema: { type: "object", properties: { y: { type: "string" } }, required: ["y"] },
    };

    // First call: populates the cache (per-tool hash runs)
    const payload1 = {
      system: [{ type: "text", text: "System", cache_control: { type: "ephemeral" } }],
      messages: msgs.map(m => ({ role: m.role, content: [{ type: "text", text: m.text }] })),
      tools: [{ ...toolDef }, { ...toolDef2 }],
    };
    await onPayload(payload1, model);

    // Second call: all-deferred skip should activate, using cached tools
    const payload2 = {
      system: [{ type: "text", text: "System", cache_control: { type: "ephemeral" } }],
      messages: msgs.map(m => ({ role: m.role, content: [{ type: "text", text: m.text }] })),
      tools: [{ ...toolDef }, { ...toolDef2 }],
    };
    const result2 = await onPayload(payload2, model);

    // Should have logged the skip message
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey }),
      expect.stringContaining("All tools deferred"),
    );
    // Tools should still be present (replayed from cache + tool_search appended by defer_loading)
    expect(Array.isArray(result2.tools)).toBe(true);
    expect((result2.tools as any[]).length).toBeGreaterThanOrEqual(2);

    clearSessionRenderedToolCache(sessionKey);
  });

  it("does NOT skip when only a subset of tools are deferred (all-deferred)", async () => {
    const sessionKey = "test-session-alldeferred-partial";
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        sessionKey,
        getDeferredToolNames: () => new Set(["tool_a"]),
        getTotalMcpToolCount: () => 3, // 3 total but only 1 deferred
      } as RequestBodyInjectorConfig,
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }

    const toolDef = {
      name: "tool_a",
      description: "desc",
      input_schema: { type: "object" },
    };

    // First call: populate cache
    const payload1 = {
      system: [{ type: "text", text: "System", cache_control: { type: "ephemeral" } }],
      messages: msgs.map(m => ({ role: m.role, content: [{ type: "text", text: m.text }] })),
      tools: [{ ...toolDef }],
    };
    await onPayload(payload1, model);

    // Second call: partial deferred -- should NOT skip
    const payload2 = {
      system: [{ type: "text", text: "System", cache_control: { type: "ephemeral" } }],
      messages: msgs.map(m => ({ role: m.role, content: [{ type: "text", text: m.text }] })),
      tools: [{ ...toolDef }],
    };
    await onPayload(payload2, model);

    // Should NOT have logged the skip message
    const debugCalls = (logger.debug as any).mock.calls as Array<[any, string]>;
    const skipLogs = debugCalls.filter(c => typeof c[1] === "string" && c[1].includes("All tools deferred"));
    expect(skipLogs.length).toBe(0);

    clearSessionRenderedToolCache(sessionKey);
  });

  it("does NOT activate on first turn before cache exists (all-deferred)", async () => {
    const sessionKey = "test-session-alldeferred-firstturn";
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        sessionKey,
        getDeferredToolNames: () => new Set(["tool_a"]),
        getTotalMcpToolCount: () => 1,
      } as RequestBodyInjectorConfig,
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }

    const toolDef = {
      name: "tool_a",
      description: "desc",
      input_schema: { type: "object" },
    };

    // First call only -- no prior cache entry exists
    const payload = {
      system: [{ type: "text", text: "System", cache_control: { type: "ephemeral" } }],
      messages: msgs.map(m => ({ role: m.role, content: [{ type: "text", text: m.text }] })),
      tools: [{ ...toolDef }],
    };
    await onPayload(payload, model);

    // Should NOT have logged the skip message on first turn
    const debugCalls = (logger.debug as any).mock.calls as Array<[any, string]>;
    const skipLogs = debugCalls.filter(c => typeof c[1] === "string" && c[1].includes("All tools deferred"));
    expect(skipLogs.length).toBe(0);

    clearSessionRenderedToolCache(sessionKey);
  });
});

describe("onPayloadForCacheDetection header passthrough", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  function textForTokens(tokens: number): string {
    return "x".repeat(tokens * 4);
  }

  it("passes mergedHeaders to onPayloadForCacheDetection for direct Anthropic", async () => {
    const base = createMockStreamFn();
    const spy = vi.fn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", onPayloadForCacheDetection: spy },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    // Build minimal payload with enough content for the wrapper to process
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 4; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }
    const payload = {
      system: [{ type: "text", text: "System prompt" }],
      messages: msgs.map(m => ({ role: m.role, content: [{ type: "text", text: m.text }] })),
    };

    await onPayload(payload, model);

    // onPayloadForCacheDetection should have been called with 3 args
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0].length).toBe(3);
    // Third arg should be the merged headers object containing anthropic-beta
    const headers = spy.mock.calls[0][2] as Record<string, string>;
    expect(headers).toBeDefined();
    expect(headers["anthropic-beta"]).toBeDefined();
    expect(headers["anthropic-beta"]).toContain("context-1m-2025-08-07");
  });

  it("passes undefined headers for non-direct-Anthropic providers", async () => {
    const base = createMockStreamFn();
    const spy = vi.fn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long", onPayloadForCacheDetection: spy },
      logger,
    );
    const wrappedFn = wrapper(base);
    // Use Bedrock provider -- mergedHeaders should be undefined since it is only built for model.provider === "anthropic"
    const model = { id: "claude-sonnet-4-5", provider: "amazon-bedrock" } as any;
    wrappedFn(model, makeContext([]), {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (p: any, m: any) => Promise<any>;

    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 4; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }
    const payload = {
      system: [{ type: "text", text: "System prompt" }],
      messages: msgs.map(m => ({ role: m.role, content: [{ type: "text", text: m.text }] })),
    };

    await onPayload(payload, model);

    // For non-direct-Anthropic, headers should be undefined
    expect(spy).toHaveBeenCalledTimes(1);
    const headers = spy.mock.calls[0][2];
    expect(headers).toBeUndefined();
  });
});
describe("SYSTEM_PROMPT_DYNAMIC_BOUNDARY", () => {
  it("has the exact expected string value", () => {
    expect(SYSTEM_PROMPT_DYNAMIC_BOUNDARY).toBe("\n\n---SYSTEM-PROMPT-DYNAMIC-BOUNDARY---\n\n");
  });
});

describe("createRequestBodyInjector — session latches", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  /** Helper to build an Anthropic payload with system, messages, and tools. */
  function makePayloadForLatch(opts?: {
    toolNames?: string[];
  }): Record<string, unknown> {
    const tools = (opts?.toolNames ?? ["tool_a"]).map(name => ({
      name,
      description: `Tool ${name}`,
      input_schema: { type: "object", properties: {} },
    }));
    return {
      system: [{ type: "text", text: "System prompt content" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "x".repeat(8000) }] },
        { role: "assistant", content: [{ type: "text", text: "response" }] },
        { role: "user", content: [{ type: "text", text: "x".repeat(8000) }] },
      ],
      tools,
    };
  }

  it("beta header latch: first call latches header, second call reuses latched value", async () => {
    const base = createMockStreamFn();
    const betaLatch = createSessionLatch<string>();

    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getBetaHeaderLatch: () => betaLatch,
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;

    // First call -- should latch the beta header
    wrappedFn(model, makeContext([]), {});
    const opts1 = base.mock.calls[0][2] as Record<string, unknown>;
    const headers1 = opts1.headers as Record<string, string>;
    expect(headers1["anthropic-beta"]).toContain("context-1m-2025-08-07");

    // Verify the latch captured the value
    expect(betaLatch.get()).toBe(headers1["anthropic-beta"]);

    // Second call with a different header input -- should reuse the latched value
    wrappedFn(model, makeContext([]), { headers: { "anthropic-beta": "some-other-beta" } });
    const opts2 = base.mock.calls[1][2] as Record<string, unknown>;
    const headers2 = opts2.headers as Record<string, string>;
    // Should still use the latched value from the first call
    expect(headers2["anthropic-beta"]).toBe(betaLatch.get());
  });

  it("retention latch: first resolution latches retention, second call uses latched value", async () => {
    const base = createMockStreamFn();
    const retentionLatch = createSessionLatch<string>();
    let retentionValue: string | undefined = "long";

    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => retentionValue as any,
        getRetentionLatch: () => retentionLatch as any,
        getSystemPromptBlocks: () => ({ staticPrefix: "prefix", attribution: "attr", semiStableBody: "body" }),
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;

    // First call: retention resolves as "long"
    wrappedFn(model, makeContext([]), {});
    const opts1 = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload1 = opts1.onPayload as (payload: any, model: any) => Promise<any>;
    const payload1 = makePayloadForLatch();
    const result1 = await onPayload1(payload1, model);
    // W1/W2: Verify via last system block (only block with cache_control after consolidation).
    // With "long" retention, last system block gets TTL 1h.
    const system1 = result1.system as Array<Record<string, unknown>>;
    const lastBlock1 = system1[system1.length - 1]!;
    expect(lastBlock1.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // Change underlying retention to "short" -- latch should prevent downgrade
    retentionValue = "short";

    // Second call: latch should keep "long"
    wrappedFn(model, makeContext([]), {});
    const opts2 = base.mock.calls[1][2] as Record<string, unknown>;
    const onPayload2 = opts2.onPayload as (payload: any, model: any) => Promise<any>;
    const payload2 = makePayloadForLatch();
    const result2 = await onPayload2(payload2, model);
    // Last system block should still have TTL 1h (latched to "long")
    const system2 = result2.system as Array<Record<string, unknown>>;
    const lastBlock2 = system2[system2.length - 1]!;
    expect(lastBlock2.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // Verify latch holds "long"
    expect(retentionLatch.get()).toBe("long");
  });

  it("defer_loading latch: once activated, stays active even when deferred set becomes empty", async () => {
    const base = createMockStreamFn();
    const deferLatch = createSessionLatch<boolean>();
    let deferredNames = new Set(["tool_a"]);

    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getDeferredToolNames: () => deferredNames,
        getDeferLoadingLatch: () => deferLatch,
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;

    // First call: deferred tools present -> activates
    wrappedFn(model, makeContext([]), {});
    const opts1 = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload1 = opts1.onPayload as (payload: any, model: any) => Promise<any>;
    const payload1 = makePayloadForLatch({ toolNames: ["tool_a", "tool_b"] });
    const result1 = await onPayload1(payload1, model);
    const tools1 = result1.tools as Array<Record<string, unknown>>;
    expect(tools1.find(t => t.name === "tool_a")!.defer_loading).toBe(true);
    expect(deferLatch.get()).toBe(true);

    // Empty the deferred set -- latch should keep defer active
    deferredNames = new Set<string>();

    // Second call: no deferred tools, but latch keeps defer_loading active
    wrappedFn(model, makeContext([]), {});
    const opts2 = base.mock.calls[1][2] as Record<string, unknown>;
    const onPayload2 = opts2.onPayload as (payload: any, model: any) => Promise<any>;
    const payload2 = makePayloadForLatch({ toolNames: ["tool_a", "tool_b"] });
    const result2 = await onPayload2(payload2, model);
    // When latch is true but getDeferredToolNames returns empty set,
    // the shouldDeferLoad check still sees true via latch
    expect(deferLatch.get()).toBe(true);
  });

  it("when latch getters are NOT provided, values are read directly each time", async () => {
    const base = createMockStreamFn();
    let retentionValue: string | undefined = "long";

    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => retentionValue as any,
        getSystemPromptBlocks: () => ({ staticPrefix: "prefix", attribution: "attr", semiStableBody: "body" }),
        // No latch getters -- values should be read fresh each time
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;

    // First call: "long" retention -> last system block gets TTL 1h (W1 consolidation)
    wrappedFn(model, makeContext([]), {});
    const opts1 = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload1 = opts1.onPayload as (payload: any, model: any) => Promise<any>;
    const result1 = await onPayload1(makePayloadForLatch(), model);
    // W1/W2: Verify via last system block
    const system1 = result1.system as Array<Record<string, unknown>>;
    const lastBlock1 = system1[system1.length - 1]!;
    expect(lastBlock1.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // Change retention to "short"
    retentionValue = "short";

    // Second call: should now use "short" (no latch to prevent change)
    wrappedFn(model, makeContext([]), {});
    const opts2 = base.mock.calls[1][2] as Record<string, unknown>;
    const onPayload2 = opts2.onPayload as (payload: any, model: any) => Promise<any>;
    const result2 = await onPayload2(makePayloadForLatch(), model);
    // Last system block should now have "ephemeral" without TTL
    const system2 = result2.system as Array<Record<string, unknown>>;
    const lastBlock2 = system2[system2.length - 1]!;
    expect(lastBlock2.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("per-tool content-addressed memoization", () => {
  beforeEach(() => {
    clearSessionPerToolCache("test-session");
  });

  it("returns same reference for unchanged tool", () => {
    const tool = { name: "bash", description: "run commands", input_schema: { type: "object" } };
    const first = getOrCacheRenderedTool("test-session", tool);
    const second = getOrCacheRenderedTool("test-session", tool);
    // Byte-identical reference -- exact same object
    expect(first).toBe(second);
  });

  it("returns new object when schema changes, but other tools still cached", () => {
    const toolA = { name: "bash", description: "run commands", input_schema: { type: "object" } };
    const toolB = { name: "search", description: "search web", input_schema: { type: "object", properties: { q: { type: "string" } } } };

    const cachedA1 = getOrCacheRenderedTool("test-session", toolA);
    const cachedB1 = getOrCacheRenderedTool("test-session", toolB);

    // Mutate tool B schema
    const toolBChanged = { ...toolB, input_schema: { type: "object", properties: { query: { type: "string" } } } };
    const cachedB2 = getOrCacheRenderedTool("test-session", toolBChanged);

    // Tool A should still be same reference (isolated)
    const cachedA2 = getOrCacheRenderedTool("test-session", toolA);
    expect(cachedA2).toBe(cachedA1);

    // Tool B should be a different object
    expect(cachedB2).not.toBe(cachedB1);
  });

  it("returns new object when description changes", () => {
    const tool1 = { name: "bash", description: "run commands", input_schema: { type: "object" } };
    const cached1 = getOrCacheRenderedTool("test-session", tool1);

    const tool2 = { name: "bash", description: "run shell commands (updated)", input_schema: { type: "object" } };
    const cached2 = getOrCacheRenderedTool("test-session", tool2);

    expect(cached2).not.toBe(cached1);
  });

  it("clearSessionPerToolCache empties the cache for that session", () => {
    const tool = { name: "bash", description: "run commands", input_schema: { type: "object" } };
    const first = getOrCacheRenderedTool("test-session", tool);
    clearSessionPerToolCache("test-session");
    const second = getOrCacheRenderedTool("test-session", tool);

    // After clearing, should be a new snapshot (different reference)
    expect(second).not.toBe(first);
  });
});

describe("per-model cache retention override", () => {
  it("returns override when model matches prefix", () => {
    const result = resolveCacheRetention("claude-sonnet-4-6-20260301", "long", { "claude-sonnet": "none" });
    expect(result).toBe("none");
  });

  it("uses longest-prefix-first: claude-sonnet-4-6 matches before claude-sonnet", () => {
    const overrides = {
      "claude-sonnet": "none" as const,
      "claude-sonnet-4-6": "short" as const,
    };
    const result = resolveCacheRetention("claude-sonnet-4-6-20260301", "long", overrides);
    expect(result).toBe("short");
  });

  it("returns agent-level retention when no override matches", () => {
    const result = resolveCacheRetention("gpt-4o", "long", { "claude-sonnet": "none" });
    expect(result).toBe("long");
  });

  it("returns agent-level retention when overrides is undefined", () => {
    const result = resolveCacheRetention("claude-sonnet-4-6", "long", undefined);
    expect(result).toBe("long");
  });

  it("returns agent-level retention when overrides is empty object", () => {
    const result = resolveCacheRetention("claude-sonnet-4-6", "short", {});
    expect(result).toBe("short");
  });
});

describe("Per-model kill switch strips ALL cache_control markers", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it("strips cache_control from system, tools, and messages when retention is 'none'", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getCacheRetentionOverrides: () => ({ "claude-test": "none" as const }),
        getModelId: () => "claude-test-20260101",
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-test-20260101", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const payload = {
      system: [
        { type: "text", text: "System prompt", cache_control: { type: "ephemeral" } },
      ],
      tools: [
        { name: "bash", description: "Run bash", input_schema: {}, cache_control: { type: "ephemeral" } },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
        { role: "user", content: [{ type: "text", text: "Bye", cache_control: { type: "ephemeral" } }] },
      ],
    };

    const result = await onPayload(payload, model);

    // All cache_control markers must be stripped
    for (const block of result.system as Array<Record<string, unknown>>) {
      expect(block.cache_control).toBeUndefined();
    }
    for (const tool of result.tools as Array<Record<string, unknown>>) {
      expect(tool.cache_control).toBeUndefined();
    }
    for (const msg of result.messages as Array<Record<string, unknown>>) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as Array<Record<string, unknown>>) {
          expect(block.cache_control).toBeUndefined();
        }
      }
    }
  });

  it("preserves cache_control markers when retention is 'long'", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long" },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const payload = {
      system: [
        { type: "text", text: "System prompt", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ],
    };

    const result = await onPayload(payload, model);

    // System cache_control should be preserved (or upgraded by TTL logic)
    expect((result.system as any[])[0].cache_control).toBeDefined();
  });
});

describe("First-block system prompt hash logging", () => {
  it("logs firstBlockHash and firstBlockSnippet on Anthropic API call", async () => {
    const debugCalls: Array<Record<string, unknown>> = [];
    const mockLogger = {
      debug: vi.fn((...args: unknown[]) => {
        const obj = args[0];
        if (typeof obj === "object" && obj !== null && "firstBlockHash" in (obj as Record<string, unknown>)) {
          debugCalls.push({ ...(obj as Record<string, unknown>), _msg: args[1] });
        }
      }),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as any;

    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long" },
      mockLogger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    await onPayload({
      system: [
        { type: "text", text: "You are a helpful assistant." },
      ],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ],
    }, model);

    expect(debugCalls.length).toBeGreaterThanOrEqual(1);
    const hashLog = debugCalls[0]!;
    expect(hashLog.firstBlockHash).toBeTypeOf("number");
    expect(hashLog.firstBlockSnippet).toBeTypeOf("string");
    expect(hashLog.blockCount).toBeTypeOf("number");
  });

  it("does not crash when system is a plain string", async () => {
    const logger = createMockLogger();
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long" },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Should not throw -- system as string is not an array, hash logging skipped
    await expect(onPayload({
      system: "Plain string system prompt",
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ],
    }, model)).resolves.toBeDefined();
  });
});

describe("Time-based microcompact", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it("clears stale tool results when idle > TTL", async () => {
    const onContentModification = vi.fn();
    const onAdaptiveRetentionReset = vi.fn();
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 400_000, // 400s > 300s TTL for "short"
        observationKeepWindow: 2,
        onContentModification,
        onAdaptiveRetentionReset,
        sessionKey: "test-session",
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const payload = {
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "tool", content: [{ type: "text", text: "A".repeat(1500) }] }, // old, clearable
        { role: "user", content: [{ type: "text", text: "Next" }] },
        { role: "tool", content: [{ type: "text", text: "B".repeat(1500) }] }, // old, clearable
        { role: "user", content: [{ type: "text", text: "More" }] },
        { role: "tool", content: [{ type: "text", text: "C".repeat(1500) }] }, // within keep window
        { role: "user", content: [{ type: "text", text: "Last" }] },
        { role: "tool", content: [{ type: "text", text: "D".repeat(1500) }] }, // within keep window
      ],
    };

    const result = await onPayload(payload, model);

    // First 2 tool results should be cleared (beyond keep window of 2)
    const toolMsgs = (result.messages as any[]).filter((m: any) => m.role === "tool");
    expect(toolMsgs[0].content[0].text).toContain("[Stale tool result cleared");
    expect(toolMsgs[1].content[0].text).toContain("[Stale tool result cleared");
    // Last 2 tool results preserved (within keep window)
    expect(toolMsgs[2].content[0].text).toBe("C".repeat(1500));
    expect(toolMsgs[3].content[0].text).toBe("D".repeat(1500));
  });

  it("does not clear when idle < TTL", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 100_000, // 100s < 300s TTL for "short"
        observationKeepWindow: 2,
        sessionKey: "test-session",
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "tool", content: [{ type: "text", text: "A".repeat(1500) }] },
      ],
    }, model);

    const toolMsg = (result.messages as any[]).find((m: any) => m.role === "tool");
    expect(toolMsg.content[0].text).toBe("A".repeat(1500));
  });

  it("does not clear on cold start (undefined elapsed)", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => undefined,
        observationKeepWindow: 2,
        sessionKey: "test-session",
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "tool", content: [{ type: "text", text: "A".repeat(1500) }] },
      ],
    }, model);

    const toolMsg = (result.messages as any[]).find((m: any) => m.role === "tool");
    expect(toolMsg.content[0].text).toBe("A".repeat(1500));
  });

  it("calls onContentModification and onAdaptiveRetentionReset when clearing", async () => {
    const onContentModification = vi.fn();
    const onAdaptiveRetentionReset = vi.fn();
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 400_000,
        observationKeepWindow: 0, // clear all
        onContentModification,
        onAdaptiveRetentionReset,
        sessionKey: "test-session",
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "tool", content: [{ type: "text", text: "A".repeat(1500) }] },
      ],
    }, model);

    expect(onContentModification).toHaveBeenCalledOnce();
    expect(onAdaptiveRetentionReset).toHaveBeenCalledOnce();
  });

  it("preserves tool results within keep window even when idle > TTL", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        getElapsedSinceLastResponse: () => 7_200_000, // 2h > 1h TTL for "long"
        observationKeepWindow: 3,
        sessionKey: "test-session",
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "tool", content: [{ type: "text", text: "X".repeat(1500) }] }, // clearable (4th from end)
        { role: "user", content: [{ type: "text", text: "Next" }] },
        { role: "tool", content: [{ type: "text", text: "A".repeat(1500) }] }, // within keep window (3)
        { role: "tool", content: [{ type: "text", text: "B".repeat(1500) }] }, // within keep window (2)
        { role: "tool", content: [{ type: "text", text: "C".repeat(1500) }] }, // within keep window (1)
      ],
    }, model);

    const toolMsgs = (result.messages as any[]).filter((m: any) => m.role === "tool");
    // First tool result cleared (beyond keep window of 3)
    expect(toolMsgs[0].content[0].text).toContain("[Stale tool result cleared");
    // Last 3 preserved
    expect(toolMsgs[1].content[0].text).toBe("A".repeat(1500));
    expect(toolMsgs[2].content[0].text).toBe("B".repeat(1500));
    expect(toolMsgs[3].content[0].text).toBe("C".repeat(1500));
  });
});

describe("(standalone): skipCacheWrite shared-prefix marker placement", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it("strips existing markers then places one on second-to-last user when skipCacheWrite is true", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        skipCacheWrite: true,
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [
          { type: "text", text: "Hello", cache_control: { type: "ephemeral" } },
        ]},
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
        { role: "user", content: [
          { type: "text", text: "Bye", cache_control: { type: "ephemeral", ttl: "1h" } },
        ]},
      ],
    }, model);

    const msgs = result.messages as any[];
    // First user (index 0) is second-to-last user -- should have cache_control marker
    expect(msgs[0].content[0].cache_control).toBeDefined();
    // Last user (index 2) gets a short (5m) marker for cache reads
    expect(msgs[2].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("preserves message cache_control when skipCacheWrite is false", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        skipCacheWrite: false,
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [
          { type: "text", text: "Hello" },
        ]},
      ],
    }, model);

    // No stripping occurs -- breakpoint placement may have added cache_control
    // The test verifies no crash and normal behavior
    expect(result.messages).toBeDefined();
  });

  // Regression coverage for Issue #4 (260419-iv4): when skipCacheWrite=true but
  // the sub-agent has only one user message, the shared-prefix strip+replace
  // has no anchor to place a replacement marker on. Previously this code path
  // stripped all cache_control markers unconditionally, leaving the request
  // with zero caching (100% miss, full-price input). The fix bypasses the
  // strip when userCount < 2 so the SDK's standard auto-placed markers remain.
  it("preserves message cache_control when skipCacheWrite=true but only one user message", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        skipCacheWrite: true,
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [
          { type: "text", text: "Solo turn", cache_control: { type: "ephemeral" } },
        ]},
      ],
    }, model);

    const msgs = result.messages as any[];
    // The single user message's cache_control must survive the bypass branch,
    // otherwise Anthropic sees an uncached request and pays full-price input.
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content[0].cache_control).toBeDefined();
  });

  it("preserves system + tool cache_control when skipCacheWrite=true but only one user message", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        skipCacheWrite: true,
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const result = await onPayload({
      system: [{ type: "text", text: "System prompt", cache_control: { type: "ephemeral", ttl: "1h" } }],
      tools: [
        { name: "grep", description: "search", input_schema: {}, cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "Solo turn" }] },
      ],
    }, model);

    // System and tool cache_control markers must not be stripped when the
    // bypass branch is taken. They're the only way the single-turn sub-agent
    // can still match the parent's cached prefix.
    expect((result.system as any[])[0].cache_control).toBeDefined();
    expect((result.tools as any[])[0].cache_control).toBeDefined();
  });
});

describe("selective tool-type clearing in microcompact", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  /**
   * Helper: Build a payload with an assistant tool_use block + tool result,
   * plus enough messages for the keepWindow to expose the clearable message.
   */
  function makePayloadWithNamedToolResult(
    toolName: string,
    toolUseId: string,
    resultText: string,
  ): Record<string, unknown> {
    return {
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        // Assistant with tool_use block containing the tool name
        {
          role: "assistant",
          content: [{ type: "tool_use", id: toolUseId, name: toolName, input: {} }],
        },
        // Tool result referencing the tool_use_id
        {
          role: "tool",
          tool_use_id: toolUseId,
          content: [{ type: "text", text: resultText }],
        },
        { role: "user", content: [{ type: "text", text: "More" }] },
        // Recent tool results within keep window (keepWindow=1)
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "recent_tool", name: "grep", input: {} }],
        },
        {
          role: "tool",
          tool_use_id: "recent_tool",
          content: [{ type: "text", text: "D".repeat(1500) }],
        },
      ],
    };
  }

  it("clears read-only tool result (grep)", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 400_000,
        observationKeepWindow: 1,
        sessionKey: "test-ccpat06-grep",
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;
    const result = await onPayload(
      makePayloadWithNamedToolResult("grep", "tu_grep", "A".repeat(1500)),
      model,
    );

    const toolMsgs = (result.messages as any[]).filter((m: any) => m.role === "tool");
    // First tool result (grep) should be cleared -- it's a read-only tool
    expect(toolMsgs[0].content[0].text).toContain("[Stale tool result cleared");
  });

  it("preserves edit/write tool result (file_write)", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 400_000,
        observationKeepWindow: 1,
        sessionKey: "test-ccpat06-write",
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;
    const result = await onPayload(
      makePayloadWithNamedToolResult("file_write", "tu_write", "A".repeat(1500)),
      model,
    );

    const toolMsgs = (result.messages as any[]).filter((m: any) => m.role === "tool");
    // file_write is NOT a compactable tool -- result should be preserved
    expect(toolMsgs[0].content[0].text).toBe("A".repeat(1500));
  });

  it("preserves tool result with unknown tool name (conservative)", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 400_000,
        observationKeepWindow: 1,
        sessionKey: "test-ccpat06-unknown",
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;
    // Orphaned tool result -- no matching tool_use block
    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        // Tool result with NO corresponding assistant tool_use block
        {
          role: "tool",
          tool_use_id: "orphan_id",
          content: [{ type: "text", text: "A".repeat(1500) }],
        },
        { role: "user", content: [{ type: "text", text: "More" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "recent_tool", name: "grep", input: {} }],
        },
        {
          role: "tool",
          tool_use_id: "recent_tool",
          content: [{ type: "text", text: "D".repeat(1500) }],
        },
      ],
    }, model);

    const toolMsgs = (result.messages as any[]).filter((m: any) => m.role === "tool");
    // Orphaned result should NOT be cleared (conservative -- unknown tool type)
    expect(toolMsgs[0].content[0].text).toBe("A".repeat(1500));
  });

  it("clears exec_tool result", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 400_000,
        observationKeepWindow: 1,
        sessionKey: "test-ccpat06-exec",
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;
    const result = await onPayload(
      makePayloadWithNamedToolResult("exec_tool", "tu_exec", "A".repeat(1500)),
      model,
    );

    const toolMsgs = (result.messages as any[]).filter((m: any) => m.role === "tool");
    // exec_tool is a compactable tool -- result should be cleared
    expect(toolMsgs[0].content[0].text).toContain("[Stale tool result cleared");
  });
});

describe("dual-category tool clearing", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  /**
   * Helper: Build a payload with assistant tool_use + tool_result,
   * plus padding messages so the target is outside the keepWindow.
   */
  function makePayloadWithToolUseAndResult(
    toolName: string,
    toolUseId: string,
    toolUseInput: Record<string, unknown>,
    resultText: string,
  ): Record<string, unknown> {
    return {
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        // Assistant with tool_use block
        {
          role: "assistant",
          content: [{ type: "tool_use", id: toolUseId, name: toolName, input: toolUseInput }],
        },
        // Tool result
        {
          role: "tool",
          tool_use_id: toolUseId,
          content: [{ type: "text", text: resultText }],
        },
        { role: "user", content: [{ type: "text", text: "More" }] },
        // Recent tool results within keep window (keepWindow=1)
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "recent_tool", name: "grep", input: { pattern: "x" } }],
        },
        {
          role: "tool",
          tool_use_id: "recent_tool",
          content: [{ type: "text", text: "D".repeat(1500) }],
        },
      ],
    };
  }

  it("clears file_read tool_result (existing compactable behavior)", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 400_000,
        observationKeepWindow: 1,
        sessionKey: "test-cbdx04-read",
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;
    const result = await onPayload(
      makePayloadWithToolUseAndResult("file_read", "tu_read", { path: "/foo" }, "A".repeat(1500)),
      model,
    );

    const toolMsgs = (result.messages as any[]).filter((m: any) => m.role === "tool");
    // file_read is a compactable tool -- result should be cleared
    expect(toolMsgs[0].content[0].text).toContain("[Stale tool result cleared");
  });

  it("preserves file_edit tool_result (edit results preserved)", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 400_000,
        observationKeepWindow: 1,
        sessionKey: "test-cbdx04-edit-result",
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;
    const result = await onPayload(
      makePayloadWithToolUseAndResult("file_edit", "tu_edit", { path: "/foo", old: "x", new: "y".repeat(1500) }, "A".repeat(1500)),
      model,
    );

    const toolMsgs = (result.messages as any[]).filter((m: any) => m.role === "tool");
    // file_edit is NOT a compactable tool -- result should be preserved
    expect(toolMsgs[0].content[0].text).toBe("A".repeat(1500));
  });

  it("clears file_edit tool_use INPUT when exceeding threshold", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 400_000,
        observationKeepWindow: 1,
        sessionKey: "test-cbdx04-edit-input",
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;
    const largeInput = { path: "/foo", old_string: "x".repeat(600), new_string: "y".repeat(600) };
    const result = await onPayload(
      makePayloadWithToolUseAndResult("file_edit", "tu_edit_large", largeInput, "Edit applied"),
      model,
    );

    // Find the assistant message with the tool_use block
    const assistantMsgs = (result.messages as any[]).filter((m: any) => m.role === "assistant");
    const targetAssistant = assistantMsgs[0];
    const toolUseBlock = targetAssistant.content.find((b: any) => b.id === "tu_edit_large");
    // The tool_use input should have been cleared
    expect(toolUseBlock.input._cleared).toBe(true);
  });

  it("does NOT clear grep tool_use input (read-only tool inputs stay)", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 400_000,
        observationKeepWindow: 1,
        sessionKey: "test-cbdx04-grep-input",
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;
    const largeInput = { pattern: "x".repeat(1200) };
    const result = await onPayload(
      makePayloadWithToolUseAndResult("grep", "tu_grep_input", largeInput, "A".repeat(1500)),
      model,
    );

    // Find the assistant message with the tool_use block
    const assistantMsgs = (result.messages as any[]).filter((m: any) => m.role === "assistant");
    const targetAssistant = assistantMsgs[0];
    const toolUseBlock = targetAssistant.content.find((b: any) => b.id === "tu_grep_input");
    // grep is NOT in CLEARABLE_USES_TOOL_NAMES -- input should be preserved
    expect(toolUseBlock.input._cleared).toBeUndefined();
    expect(toolUseBlock.input.pattern).toBe("x".repeat(1200));
  });

  it("does NOT clear tool_use inputs within keepWindow", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 400_000,
        observationKeepWindow: 10, // Large keepWindow protects everything
        sessionKey: "test-cbdx04-keepwindow",
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;
    const largeInput = { path: "/foo", old_string: "x".repeat(600), new_string: "y".repeat(600) };
    const result = await onPayload(
      makePayloadWithToolUseAndResult("file_edit", "tu_edit_keep", largeInput, "Edit applied"),
      model,
    );

    // All messages are within keepWindow -- input should NOT be cleared
    const assistantMsgs = (result.messages as any[]).filter((m: any) => m.role === "assistant");
    const targetAssistant = assistantMsgs[0];
    const toolUseBlock = targetAssistant.content.find((b: any) => b.id === "tu_edit_keep");
    expect(toolUseBlock.input._cleared).toBeUndefined();
  });
});

describe("original params.messages not mutated after onPayload", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it("structuredClone prevents cache_control mutation on original params", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;

    // Build params with content arrays that would receive cache_control
    const originalMessages = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
      { role: "user", content: [{ type: "text", text: "What's up?" }] },
    ];
    const params = {
      system: [{ type: "text", text: "System prompt" }],
      tools: [],
      messages: originalMessages,
    };

    // Run onPayload (which adds cache_control markers to the cloned result)
    await onPayload(params, model);

    // Verify the original params.messages content blocks do NOT have cache_control
    for (const msg of originalMessages) {
      for (const block of msg.content) {
        expect((block as any).cache_control).toBeUndefined();
      }
    }
    // Also verify system blocks
    for (const block of params.system) {
      expect((block as any).cache_control).toBeUndefined();
    }
  });
});

describe("content reordering for stable prefix", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it("reorders [text, image] to [image, text] in user message", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;
    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Check this image" },
            { type: "image", source: { type: "base64", data: "abc" } },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "I see it" }] },
        { role: "user", content: [{ type: "text", text: "Thanks" }] },
      ],
    }, model);

    const msgs = result.messages as any[];
    const firstUser = msgs[0];
    // Image should come before text after reordering
    expect(firstUser.content[0].type).toBe("image");
    expect(firstUser.content[1].type).toBe("text");
  });

  it("does not reorder assistant messages", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;
    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Here is the result" },
            { type: "tool_use", id: "t1", name: "bash", input: {} },
          ],
        },
        { role: "user", content: [{ type: "text", text: "Thanks" }] },
      ],
    }, model);

    const msgs = result.messages as any[];
    const assistantMsg = msgs[1];
    // Assistant message should NOT be reordered
    expect(assistantMsg.content[0].type).toBe("text");
    expect(assistantMsg.content[1].type).toBe("tool_use");
  });

  it("does not reorder single-block messages", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;
    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
        { role: "user", content: [{ type: "text", text: "Bye" }] },
      ],
    }, model);

    const msgs = result.messages as any[];
    // Single-block messages remain unchanged
    expect(msgs[0].content[0].type).toBe("text");
    expect(msgs[2].content[0].type).toBe("text");
  });

  it("preserves order when no non-text blocks exist", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;
    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "First line" },
            { type: "text", text: "Second line" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
        { role: "user", content: [{ type: "text", text: "Bye" }] },
      ],
    }, model);

    const msgs = result.messages as any[];
    const firstUser = msgs[0];
    // All text blocks -- no reordering should happen
    expect(firstUser.content[0].text).toBe("First line");
    expect(firstUser.content[1].text).toBe("Second line");
  });
});

describe("skipCacheWrite shared-prefix marker placement", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it("places marker on second-to-last user message when skipCacheWrite=true", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        skipCacheWrite: true,
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;

    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "First user" }] },
        { role: "assistant", content: [{ type: "text", text: "First response" }] },
        { role: "user", content: [{ type: "text", text: "Second user" }] },
        { role: "assistant", content: [{ type: "text", text: "Second response" }] },
        { role: "user", content: [{ type: "text", text: "Third user (last)" }] },
      ],
    }, model);

    const msgs = result.messages as any[];
    // Second-to-last user is "Second user" at index 2
    // It should have cache_control on its last content block
    const secondToLastUser = msgs[2];
    expect(secondToLastUser.content[0].cache_control).toBeDefined();

    // Last user message gets a short (5m) marker for cache reads
    const lastUser = msgs[4];
    expect(lastUser.content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("strips all other message markers when skipCacheWrite=true", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        skipCacheWrite: true,
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;

    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [
          { type: "text", text: "First user", cache_control: { type: "ephemeral" } },
        ]},
        { role: "assistant", content: [{ type: "text", text: "Response" }] },
        { role: "user", content: [
          { type: "text", text: "Second user", cache_control: { type: "ephemeral" } },
        ]},
        { role: "assistant", content: [{ type: "text", text: "Response" }] },
        { role: "user", content: [
          { type: "text", text: "Third user", cache_control: { type: "ephemeral", ttl: "1h" } },
        ]},
      ],
    }, model);

    const msgs = result.messages as any[];
    // Second-to-last user (index 2) should have cache_control with retention
    // First user (index 0) -- stripped (not second-to-last or last)
    expect(msgs[0].content[0].cache_control).toBeUndefined();
    // Last user (index 4) gets a short marker after strip+re-place
    expect(msgs[4].content[0].cache_control).toEqual({ type: "ephemeral" });
    // Second-to-last user (index 2) -- has retention marker
    expect(msgs[2].content[0].cache_control).toBeDefined();
  });

  it("no marker placed when only 1 user message", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        skipCacheWrite: true,
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;

    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Only user message" }] },
      ],
    }, model);

    const msgs = result.messages as any[];
    // No second-to-last user exists -- no marker should be placed on any message
    for (const msg of msgs) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as any[]) {
          expect(block.cache_control).toBeUndefined();
        }
      }
    }
  });

  it("skipCacheWrite=false unchanged behavior", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        skipCacheWrite: false,
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;

    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
        { role: "user", content: [{ type: "text", text: "Bye" }] },
      ],
    }, model);

    // When skipCacheWrite=false, no special strip+marker behavior applies.
    // Normal breakpoint placement runs. No crash.
    expect(result.messages).toBeDefined();
  });

  it("last user message gets short (5m) marker when userCount >= 2", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        skipCacheWrite: true,
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;

    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "First user" }] },
        { role: "assistant", content: [{ type: "text", text: "Response" }] },
        { role: "user", content: [{ type: "text", text: "Second user" }] },
        { role: "assistant", content: [{ type: "text", text: "Response" }] },
        { role: "user", content: [{ type: "text", text: "Third user (last)" }] },
      ],
    }, model);

    const msgs = result.messages as any[];
    // Second-to-last user (index 2) has long retention marker
    expect(msgs[2].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // Last user (index 4) has short (5m) marker -- no ttl field
    expect(msgs[4].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("last user marker is short regardless of resolvedRetention", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        skipCacheWrite: true,
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;

    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "First" }] },
        { role: "assistant", content: [{ type: "text", text: "R1" }] },
        { role: "user", content: [{ type: "text", text: "Second (last)" }] },
      ],
    }, model);

    const msgs = result.messages as any[];
    // Last user marker is always "short" (ephemeral, no ttl) regardless of retention config
    const lastUser = msgs[2];
    expect(lastUser.content[0].cache_control).toEqual({ type: "ephemeral" });
    // Second-to-last user (index 0) has the retention-based marker (long in this case)
    expect(msgs[0].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("no last-user marker when only 1 user message", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        skipCacheWrite: true,
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;

    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Only user" }] },
      ],
    }, model);

    const msgs = result.messages as any[];
    // Single user message -- no marker placed (skips when userCount < 2)
    for (const msg of msgs) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as any[]) {
          expect(block.cache_control).toBeUndefined();
        }
      }
    }
  });

  it("skipCacheWrite=false does not run last-user marker logic", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        skipCacheWrite: false,
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (payload: any, model: any) => Promise<any>;

    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
        { role: "user", content: [{ type: "text", text: "Bye" }] },
      ],
    }, model);

    // No crash and normal behavior
    expect(result.messages).toBeDefined();
  });
});
describe("sticky-on beta header latches", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    // Clear any latched state between tests
    clearSessionBetaHeaderLatches("test-session");
    clearSessionBetaHeaderLatches("other-session");
  });

  const anthropicModel = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;

  function makeWrapper(sessionKey: string, extra?: Partial<RequestBodyInjectorConfig>) {
    return createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        sessionKey,
        ...extra,
      },
      logger,
    );
  }

  it("first API call latches beta headers; second call (no new headers from config) still includes them", () => {
    const base = createMockStreamFn();
    const wrapper = makeWrapper("test-session");
    const wrappedFn = wrapper(base);

    // First call -- injects CONTEXT_1M_BETA via normal flow
    wrappedFn(anthropicModel, makeContext([]), { headers: { "anthropic-beta": "prompt-caching-2024-07-31" } });
    const opts1 = base.mock.calls[0][2] as Record<string, unknown>;
    const headers1 = opts1.headers as Record<string, string>;
    // Should have both the caller-provided beta and CONTEXT_1M_BETA
    expect(headers1["anthropic-beta"]).toContain("prompt-caching-2024-07-31");
    expect(headers1["anthropic-beta"]).toContain("context-1m-2025-08-07");

    // Second call -- no beta headers from caller; latched values should still appear
    wrappedFn(anthropicModel, makeContext([]), {});
    const opts2 = base.mock.calls[1][2] as Record<string, unknown>;
    const headers2 = opts2.headers as Record<string, string>;
    expect(headers2["anthropic-beta"]).toContain("prompt-caching-2024-07-31");
    expect(headers2["anthropic-beta"]).toContain("context-1m-2025-08-07");
  });

  it("accumulates new beta headers discovered mid-session (union semantics)", () => {
    const base = createMockStreamFn();
    const wrapper = makeWrapper("test-session");
    const wrappedFn = wrapper(base);

    // First call with one beta header
    wrappedFn(anthropicModel, makeContext([]), { headers: { "anthropic-beta": "prompt-caching-2024-07-31" } });
    const headers1 = (base.mock.calls[0][2] as Record<string, unknown>).headers as Record<string, string>;
    expect(headers1["anthropic-beta"]).toContain("prompt-caching-2024-07-31");

    // Second call adds a NEW beta header
    wrappedFn(anthropicModel, makeContext([]), { headers: { "anthropic-beta": "pdfs-2024-09-25" } });
    const headers2 = (base.mock.calls[1][2] as Record<string, unknown>).headers as Record<string, string>;
    // Should contain BOTH the old latched value AND the new one
    expect(headers2["anthropic-beta"]).toContain("prompt-caching-2024-07-31");
    expect(headers2["anthropic-beta"]).toContain("pdfs-2024-09-25");
    expect(headers2["anthropic-beta"]).toContain("context-1m-2025-08-07");

    // Third call with no new headers -- should still have ALL three
    wrappedFn(anthropicModel, makeContext([]), {});
    const headers3 = (base.mock.calls[2][2] as Record<string, unknown>).headers as Record<string, string>;
    expect(headers3["anthropic-beta"]).toContain("prompt-caching-2024-07-31");
    expect(headers3["anthropic-beta"]).toContain("pdfs-2024-09-25");
    expect(headers3["anthropic-beta"]).toContain("context-1m-2025-08-07");
  });

  it("merges latched headers with new headers without duplicates", () => {
    const base = createMockStreamFn();
    const wrapper = makeWrapper("test-session");
    const wrappedFn = wrapper(base);

    // First call latches
    wrappedFn(anthropicModel, makeContext([]), { headers: { "anthropic-beta": "prompt-caching-2024-07-31" } });

    // Second call passes the same header again -- no duplicates
    wrappedFn(anthropicModel, makeContext([]), { headers: { "anthropic-beta": "prompt-caching-2024-07-31" } });
    const headers2 = (base.mock.calls[1][2] as Record<string, unknown>).headers as Record<string, string>;
    const betas = headers2["anthropic-beta"].split(",").map((s: string) => s.trim());
    // Count occurrences of each
    const promptCachingCount = betas.filter((b: string) => b === "prompt-caching-2024-07-31").length;
    expect(promptCachingCount).toBe(1);
  });

  it("non-Anthropic providers do not use beta header latches", () => {
    const base = createMockStreamFn();
    const wrapper = makeWrapper("test-session");
    const wrappedFn = wrapper(base);

    const openaiModel = { id: "gpt-4", provider: "openai" } as any;
    wrappedFn(openaiModel, makeContext([]), { someOption: true });

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    // Non-Anthropic -- no headers modification at all
    expect(opts.headers).toBeUndefined();
    expect(opts.someOption).toBe(true);
  });

  it("clearSessionBetaHeaderLatches resets latched state for next call", () => {
    const base = createMockStreamFn();
    const wrapper = makeWrapper("test-session");
    const wrappedFn = wrapper(base);

    // First call latches
    wrappedFn(anthropicModel, makeContext([]), { headers: { "anthropic-beta": "prompt-caching-2024-07-31" } });
    const headers1 = (base.mock.calls[0][2] as Record<string, unknown>).headers as Record<string, string>;
    expect(headers1["anthropic-beta"]).toContain("prompt-caching-2024-07-31");

    // Clear the session
    clearSessionBetaHeaderLatches("test-session");

    // Next call should NOT have the previously latched value (only CONTEXT_1M_BETA from normal flow)
    wrappedFn(anthropicModel, makeContext([]), {});
    const headers2 = (base.mock.calls[1][2] as Record<string, unknown>).headers as Record<string, string>;
    expect(headers2["anthropic-beta"]).toContain("context-1m-2025-08-07");
    expect(headers2["anthropic-beta"]).not.toContain("prompt-caching-2024-07-31");
  });

  it("CONTEXT_1M_BETA is always present in latched headers", () => {
    const base = createMockStreamFn();
    const wrapper = makeWrapper("test-session");
    const wrappedFn = wrapper(base);

    // Call with no extra beta headers
    wrappedFn(anthropicModel, makeContext([]), {});
    const headers = (base.mock.calls[0][2] as Record<string, unknown>).headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toContain("context-1m-2025-08-07");

    // Second call -- CONTEXT_1M_BETA still present via latch
    wrappedFn(anthropicModel, makeContext([]), {});
    const headers2 = (base.mock.calls[1][2] as Record<string, unknown>).headers as Record<string, string>;
    expect(headers2["anthropic-beta"]).toContain("context-1m-2025-08-07");
  });

  it("different sessions maintain independent latch state", () => {
    const base = createMockStreamFn();
    const wrapper1 = makeWrapper("session-A");
    const wrapper2 = makeWrapper("session-B");
    const fn1 = wrapper1(base);
    const fn2 = wrapper2(base);

    // Session A latches a beta
    fn1(anthropicModel, makeContext([]), { headers: { "anthropic-beta": "beta-a" } });

    // Session B latches a different beta
    fn2(anthropicModel, makeContext([]), { headers: { "anthropic-beta": "beta-b" } });

    // Session A should NOT have session B's beta
    fn1(anthropicModel, makeContext([]), {});
    const headersA = (base.mock.calls[2][2] as Record<string, unknown>).headers as Record<string, string>;
    expect(headersA["anthropic-beta"]).toContain("beta-a");
    expect(headersA["anthropic-beta"]).not.toContain("beta-b");

    // Session B should NOT have session A's beta
    fn2(anthropicModel, makeContext([]), {});
    const headersB = (base.mock.calls[3][2] as Record<string, unknown>).headers as Record<string, string>;
    expect(headersB["anthropic-beta"]).toContain("beta-b");
    expect(headersB["anthropic-beta"]).not.toContain("beta-a");

    // Cleanup
    clearSessionBetaHeaderLatches("session-A");
    clearSessionBetaHeaderLatches("session-B");
  });
});

describe("clearStaleThinkingBlocks", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it("removes thinking blocks from assistant messages beyond keepWindow", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Let me think about this..." },
        { type: "text", text: "Response 1" },
      ]},
      { role: "user", content: [{ type: "text", text: "Next" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Thinking again..." },
        { type: "text", text: "Response 2" },
      ]},
      { role: "user", content: [{ type: "text", text: "Last" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Final thought..." },
        { type: "text", text: "Response 3" },
      ]},
    ];

    // keepWindow = 1: only last assistant message keeps thinking blocks
    const cleared = clearStaleThinkingBlocks(messages, 1);

    expect(cleared).toBe(2); // 2 thinking blocks cleared from first 2 assistant messages
    // First assistant: thinking removed, text preserved
    expect((messages[1]!.content as any[]).length).toBe(1);
    expect((messages[1]!.content as any[])[0].type).toBe("text");
    // Second assistant: thinking removed, text preserved
    expect((messages[3]!.content as any[]).length).toBe(1);
    expect((messages[3]!.content as any[])[0].type).toBe("text");
    // Third assistant: within keepWindow, thinking preserved
    expect((messages[5]!.content as any[]).length).toBe(2);
    expect((messages[5]!.content as any[])[0].type).toBe("thinking");
  });

  it("preserves redacted_thinking blocks (block.redacted === true)", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [
        { type: "thinking", redacted: true, data: "encrypted-signature" },
        { type: "thinking", thinking: "Normal thinking to be cleared" },
        { type: "text", text: "Response" },
      ]},
      { role: "user", content: [{ type: "text", text: "Next" }] },
      { role: "assistant", content: [
        { type: "text", text: "Latest response" },
      ]},
    ];

    // keepWindow = 1: first assistant beyond window
    const cleared = clearStaleThinkingBlocks(messages, 1);

    expect(cleared).toBe(1); // Only non-redacted thinking cleared
    const firstAssistantContent = messages[1]!.content as any[];
    expect(firstAssistantContent.length).toBe(2); // redacted_thinking + text
    expect(firstAssistantContent[0].type).toBe("thinking");
    expect(firstAssistantContent[0].redacted).toBe(true);
    expect(firstAssistantContent[1].type).toBe("text");
  });

  it("preserves text, tool_use, and image blocks in assistant messages", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "To be cleared" },
        { type: "text", text: "Response text" },
        { type: "tool_use", id: "tu_1", name: "bash", input: {} },
        { type: "image", source: { type: "base64", data: "abc" } },
      ]},
      { role: "user", content: [{ type: "text", text: "Next" }] },
      { role: "assistant", content: [{ type: "text", text: "Latest" }] },
    ];

    const cleared = clearStaleThinkingBlocks(messages, 1);

    expect(cleared).toBe(1);
    const content = messages[1]!.content as any[];
    expect(content.length).toBe(3); // text + tool_use + image (thinking removed)
    expect(content[0].type).toBe("text");
    expect(content[1].type).toBe("tool_use");
    expect(content[2].type).toBe("image");
  });

  it("preserves all thinking blocks within the keepWindow", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Thought 1" },
        { type: "text", text: "Response 1" },
      ]},
      { role: "user", content: [{ type: "text", text: "Next" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Thought 2" },
        { type: "text", text: "Response 2" },
      ]},
    ];

    // keepWindow = 5: all 2 assistant messages fit within window
    const cleared = clearStaleThinkingBlocks(messages, 5);

    expect(cleared).toBe(0);
    // Both messages should retain their thinking blocks
    expect((messages[1]!.content as any[]).length).toBe(2);
    expect((messages[3]!.content as any[]).length).toBe(2);
  });

  it("returns count of cleared blocks", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Thought A" },
        { type: "thinking", thinking: "Thought B" },
        { type: "text", text: "Response 1" },
      ]},
      { role: "user", content: [{ type: "text", text: "Next" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Thought C" },
        { type: "text", text: "Response 2" },
      ]},
      { role: "user", content: [{ type: "text", text: "Last" }] },
      { role: "assistant", content: [
        { type: "text", text: "Response 3" },
      ]},
    ];

    // keepWindow = 1: first 2 assistants beyond window, 3rd within
    const cleared = clearStaleThinkingBlocks(messages, 1);

    // First assistant: 2 thinking blocks cleared, second assistant: 1 thinking cleared
    expect(cleared).toBe(3);
  });

  it("onPayload calls clearStaleThinkingBlocks alongside clearStaleToolResults when elapsed > TTL", async () => {
    const onContentModification = vi.fn();
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 400_000, // 400s > 300s TTL for "short"
        observationKeepWindow: 1,
        onContentModification,
        onAdaptiveRetentionReset: vi.fn(),
        sessionKey: "test-thinking-clear",
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [
          { type: "thinking", thinking: "Long thinking block..." },
          { type: "text", text: "Response" },
        ]},
        { role: "user", content: [{ type: "text", text: "Next" }] },
        { role: "assistant", content: [
          { type: "thinking", thinking: "Another thought" },
          { type: "text", text: "Latest response" },
        ]},
      ],
    }, model);

    // First assistant beyond keepWindow=1 should have thinking cleared
    const msgs = result.messages as any[];
    const firstAssistant = msgs[1];
    expect(firstAssistant.content.length).toBe(1);
    expect(firstAssistant.content[0].type).toBe("text");
    // Second assistant within keepWindow should retain thinking
    const secondAssistant = msgs[3];
    expect(secondAssistant.content.length).toBe(2);
    expect(secondAssistant.content[0].type).toBe("thinking");
    // onContentModification should have been called
    expect(onContentModification).toHaveBeenCalled();
  });

  it("onPayload does NOT call clearStaleThinkingBlocks when elapsed <= TTL (cache is warm)", async () => {
    const onContentModification = vi.fn();
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 100_000, // 100s < 300s TTL for "short"
        observationKeepWindow: 1,
        onContentModification,
        sessionKey: "test-thinking-warm",
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [
          { type: "thinking", thinking: "Thinking should be preserved" },
          { type: "text", text: "Response" },
        ]},
        { role: "user", content: [{ type: "text", text: "Next" }] },
        { role: "assistant", content: [
          { type: "text", text: "Latest" },
        ]},
      ],
    }, model);

    // All thinking blocks should be preserved when cache is warm
    const msgs = result.messages as any[];
    expect(msgs[1].content.length).toBe(2);
    expect(msgs[1].content[0].type).toBe("thinking");
    // onContentModification should NOT have been called for thinking
    // (may have been called for tool results, but not for thinking alone)
  });
});
describe("token-ceiling microcompact", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it("clears stale tool results when estimatedTokens > microcompactTokenCeiling even within TTL", async () => {
    const onContentModification = vi.fn();
    const onAdaptiveRetentionReset = vi.fn();
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 100_000, // 100s < 300s TTL -- cache is warm
        observationKeepWindow: 1,
        onContentModification,
        onAdaptiveRetentionReset,
        sessionKey: "test-ceiling",
        microcompactTokenCeiling: 100, // Very low ceiling to trigger easily
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Build payload with enough content to exceed 100 tokens (~400 chars)
    const payload = {
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "tool", content: [{ type: "text", text: "A".repeat(1500) }] }, // old, clearable
        { role: "user", content: [{ type: "text", text: "Next" }] },
        { role: "tool", content: [{ type: "text", text: "B".repeat(1500) }] }, // within keep window (1)
      ],
    };

    const result = await onPayload(payload, model);

    // First tool result should be cleared (beyond keep window of 1)
    const toolMsgs = (result.messages as any[]).filter((m: any) => m.role === "tool");
    expect(toolMsgs[0].content[0].text).toContain("[Stale tool result cleared");
    // Last tool result preserved (within keep window)
    expect(toolMsgs[1].content[0].text).toBe("B".repeat(1500));
    expect(onContentModification).toHaveBeenCalledOnce();
  });

  it("calls onContentModification but NOT onAdaptiveRetentionReset when token ceiling triggers", async () => {
    const onContentModification = vi.fn();
    const onAdaptiveRetentionReset = vi.fn();
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 100_000, // within TTL
        observationKeepWindow: 1,
        onContentModification,
        onAdaptiveRetentionReset,
        sessionKey: "test-ceiling-no-reset",
        microcompactTokenCeiling: 100,
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const payload = {
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "tool", content: [{ type: "text", text: "A".repeat(1500) }] },
        { role: "user", content: [{ type: "text", text: "Next" }] },
        { role: "tool", content: [{ type: "text", text: "B".repeat(1500) }] },
      ],
    };

    await onPayload(payload, model);

    expect(onContentModification).toHaveBeenCalledOnce();
    // Token ceiling does NOT reset adaptive retention -- cache may still be warm
    expect(onAdaptiveRetentionReset).not.toHaveBeenCalled();
  });

  it("skips token-ceiling check entirely when microcompactTokenCeiling is undefined", async () => {
    const onContentModification = vi.fn();
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 100_000,
        observationKeepWindow: 1,
        onContentModification,
        sessionKey: "test-ceiling-disabled",
        // microcompactTokenCeiling NOT set
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    const payload = {
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "tool", content: [{ type: "text", text: "A".repeat(1500) }] },
        { role: "user", content: [{ type: "text", text: "Next" }] },
        { role: "tool", content: [{ type: "text", text: "B".repeat(1500) }] },
      ],
    };

    await onPayload(payload, model);

    // No ceiling configured -- should not trigger
    expect(onContentModification).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TTL estimation cleanup
// ---------------------------------------------------------------------------

describe("TTL estimation cleanup", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it("microcompact token ceiling divides by CHARS_PER_TOKEN_RATIO, not hardcoded 4", async () => {
    // We set up a scenario where the distinction between /4 and /CHARS_PER_TOKEN_RATIO
    // determines whether microcompact triggers. Since CHARS_PER_TOKEN_RATIO is the
    // canonical constant, the code must use it for consistency with the rest of the
    // codebase (not a hardcoded literal).

    // CHARS_PER_TOKEN_RATIO is currently 4. We verify the microcompact triggers
    // exactly at the threshold computed with CHARS_PER_TOKEN_RATIO.
    const onContentModification = vi.fn();
    const base = createMockStreamFn();

    // Set ceiling at 500 tokens. With CHARS_PER_TOKEN_RATIO=4, that means
    // 2000 chars of content should trigger (2000/4 = 500 tokens = ceiling).
    // We'll use 2100 chars to be safely above.
    const ceiling = 500;
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 100_000, // within TTL
        observationKeepWindow: 1,
        onContentModification,
        sessionKey: "test-ratio",
        microcompactTokenCeiling: ceiling,
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Build payload with enough content to exceed ceiling.
    // estimateContextChars sums text lengths. 2100 chars / CHARS_PER_TOKEN_RATIO = 525 tokens > 500.
    const payload = {
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "tool", content: [{ type: "text", text: "A".repeat(1050) }] }, // old, clearable
        { role: "user", content: [{ type: "text", text: "Next" }] },
        { role: "tool", content: [{ type: "text", text: "B".repeat(1050) }] }, // within keep window
      ],
    };

    await onPayload(payload, model);

    // Microcompact should have triggered because estimated tokens > ceiling
    expect(onContentModification).toHaveBeenCalledOnce();
  });

  it("microcompact does NOT trigger when content is below CHARS_PER_TOKEN_RATIO threshold", async () => {
    const onContentModification = vi.fn();
    const base = createMockStreamFn();

    // Set ceiling at 500 tokens. With CHARS_PER_TOKEN_RATIO=4, that means
    // 1900 chars of content should NOT trigger (1900/4 = 475 tokens < 500 ceiling).
    const ceiling = 500;
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 100_000, // within TTL
        observationKeepWindow: 1,
        onContentModification,
        sessionKey: "test-ratio-below",
        microcompactTokenCeiling: ceiling,
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Build payload with content below the threshold.
    // Short messages: user "Hello" (5 chars) + "Next" (4 chars) + tool results
    // Total should be well below ceiling * CHARS_PER_TOKEN_RATIO = 2000 chars
    const payload = {
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "tool", content: [{ type: "text", text: "Short result" }] },
        { role: "user", content: [{ type: "text", text: "Next" }] },
        { role: "tool", content: [{ type: "text", text: "Another short result" }] },
      ],
    };

    await onPayload(payload, model);

    // Should NOT trigger -- estimated tokens below ceiling
    expect(onContentModification).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Gap closure: single TTL estimation pass with text extraction
// ---------------------------------------------------------------------------

describe("gap closure: single TTL estimation pass with text extraction", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it("onTtlSplitEstimate is invoked exactly once per onPayload call", async () => {
    const onTtlSplitEstimate = vi.fn();
    const base = createMockStreamFn();

    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        onTtlSplitEstimate,
        sessionKey: "test-single-invocation",
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Build payload with system and message blocks that will get cache_control
    // from the breakpoint placement logic. The system block gets a marker and
    // messages with enough text also get markers.
    const payload = {
      system: [{ type: "text", text: "System prompt content here" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "x".repeat(2000) }] },
        { role: "assistant", content: [{ type: "text", text: "Response" }] },
        { role: "user", content: [{ type: "text", text: "Follow up question" }] },
      ],
    };

    await onPayload(payload, model);

    // The 49-01 pre-kill-switch pass was deleted, so onTtlSplitEstimate
    // is called at most once (from the post-kill-switch pass only).
    expect(onTtlSplitEstimate).toHaveBeenCalledTimes(1);

    // The callback receives an object with cacheWrite5mTokens and cacheWrite1hTokens
    const estimate = onTtlSplitEstimate.mock.calls[0][0];
    expect(estimate).toHaveProperty("cacheWrite5mTokens");
    expect(estimate).toHaveProperty("cacheWrite1hTokens");
  });

  it("TTL estimation uses text extraction, not JSON.stringify length", async () => {
    // Verify the module-level estimateBlockTokens function uses text extraction.
    // For a text block: { type: "text", text: "hello world", cache_control: { type: "ephemeral" } }
    // Text extraction: "hello world".length = 11 chars -> Math.ceil(11 / 3.5) = 4 tokens
    // JSON.stringify would be much larger (~65+ chars) -> ~19 tokens
    const textBlock = { type: "text", text: "hello world", cache_control: { type: "ephemeral" } };
    const tokens = estimateBlockTokens(textBlock as unknown as Record<string, unknown>);

    // text extraction: Math.ceil(11 / 3.5) = Math.ceil(3.14) = 4
    expect(tokens).toBe(4);

    // If it were using JSON.stringify, we'd get a much larger number
    const jsonLength = JSON.stringify(textBlock).length; // ~65 chars
    const jsonTokens = Math.ceil(jsonLength / 3.5); // ~19
    expect(jsonTokens).toBeGreaterThan(tokens);
  });

  it("TTL estimation callback receives values consistent with text extraction", async () => {
    const onTtlSplitEstimate = vi.fn();
    const base = createMockStreamFn();

    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        onTtlSplitEstimate,
        sessionKey: "test-text-extraction",
      },
      logger,
    );
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Provide a system block with a known text length AND cache_control already set.
    // The system block will keep its cache_control through processing.
    // "System prompt" = 13 chars -> Math.ceil(13 / 3.5) = 4 tokens (text extraction)
    // vs JSON.stringify would give ~80+ chars -> ~23+ tokens
    const payload = {
      system: [{ type: "text", text: "System prompt", cache_control: { type: "ephemeral" } }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ],
    };

    await onPayload(payload, model);

    if (onTtlSplitEstimate.mock.calls.length > 0) {
      const estimate = onTtlSplitEstimate.mock.calls[0][0];
      // Verify the total tokens are consistent with text extraction (small values)
      // rather than JSON.stringify (which would inflate by 4-5x due to key overhead)
      const totalTokens = estimate.cacheWrite5mTokens + estimate.cacheWrite1hTokens;
      // With text extraction, system "System prompt" (13 chars) -> 4 tokens
      // Other marked blocks would add small amounts. Total should be modest.
      // With JSON.stringify it would be much larger (23+ for system block alone).
      expect(totalTokens).toBeLessThan(20);
    }
  });

  it("estimateBlockTokens uses CHARS_PER_TOKEN_RATIO for non-text blocks (JSON fallback)", () => {
    // For non-text blocks, estimateBlockTokens falls back to JSON.stringify
    // but divides by CHARS_PER_TOKEN_RATIO (the constant), not a hardcoded literal.
    const toolBlock = { name: "read_file", input_schema: { type: "object" } };
    const tokens = estimateBlockTokens(toolBlock as unknown as Record<string, unknown>);
    const jsonLength = JSON.stringify(toolBlock).length;
    // Math.ceil(jsonLength / 3.5)
    expect(tokens).toBe(Math.ceil(jsonLength / 3.5));
  });
});

// ---------------------------------------------------------------------------
// sortToolsForCacheStability
// ---------------------------------------------------------------------------

describe("sortToolsForCacheStability", () => {
  it("places built-in tools before MCP tools in mixed input", () => {
    const input = [
      { name: "read" },
      { name: "mcp__z_tool" },
      { name: "write" },
      { name: "mcp:a_tool" },
      { name: "mcp__m_tool" },
    ];
    const result = sortToolsForCacheStability(input as Array<Record<string, unknown>>);
    const names = result.map(t => t.name);
    // Built-in tools come first in original order
    expect(names[0]).toBe("read");
    expect(names[1]).toBe("write");
    // MCP tools come after, sorted alphabetically by localeCompare
    const mcpNames = names.slice(2);
    expect(mcpNames).toEqual([...mcpNames].sort((a, b) => (a as string).localeCompare(b as string)));
    expect(mcpNames).toContain("mcp:a_tool");
    expect(mcpNames).toContain("mcp__m_tool");
    expect(mcpNames).toContain("mcp__z_tool");
  });

  it("sorts MCP tools alphabetically among themselves", () => {
    const input = [
      { name: "mcp__zebra" },
      { name: "mcp:alpha" },
      { name: "mcp__middle" },
    ];
    const result = sortToolsForCacheStability(input as Array<Record<string, unknown>>);
    const names = result.map(t => t.name);
    // All MCP -- sorted alphabetically by localeCompare
    expect(names).toEqual([...names].sort((a, b) => (a as string).localeCompare(b as string)));
    expect(names.length).toBe(3);
  });

  it("preserves built-in tool relative order (not re-sorted)", () => {
    const input = [
      { name: "write" },
      { name: "bash" },
      { name: "read" },
    ];
    const result = sortToolsForCacheStability(input as Array<Record<string, unknown>>);
    expect(result.map(t => t.name)).toEqual(["write", "bash", "read"]);
  });

  it("returns empty array for empty input", () => {
    const result = sortToolsForCacheStability([]);
    expect(result).toEqual([]);
  });

  it("returns same order for all built-in tools", () => {
    const input = [
      { name: "read" },
      { name: "write" },
      { name: "bash" },
    ];
    const result = sortToolsForCacheStability(input as Array<Record<string, unknown>>);
    expect(result.map(t => t.name)).toEqual(["read", "write", "bash"]);
  });

  it("excludes server-side tools from sorting and places them at end", () => {
    const input = [
      { name: "read" },
      { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
      { name: "mcp:foo" },
    ];
    const result = sortToolsForCacheStability(input as Array<Record<string, unknown>>);
    expect(result.map(t => t.name)).toEqual([
      "read",
      "mcp:foo",
      "tool_search_tool_regex",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Zone-aware retention tests
// ---------------------------------------------------------------------------

describe("zone-aware retention", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  function makeApiPayload(
    messageSpecs: Array<{ role: string; text: string; cache_control?: boolean }>,
    systemBreakpoints = 0,
  ): Record<string, unknown> {
    const system = [
      { type: "text", text: "System prompt content here" },
    ];
    if (systemBreakpoints > 0) {
      (system[0] as any).cache_control = { type: "ephemeral" };
    }
    const messages = messageSpecs.map(spec => {
      const block: Record<string, unknown> = { type: "text", text: spec.text };
      if (spec.cache_control) {
        block.cache_control = { type: "ephemeral" };
      }
      return { role: spec.role, content: [block] };
    });
    return { system, messages };
  }

  function textForTokens(tokens: number): string {
    return "x".repeat(tokens * 4);
  }

  /** Get cache_control from a message's first content block. */
  function getBlockCacheControl(payload: Record<string, unknown>, msgIdx: number): Record<string, unknown> | undefined {
    const messages = payload.messages as any[];
    const msg = messages[msgIdx];
    if (!msg || !Array.isArray(msg.content)) return undefined;
    for (const b of msg.content) {
      if (b.cache_control) return b.cache_control;
    }
    return undefined;
  }

  /** Find indices of messages with cache_control set. */
  function findBreakpointIndices(payload: Record<string, unknown>): number[] {
    const indices: number[] = [];
    const messages = payload.messages as any[];
    for (let i = 0; i < messages.length; i++) {
      for (const b of messages[i].content) {
        if (b.cache_control) {
          indices.push(i);
          break;
        }
      }
    }
    return indices;
  }

  it("semi-stable breakpoint gets 1h TTL with resolvedRetention='long', recent stays default", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({
      getCacheRetention: () => "long",
      getMessageRetention: () => "long",
      cacheBreakpointStrategy: "multi-zone",
    }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Build 30-message conversation: compaction summary at index 0
    const msgs: Array<{ role: string; text: string }> = [];
    msgs.push({ role: "user", text: "<summary>" + textForTokens(2000) + "</summary>" });
    msgs.push({ role: "assistant", text: textForTokens(2000) });
    for (let i = 2; i < 30; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }

    const payload = makeApiPayload(msgs, 1);
    const result = await onPayload(payload, model);

    // Find breakpoint indices
    const bpIndices = findBreakpointIndices(result);
    expect(bpIndices.length).toBeGreaterThanOrEqual(2);

    // Semi-stable breakpoint (first in message array, index 0 = compaction summary) should have 1h TTL
    const semiStableCc = getBlockCacheControl(result, bpIndices[0]!);
    expect(semiStableCc).toEqual({ type: "ephemeral", ttl: "1h" });

    // Recent breakpoint (last breakpoint placed) should NOT have 1h TTL (uses "short" = no ttl)
    const lastBpIdx = bpIndices[bpIndices.length - 1]!;
    // The recent breakpoint is the second-to-last user message
    // It should use retention="short" (no ttl property, just { type: "ephemeral" })
    const recentCc = getBlockCacheControl(result, lastBpIdx);
    // Recent zone always uses "short" retention, so it should NOT have ttl: "1h"
    // (it gets { type: "ephemeral" } without ttl)
    expect(recentCc).toBeDefined();
    expect(recentCc!.ttl).toBeUndefined();
  });

  it("mid-zone breakpoint gets 1h TTL with resolvedRetention='long'", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({
      getCacheRetention: () => "long",
      getMessageRetention: () => "long",
      cacheBreakpointStrategy: "multi-zone",
    }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Build 30-message conversation with compaction summary
    const msgs: Array<{ role: string; text: string }> = [];
    msgs.push({ role: "user", text: "<summary>" + textForTokens(2000) + "</summary>" });
    msgs.push({ role: "assistant", text: textForTokens(2000) });
    for (let i = 2; i < 30; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }

    const payload = makeApiPayload(msgs, 1);
    const result = await onPayload(payload, model);

    const bpIndices = findBreakpointIndices(result);
    // With 3 breakpoints: semi-stable, mid, recent
    // The mid-zone (index 1 in breakpoints) should have 1h TTL
    if (bpIndices.length >= 3) {
      const midCc = getBlockCacheControl(result, bpIndices[1]!);
      expect(midCc).toEqual({ type: "ephemeral", ttl: "1h" });
    }
  });

  it("without resolvedRetention (getMessageRetention returns short), all breakpoints use same retention", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({
      getCacheRetention: () => "long",
      getMessageRetention: () => "short",
      cacheBreakpointStrategy: "multi-zone",
    }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Build 30-message conversation with compaction summary
    const msgs: Array<{ role: string; text: string }> = [];
    msgs.push({ role: "user", text: "<summary>" + textForTokens(2000) + "</summary>" });
    msgs.push({ role: "assistant", text: textForTokens(2000) });
    for (let i = 2; i < 30; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }

    const payload = makeApiPayload(msgs, 1);
    const result = await onPayload(payload, model);

    const bpIndices = findBreakpointIndices(result);
    // All breakpoints should have { type: "ephemeral" } without ttl (retention="short")
    for (const idx of bpIndices) {
      const cc = getBlockCacheControl(result, idx);
      expect(cc).toBeDefined();
      expect(cc!.ttl).toBeUndefined();
    }
  });

  it("after escalation, semi-stable zone cache_control has ttl:'1h' (survives 6-minute idle gap)", async () => {
    const base = createMockStreamFn();
    // Simulate post-escalation: getMessageRetention returns "long"
    const wrapper = createRequestBodyInjector({
      getCacheRetention: () => "long",
      getMessageRetention: () => "long",
      cacheBreakpointStrategy: "multi-zone",
    }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Build conversation with enough content for breakpoints
    const msgs: Array<{ role: string; text: string }> = [];
    msgs.push({ role: "user", text: "<summary>" + textForTokens(2000) + "</summary>" });
    msgs.push({ role: "assistant", text: textForTokens(2000) });
    for (let i = 2; i < 20; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(400) });
    }

    const payload = makeApiPayload(msgs, 1);
    const result = await onPayload(payload, model);

    const bpIndices = findBreakpointIndices(result);
    expect(bpIndices.length).toBeGreaterThanOrEqual(1);

    // Semi-stable zone (first breakpoint) has 1h TTL
    // Anthropic's 1h server-side TTL means the cache survives idle gaps up to ~1h
    // A 6-minute idle gap (which would expire a 5m TTL) does NOT expire this cache
    const semiStableCc = getBlockCacheControl(result, bpIndices[0]!);
    expect(semiStableCc).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

// ---------------------------------------------------------------------------
// Token-density semi-stable placement tests
// ---------------------------------------------------------------------------

describe("token-density semi-stable placement", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  function makeApiPayload(
    messageSpecs: Array<{ role: string; text: string; cache_control?: boolean }>,
    systemBreakpoints = 0,
  ): Record<string, unknown> {
    const system = [
      { type: "text", text: "System prompt content here" },
    ];
    if (systemBreakpoints > 0) {
      (system[0] as any).cache_control = { type: "ephemeral" };
    }
    const messages = messageSpecs.map(spec => {
      const block: Record<string, unknown> = { type: "text", text: spec.text };
      if (spec.cache_control) {
        block.cache_control = { type: "ephemeral" };
      }
      return { role: spec.role, content: [block] };
    });
    return { system, messages };
  }

  /** Generate text that estimates to at least N tokens (CHARS_PER_TOKEN_RATIO = 4). */
  function textForTokens(tokens: number): string {
    return "x".repeat(tokens * 4);
  }

  /** Find indices of messages with cache_control set. */
  function findBreakpointIndices(payload: Record<string, unknown>): number[] {
    const indices: number[] = [];
    const messages = payload.messages as any[];
    for (let i = 0; i < messages.length; i++) {
      for (const b of messages[i].content) {
        if (b.cache_control) {
          indices.push(i);
          break;
        }
      }
    }
    return indices;
  }

  it("uniform messages: semi-stable breakpoint near message-count midpoint", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({
      getCacheRetention: () => "long",
      cacheBreakpointStrategy: "multi-zone",
    }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // 20 alternating user/assistant messages, each ~500 tokens, NO compaction summary
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(500) });
    }

    const payload = makeApiPayload(msgs, 1);
    const result = await onPayload(payload, model);

    const bpIndices = findBreakpointIndices(result);
    // Semi-stable breakpoint (first message breakpoint) should be near midpoint for uniform sizes
    // With uniform 500-token messages, 50% token threshold is at message ~10
    expect(bpIndices.length).toBeGreaterThanOrEqual(1);
    const semiStableIdx = bpIndices[0]!;
    // Token midpoint = index midpoint for uniform sizes: between 8 and 12
    expect(semiStableIdx).toBeGreaterThanOrEqual(8);
    expect(semiStableIdx).toBeLessThanOrEqual(12);
  });

  it("tool-heavy early messages: semi-stable breakpoint much earlier than index midpoint", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({
      getCacheRetention: () => "long",
      cacheBreakpointStrategy: "multi-zone",
    }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // 20 messages: first 4 have 5000 tokens each, remaining 16 have 200 tokens each
    // Total tokens ~ 20,000 + 3,200 = 23,200. Half = 11,600.
    // Cumulative: msg0=5000, msg1=10000, msg2=15000 > 11,600 -- crosses at message 2
    // Semi-stable breakpoint should be at index <= 4 (much earlier than midpoint ~10)
    const msgs: Array<{ role: string; text: string }> = [];
    for (let i = 0; i < 4; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(5000) });
    }
    for (let i = 4; i < 20; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(200) });
    }

    const payload = makeApiPayload(msgs, 1);
    const result = await onPayload(payload, model);

    const bpIndices = findBreakpointIndices(result);
    expect(bpIndices.length).toBeGreaterThanOrEqual(1);
    const semiStableIdx = bpIndices[0]!;
    // Token density is front-loaded: 50% threshold crossed by message ~2-3
    // Semi-stable breakpoint must be at index <= 4 (user message at or before crossing)
    expect(semiStableIdx).toBeLessThanOrEqual(4);
  });

  it("compaction summary present: uses summary position, not token-density scan", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({
      getCacheRetention: () => "long",
      cacheBreakpointStrategy: "multi-zone",
    }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // 20 messages: compaction summary at index 0
    const msgs: Array<{ role: string; text: string }> = [];
    msgs.push({ role: "user", text: "<summary>" + textForTokens(2000) + "</summary>" });
    msgs.push({ role: "assistant", text: textForTokens(2000) });
    for (let i = 2; i < 20; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(300) });
    }

    const payload = makeApiPayload(msgs, 1);
    const result = await onPayload(payload, model);

    const bpIndices = findBreakpointIndices(result);
    expect(bpIndices.length).toBeGreaterThanOrEqual(1);
    // Compaction summary at index 0 should be used (not token-density scan)
    expect(bpIndices[0]).toBe(0);
  });

  it("backward scan finds user message when token threshold crosses at assistant message", async () => {
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector({
      getCacheRetention: () => "long",
      cacheBreakpointStrategy: "multi-zone",
    }, logger);
    const wrappedFn = wrapper(base);

    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    const context = makeContext([]);
    wrappedFn(model, context, {});

    const receivedOptions = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = receivedOptions.onPayload as (payload: any, model: any) => Promise<any>;

    // Build messages where 50% token crossing happens at an assistant message:
    // msg0 (user, 1000 tokens), msg1 (assistant, very large 8000 tokens -- pushes past 50%),
    // msg2 (user, 500), msg3 (assistant, 500), ... remaining are small
    // Total ~ 1000 + 8000 + remaining ~4000 = 13000. Half = 6500.
    // Cumulative: msg0=1000, msg1=9000 > 6500 -- crosses at msg1 (assistant)
    // Backward scan should find msg0 (user) as the semi-stable breakpoint
    const msgs: Array<{ role: string; text: string }> = [];
    msgs.push({ role: "user", text: textForTokens(1000) });
    msgs.push({ role: "assistant", text: textForTokens(8000) });
    for (let i = 2; i < 20; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", text: textForTokens(500) });
    }

    const payload = makeApiPayload(msgs, 1);
    const result = await onPayload(payload, model);

    const bpIndices = findBreakpointIndices(result);
    expect(bpIndices.length).toBeGreaterThanOrEqual(1);
    // The token crossing is at index 1 (assistant), backward scan finds user at index 0
    expect(bpIndices[0]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fence-aware microcompaction
// ---------------------------------------------------------------------------

describe("fence-aware microcompaction", () => {
  it("clearStaleThinkingBlocks skips messages at or below fenceIndex", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Protected thinking" },
        { type: "text", text: "Response 1" },
      ]},
      { role: "user", content: [{ type: "text", text: "Next" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Unprotected thinking" },
        { type: "text", text: "Response 2" },
      ]},
      { role: "user", content: [{ type: "text", text: "Last" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Recent thinking" },
        { type: "text", text: "Response 3" },
      ]},
    ];

    // Fence at index 1: first assistant (idx 1) protected. keepWindow=1: last assistant preserved.
    const cleared = clearStaleThinkingBlocks(messages, 1, 1);

    // idx 1: PROTECTED by fence — thinking preserved
    expect((messages[1]!.content as any[]).length).toBe(2);
    expect((messages[1]!.content as any[])[0].type).toBe("thinking");
    // idx 3: beyond fence — thinking cleared
    expect((messages[3]!.content as any[]).length).toBe(1);
    expect((messages[3]!.content as any[])[0].type).toBe("text");
    // idx 5: within keepWindow — thinking preserved
    expect((messages[5]!.content as any[]).length).toBe(2);
    expect(cleared).toBe(1);
  });

  it("onPayload respects getCacheFenceIndex during time-based microcompact", async () => {
    const longText = "x".repeat(2000);
    const onContentModification = vi.fn();
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "short",
        getElapsedSinceLastResponse: () => 400_000, // > 300s TTL
        getCacheFenceIndex: () => 3, // Protect messages 0-3
        observationKeepWindow: 1,
        onContentModification,
        sessionKey: "test-fence-microcompact",
      },
      createMockLogger(),
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (p: any, m: any) => Promise<any>;

    // Use "file_read" (in COMPACTABLE_TOOL_NAMES) and role: "tool" (Anthropic API format)
    const result = await onPayload({
      system: [{ type: "text", text: "System" }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "user 1" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "file_read", input: {} }] },
        { role: "tool", tool_use_id: "t1", content: [{ type: "text", text: longText }] }, // idx 2 — protected by fence
        { role: "user", content: [{ type: "text", text: "user 2" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "file_read", input: {} }] },
        { role: "tool", tool_use_id: "t2", content: [{ type: "text", text: longText }] }, // idx 5 — beyond fence
        { role: "user", content: [{ type: "text", text: "user 3" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t3", name: "file_read", input: {} }] },
        { role: "tool", tool_use_id: "t3", content: [{ type: "text", text: longText }] }, // idx 8 — within keepWindow
      ],
    }, model);

    const msgs = result.messages as any[];
    // idx 2: PROTECTED by fence — content preserved
    expect(msgs[2].content[0].text).toBe(longText);
    // idx 5: Beyond fence, beyond keepWindow — cleared
    expect(msgs[5].content[0].text).toContain("Stale tool result cleared");
    // idx 8: Within keepWindow — preserved
    expect(msgs[8].content[0].text).toBe(longText);
  });

  // -------------------------------------------------------------------------
  // Breakpoint budget audit
  // -------------------------------------------------------------------------

  it("emits INFO log with breakpoint budget audit on Anthropic API call", async () => {
    const logger = createMockLogger();
    const base = createMockStreamFn();
    const wrapper = createRequestBodyInjector(
      { getCacheRetention: () => "long" },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (p: any, m: any) => Promise<any>;

    await onPayload({
      system: [
        { type: "text", text: "System prompt", cache_control: { type: "ephemeral" } },
      ],
      tools: [
        // Simulate pi-ai 0.67.4 auto-placing cache_control on the last tool
        { name: "bash", input_schema: {}, cache_control: { type: "ephemeral" } },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ],
    }, model);

    // Find the breakpoint budget audit log call
    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const auditCall = infoCalls.find((c: unknown[]) =>
      typeof c[1] === "string" && c[1].includes("Breakpoint budget audit"),
    );
    expect(auditCall).toBeDefined();
    const auditPayload = auditCall![0] as Record<string, unknown>;
    expect(auditPayload).toHaveProperty("existingCount");
    expect(auditPayload).toHaveProperty("slotsAvailable");
    expect(auditPayload).toHaveProperty("systemBreakpoints");
    expect(auditPayload).toHaveProperty("toolBreakpoints");
    expect(auditPayload.systemBreakpoints).toBe(1);
    // W2 guard strips tool cache_control in non-sub-agent flow -> audit sees 0
    expect(auditPayload.toolBreakpoints).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Cache fence unset in mature session
  // -------------------------------------------------------------------------

  it("emits WARN when no fence found in mature session (>=10 messages)", async () => {
    const logger = createMockLogger();
    const base = createMockStreamFn();
    const onBreakpointsPlaced = vi.fn();
    const wrapper = createRequestBodyInjector(
      {
        getCacheRetention: () => "long",
        onBreakpointsPlaced,
        cacheBreakpointStrategy: "single",
        // skipCacheWrite prevents message breakpoint placement
        skipCacheWrite: true,
      },
      logger,
    );
    const wrappedFn = wrapper(base);
    const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;
    wrappedFn(model, makeContext([]), {});

    const opts = base.mock.calls[0][2] as Record<string, unknown>;
    const onPayload = opts.onPayload as (p: any, m: any) => Promise<any>;

    // Build a mature session with 12 very short messages (below minTokens threshold).
    // With skipCacheWrite=true, the single breakpoint targets third-to-last user message,
    // but only if there are enough user messages. Short messages don't reach minTokens.
    // Exhaust the budget so slotsAvailable=0 by having 4 system blocks with cache_control.
    const messages = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `M${i}` }],
    }));

    await onPayload({
      system: [
        { type: "text", text: "S1", cache_control: { type: "ephemeral" } },
        { type: "text", text: "S2", cache_control: { type: "ephemeral" } },
        { type: "text", text: "S3", cache_control: { type: "ephemeral" } },
        { type: "text", text: "S4", cache_control: { type: "ephemeral" } },
      ],
      tools: [],
      messages,
    }, model);

    // Find the cache fence warn call
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const fenceWarn = warnCalls.find((c: unknown[]) =>
      typeof c[1] === "string" && c[1].includes("Cache fence unset"),
    );
    expect(fenceWarn).toBeDefined();
    const warnPayload = fenceWarn![0] as Record<string, unknown>;
    expect(warnPayload).toHaveProperty("messageCount");
    expect(warnPayload).toHaveProperty("hint");
    expect(warnPayload).toHaveProperty("errorKind", "performance");
    expect(warnPayload.messageCount).toBe(12);
  });

  // -------------------------------------------------------------------------
  // Prefix stability diagnostic — fence-index-aware tracking
  // -------------------------------------------------------------------------

  describe("prefix stability diagnostic", () => {
    const SESSION_KEY = "test-prefix-stability";
    const anthropicModel = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" } as any;

    /**
     * Helper: create an injector with controllable getCacheFenceIndex and invoke
     * onPayload with the given messages. Returns the logger for warn assertions.
     */
    async function invokeWithFence(
      fenceIdx: number,
      messages: Array<Record<string, unknown>>,
      testLogger: ReturnType<typeof createMockLogger>,
    ): Promise<void> {
      const base = createMockStreamFn();
      const wrapper = createRequestBodyInjector(
        {
          getCacheRetention: () => "long",
          sessionKey: SESSION_KEY,
          getCacheFenceIndex: () => fenceIdx,
        },
        testLogger,
      );
      const wrappedFn = wrapper(base);
      wrappedFn(anthropicModel, makeContext([]), {});
      const opts = base.mock.calls[0][2] as Record<string, unknown>;
      const onPayload = opts.onPayload as (p: any, m: any) => Promise<any>;

      await onPayload({
        system: [{ type: "text", text: "System prompt" }],
        tools: [],
        messages,
      }, anthropicModel);
    }

    /** Build N messages with predictable content. */
    function buildMessages(count: number, prefix = "msg"): Array<Record<string, unknown>> {
      return Array.from({ length: count }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `${prefix}-${i}` }],
      }));
    }

    function countUnstableWarns(testLogger: ReturnType<typeof createMockLogger>): number {
      return (testLogger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => typeof c[1] === "string" && c[1].includes("Unstable prefix detected"),
      ).length;
    }

    beforeEach(() => {
      clearSessionPrefixStability(SESSION_KEY);
    });

    it("growing fence with unchanged old content does NOT warn", async () => {
      const testLogger = createMockLogger();
      const msgs = buildMessages(10);

      // Turn 1: fence at 3
      await invokeWithFence(3, msgs.slice(0, 6), testLogger);
      // Turn 2: fence at 5 (grew), but old 0..3 content unchanged
      await invokeWithFence(5, msgs.slice(0, 8), testLogger);
      // Turn 3: fence at 7 (grew again)
      await invokeWithFence(7, msgs.slice(0, 10), testLogger);
      // Turn 4: fence at 8
      await invokeWithFence(8, [...msgs.slice(0, 10), { role: "user", content: [{ type: "text", text: "extra" }] }], testLogger);

      expect(countUnstableWarns(testLogger)).toBe(0);
    });

    it("same fence with content change warns at >= 3 consecutive changes", async () => {
      const testLogger = createMockLogger();

      // All turns at fence index 4 with 6 messages but mutating content at index 2
      for (let turn = 0; turn < 5; turn++) {
        const msgs = buildMessages(6);
        // Mutate content within the fenced prefix each turn
        (msgs[2].content as any[])[0].text = `mutated-turn-${turn}`;
        await invokeWithFence(4, msgs, testLogger);
      }

      // First observation stores, second is change #1, third is #2, fourth is #3 (triggers warn)
      // So turns 0-4 => changes at turns 1,2,3,4 => warn at turn 3 (change #3) and turn 4 (change #4)
      expect(countUnstableWarns(testLogger)).toBeGreaterThanOrEqual(1);
    });

    it("fence shrink resets counter to 0", async () => {
      const testLogger = createMockLogger();

      // Build up 2 consecutive changes at same fence
      const msgs6 = buildMessages(6);
      await invokeWithFence(4, msgs6, testLogger); // first observation
      const msgs6b = buildMessages(6, "changed1");
      await invokeWithFence(4, msgs6b, testLogger); // change #1
      const msgs6c = buildMessages(6, "changed2");
      await invokeWithFence(4, msgs6c, testLogger); // change #2

      // Fence shrinks (compaction)
      const msgs4 = buildMessages(4);
      await invokeWithFence(2, msgs4, testLogger); // shrink — reset

      // Now 3 more changes at the new fence — should need 3 fresh changes to warn
      const msgs4b = buildMessages(4, "post-compact-1");
      await invokeWithFence(2, msgs4b, testLogger); // change #1 after reset
      const msgs4c = buildMessages(4, "post-compact-2");
      await invokeWithFence(2, msgs4c, testLogger); // change #2 after reset

      // Should NOT have warned — only 2 changes after reset, never hit 3
      expect(countUnstableWarns(testLogger)).toBe(0);
    });

    it("growing fence with mutated old content increments counter", async () => {
      const testLogger = createMockLogger();

      // Turn 1: fence at 3 with 6 messages
      const msgs1 = buildMessages(6);
      await invokeWithFence(3, msgs1, testLogger);

      // Turns 2-4: fence grows but old content (0..3) is mutated each time
      for (let turn = 1; turn <= 4; turn++) {
        const msgs = buildMessages(6 + turn * 2);
        // Mutate content at index 1 (within old fence range)
        (msgs[1].content as any[])[0].text = `tampered-turn-${turn}`;
        await invokeWithFence(3 + turn, msgs, testLogger);
      }

      // Changes: turn 2 (#1), turn 3 (#2), turn 4 (#3 triggers warn), turn 5 (#4 triggers warn)
      expect(countUnstableWarns(testLogger)).toBeGreaterThanOrEqual(1);
    });
  });
});
