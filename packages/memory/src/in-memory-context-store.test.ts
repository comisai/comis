// SPDX-License-Identifier: Apache-2.0
import type { ConversationRef } from "@comis/core";
import { describe, expect, it } from "vitest";
import { createInMemoryContextStore } from "./in-memory-context-store.js";

describe("explicit in-memory context store", () => {
  it("provides the full context-store contract without durable filesystem state", () => {
    const created = createInMemoryContextStore();
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const scope = {
      conversationRef: `cv_${"m".repeat(43)}` as ConversationRef,
      tenantId: "tenant_a",
      agentId: "agent_a",
      sessionKey: "tenant_a:agent_a:user_a:channel_a",
    };
    created.value.contextStore.append({
      scope,
      seq: 0,
      role: "user",
      tokenCount: 1,
      createdAt: 1,
      parts: [],
    });

    expect(created.value.contextStore.getMessages(scope)).toHaveLength(1);
    expect(created.value.close().ok).toBe(true);
    expect(created.value.close().ok).toBe(true);
  });
});
