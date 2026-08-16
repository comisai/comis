// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  createTerminalDecisionRecord,
  findTerminalDecision,
  isAnnouncementTerminalDecisionRecord,
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

describe("announcement terminal decisions", () => {
  it("matches a content-free terminal decision across reconstructed owners", () => {
    const created = createTerminalDecisionRecord(owner, "no_reply", 10);
    if (!created.ok) throw created.error;

    expect(isAnnouncementTerminalDecisionRecord(created.value)).toBe(true);
    expect(JSON.stringify(created.value)).not.toContain(owner.sessionKey);
    expect(findTerminalDecision([created.value], { ...owner })).toEqual({
      ok: true,
      value: created.value,
    });
  });
});
