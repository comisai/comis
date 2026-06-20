// SPDX-License-Identifier: Apache-2.0
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
import type { ExecutionOverrides, ExecutionResult } from "./types.js";
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

// ---------------------------------------------------------------------------
// SPEND-02 (Phase 177-01): ExecutionResult.finishReason gains "spend_exceeded".
//
// A dedicated member (NOT a reuse of "budget_exceeded") keeps the dollars-vs-
// tokens terminal cause distinct. SafetyCheckResult.finishReason is typed off
// ExecutionResult["finishReason"] (bridge-safety-controls.ts), so Plan 03's
// checkSpendLimit depends on this member existing. RED on pre-patch: the closed
// union lacks "spend_exceeded", so the assignment below fails to COMPILE (per
// AGENTS §2.10 a compile-RED is the failing state for a closed-type widen).
// ---------------------------------------------------------------------------
describe("ExecutionResult.finishReason spend_exceeded member", () => {
  it("accepts spend_exceeded as a finishReason literal", () => {
    const reason: ExecutionResult["finishReason"] = "spend_exceeded";
    expect(reason).toBe("spend_exceeded");
  });

  it("still accepts the pre-existing finishReason members (additive widen, no member removed)", () => {
    const members: ExecutionResult["finishReason"][] = [
      "stop",
      "max_steps",
      "budget_exceeded",
      "budget_exhausted",
      "context_exhausted",
      "loop_detected",
      "prompt_timeout",
      "error",
      "spend_exceeded",
    ];
    expect(members).toContain("spend_exceeded");
    // "budget_exceeded" (tokens) and "spend_exceeded" (dollars) are DISTINCT members.
    expect(members.includes("budget_exceeded") && members.includes("spend_exceeded")).toBe(true);
  });

  it("rejects a non-member finishReason literal (closed union)", () => {
    // @ts-expect-error - "spend_unpriceable" is not a finishReason member; the
    // distinct observability:spend_unpriceable event carries that nuance (A3).
    const bad: ExecutionResult["finishReason"] = "spend_unpriceable";
    void bad;
  });
});
