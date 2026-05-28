// SPDX-License-Identifier: Apache-2.0
/**
 * IRC subagent inline-line tests (APV-02 / APV-03 IRC half; §18.3 LinePerEvent).
 *
 * IRC has no thread primitive, so a `kind:"subagent"` event renders INLINE with a
 * `↳ ` depth prefix (the depth-aware plain-text form, §18.3). The prefix is a
 * renderer concern applied via the 73-06 `subagentLine(event, { depthPrefix: "↳ " })`;
 * the `🤖`/agentId portion rides on the projection's `defaultLabel` and is painted
 * verbatim after the prefix. The renderer adds the `↳ ` — it is NOT baked into the
 * event upstream (contrast the Phase-72 S7 fixture where `↳ ` was pre-baked data).
 *
 * A non-subagent event keeps the plain `eventLabel` line — no `↳ ` prefix.
 */
import { describe, it, expect } from "vitest";
import type { ActivityRenderFrame, ActivityEvent } from "@comis/core";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createIrcActivityRenderer } from "../irc-activity.js";
import { createFakeIrcAdapter } from "../../__tests__/fakes/irc-fake.js";

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    schemaVersion: 1,
    activityId: "a-1",
    sessionKey: "sess-a",
    agentId: "researcher",
    traceId: "trace-a",
    ts: "2026-05-26T00:00:00.000Z",
    phase: "progress",
    status: "running",
    kind: "subagent",
    semanticPhase: "tool",
    defaultLabel: "🤖 researcher: 3 steps",
    ...overrides,
  } as ActivityEvent;
}

function frame(event: ActivityEvent): ActivityRenderFrame {
  return {
    frameSeq: 0,
    visibleEvents: [event],
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added: [event.activityId], edited: [], removed: [] },
  };
}

describe("IRC subagent inline line (↳ depth prefix — APV-03)", () => {
  it("prefixes a kind:'subagent' event line with '↳ ' (the projection's label rides after it)", async () => {
    const clock = createFakeClock(0);
    const fake = createFakeIrcAdapter();
    const r = createIrcActivityRenderer(fake, "chan-1", { clock });

    await r.apply(frame(makeEvent({ defaultLabel: "🤖 researcher: 3 steps" })));

    const send = fake.recorded.calls.find((c) => c.op === "send");
    expect(send?.op).toBe("send");
    if (send?.op === "send") {
      expect(send.text.startsWith("↳ ")).toBe(true);
      // The agentId-bearing projection label rides verbatim after the prefix.
      expect(send.text).toBe("↳ 🤖 researcher: 3 steps");
    }
  });

  it("does NOT prefix a non-subagent (tool) event — it keeps the plain eventLabel line", async () => {
    const clock = createFakeClock(0);
    const fake = createFakeIrcAdapter();
    const r = createIrcActivityRenderer(fake, "chan-1", { clock });

    await r.apply(frame(makeEvent({ kind: "tool", defaultLabel: "running tool" })));

    const send = fake.recorded.calls.find((c) => c.op === "send");
    if (send?.op === "send") {
      // [Rule 1 — bug fix, quick-260528-nsv] Non-subagent tool event renders
      // with the per-step running 🔧 marker; the no-`↳ ` invariant (this
      // test's load-bearing point — IRC depth prefix only on subagent kind)
      // is unchanged.
      expect(send.text).toBe("🔧 running tool");
      expect(send.text.startsWith("↳ ")).toBe(false);
    }
  });
});
