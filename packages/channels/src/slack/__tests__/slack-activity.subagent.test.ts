// SPDX-License-Identifier: Apache-2.0
/**
 * Slack subagent parent-line + thread-expand tests.
 *
 * A `kind:"subagent"` event's `defaultLabel` carries the `🤖` marker the
 * projection set; `renderFrameText` paints it verbatim, so the sent text shows
 * the subagent parent line (incl. the agentId baked into the label). Slack keys
 * the expand affordance off that marker: a subagent placeholder `send` requests
 * `{ threadReply: true }`, which the adapter surfaces as a Slack thread
 * (`thread_ts`) — the capability-appropriate expand for Slack (vs Telegram's
 * inline form).
 */
import { describe, it, expect } from "vitest";
import type { ActivityRenderFrame, ActivityEvent } from "@comis/core";
import { signCallbackData } from "@comis/core";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createSlackActivityRenderer } from "../slack-activity.js";
import { createFakeSlackAdapter } from "../../__tests__/fakes/slack-fake.js";
import type { FakeSlackCall } from "../../__tests__/fakes/slack-fake.js";

const SECRET = "test-callback-signing-secret-0123456789";
const sign = (choice: "approve" | "deny" | "details", shortId: string): string =>
  signCallbackData(SECRET, choice, shortId);

function subagentFrame(label: string): ActivityRenderFrame {
  const event: ActivityEvent = {
    schemaVersion: 1,
    activityId: "00000000-0000-0000-0000-000000000000",
    sessionKey: "sess-a",
    agentId: "researcher",
    traceId: "trace-a",
    ts: "2026-05-26T00:00:00.000Z",
    phase: "progress",
    status: "running",
    kind: "subagent",
    semanticPhase: "tool",
    defaultLabel: label,
  } as ActivityEvent;
  return {
    frameSeq: 0,
    visibleEvents: [event],
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added: [], edited: [], removed: [] },
  };
}

describe("Slack subagent parent line + thread-expand affordance", () => {
  it("renders the subagent parent line (text carries the agentId) and opens a thread", async () => {
    const timer = createFakeTimers();
    const fake = createFakeSlackAdapter();
    // Drop clock so the "(running N s)" elapsed fallback is skipped — the test
    // asserts send.text byte-stably.
    const r = createSlackActivityRenderer(fake, "chat-1", { timer, signCallbackData: sign });

    await r.apply(subagentFrame("🤖 researcher: 3 steps"));

    const send = fake.recorded.calls.find(
      (c): c is Extract<FakeSlackCall, { op: "send" }> => c.op === "send",
    );
    expect(send?.text).toBe("🤖 researcher: 3 steps");
    expect(send?.text).toContain("researcher");

    // Slack places the expand affordance in a thread (thread_ts).
    const thread = fake.recorded.calls.find((c) => c.op === "thread");
    expect(thread).toEqual({ op: "thread", parentId: "sl-msg-0" });
  });

  it("a non-subagent frame opens NO thread", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeSlackAdapter();
    const r = createSlackActivityRenderer(fake, "chat-1", { timer, clock, signCallbackData: sign });

    await r.apply(subagentFrame("running tool"));

    const thread = fake.recorded.calls.find((c) => c.op === "thread");
    expect(thread).toBeUndefined();
  });
});
