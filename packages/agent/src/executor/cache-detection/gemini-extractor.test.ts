// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for cache-detection/gemini-extractor.ts.
 *
 * Covers `extractGeminiPromptState` — the Gemini-native adapter.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { extractGeminiPromptState } from "./gemini-extractor.js";
import { computeHash } from "./prompt-state-utils.js";

// ---------------------------------------------------------------------------
// extractGeminiPromptState
// ---------------------------------------------------------------------------

describe("extractGeminiPromptState", () => {
  const geminiPayload = {
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    config: {
      systemInstruction: "You are a helpful assistant",
      tools: [{
        functionDeclarations: [
          { name: "bash", description: "Run bash commands", parametersJsonSchema: { type: "object", properties: { cmd: { type: "string" } } } },
          { name: "file_read", description: "Read file", parametersJsonSchema: { type: "object", properties: { path: { type: "string" } } } },
        ],
      }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      temperature: 0.7,
      maxOutputTokens: 8192,
    },
  };

  it("hashes systemInstruction string correctly", () => {
    const result = extractGeminiPromptState(geminiPayload, "gemini-2.5-flash", "sess-1", "agent-1");
    expect(result.systemHash).toBe(computeHash("You are a helpful assistant"));
  });

  it("hashes functionDeclarations array (not the wrapper tools array)", () => {
    const result = extractGeminiPromptState(geminiPayload, "gemini-2.5-flash", "sess-1", "agent-1");
    const expectedDecls = geminiPayload.config.tools[0].functionDeclarations;
    expect(result.toolsHash).toBe(computeHash(expectedDecls));
  });

  it("always returns cacheMetadataHash: null", () => {
    const result = extractGeminiPromptState(geminiPayload, "gemini-2.5-flash", "sess-1", "agent-1");
    expect(result.cacheMetadataHash).toBeNull();
  });

  it("returns provider: 'google'", () => {
    const result = extractGeminiPromptState(geminiPayload, "gemini-2.5-flash", "sess-1", "agent-1");
    expect(result.provider).toBe("google");
  });

  it("returns retention: undefined (Gemini reads static config, not adaptive)", () => {
    const result = extractGeminiPromptState(geminiPayload, "gemini-2.5-flash", "sess-1", "agent-1");
    expect(result.retention).toBeUndefined();
  });

  it("extracts tool names from functionDeclarations", () => {
    const result = extractGeminiPromptState(geminiPayload, "gemini-2.5-flash", "sess-1", "agent-1");
    expect(result.toolNames).toEqual(["bash", "file_read"]);
  });

  it("builds perToolHashes using parametersJsonSchema", () => {
    const result = extractGeminiPromptState(geminiPayload, "gemini-2.5-flash", "sess-1", "agent-1");
    expect(result.perToolHashes).toHaveProperty("bash");
    expect(result.perToolHashes).toHaveProperty("file_read");
    expect(result.perToolHashes["bash"]).toBe(
      computeHash({ type: "object", properties: { cmd: { type: "string" } } }),
    );
    expect(result.perToolHashes["file_read"]).toBe(
      computeHash({ type: "object", properties: { path: { type: "string" } } }),
    );
    // Different schemas -> different hashes
    expect(result.perToolHashes["bash"]).not.toBe(result.perToolHashes["file_read"]);
  });

  it("with empty tools returns toolsHash of computeHash([]) and empty toolNames/perToolHashes", () => {
    const emptyPayload = {
      ...geminiPayload,
      config: { ...geminiPayload.config, tools: [] },
    };
    const result = extractGeminiPromptState(emptyPayload, "gemini-2.5-flash", "sess-1", "agent-1");
    expect(result.toolsHash).toBe(computeHash([]));
    expect(result.toolNames).toEqual([]);
    expect(result.perToolHashes).toEqual({});
  });

  it("handles MCP tool names via sanitizeMcpToolName in perToolHashes keys", () => {
    const mcpPayload = {
      ...geminiPayload,
      config: {
        ...geminiPayload.config,
        tools: [{
          functionDeclarations: [
            { name: "mcp__myserver--read_file", description: "Read", parametersJsonSchema: { type: "object" } },
          ],
        }],
      },
    };
    const result = extractGeminiPromptState(mcpPayload, "gemini-2.5-flash", "sess-1", "agent-1");
    expect(result.toolNames).toEqual(["mcp__myserver--read_file"]);
    // perToolHashes key uses sanitized name
    expect(result.perToolHashes).toHaveProperty("mcp__myserver");
    expect(result.perToolHashes["mcp__myserver"]).toBe(computeHash({ type: "object" }));
  });

  it("returns correct sessionKey, agentId, and model", () => {
    const result = extractGeminiPromptState(geminiPayload, "gemini-2.5-flash", "sess-42", "bot-7");
    expect(result.sessionKey).toBe("sess-42");
    expect(result.agentId).toBe("bot-7");
    expect(result.model).toBe("gemini-2.5-flash");
  });

  it("handles missing systemInstruction (hashes empty string)", () => {
    const noSysPayload = {
      ...geminiPayload,
      config: { ...geminiPayload.config, systemInstruction: undefined },
    };
    const result = extractGeminiPromptState(noSysPayload as Record<string, unknown>, "gemini-2.5-flash", "sess-1", "agent-1");
    expect(result.systemHash).toBe(computeHash(""));
  });

  it("handles missing config object gracefully", () => {
    const noConfigPayload = { model: "gemini-2.5-flash", contents: [] };
    const result = extractGeminiPromptState(noConfigPayload, "gemini-2.5-flash", "sess-1", "agent-1");
    expect(result.systemHash).toBe(computeHash(""));
    expect(result.toolsHash).toBe(computeHash([]));
    expect(result.toolNames).toEqual([]);
    expect(result.perToolHashes).toEqual({});
  });
});
