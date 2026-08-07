// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for createBeforeToolCallGuard — proactive tool-call safety
 * guard.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { ok, err } from "@comis/shared";
import { createBeforeToolCallGuard } from "./before-tool-call-guard.js";
import { createTurnLoopDetector } from "../turn-loop-detector.js";
import { createBudgetGuard } from "../../budget/budget-guard.js";

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

  it("blocks an outbound repaired-file claim without matched mutation evidence", async () => {
    const { stepCounter, budgetGuard, circuitBreaker } = passThroughSafety();
    const onBlocked = vi.fn();
    const guard = Reflect.apply(createBeforeToolCallGuard, undefined, [
      stepCounter,
      budgetGuard,
      circuitBreaker,
      undefined,
      undefined,
      undefined,
      undefined,
      "its broken",
      undefined,
      {
        requestMutationToolNames: new Set(["edit", "write"]),
        currentSuccessfulMutationCount: () => 0,
        onBlocked,
      },
    ]);

    const result = await guard({
      toolCall: { name: "message" },
      args: {
        action: "attach",
        caption: "Here is the repaired run tracker file.",
      },
    });

    expect(result).toEqual({
      block: true,
      reason: expect.stringMatching(/successful current-turn mutation/iu),
    });
    expect(onBlocked).toHaveBeenCalledOnce();
  });

  it("allows an outbound repair claim after a matched mutation succeeds", async () => {
    const { stepCounter, budgetGuard, circuitBreaker } = passThroughSafety();
    const guard = Reflect.apply(createBeforeToolCallGuard, undefined, [
      stepCounter,
      budgetGuard,
      circuitBreaker,
      undefined,
      undefined,
      undefined,
      undefined,
      "its broken",
      undefined,
      {
        requestMutationToolNames: new Set(["edit", "write"]),
        currentSuccessfulMutationCount: () => 1,
        onBlocked: vi.fn(),
      },
    ]);

    await expect(guard({
      toolCall: { name: "message" },
      args: {
        action: "attach",
        caption: "Here is the repaired run tracker file.",
      },
    })).resolves.toBeUndefined();
  });

  it("allows a neutral attachment caption without mutation evidence", async () => {
    const { stepCounter, budgetGuard, circuitBreaker } = passThroughSafety();
    const guard = Reflect.apply(createBeforeToolCallGuard, undefined, [
      stepCounter,
      budgetGuard,
      circuitBreaker,
      undefined,
      undefined,
      undefined,
      undefined,
      "its broken",
      undefined,
      {
        requestMutationToolNames: new Set(["edit"]),
        currentSuccessfulMutationCount: () => 0,
        onBlocked: vi.fn(),
      },
    ]);

    await expect(guard({
      toolCall: { name: "message" },
      args: { action: "attach", caption: "Here is the current file for inspection." },
    })).resolves.toBeUndefined();
  });

  it("blocks an outbound citation whose exact URL lacks fetch evidence", async () => {
    const { stepCounter, budgetGuard, circuitBreaker } = passThroughSafety();
    const fetchedUrl = "https://example.com/source/abcdef";
    const mutatedUrl = "https://example.com/source/abcdeg";
    const onCitationBlocked = vi.fn();
    const guard = Reflect.apply(createBeforeToolCallGuard, undefined, [
      stepCounter,
      budgetGuard,
      circuitBreaker,
      undefined,
      undefined,
      undefined,
      undefined,
      "where is that from",
      undefined,
      {
        requestMutationToolNames: new Set<string>(),
        currentSuccessfulMutationCount: () => 0,
        onBlocked: vi.fn(),
        citationEvidenceEnabled: () => true,
        allowedCitationDigests: () => [
          createHash("sha256").update(fetchedUrl, "utf8").digest("hex"),
        ],
        onCitationBlocked,
      },
    ]);

    const result = await guard({
      toolCall: { name: "message" },
      args: {
        action: "reply",
        text: `[Source](${mutatedUrl})`,
      },
    });

    expect(result).toEqual({
      block: true,
      reason: expect.stringMatching(/exact successful web_fetch/iu),
    });
    expect(onCitationBlocked).toHaveBeenCalledOnce();
  });

  it("allows an outbound citation backed by the exact fetch digest", async () => {
    const { stepCounter, budgetGuard, circuitBreaker } = passThroughSafety();
    const fetchedUrl = "https://example.com/source/abcdef";
    const guard = Reflect.apply(createBeforeToolCallGuard, undefined, [
      stepCounter,
      budgetGuard,
      circuitBreaker,
      undefined,
      undefined,
      undefined,
      undefined,
      "where is that from",
      undefined,
      {
        requestMutationToolNames: new Set<string>(),
        currentSuccessfulMutationCount: () => 0,
        onBlocked: vi.fn(),
        citationEvidenceEnabled: () => true,
        allowedCitationDigests: () => [
          createHash("sha256").update(fetchedUrl, "utf8").digest("hex"),
        ],
        onCitationBlocked: vi.fn(),
      },
    ]);

    await expect(guard({
      toolCall: { name: "message" },
      args: { action: "send", text: `[Source](${fetchedUrl})` },
    })).resolves.toBeUndefined();
  });

  it("blocks current-route delivery while forwarded correspondence is active", async () => {
    const { stepCounter, budgetGuard, circuitBreaker } = passThroughSafety();
    const onRecipientBlocked = vi.fn();
    const guard = Reflect.apply(createBeforeToolCallGuard, undefined, [
      stepCounter,
      budgetGuard,
      circuitBreaker,
      undefined,
      undefined,
      undefined,
      undefined,
      "ok send it",
      undefined,
      {
        requestMutationToolNames: new Set<string>(),
        currentSuccessfulMutationCount: () => 0,
        onBlocked: vi.fn(),
        forwardedContextActive: true,
        currentRoute: { channelType: "telegram", channelId: "chat-a" },
        onRecipientBlocked,
      },
    ]);

    const result = await guard({
      toolCall: { name: "message" },
      args: {
        action: "send",
        channel_type: "telegram",
        channel_id: "chat-a",
        text: "draft body",
      },
    });

    expect(result).toEqual({
      block: true,
      reason: expect.stringMatching(/forwarded.*exact recipient.*not sent/iu),
    });
    expect(onRecipientBlocked).toHaveBeenCalledOnce();
  });

  it("allows an exact non-origin target while forwarded correspondence is active", async () => {
    const { stepCounter, budgetGuard, circuitBreaker } = passThroughSafety();
    const guard = Reflect.apply(createBeforeToolCallGuard, undefined, [
      stepCounter,
      budgetGuard,
      circuitBreaker,
      undefined,
      undefined,
      undefined,
      undefined,
      "send it to chat-b",
      undefined,
      {
        requestMutationToolNames: new Set<string>(),
        currentSuccessfulMutationCount: () => 0,
        onBlocked: vi.fn(),
        forwardedContextActive: true,
        currentRoute: { channelType: "telegram", channelId: "chat-a" },
        onRecipientBlocked: vi.fn(),
      },
    ]);

    await expect(guard({
      toolCall: { name: "message" },
      args: {
        action: "send",
        channel_type: "telegram",
        channel_id: "chat-b",
        text: "draft body",
      },
    })).resolves.toBeUndefined();
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

  it("blocks a tool immediately after a structured failure declared an active alternative", async () => {
    const stepCounter = { shouldHalt: () => false, increment: () => 1, reset: () => {}, getCount: () => 0 };
    const budgetGuard = { checkBudget: () => ok(undefined), estimateCost: () => 0, recordUsage: () => {}, resetExecution: () => {}, getSnapshot: () => ({ perExecution: 0, perHour: 0, perDay: 0 }) } as any;
    const circuitBreaker = { isOpen: () => false, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "closed" as const, reset: () => {} };
    const redirects = new Map([
      ["web_search", "Use browser next to run a Google Search."],
    ]);

    const guard = createBeforeToolCallGuard(
      stepCounter,
      budgetGuard,
      circuitBreaker,
      undefined,
      undefined,
      undefined,
      redirects,
    );
    const result = await guard({
      toolCall: { name: "web_search" },
      args: { query: "different query" },
    });

    expect(result).toEqual({
      block: true,
      reason: "Use browser next to run a Google Search.",
    });
  });

  // -------------------------------------------------------------------------
  // The turn-loop detector short-circuits a repeat idempotent read.
  // The SDK's beforeToolCall can only block-with-reason (BeforeToolCallResult
  // is {block?, reason?} — no content channel), so a short-circuit blocks the
  // re-execution and surfaces the one-line steer as the tool-result reason text
  // the model sees. The cached content is already in context.
  // -------------------------------------------------------------------------

  const passThroughSafety = () => ({
    stepCounter: { shouldHalt: () => false, increment: () => 1, reset: () => {}, getCount: () => 0 },
    budgetGuard: { checkBudget: () => ok(undefined), estimateCost: () => 0, recordUsage: () => {}, resetExecution: () => {}, getSnapshot: () => ({ perExecution: 0, perHour: 0, perDay: 0 }) } as any,
    circuitBreaker: { isOpen: () => false, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "closed" as const, reset: () => {} },
  });

  it("blocks substitution of an explicit model identifier before agent mutation", async () => {
    const { stepCounter, budgetGuard, circuitBreaker } = passThroughSafety();
    const guard = Reflect.apply(createBeforeToolCallGuard, undefined, [
      stepCounter,
      budgetGuard,
      circuitBreaker,
      undefined,
      undefined,
      undefined,
      undefined,
      "use gpt-turbo-9",
    ]);

    const result = await guard({
      toolCall: { name: "agents_manage" },
      args: {
        action: "update",
        agent_id: "default",
        config: { model: "gpt-4-turbo" },
      },
    });

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("gpt-turbo-9"),
    });
  });

  it("blocks substitution of an explicit provider identifier before agent mutation", async () => {
    const { stepCounter, budgetGuard, circuitBreaker } = passThroughSafety();
    const guard = Reflect.apply(createBeforeToolCallGuard, undefined, [
      stepCounter,
      budgetGuard,
      circuitBreaker,
      undefined,
      undefined,
      undefined,
      undefined,
      "use provider_a instead",
      new Set(["provider_a"]),
    ]);

    const result = await guard({
      toolCall: { name: "agents_manage" },
      args: {
        action: "update",
        agent_id: "default",
        config: { model: "model_b" },
      },
    });

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("provider_a"),
    });
  });

  it("allows one explicit provider and model binding before agent mutation", async () => {
    const { stepCounter, budgetGuard, circuitBreaker } = passThroughSafety();
    const guard = Reflect.apply(createBeforeToolCallGuard, undefined, [
      stepCounter,
      budgetGuard,
      circuitBreaker,
      undefined,
      undefined,
      undefined,
      undefined,
      "switch to openai-codex gpt-5.4-mini",
      new Set(["openai", "openai-codex"]),
    ]);

    await expect(guard({
      toolCall: { name: "agents_manage" },
      args: {
        action: "update",
        agent_id: "default",
        config: {
          provider: "openai-codex",
          model: "gpt-5.4-mini",
        },
      },
    })).resolves.toBeUndefined();
  });

  it("reports the requested model when a paired binding substitutes it", async () => {
    const { stepCounter, budgetGuard, circuitBreaker } = passThroughSafety();
    const guard = Reflect.apply(createBeforeToolCallGuard, undefined, [
      stepCounter,
      budgetGuard,
      circuitBreaker,
      undefined,
      undefined,
      undefined,
      undefined,
      "switch to openai-codex gpt-5.4-mini",
      new Set(["openai", "openai-codex"]),
    ]);

    const result = await guard({
      toolCall: { name: "agents_manage" },
      args: {
        action: "update",
        agent_id: "default",
        config: {
          provider: "openai-codex",
          model: "gpt-4-turbo",
        },
      },
    });

    expect(result).toEqual({
      block: true,
      reason: expect.stringMatching(
        /requested model identifier "gpt-5\.4-mini".*proposes "gpt-4-turbo"/,
      ),
    });
  });

  it("supplies the exact requested binding when a provider is omitted", async () => {
    const { stepCounter, budgetGuard, circuitBreaker } = passThroughSafety();
    const guard = Reflect.apply(createBeforeToolCallGuard, undefined, [
      stepCounter,
      budgetGuard,
      circuitBreaker,
      undefined,
      undefined,
      undefined,
      undefined,
      "switch to openai-codex gpt-5.4-mini",
      new Set(["openai", "openai-codex"]),
    ]);

    const result = await guard({
      toolCall: { name: "agents_manage" },
      args: {
        action: "update",
        agent_id: "default",
        config: { model: "gpt-5.4-mini" },
      },
    });

    expect(result).toEqual({
      block: true,
      reason: expect.stringMatching(
        /config\.provider="openai-codex".*config\.model="gpt-5\.4-mini"/,
      ),
    });
  });

  it("allows an exact explicit model identifier and a qualitative model choice", async () => {
    const { stepCounter, budgetGuard, circuitBreaker } = passThroughSafety();
    const exactGuard = Reflect.apply(createBeforeToolCallGuard, undefined, [
      stepCounter,
      budgetGuard,
      circuitBreaker,
      undefined,
      undefined,
      undefined,
      undefined,
      "use gpt-turbo-9",
    ]);
    const qualitativeGuard = Reflect.apply(createBeforeToolCallGuard, undefined, [
      stepCounter,
      budgetGuard,
      circuitBreaker,
      undefined,
      undefined,
      undefined,
      undefined,
      "pick something cheaper and switch to it",
    ]);

    await expect(exactGuard({
      toolCall: { name: "agents_manage" },
      args: {
        action: "update",
        agent_id: "default",
        config: { model: "gpt-turbo-9" },
      },
    })).resolves.toBeUndefined();
    await expect(qualitativeGuard({
      toolCall: { name: "agents_manage" },
      args: {
        action: "update",
        agent_id: "default",
        config: { model: "gpt-4.1-nano" },
      },
    })).resolves.toBeUndefined();
  });

  it("short-circuits a repeat idempotent read with the steer surfaced as the block reason", async () => {
    const { stepCounter, budgetGuard, circuitBreaker } = passThroughSafety();
    const detector = createTurnLoopDetector();
    detector.recordCall("read", { path: "/a" }, { content: [{ type: "text", text: "body" }] });

    const guard = createBeforeToolCallGuard(stepCounter, budgetGuard, circuitBreaker, undefined, undefined, detector);
    const result = await guard({ toolCall: { name: "read" }, args: { path: "/a" } });

    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    // The one-line steer is the reason text the model sees (read-tool referenced).
    expect(result?.reason).toContain("read");
    expect(result?.reason).toMatch(/already ran/i);
  });

  it("a non-cached idempotent read falls through to the normal allow path", async () => {
    const { stepCounter, budgetGuard, circuitBreaker } = passThroughSafety();
    const detector = createTurnLoopDetector();

    const guard = createBeforeToolCallGuard(stepCounter, budgetGuard, circuitBreaker, undefined, undefined, detector);
    const result = await guard({ toolCall: { name: "read" }, args: { path: "/never-seen" } });

    expect(result).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // The mid-run hard stop fires off the per-execution EFFECTIVE cap
  // set via resetExecution(cap), not just config.perExecution. Built with a
  // REAL createBudgetGuard so the resetExecution(cap?) seam is exercised
  // end-to-end (not a stub) — proving a runaway child is blocked at the next
  // tool call once its tight cap is hit.
  // -------------------------------------------------------------------------
  it("blocks the next tool call once the per-execution effective cap from resetExecution is reached", async () => {
    const stepCounter = { shouldHalt: () => false, increment: () => 1, reset: () => {}, getCount: () => 0 };
    const circuitBreaker = { isOpen: () => false, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "closed" as const, reset: () => {} };
    // Real guard: config.perExecution is roomy (10_000) but the spawn caps THIS run at 1_000.
    const budgetGuard = createBudgetGuard({ perExecution: 10_000, perHour: 50_000, perDay: 200_000 });
    budgetGuard.resetExecution(1_000);
    budgetGuard.recordUsage(1_500); // over the 1_000 effective cap (checkBudget(0) → 1_500 > 1_000)

    const guard = createBeforeToolCallGuard(stepCounter, budgetGuard, circuitBreaker);
    const result = await guard({ toolCall: { name: "read" }, args: { path: "/a" } });

    expect(result).toEqual({ block: true, reason: "Token budget exhausted" });
  });

  it("does not block on the effective cap when the run is still under it", async () => {
    const stepCounter = { shouldHalt: () => false, increment: () => 1, reset: () => {}, getCount: () => 0 };
    const circuitBreaker = { isOpen: () => false, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "closed" as const, reset: () => {} };
    const budgetGuard = createBudgetGuard({ perExecution: 10_000, perHour: 50_000, perDay: 200_000 });
    budgetGuard.resetExecution(1_000);
    budgetGuard.recordUsage(500); // still under the 1_000 effective cap

    const guard = createBeforeToolCallGuard(stepCounter, budgetGuard, circuitBreaker);
    const result = await guard({ toolCall: { name: "read" }, args: { path: "/a" } });

    expect(result).toBeUndefined();
  });

  it("the step limit still takes priority over the loop detector", async () => {
    const detector = createTurnLoopDetector();
    detector.recordCall("read", { path: "/a" }, { content: [{ type: "text", text: "body" }] });
    const stepCounter = { shouldHalt: () => true, increment: () => 1, reset: () => {}, getCount: () => 50 };
    const budgetGuard = { checkBudget: () => ok(undefined), estimateCost: () => 0, recordUsage: () => {}, resetExecution: () => {}, getSnapshot: () => ({ perExecution: 0, perHour: 0, perDay: 0 }) } as any;
    const circuitBreaker = { isOpen: () => false, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "closed" as const, reset: () => {} };

    const guard = createBeforeToolCallGuard(stepCounter, budgetGuard, circuitBreaker, undefined, undefined, detector);
    const result = await guard({ toolCall: { name: "read" }, args: { path: "/a" } });

    // Step-limit reason wins — the safety blocks stay first in priority.
    expect(result?.reason).toContain("Step limit");
  });
});
