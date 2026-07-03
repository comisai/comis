// SPDX-License-Identifier: Apache-2.0
/**
 * Discord subagent parent-line + thread-expand tests.
 *
 * A `kind:"subagent"` event's `defaultLabel` carries the `🤖` marker the
 * activity-stream projection set; `renderFrameText` paints it verbatim,
 * so the sent text shows the subagent parent line (incl. the agentId the
 * projection baked into the label). Discord keys the thread-expand affordance off
 * that marker: a subagent placeholder `send` requests `{ threadReply: true }`,
 * which the adapter surfaces as a public thread (the `threadCreate` egress).
 *
 * This is the capability-appropriate expand: Discord supports threads, so the
 * expand affordance lives in a thread (vs Telegram's inline form).
 */
import { describe, it, expect } from "vitest";
import type { ActivityRenderFrame, ActivityEvent } from "@comis/core";
import { signCallbackData } from "@comis/core";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createDiscordActivityRenderer } from "../discord-activity.js";
import { createFakeDiscordAdapter } from "../../__tests__/fakes/discord-fake.js";
import type { FakeDiscordCall } from "../../__tests__/fakes/discord-fake.js";

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

describe("Discord subagent parent line + thread-expand affordance", () => {
  it("renders the subagent parent line (text carries the agentId) and requests a thread", async () => {
    const timer = createFakeTimers();
    const fake = createFakeDiscordAdapter();
    // Drop clock so the "(running N s)" elapsed fallback
    // is skipped — the test asserts send.text byte-stably.
    const r = createDiscordActivityRenderer(fake, "chat-1", { timer, signCallbackData: sign });

    await r.apply(subagentFrame("🤖 researcher: 3 steps"));

    const send = fake.recorded.calls.find(
      (c): c is Extract<FakeDiscordCall, { op: "send" }> => c.op === "send",
    );
    // The parent line renders verbatim — the projection baked the agentId in.
    expect(send?.text).toBe("🤖 researcher: 3 steps");
    expect(send?.text).toContain("researcher");

    // Discord places the expand affordance in a thread (capability-appropriate).
    const thread = fake.recorded.calls.find((c) => c.op === "threadCreate");
    expect(thread).toEqual({ op: "threadCreate", parentId: "dc-msg-0" });
  });

  it("a non-subagent frame requests NO thread", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeDiscordAdapter();
    const r = createDiscordActivityRenderer(fake, "chat-1", { timer, clock, signCallbackData: sign });

    await r.apply(subagentFrame("running tool"));

    const thread = fake.recorded.calls.find((c) => c.op === "threadCreate");
    expect(thread).toBeUndefined();
  });
});
