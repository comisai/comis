// SPDX-License-Identifier: Apache-2.0
/**
 * Telegram subagent parent-line tests.
 *
 * Telegram has no thread primitive, so the subagent expand affordance is INLINE:
 * the `🤖`-marked parent line (the projection baked the agentId into the
 * `defaultLabel`) renders verbatim in the edited message via `renderFrameText` —
 * there is no thread egress (unlike Discord/Slack). The renderer keeps its silent
 * effect and requests no thread for a subagent.
 */
import { describe, it, expect } from "vitest";
import type { ActivityRenderFrame, ActivityEvent } from "@comis/core";
import { signCallbackData } from "@comis/core";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createTelegramActivityRenderer } from "../telegram-activity.js";
import { createFakeTelegramAdapter } from "../../__tests__/fakes/telegram-fake.js";
import type { FakeTelegramCall } from "../../__tests__/fakes/telegram-fake.js";

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

describe("Telegram subagent parent line (inline expand)", () => {
  it("renders the subagent parent line inline (text carries the agentId), no thread", async () => {
    const timer = createFakeTimers();
    const fake = createFakeTelegramAdapter();
    // Drop clock so the "(running N s)" elapsed fallback
    // is skipped — the test asserts send.text byte-stably.
    const r = createTelegramActivityRenderer(fake, "chat-1", { timer, signCallbackData: sign });

    await r.apply(subagentFrame("🤖 researcher: 3 steps"));

    const send = fake.recorded.calls.find(
      (c): c is Extract<FakeTelegramCall, { op: "send" }> => c.op === "send",
    );
    // The parent line renders verbatim, inline — Telegram has no thread egress.
    expect(send?.text).toBe("🤖 researcher: 3 steps");
    expect(send?.text).toContain("researcher");
    expect(send?.silent).toBe(true);
    // A subagent carries no approval buttons.
    expect(send?.buttons).toBeUndefined();
  });
});
