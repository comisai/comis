// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { SessionKey } from "@comis/core";
import { createFollowupTrigger } from "./followup-trigger.js";

const testSessionKey: SessionKey = {
  tenantId: "default",
  userId: "user-1",
  channelId: "chan-1",
};

describe("createFollowupTrigger", () => {
  it("shouldFollowup returns true when needs_followup is true", () => {
    const trigger = createFollowupTrigger({ maxFollowupRuns: 3, followupOnCompaction: true });
    expect(trigger.shouldFollowup({ needs_followup: true })).toBe(true);
  });

  it("shouldFollowup returns true on compaction when followupOnCompaction enabled", () => {
    const trigger = createFollowupTrigger({ maxFollowupRuns: 3, followupOnCompaction: true });
    expect(trigger.shouldFollowup({ compaction_triggered: true })).toBe(true);
  });

  it("shouldFollowup returns false on compaction when followupOnCompaction disabled", () => {
    const trigger = createFollowupTrigger({ maxFollowupRuns: 3, followupOnCompaction: false });
    expect(trigger.shouldFollowup({ compaction_triggered: true })).toBe(false);
  });

  it("shouldFollowup returns false when no trigger present", () => {
    const trigger = createFollowupTrigger({ maxFollowupRuns: 3, followupOnCompaction: true });
    expect(trigger.shouldFollowup({})).toBe(false);
    expect(trigger.shouldFollowup({ someOtherKey: true })).toBe(false);
  });

  it("createFollowupMessage produces correct NormalizedMessage", () => {
    const trigger = createFollowupTrigger({ maxFollowupRuns: 3, followupOnCompaction: true });
    const msg = trigger.createFollowupMessage(
      testSessionKey,
      "telegram",
      "chan-1",
      "tool_result",
      "chain-abc",
      2,
    );

    expect(msg.id).toBe("followup-chain-abc-2");
    expect(msg.channelId).toBe("chan-1");
    expect(msg.channelType).toBe("telegram");
    expect(msg.senderId).toBe("system");
    expect(msg.text).toContain("Continue processing");
    expect(msg.attachments).toEqual([]);
    expect(msg.metadata).toEqual({
      isFollowup: true,
      followupChainId: "chain-abc",
      followupChainDepth: 2,
      followupReason: "tool_result",
    });
  });

  it("chain depth tracking increments correctly", () => {
    const trigger = createFollowupTrigger({ maxFollowupRuns: 3, followupOnCompaction: true });

    expect(trigger.getChainDepth("chain-1")).toBe(0);
    trigger.incrementChain("chain-1");
    trigger.incrementChain("chain-1");
    trigger.incrementChain("chain-1");

    expect(trigger.getChainDepth("chain-1")).toBe(3);
  });

  it("clearChain resets depth to 0", () => {
    const trigger = createFollowupTrigger({ maxFollowupRuns: 3, followupOnCompaction: true });

    trigger.incrementChain("chain-1");
    trigger.incrementChain("chain-1");
    expect(trigger.getChainDepth("chain-1")).toBe(2);

    trigger.clearChain("chain-1");
    expect(trigger.getChainDepth("chain-1")).toBe(0);
  });

  it("incrementChain creates entry if not exists", () => {
    const trigger = createFollowupTrigger({ maxFollowupRuns: 3, followupOnCompaction: true });

    const depth = trigger.incrementChain("brand-new-chain");
    expect(depth).toBe(1);
    expect(trigger.getChainDepth("brand-new-chain")).toBe(1);
  });

  it("createFollowupMessage merges extraMetadata into metadata", () => {
    const trigger = createFollowupTrigger({ maxFollowupRuns: 3, followupOnCompaction: true });
    const msg = trigger.createFollowupMessage(
      testSessionKey,
      "telegram",
      "chat-1",
      "tool_result",
      "chain-1",
      1,
      { threadId: "42", telegramThreadId: 42 },
    );

    expect(msg.metadata).toEqual({
      isFollowup: true,
      followupChainId: "chain-1",
      followupChainDepth: 1,
      followupReason: "tool_result",
      threadId: "42",
      telegramThreadId: 42,
    });
  });

  it("createFollowupMessage works without extraMetadata (backward compat)", () => {
    const trigger = createFollowupTrigger({ maxFollowupRuns: 3, followupOnCompaction: true });
    const msg = trigger.createFollowupMessage(
      testSessionKey,
      "telegram",
      "chat-1",
      "compaction",
      "chain-2",
      2,
    );

    expect(msg.metadata).toEqual({
      isFollowup: true,
      followupChainId: "chain-2",
      followupChainDepth: 2,
      followupReason: "compaction",
    });
    // No extra keys from thread metadata
    expect(Object.keys(msg.metadata!)).toHaveLength(4);
  });
});
