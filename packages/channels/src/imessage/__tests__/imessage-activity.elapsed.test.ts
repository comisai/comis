// SPDX-License-Identifier: Apache-2.0
/**
 * iMessage wrapper elapsed-fallback wiring.
 * Regression-locks the LIVE production path: when the daemon injects a
 * `ClockPort` into the wrapper deps, the wrapper MUST forward it into
 * `createAppendOnlyRenderer({...clock})` so the strategy's first-apply `startedAtMs`
 * capture fires and the opening status carries the "(running N s)" elapsed-time
 * fallback.
 *
 * Without the wrapper forward, `deps.clock` is dropped at the wrapper layer →
 * startedAtMs stays undefined → elapsedMs stays undefined → the elapsed
 * fallback is silently inert in iMessage production. The wrapper's deps shape
 * must therefore include `clock?: ClockPort`, or the
 * `createIMessageActivityRenderer(fake, "chat-1", { clock })` call below does
 * not compile.
 *
 * AppendOnly posts ONCE — the elapsed fallback only ever appears on the first
 * (and only) send, exactly when the daemon has constructed the wrapper but SEP has
 * not yet emitted a plan. The assertion is on the SINGLE captured `actions.send`
 * text, never on edit/delete (iMessage has neither).
 */
import { describe, it, expect } from "vitest";
import type { ActivityRenderFrame, ActivityEvent } from "@comis/core";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createIMessageActivityRenderer } from "../imessage-activity.js";
import { createFakeIMessageAdapter } from "../../__tests__/fakes/imessage-fake.js";

function event(label: string): ActivityEvent {
  return {
    schemaVersion: 1,
    activityId: "00000000-0000-0000-0000-000000000000",
    sessionKey: "sess-a",
    agentId: "main",
    traceId: "trace-a",
    ts: "2026-05-26T00:00:00.000Z",
    phase: "progress",
    status: "running",
    kind: "tool",
    semanticPhase: "tool",
    defaultLabel: label,
  } as ActivityEvent;
}

function frameNoPlan(label: string): ActivityRenderFrame {
  return {
    frameSeq: 0,
    visibleEvents: [event(label)],
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added: [], edited: [], removed: [] },
  };
}

function frameWithPlan(label: string): ActivityRenderFrame {
  return {
    frameSeq: 0,
    visibleEvents: [event(label)],
    groupedActivityIds: {},
    planSnapshot: {
      entries: [{ id: "0", label: "step a", status: "in_progress" }],
    },
    changeSet: { added: [], edited: [], removed: [] },
  };
}

describe("iMessage wrapper forwards deps.clock into AppendOnly", () => {
  it("forwards deps.clock → AppendOnly: opening status carries '(running 0 s)' on the first frame (no SEP plan)", async () => {
    const fake = createFakeIMessageAdapter();
    const clock = createFakeClock(1000);
    // The wrapper's deps shape MUST accept `clock?: ClockPort` AND forward it
    // into `createAppendOnlyRenderer({...clock})`. Without the forward,
    // startedAtMs would stay undefined in the strategy → elapsedMs undefined →
    // fallback skipped → this assertion fails.
    const r = createIMessageActivityRenderer(fake, "chat-1", { clock });

    await r.apply(frameNoPlan("running tool"));

    const sends = fake.recorded.calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(1);
    if (sends[0]?.op === "send") {
      expect(sends[0].text).toContain("(running 0 s)");
      expect(sends[0].text).toContain("running tool");
    }
  });

  it("WITHOUT clock dep: graceful-degrade — opening status carries NO '(running' fallback", async () => {
    const fake = createFakeIMessageAdapter();
    // No clock passed — the wrapper's optional clock stays undefined → strategy
    // never captures startedAtMs → elapsedMs undefined → fallback skipped.
    const r = createIMessageActivityRenderer(fake, "chat-1", {});

    await r.apply(frameNoPlan("running tool"));

    const sends = fake.recorded.calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(1);
    if (sends[0]?.op === "send") {
      // The tool-event line carries the running 🔧 marker (the per-step
      // glyph); the no-elapsed-fallback invariant (`(running …)` absent) is
      // the load-bearing assertion.
      expect(sends[0].text).not.toContain("(running");
      expect(sends[0].text).toBe("🔧 running tool");
    }
  });

  it("with clock + frame.planSnapshot present: skips the elapsed fallback (no double-display)", async () => {
    const fake = createFakeIMessageAdapter();
    const clock = createFakeClock(1000);
    const r = createIMessageActivityRenderer(fake, "chat-1", { clock });

    // The plan header above the events already shows progress — the
    // elapsed fallback is suppressed to avoid double-display.
    await r.apply(frameWithPlan("running tool"));

    const sends = fake.recorded.calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(1);
    if (sends[0]?.op === "send") {
      expect(sends[0].text).not.toContain("(running");
    }
  });
});
