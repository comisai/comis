// SPDX-License-Identifier: Apache-2.0
import type { ChannelEndpoint } from "@comis/core";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createDuplicateDetector } from "./duplicate-detector.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const ENDPOINT: ChannelEndpoint = {
  channelType: "telegram",
  channelInstanceId: "bot_a",
  conversationId: "chat_a",
  conversationKind: "direct",
};

function candidate(overrides: Partial<{
  agentId: string;
  destinationEndpoint: ChannelEndpoint;
  text: string;
}> = {}) {
  return {
    agentId: "agent_a",
    destinationEndpoint: ENDPOINT,
    text: "CPU at 90%",
    ...overrides,
  };
}

describe("possibly visible heartbeat duplicate detector", () => {
  it("separates pure checks from platform-visibility recording", () => {
    const detector = createDuplicateDetector({ clock: createFakeClock(1_000) });
    expect(detector.check(candidate())).toBe(false);
    expect(detector.check(candidate())).toBe(false);
    detector.recordPossiblyVisible(candidate());
    expect(detector.check(candidate())).toBe(true);
  });

  it("expires recorded visibility at the fixed twenty-four-hour boundary", () => {
    const clock = createFakeClock(1_000);
    const detector = createDuplicateDetector({ clock });
    detector.recordPossiblyVisible(candidate());
    clock.advance(DAY_MS - 1);
    expect(detector.check(candidate())).toBe(true);
    clock.advance(1);
    expect(detector.check(candidate())).toBe(false);
  });

  it("keys every exact destination endpoint field and owning agent", () => {
    const detector = createDuplicateDetector({ clock: createFakeClock(1_000) });
    detector.recordPossiblyVisible(candidate());
    expect(detector.check(candidate({ agentId: "agent_b" }))).toBe(false);
    expect(detector.check(candidate({
      destinationEndpoint: { ...ENDPOINT, channelInstanceId: "bot_b" },
    }))).toBe(false);
    expect(detector.check(candidate({
      destinationEndpoint: { ...ENDPOINT, conversationId: "chat_b" },
    }))).toBe(false);
    expect(detector.check(candidate({
      destinationEndpoint: { ...ENDPOINT, threadId: "thread_a" },
    }))).toBe(false);
    expect(detector.check(candidate({
      destinationEndpoint: { ...ENDPOINT, conversationKind: "shared" },
    }))).toBe(false);
    expect(detector.check(candidate({ text: "Memory at 80%" }))).toBe(false);
  });

  it("uses length-delimited endpoint identities rather than ambiguous concatenation", () => {
    const detector = createDuplicateDetector({ clock: createFakeClock(1_000) });
    detector.recordPossiblyVisible(candidate({
      destinationEndpoint: { ...ENDPOINT, channelInstanceId: "ab", conversationId: "c" },
    }));
    expect(detector.check(candidate({
      destinationEndpoint: { ...ENDPOINT, channelInstanceId: "a", conversationId: "bc" },
    }))).toBe(false);
  });

  it("evicts the oldest record at the fixed five-hundred-entry bound", () => {
    const detector = createDuplicateDetector({ clock: createFakeClock(1_000) });
    for (let index = 0; index < 501; index++) {
      detector.recordPossiblyVisible(candidate({ text: `event-${index}` }));
    }
    expect(detector.check(candidate({ text: "event-0" }))).toBe(false);
    expect(detector.check(candidate({ text: "event-1" }))).toBe(true);
    expect(detector.check(candidate({ text: "event-500" }))).toBe(true);
  });

  it("clears all process-lifetime visibility records", () => {
    const detector = createDuplicateDetector({ clock: createFakeClock(1_000) });
    detector.recordPossiblyVisible(candidate());
    detector.clear();
    expect(detector.check(candidate())).toBe(false);
  });
});
