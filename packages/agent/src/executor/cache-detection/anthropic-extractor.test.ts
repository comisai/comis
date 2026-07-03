// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for cache-detection/anthropic-extractor.ts.
 *
 * Covers `extractAnthropicPromptState` — the Anthropic Messages API adapter.
 * Cross-cutting tests that exercise the adapter together with the detector
 * factory live in cache-state.test.ts.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { extractAnthropicPromptState } from "./anthropic-extractor.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fixtureParams = {
  system: [
    { type: "text", text: "You are a helpful assistant", cache_control: { type: "ephemeral" } },
  ],
  tools: [
    { name: "bash", description: "Run bash", input_schema: { type: "object", properties: { cmd: { type: "string" } } }, cache_control: { type: "ephemeral" } },
    { name: "file_read", description: "Read file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
  ],
};

// ---------------------------------------------------------------------------
// extractAnthropicPromptState
// ---------------------------------------------------------------------------

describe("extractAnthropicPromptState", () => {
  it("extracts systemHash from system blocks (strips cache_control before hashing)", () => {
    const result = extractAnthropicPromptState(fixtureParams, "claude-sonnet-4-5", "short", "sess-1", "agent-1");
    expect(result.systemHash).toBeTypeOf("number");
    expect(result.systemHash).toBeGreaterThan(0);

    // Verify stripping: same content with different cache_control should produce same systemHash
    const paramsWithDifferentCacheControl = {
      ...fixtureParams,
      system: [
        { type: "text", text: "You are a helpful assistant", cache_control: { type: "permanent" } },
      ],
    };
    const result2 = extractAnthropicPromptState(paramsWithDifferentCacheControl, "claude-sonnet-4-5", "short", "sess-1", "agent-1");
    expect(result2.systemHash).toBe(result.systemHash);
  });

  it("extracts per-tool hashes using input_schema field", () => {
    const result = extractAnthropicPromptState(fixtureParams, "claude-sonnet-4-5", "short", "sess-1", "agent-1");
    expect(result.perToolHashes).toHaveProperty("bash");
    expect(result.perToolHashes).toHaveProperty("file_read");
    expect(result.perToolHashes["bash"]).toBeTypeOf("number");
    expect(result.perToolHashes["file_read"]).toBeTypeOf("number");
    // Different schemas -> different hashes
    expect(result.perToolHashes["bash"]).not.toBe(result.perToolHashes["file_read"]);
  });

  it("hashes cache_control metadata separately as cacheMetadataHash", () => {
    const result = extractAnthropicPromptState(fixtureParams, "claude-sonnet-4-5", "short", "sess-1", "agent-1");
    // fixtureParams has cache_control on system[0] and tools[0]
    expect(result.cacheMetadataHash).toBeTypeOf("number");
    expect(result.cacheMetadataHash).not.toBe(null);
  });

  it("does NOT mutate the original params object", () => {
    const original = JSON.parse(JSON.stringify(fixtureParams));
    extractAnthropicPromptState(fixtureParams, "claude-sonnet-4-5", "short", "sess-1", "agent-1");
    expect(fixtureParams).toEqual(original);
  });

  it("with empty tools array, perToolHashes is empty and toolsHash is stable", () => {
    const params = { system: fixtureParams.system, tools: [] };
    const result = extractAnthropicPromptState(params, "claude-sonnet-4-5", "short", "sess-1", "agent-1");
    expect(result.perToolHashes).toEqual({});
    expect(result.toolNames).toEqual([]);
    expect(result.toolsHash).toBeTypeOf("number");

    // Stable across calls
    const result2 = extractAnthropicPromptState(params, "claude-sonnet-4-5", "short", "sess-1", "agent-1");
    expect(result2.toolsHash).toBe(result.toolsHash);
  });

  it("returns correct provider, model, retention, sessionKey, agentId", () => {
    const result = extractAnthropicPromptState(fixtureParams, "claude-sonnet-4-5", "long", "sess-42", "bot-7");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(result.retention).toBe("long");
    expect(result.sessionKey).toBe("sess-42");
    expect(result.agentId).toBe("bot-7");
  });

  it("handles server-side tools (tool_search_tool_regex) without crashing", () => {
    // tool_search_tool_regex has type + name but no input_schema.
    // Guards the crash path: computeHash(undefined) → djb2(JSON.stringify(undefined)) → str.length on undefined.
    const paramsWithServerTool = {
      ...fixtureParams,
      tools: [
        ...fixtureParams.tools,
        { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
      ],
    };
    const result = extractAnthropicPromptState(paramsWithServerTool, "claude-opus-4-6", "long", "sess-1", "agent-1");
    // Server-side tool should be excluded from per-tool hashes and toolNames
    expect(result.perToolHashes).not.toHaveProperty("tool_search_tool_regex");
    expect(result.toolNames).not.toContain("tool_search_tool_regex");
    // Regular tools are still hashed
    expect(result.perToolHashes).toHaveProperty("bash");
    expect(result.perToolHashes).toHaveProperty("file_read");
  });
});

// ---------------------------------------------------------------------------
// Anthropic-pure header / extra-body tracking (no detector dependency)
// Cross-cutting tests that exercise the detector remain in cache-state.test.ts.
// ---------------------------------------------------------------------------

describe("extractAnthropicPromptState header and extra-body hashing", () => {
  it("returns headersHash when headers provided", () => {
    const result = extractAnthropicPromptState(
      fixtureParams, "claude-sonnet-4-5", "short", "sess-1", "agent-1",
      { "anthropic-beta": "prompt-caching-2024-07-31", "anthropic-version": "2024-01-01" },
    );
    expect(result.headersHash).toBeTypeOf("number");
    expect(result.headersHash).not.toBeNull();
  });

  it("returns null headersHash when no headers", () => {
    const result = extractAnthropicPromptState(
      fixtureParams, "claude-sonnet-4-5", "short", "sess-1", "agent-1",
    );
    expect(result.headersHash).toBeNull();
  });

  it("returns extraBodyHash for non-standard params", () => {
    const paramsWithExtra = { ...fixtureParams, custom_field: "some-value" };
    const result = extractAnthropicPromptState(
      paramsWithExtra, "claude-sonnet-4-5", "short", "sess-1", "agent-1",
    );
    expect(result.extraBodyHash).toBeTypeOf("number");
    expect(result.extraBodyHash).not.toBeNull();
  });

  it("returns null extraBodyHash for standard-only params", () => {
    // fixtureParams only has system and tools (both standard)
    const result = extractAnthropicPromptState(
      fixtureParams, "claude-sonnet-4-5", "short", "sess-1", "agent-1",
    );
    expect(result.extraBodyHash).toBeNull();
  });

  it("standard fields (including cache_control, betas) do not trigger extraBodyHash", () => {
    const standardParams = {
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      messages: [],
      system: fixtureParams.system,
      tools: fixtureParams.tools,
      stream: true,
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      tool_choice: { type: "auto" },
      cache_control: { type: "ephemeral" },
      betas: ["prompt-caching-2024-07-31"],
      stop_sequences: ["END"],
      thinking: { type: "enabled", budget_tokens: 1024 },
      output_config: {},
      container: {},
      inference_geo: "us",
      service_tier: "standard",
      metadata: { user_id: "abc" },
    };
    const result = extractAnthropicPromptState(
      standardParams, "claude-sonnet-4-5", "short", "sess-1", "agent-1",
    );
    expect(result.extraBodyHash).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Anthropic-pure effort value / cache_control_hash / lazy diff content
// ---------------------------------------------------------------------------

describe("extractAnthropicPromptState effort value (params.thinking)", () => {
  it("with params.thinking returns effortValue as JSON string", () => {
    const params = {
      ...fixtureParams,
      thinking: { type: "enabled", budget_tokens: 1024 },
    };
    const result = extractAnthropicPromptState(params, "claude-sonnet-4-5", "short", "sess-1", "agent-1");
    expect(result.effortValue).toBe(JSON.stringify({ type: "enabled", budget_tokens: 1024 }));
  });

  it("without params.thinking returns effortValue as undefined", () => {
    const result = extractAnthropicPromptState(fixtureParams, "claude-sonnet-4-5", "short", "sess-1", "agent-1");
    expect(result.effortValue).toBeUndefined();
  });
});

describe("extractAnthropicPromptState cacheControlHash", () => {
  it("returns cacheControlHash from raw system blocks (with cache_control)", () => {
    const result = extractAnthropicPromptState(fixtureParams, "claude-sonnet-4-5", "short", "sess-1", "agent-1");
    expect(result.cacheControlHash).toBeTypeOf("number");
    expect(result.cacheControlHash).not.toBeNull();
  });

  it("differs when cache_control markers change but system text is identical", () => {
    // System with ephemeral cache_control
    const paramsEphemeral = {
      ...fixtureParams,
      system: [
        { type: "text", text: "You are a helpful assistant", cache_control: { type: "ephemeral" } },
      ],
    };
    const resultEphemeral = extractAnthropicPromptState(paramsEphemeral, "claude-sonnet-4-5", "short", "sess-1", "agent-1");

    // System with no cache_control (same text)
    const paramsNone = {
      ...fixtureParams,
      system: [
        { type: "text", text: "You are a helpful assistant" },
      ],
    };
    const resultNone = extractAnthropicPromptState(paramsNone, "claude-sonnet-4-5", "short", "sess-1", "agent-1");

    // systemHash should be the SAME (text unchanged)
    expect(resultEphemeral.systemHash).toBe(resultNone.systemHash);
    // cacheControlHash should be DIFFERENT (markers changed)
    expect(resultEphemeral.cacheControlHash).not.toBe(resultNone.cacheControlHash);
  });
});

describe("extractAnthropicPromptState lazy buildDiffableContent", () => {
  it("returns buildDiffableContent as a function (not eager strings)", () => {
    const result = extractAnthropicPromptState(fixtureParams, "claude-sonnet-4-5", "short", "sess-1", "agent-1");
    expect(result.buildDiffableContent).toBeTypeOf("function");
    // Should NOT have serializedSystem or serializedTools
    expect((result as Record<string, unknown>).serializedSystem).toBeUndefined();
    expect((result as Record<string, unknown>).serializedTools).toBeUndefined();
  });

  it("lazy getter serializes joined system text and cache_control-stripped tools JSON", () => {
    const result = extractAnthropicPromptState(fixtureParams, "claude-sonnet-4-5", "short", "sess-1", "agent-1");
    const content = result.buildDiffableContent!();

    // System: joined text blocks
    expect(content.system).toBe("You are a helpful assistant");

    // Tools: JSON stringified with cache_control stripped
    const expectedTools = JSON.stringify([
      { name: "bash", description: "Run bash", input_schema: { type: "object", properties: { cmd: { type: "string" } } } },
      { name: "file_read", description: "Read file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    ], null, 2);
    expect(content.tools).toBe(expectedTools);
  });
});
