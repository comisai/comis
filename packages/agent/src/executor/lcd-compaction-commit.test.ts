// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type {
  AppendCondensedSummaryInput,
  AppendSummaryInput,
  ContextStorePort,
  ContextStoreScope,
} from "@comis/core";
import {
  commitCondensedSummaryIfCurrent,
  commitLeafSummaryIfCurrent,
} from "./lcd-compaction-commit.js";

const scope: ContextStoreScope = {
  conversationRef: "cv_commit_test",
  tenantId: "tenant_a",
  agentId: "agent_a",
  sessionKey: "session_a",
};

function storeWithItems(
  items: ReturnType<ContextStorePort["getContextItems"]>,
): ContextStorePort {
  return {
    getContextItems: vi.fn(() => items),
    runOnConversation: vi.fn(async (_ref, task) => task()),
    appendLeafSummary: vi.fn(() => "leaf_a"),
    appendCondensedSummary: vi.fn(() => "condensed_a"),
  } as unknown as ContextStorePort;
}

describe("LCD compaction commit — stale snapshot guard", () => {
  it("commits a leaf only while the selected message window is unchanged", async () => {
    const store = storeWithItems([
      { ordinal: 0, refKind: "message", refId: "message_a" },
      { ordinal: 1, refKind: "message", refId: "message_b" },
      { ordinal: 2, refKind: "message", refId: "new_tail" },
    ]);
    const input = {
      scope,
      startOrdinal: 0,
      endOrdinal: 1,
    } as AppendSummaryInput;

    await expect(
      commitLeafSummaryIfCurrent(store, scope, ["message_a", "message_b"], input),
    ).resolves.toBe(true);
    expect(store.appendLeafSummary).toHaveBeenCalledWith(input);
  });

  it("refuses a condensed write when another pass replaced its selected refs", async () => {
    const store = storeWithItems([
      { ordinal: 0, refKind: "summary", refId: "new_parent" },
    ]);
    const input = {
      scope,
      startOrdinal: 0,
      endOrdinal: 1,
    } as AppendCondensedSummaryInput;

    await expect(
      commitCondensedSummaryIfCurrent(store, scope, ["child_a", "child_b"], input),
    ).resolves.toBeUndefined();
    expect(store.appendCondensedSummary).not.toHaveBeenCalled();
  });
});
