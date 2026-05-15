// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for createBeforeToolCallGuard — proactive tool-call safety
 * guard. Migrated verbatim from pi-executor.test.ts (Phase 42 split per
 * EXEC-SPLIT-05).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { ok, err } from "@comis/shared";
import { createBeforeToolCallGuard } from "./before-tool-call-guard.js";

describe("createBeforeToolCallGuard", () => {
  it("blocks when step counter is exhausted", async () => {
    const stepCounter = { shouldHalt: () => true, increment: () => 1, reset: () => {}, getCount: () => 50 };
    const budgetGuard = { checkBudget: () => ok(undefined), estimateCost: () => 0, recordUsage: () => {}, resetExecution: () => {}, getSnapshot: () => ({ perExecution: 0, perHour: 0, perDay: 0 }) } as any;
    const circuitBreaker = { isOpen: () => false, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "closed" as const, reset: () => {} };

    const guard = createBeforeToolCallGuard(stepCounter, budgetGuard, circuitBreaker);
    const result = await guard({});

    expect(result).toEqual({ block: true, reason: expect.stringContaining("Step limit") });
  });

  it("blocks when budget exhausted", async () => {
    const stepCounter = { shouldHalt: () => false, increment: () => 1, reset: () => {}, getCount: () => 0 };
    const budgetGuard = { checkBudget: () => err(new Error("exceeded")), estimateCost: () => 0, recordUsage: () => {}, resetExecution: () => {}, getSnapshot: () => ({ perExecution: 0, perHour: 0, perDay: 0 }) } as any;
    const circuitBreaker = { isOpen: () => false, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "closed" as const, reset: () => {} };

    const guard = createBeforeToolCallGuard(stepCounter, budgetGuard, circuitBreaker);
    const result = await guard({});

    expect(result).toEqual({ block: true, reason: expect.stringContaining("budget") });
  });

  it("blocks when circuit breaker open", async () => {
    const stepCounter = { shouldHalt: () => false, increment: () => 1, reset: () => {}, getCount: () => 0 };
    const budgetGuard = { checkBudget: () => ok(undefined), estimateCost: () => 0, recordUsage: () => {}, resetExecution: () => {}, getSnapshot: () => ({ perExecution: 0, perHour: 0, perDay: 0 }) } as any;
    const circuitBreaker = { isOpen: () => true, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "open" as const, reset: () => {} };

    const guard = createBeforeToolCallGuard(stepCounter, budgetGuard, circuitBreaker);
    const result = await guard({});

    expect(result).toEqual({ block: true, reason: expect.stringContaining("circuit") });
  });

  it("allows execution when all checks pass", async () => {
    const stepCounter = { shouldHalt: () => false, increment: () => 1, reset: () => {}, getCount: () => 0 };
    const budgetGuard = { checkBudget: () => ok(undefined), estimateCost: () => 0, recordUsage: () => {}, resetExecution: () => {}, getSnapshot: () => ({ perExecution: 0, perHour: 0, perDay: 0 }) } as any;
    const circuitBreaker = { isOpen: () => false, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "closed" as const, reset: () => {} };

    const guard = createBeforeToolCallGuard(stepCounter, budgetGuard, circuitBreaker);
    const result = await guard({});

    expect(result).toBeUndefined();
  });

  it("checks step counter first (priority order)", async () => {
    // All three would block -- step counter should be the reason
    const stepCounter = { shouldHalt: () => true, increment: () => 1, reset: () => {}, getCount: () => 50 };
    const budgetGuard = { checkBudget: () => err(new Error("exceeded")), estimateCost: () => 0, recordUsage: () => {}, resetExecution: () => {}, getSnapshot: () => ({ perExecution: 0, perHour: 0, perDay: 0 }) } as any;
    const circuitBreaker = { isOpen: () => true, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "open" as const, reset: () => {} };

    const guard = createBeforeToolCallGuard(stepCounter, budgetGuard, circuitBreaker);
    const result = await guard({});

    expect(result).toEqual({ block: true, reason: expect.stringContaining("Step limit") });
  });

  it("blocks when tool retry breaker returns block verdict", async () => {
    const stepCounter = { shouldHalt: () => false, increment: () => 1, reset: () => {}, getCount: () => 0 };
    const budgetGuard = { checkBudget: () => ok(undefined), estimateCost: () => 0, recordUsage: () => {}, resetExecution: () => {}, getSnapshot: () => ({ perExecution: 0, perHour: 0, perDay: 0 }) } as any;
    const circuitBreaker = { isOpen: () => false, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "closed" as const, reset: () => {} };
    const toolRetryBreaker = {
      beforeToolCall: () => ({ block: true, reason: "Tool blocked by retry breaker" }),
      recordResult: () => {},
      getBlockedTools: () => [],
      reset: () => {},
    };

    const guard = createBeforeToolCallGuard(stepCounter, budgetGuard, circuitBreaker, toolRetryBreaker);
    // Simulate SDK context shape: { toolCall: { name }, args }
    const result = await guard({ toolCall: { name: "mcp__yfinance--get_recs" }, args: { symbol: "NVDA" } });

    expect(result).toEqual({ block: true, reason: "Tool blocked by retry breaker" });
  });

  it("allows execution when tool retry breaker returns no block", async () => {
    const stepCounter = { shouldHalt: () => false, increment: () => 1, reset: () => {}, getCount: () => 0 };
    const budgetGuard = { checkBudget: () => ok(undefined), estimateCost: () => 0, recordUsage: () => {}, resetExecution: () => {}, getSnapshot: () => ({ perExecution: 0, perHour: 0, perDay: 0 }) } as any;
    const circuitBreaker = { isOpen: () => false, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "closed" as const, reset: () => {} };
    const toolRetryBreaker = {
      beforeToolCall: () => ({ block: false }),
      recordResult: () => {},
      getBlockedTools: () => [],
      reset: () => {},
    };

    const guard = createBeforeToolCallGuard(stepCounter, budgetGuard, circuitBreaker, toolRetryBreaker);
    const result = await guard({ toolCall: { name: "web_search" }, args: { query: "test" } });

    expect(result).toBeUndefined();
  });
});
