// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  createOperatorDecisionRecord,
  findOperatorDecision,
  isAnnouncementOperatorDecisionRecord,
} from "./announcement-dead-letter-operator-decision.js";

const owner = {
  announcementText: "completion",
  channelType: "telegram",
  channelId: "chat-1",
  runId: "run-1",
  sessionKey: "default:agent-a:telegram:chat-1:user_a",
  failedAt: 1,
  attemptCount: 5,
};

describe("announcement operator decisions", () => {
  it("matches a content-free terminal decision across reconstructed owners", () => {
    const created = createOperatorDecisionRecord(owner, "discarded", 10);
    if (!created.ok) throw created.error;

    expect(isAnnouncementOperatorDecisionRecord(created.value)).toBe(true);
    expect(JSON.stringify(created.value)).not.toContain(owner.sessionKey);
    expect(findOperatorDecision([created.value], { ...owner })).toEqual({
      ok: true,
      value: created.value,
    });
  });
});
