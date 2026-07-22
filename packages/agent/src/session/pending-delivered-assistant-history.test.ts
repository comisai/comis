// SPDX-License-Identifier: Apache-2.0
import {
  SessionManager,
  convertToLlm,
} from "@earendil-works/pi-coding-agent";
import { createConversationLocator, type ConversationLocator, type ConversationScope } from "@comis/core";
import { describe, expect, it } from "vitest";
import { DELIVERED_ASSISTANT_HISTORY_CUSTOM_TYPE } from "./delivered-assistant-history.js";
import { projectPendingDeliveredAssistantHistory } from "./pending-delivered-assistant-history.js";

function locator(): ConversationLocator {
  const scope: ConversationScope = {
    tenantId: "tenant_a",
    agentId: "agent_a",
    partition: {
      kind: "endpoint-conversation",
      endpoint: {
        channelType: "telegram",
        channelInstanceId: "telegram_primary",
        conversationId: "chat_a",
        conversationKind: "direct",
      },
    },
  };
  const result = createConversationLocator(scope);
  if (!result.ok) throw result.error;
  return result.value;
}

function appendAssistant(sm: SessionManager, text: string): void {
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "messages",
    provider: "example",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  } as never);
}

function appendHistory(
  sm: SessionManager,
  attemptId: string,
  text: string,
  overrides: Record<string, unknown> = {},
): void {
  sm.appendCustomEntry(DELIVERED_ASSISTANT_HISTORY_CUSTOM_TYPE, {
    tenantId: "tenant_a",
    agentId: "agent_a",
    conversationRef: locator().conversationRef,
    sourceExecutionId: `execution_${attemptId}`,
    attemptId,
    deliveredAtMs: 1_700_000_000_000,
    text,
    contentTrust: "derived",
    ...overrides,
  });
}

describe("pending delivered assistant history projection", () => {
  it("projects only strict active-authority entries after the latest assistant", () => {
    const sm = SessionManager.inMemory("/tmp/test-workspace");
    appendHistory(sm, "old", "old-delivery");
    appendAssistant(sm, "ordinary-assistant");
    appendHistory(sm, "valid", "valid-delivery");
    appendHistory(sm, "wrong-agent", "other-delivery", { agentId: "agent_b" });
    sm.appendCustomEntry(DELIVERED_ASSISTANT_HISTORY_CUSTOM_TYPE, {
      attemptId: "invalid",
      text: "invalid-delivery",
    });

    const result = projectPendingDeliveredAssistantHistory(sm, locator());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.compiledContext).toContain("previously delivered assistant output");
    expect(result.value.compiledContext).toContain("valid-delivery");
    expect(result.value.compiledContext).not.toContain("old-delivery");
    expect(result.value.compiledContext).not.toContain("other-delivery");
    expect(result.value.compiledContext).not.toContain("invalid-delivery");
    expect(result.value.diagnostics).toEqual({
      projectedEntries: 1,
      invalidEntries: 1,
      authorityMismatches: 1,
      omittedOversizedEntries: 0,
      omittedOlderEntries: 0,
    });
  });

  it("keeps the newest eight complete blocks and restores chronological order", () => {
    const sm = SessionManager.inMemory("/tmp/test-workspace");
    for (let index = 0; index < 10; index++) {
      appendHistory(sm, `attempt_${index}`, `delivery-${index}`);
    }

    const result = projectPendingDeliveredAssistantHistory(sm, locator());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.compiledContext).not.toContain("delivery-0\n");
    expect(result.value.compiledContext).not.toContain("delivery-1\n");
    for (let index = 2; index < 10; index++) {
      expect(result.value.compiledContext).toContain(`delivery-${index}`);
    }
    expect(result.value.compiledContext.indexOf("delivery-2"))
      .toBeLessThan(result.value.compiledContext.indexOf("delivery-9"));
    expect(result.value.diagnostics.omittedOlderEntries).toBe(2);
    expect(Buffer.byteLength(result.value.compiledContext, "utf8")).toBeLessThanOrEqual(64 * 1024);
  });

  it("omits a block that cannot fit without truncating it and can retain an older small block", () => {
    const sm = SessionManager.inMemory("/tmp/test-workspace");
    appendHistory(sm, "small", "small-delivery");
    appendHistory(sm, "large", "x".repeat(65_000));

    const result = projectPendingDeliveredAssistantHistory(sm, locator());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.compiledContext).toContain("small-delivery");
    expect(result.value.compiledContext).not.toContain("x".repeat(100));
    expect(result.value.diagnostics.omittedOversizedEntries).toBe(1);
  });

  it("leaves the SDK provider history role-neutral until the explicit projection seam", () => {
    const sm = SessionManager.inMemory("/tmp/test-workspace");
    sm.appendMessage({ role: "user", content: "user-request", timestamp: 1 } as never);
    appendAssistant(sm, "ordinary-assistant");
    appendHistory(sm, "pending", "pending-delivery");

    const sdkContext = sm.buildSessionContext().messages;
    const providerMessages = convertToLlm(sdkContext);

    expect(JSON.stringify(sdkContext)).not.toContain("pending-delivery");
    expect(JSON.stringify(providerMessages)).not.toContain("pending-delivery");
    expect(providerMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const projected = projectPendingDeliveredAssistantHistory(sm, locator());
    expect(projected.ok && projected.value.compiledContext).toContain("pending-delivery");
  });
});
