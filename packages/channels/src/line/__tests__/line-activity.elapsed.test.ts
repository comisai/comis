// SPDX-License-Identifier: Apache-2.0
/**
 * LINE wrapper elapsed-fallback wiring. Regression-locks the LIVE
 * production path: when the daemon injects a `ClockPort` into the wrapper deps,
 * the wrapper MUST forward it into `createAppendOnlyRenderer({...clock})` so the
 * strategy's first-apply `startedAtMs` capture fires and the opening status
 * carries the "(running N s)" elapsed-time fallback.
 *
 * Merely declaring `clock?: ClockPort` on the wrapper's deps shape is not
 * enough — passing `{ clock }` compiles either way. If the wrapper drops `clock`
 * on the floor at the `createAppendOnlyRenderer` call, the failure is
 * runtime-only: the captured send text contains no "(running" suffix because the
 * clock never reaches the strategy. This test fails exactly in that case.
 *
 * AppendOnly posts ONCE — the fallback only ever appears on the first (and only)
 * send, exactly when the daemon has wired the wrapper but SEP has not yet emitted
 * a plan. The assertion is on the SINGLE captured `actions.send` text.
 */
import { describe, it, expect } from "vitest";
import type { ActivityRenderFrame, ActivityEvent } from "@comis/core";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createLineActivityRenderer } from "../line-activity.js";
import { createFakeLineAdapter } from "../../__tests__/fakes/line-fake.js";

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

describe("LINE wrapper forwards deps.clock into AppendOnly", () => {
  it("forwards deps.clock → AppendOnly: opening status carries '(running 0 s)' on the first frame (no SEP plan)", async () => {
    const fake = createFakeLineAdapter();
    const clock = createFakeClock(1000);
    // The wrapper's deps shape accepts `clock?: ClockPort`, and the contract is
    // that `clock` is destructured AND forwarded into
    // `createAppendOnlyRenderer({...clock})`. Without the forward, startedAtMs
    // would stay undefined in the strategy → elapsedMs undefined → fallback
    // skipped → this assertion fails.
    const r = createLineActivityRenderer(fake, "chat-1", { clock });

    await r.apply(frameNoPlan("running tool"));

    const sends = fake.recorded.calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(1);
    if (sends[0]?.op === "send") {
      expect(sends[0].text).toContain("(running 0 s)");
      expect(sends[0].text).toContain("running tool");
    }
  });

  it("WITHOUT clock dep: graceful-degrade — opening status carries NO '(running' fallback", async () => {
    const fake = createFakeLineAdapter();
    const r = createLineActivityRenderer(fake, "chat-1", {});

    await r.apply(frameNoPlan("running tool"));

    const sends = fake.recorded.calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(1);
    if (sends[0]?.op === "send") {
      // Tool-event line carries the
      // running 🔧 marker; the no-elapsed-fallback invariant (`(running …)`
      // absent) is the load-bearing assertion.
      expect(sends[0].text).not.toContain("(running");
      expect(sends[0].text).toBe("🔧 running tool");
    }
  });

  it("with clock + frame.planSnapshot present: skips the elapsed fallback (no double-display)", async () => {
    const fake = createFakeLineAdapter();
    const clock = createFakeClock(1000);
    const r = createLineActivityRenderer(fake, "chat-1", { clock });

    // The plan header above the events already shows progress — the elapsed
    // fallback is suppressed to avoid double-display.
    await r.apply(frameWithPlan("running tool"));

    const sends = fake.recorded.calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(1);
    if (sends[0]?.op === "send") {
      expect(sends[0].text).not.toContain("(running");
    }
  });
});
