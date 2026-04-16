/**
 * Tests for ExecutionOverrides type extensions.
 *
 * Validates that ExecutionOverrides has the promptTimeout and operationType
 * fields with the correct types. These are compile-time checks expressed
 * as runtime assertions on dummy values.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import type { ExecutionOverrides } from "./types.js";
import type { ModelOperationType } from "@comis/core";

describe("ExecutionOverrides type extensions", () => {
  it("accepts promptTimeout with promptTimeoutMs and retryPromptTimeoutMs", () => {
    const overrides: ExecutionOverrides = {
      operationType: "interactive",
      promptTimeout: {
        promptTimeoutMs: 60_000,
        retryPromptTimeoutMs: 30_000,
      },
    };
    expect(overrides.promptTimeout?.promptTimeoutMs).toBe(60_000);
    expect(overrides.promptTimeout?.retryPromptTimeoutMs).toBe(30_000);
  });

  it("accepts promptTimeout with only promptTimeoutMs", () => {
    const overrides: ExecutionOverrides = {
      operationType: "interactive",
      promptTimeout: { promptTimeoutMs: 90_000 },
    };
    expect(overrides.promptTimeout?.promptTimeoutMs).toBe(90_000);
    expect(overrides.promptTimeout?.retryPromptTimeoutMs).toBeUndefined();
  });

  it("accepts promptTimeout with only retryPromptTimeoutMs", () => {
    const overrides: ExecutionOverrides = {
      operationType: "interactive",
      promptTimeout: { retryPromptTimeoutMs: 45_000 },
    };
    expect(overrides.promptTimeout?.promptTimeoutMs).toBeUndefined();
    expect(overrides.promptTimeout?.retryPromptTimeoutMs).toBe(45_000);
  });

  it("accepts operationType field typed as ModelOperationType", () => {
    const operations: ModelOperationType[] = [
      "interactive",
      "cron",
      "heartbeat",
      "subagent",
      "compaction",
      "taskExtraction",
      "condensation",
    ];
    for (const op of operations) {
      const overrides: ExecutionOverrides = { operationType: op };
      expect(overrides.operationType).toBe(op);
    }
  });

  it("keeps all existing fields unchanged when new fields are added", () => {
    const overrides: ExecutionOverrides = {
      stepCounter: undefined,
      spawnPacket: undefined,
      model: "anthropic:claude-sonnet-4-5",
      cacheRetention: "short",
      skipRag: true,
      ephemeralSessionAdapter: undefined,
      skipSep: false,
      promptTimeout: { promptTimeoutMs: 60_000 },
      operationType: "heartbeat",
    };
    expect(overrides.model).toBe("anthropic:claude-sonnet-4-5");
    expect(overrides.cacheRetention).toBe("short");
    expect(overrides.skipRag).toBe(true);
    expect(overrides.skipSep).toBe(false);
    expect(overrides.operationType).toBe("heartbeat");
  });

  it("requires operationType field", () => {
    const overrides: ExecutionOverrides = { operationType: "interactive" };
    expect(overrides.operationType).toBe("interactive");
  });
});
