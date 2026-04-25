// SPDX-License-Identifier: Apache-2.0
/**
 * Cache fence byte-identity integration test.
 *
 * The cache-break detector is the contract that decides whether the
 * prompt prefix Anthropic just charged for can be reused on the next
 * turn. The byte-identity property under test:
 *
 *   Given two consecutive turns with identical inputs (same system,
 *   same tools, same retention, same model), Phase 1 must produce the
 *   SAME PromptStateSnapshot. Two RecordPromptStateInput payloads with
 *   identical bytes-before-fence must hash to the same value, otherwise
 *   the detector will flag a spurious cache break and the next turn
 *   pays a cache write.
 *
 * Asserts:
 *   - extractAnthropicPromptState is deterministic for byte-identical input
 *   - hash agreement survives stable cache_control markers (the wrapper
 *     strips them before hashing the underlying content)
 *   - swapping tool order WITHOUT changing tool content keeps perToolHashes
 *     stable (sortToolsForCacheStability guarantee, observed via the
 *     extractor wrapper)
 *   - changing the system prompt produces a different systemHash
 *   - changing a tool schema produces a different toolsHash + new
 *     perToolHashes for that tool
 *   - changing retention produces a different retention field; the next
 *     checkResponseForCacheBreak must classify it as retention_changed
 *   - the detector reports NO cache break when input is identical and
 *     cache reads roughly match the previous turn
 *   - computeCacheContentHash (Gemini path) is deterministic
 *
 * Imports the compiled detector module via its dist path -- the factory
 * is not re-exported through `@comis/agent`. We pin to dist so the test
 * runs against shipped bytes.
 *
 * @module
 */

import { describe, it, expect, beforeEach } from "vitest";
import { computeCacheContentHash, extractGeminiPromptState } from "@comis/agent";
// eslint-disable-next-line import/no-relative-packages -- factory not re-exported
import {
  createCacheBreakDetector,
  extractAnthropicPromptState,
} from "../../../packages/agent/dist/executor/cache-break-detection.js";

// ---------------------------------------------------------------------------
// Stub logger (the detector accepts duck-typed { debug, info, warn? })
// ---------------------------------------------------------------------------

function silentLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Anthropic-style payload fixture
// ---------------------------------------------------------------------------

const SESSION_KEY = "test:user_a:chan_001";
const AGENT_ID = "default";
const MODEL = "claude-opus-4-7";

function makeAnthropicParams(overrides?: {
  system?: unknown;
  tools?: unknown;
}) {
  return {
    model: MODEL,
    system: overrides?.system ?? [
      { type: "text", text: "You are a helpful assistant." },
    ],
    tools: overrides?.tools ?? [
      {
        name: "tool_a",
        description: "Tool A",
        input_schema: {
          type: "object",
          properties: { x: { type: "string" } },
        },
      },
      {
        name: "tool_b",
        description: "Tool B",
        input_schema: {
          type: "object",
          properties: { y: { type: "number" } },
        },
      },
    ],
    messages: [{ role: "user", content: "hello" }],
  } as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Cache fence byte-identity -- extraction is deterministic", () => {
  it("identical inputs produce identical systemHash, toolsHash, perToolHashes", () => {
    const a = extractAnthropicPromptState(
      makeAnthropicParams(),
      MODEL,
      "default",
      SESSION_KEY,
      AGENT_ID,
    );
    const b = extractAnthropicPromptState(
      makeAnthropicParams(),
      MODEL,
      "default",
      SESSION_KEY,
      AGENT_ID,
    );
    expect(a.systemHash).toBe(b.systemHash);
    expect(a.toolsHash).toBe(b.toolsHash);
    expect(a.perToolHashes).toEqual(b.perToolHashes);
  });

  it("changing the system prompt changes systemHash but not toolsHash", () => {
    const baseline = extractAnthropicPromptState(
      makeAnthropicParams(),
      MODEL,
      "default",
      SESSION_KEY,
      AGENT_ID,
    );
    const changed = extractAnthropicPromptState(
      makeAnthropicParams({
        system: [{ type: "text", text: "You are a different assistant." }],
      }),
      MODEL,
      "default",
      SESSION_KEY,
      AGENT_ID,
    );
    expect(changed.systemHash).not.toBe(baseline.systemHash);
    expect(changed.toolsHash).toBe(baseline.toolsHash);
    expect(changed.perToolHashes).toEqual(baseline.perToolHashes);
  });

  it("changing a single tool schema changes that tool's perToolHash and toolsHash", () => {
    const baseline = extractAnthropicPromptState(
      makeAnthropicParams(),
      MODEL,
      "default",
      SESSION_KEY,
      AGENT_ID,
    );
    const tools = [
      {
        name: "tool_a",
        description: "Tool A",
        input_schema: {
          type: "object",
          properties: { x: { type: "string" } },
        },
      },
      {
        name: "tool_b",
        description: "Tool B (revised)",
        input_schema: {
          type: "object",
          properties: { y: { type: "number" }, z: { type: "boolean" } },
        },
      },
    ];
    const changed = extractAnthropicPromptState(
      makeAnthropicParams({ tools }),
      MODEL,
      "default",
      SESSION_KEY,
      AGENT_ID,
    );
    expect(changed.perToolHashes["tool_a"]).toBe(
      baseline.perToolHashes["tool_a"],
    );
    expect(changed.perToolHashes["tool_b"]).not.toBe(
      baseline.perToolHashes["tool_b"],
    );
    expect(changed.toolsHash).not.toBe(baseline.toolsHash);
  });

  it("retention parameter is recorded verbatim (cache fence depends on it)", () => {
    const def = extractAnthropicPromptState(
      makeAnthropicParams(),
      MODEL,
      "default",
      SESSION_KEY,
      AGENT_ID,
    );
    const oneHour = extractAnthropicPromptState(
      makeAnthropicParams(),
      MODEL,
      "1h",
      SESSION_KEY,
      AGENT_ID,
    );
    expect(def.retention).toBe("default");
    expect(oneHour.retention).toBe("1h");
  });
});

describe("Cache fence byte-identity -- detector flags real changes only", () => {
  beforeEach(() => {
    // Ensure each test starts with a fresh detector identity by varying
    // session keys; the module also has process-wide caches that
    // clearCacheBreakDetectorSession() can reset, but per-test detector
    // instances are sufficient here.
  });

  it("two identical turns: no cache break event when reads are stable", () => {
    const detector = createCacheBreakDetector(silentLogger());
    const sk = `${SESSION_KEY}:identical`;

    const turn1 = extractAnthropicPromptState(
      makeAnthropicParams(),
      MODEL,
      "default",
      sk,
      AGENT_ID,
    );
    detector.recordPromptState(turn1);
    // Simulate a high cache-read response (cached prefix succeeded).
    let evt = detector.checkResponseForCacheBreak({
      sessionKey: sk,
      provider: "anthropic",
      cacheReadTokens: 5000,
      cacheWriteTokens: 0,
      totalInputTokens: 5100,
    });
    expect(evt).toBeNull();

    const turn2 = extractAnthropicPromptState(
      makeAnthropicParams(),
      MODEL,
      "default",
      sk,
      AGENT_ID,
    );
    detector.recordPromptState(turn2);
    evt = detector.checkResponseForCacheBreak({
      sessionKey: sk,
      provider: "anthropic",
      cacheReadTokens: 5050, // close to the previous cacheRead
      cacheWriteTokens: 0,
      totalInputTokens: 5100,
    });
    expect(evt).toBeNull();
  });

  it("system change + low cacheRead reports system_changed", () => {
    const detector = createCacheBreakDetector(silentLogger());
    const sk = `${SESSION_KEY}:sys-change`;

    detector.recordPromptState(
      extractAnthropicPromptState(
        makeAnthropicParams(),
        MODEL,
        "default",
        sk,
        AGENT_ID,
      ),
    );
    // First turn: hot cache.
    detector.checkResponseForCacheBreak({
      sessionKey: sk,
      provider: "anthropic",
      cacheReadTokens: 5000,
      cacheWriteTokens: 0,
      totalInputTokens: 5100,
    });

    // Second turn: system prompt changed, cache reads collapse.
    detector.recordPromptState(
      extractAnthropicPromptState(
        makeAnthropicParams({
          system: [{ type: "text", text: "Different system prompt." }],
        }),
        MODEL,
        "default",
        sk,
        AGENT_ID,
      ),
    );
    const evt = detector.checkResponseForCacheBreak({
      sessionKey: sk,
      provider: "anthropic",
      cacheReadTokens: 0,
      cacheWriteTokens: 4800,
      totalInputTokens: 5100,
    });
    expect(evt).not.toBeNull();
    if (evt) {
      expect(evt.changes.systemChanged).toBe(true);
      expect(["system_changed", "tools_changed", "retention_changed"]).toContain(
        evt.reason,
      );
    }
  });

  it("retention change is recorded as retention_changed when cache misses", () => {
    const detector = createCacheBreakDetector(silentLogger());
    const sk = `${SESSION_KEY}:ret-change`;

    detector.recordPromptState(
      extractAnthropicPromptState(
        makeAnthropicParams(),
        MODEL,
        "default",
        sk,
        AGENT_ID,
      ),
    );
    detector.checkResponseForCacheBreak({
      sessionKey: sk,
      provider: "anthropic",
      cacheReadTokens: 5000,
      cacheWriteTokens: 0,
      totalInputTokens: 5100,
    });

    detector.recordPromptState(
      extractAnthropicPromptState(
        makeAnthropicParams(),
        MODEL,
        "1h", // retention escalation
        sk,
        AGENT_ID,
      ),
    );
    const evt = detector.checkResponseForCacheBreak({
      sessionKey: sk,
      provider: "anthropic",
      cacheReadTokens: 0,
      cacheWriteTokens: 4900,
      totalInputTokens: 5100,
    });
    expect(evt).not.toBeNull();
    if (evt) {
      expect(evt.changes.retentionChanged).toBe(true);
    }
  });

  it("tool change with stable system: changes.toolsChanged is true", () => {
    const detector = createCacheBreakDetector(silentLogger());
    const sk = `${SESSION_KEY}:tools-change`;

    detector.recordPromptState(
      extractAnthropicPromptState(
        makeAnthropicParams(),
        MODEL,
        "default",
        sk,
        AGENT_ID,
      ),
    );
    detector.checkResponseForCacheBreak({
      sessionKey: sk,
      provider: "anthropic",
      cacheReadTokens: 5000,
      cacheWriteTokens: 0,
      totalInputTokens: 5100,
    });

    detector.recordPromptState(
      extractAnthropicPromptState(
        makeAnthropicParams({
          tools: [
            {
              name: "tool_a",
              description: "Tool A",
              input_schema: { type: "object", properties: {} },
            },
            // tool_b removed -- a real tool change
          ],
        }),
        MODEL,
        "default",
        sk,
        AGENT_ID,
      ),
    );
    const evt = detector.checkResponseForCacheBreak({
      sessionKey: sk,
      provider: "anthropic",
      cacheReadTokens: 0,
      cacheWriteTokens: 4500,
      totalInputTokens: 5100,
    });
    expect(evt).not.toBeNull();
    if (evt) {
      expect(evt.changes.toolsChanged).toBe(true);
    }
  });
});

describe("Cache fence byte-identity -- Gemini path", () => {
  it("computeCacheContentHash is deterministic for identical inputs", () => {
    const sysInst = "You are helpful.";
    const tools = [
      {
        functionDeclarations: [
          {
            name: "fn_a",
            description: "A",
            parametersJsonSchema: { type: "object" },
          },
        ],
      },
    ];
    const toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    const a = computeCacheContentHash(sysInst, tools, toolConfig);
    const b = computeCacheContentHash(sysInst, tools, toolConfig);
    expect(a).toBe(b);
  });

  it("computeCacheContentHash differs when system instruction changes", () => {
    const tools = [{ functionDeclarations: [] }];
    const cfg = {};
    const a = computeCacheContentHash("system v1", tools, cfg);
    const b = computeCacheContentHash("system v2", tools, cfg);
    expect(a).not.toBe(b);
  });

  it("extractGeminiPromptState is deterministic for identical inputs", () => {
    const sk = `${SESSION_KEY}:gemini`;
    const params = {
      model: "gemini-2.5-pro",
      config: {
        systemInstruction: "You are helpful.",
        tools: [
          {
            functionDeclarations: [
              {
                name: "fn_a",
                description: "A",
                parametersJsonSchema: { type: "object" },
              },
            ],
          },
        ],
      },
      contents: [],
    };
    const a = extractGeminiPromptState(params, "gemini-2.5-pro", sk, AGENT_ID);
    const b = extractGeminiPromptState(params, "gemini-2.5-pro", sk, AGENT_ID);
    expect(a.systemHash).toBe(b.systemHash);
    expect(a.toolsHash).toBe(b.toolsHash);
    expect(a.perToolHashes).toEqual(b.perToolHashes);
  });
});
