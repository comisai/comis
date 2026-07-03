// SPDX-License-Identifier: Apache-2.0
/**
 * Echo activity renderer + harness tests.
 *
 * Echo is the canonical-stream reference: `createEchoActivityRenderer()` wraps
 * `createTestSink()`, which records every `apply(frame)` verbatim with NO
 * coalescing plus the single `finalize(outcome)`. The scenario cases read a
 * golden fixture from disk and assert via `toEqual` (NEVER `toMatchSnapshot` —
 * auto-write self-heals a wrong fixture).
 *
 * Determinism: fixed activityIds (`00000000-0000-0000-0000-00000000000N`),
 * fixed frameSeq, fake clock/timers — no `randomUUID`, no wall-clock timestamps
 * (would flap fixtures). The FakeEchoAdapter mints deterministic `echo-msg-N` ids and
 * records call ORDER only (no clock).
 */
import { describe, it, expect } from "vitest";
import type {
  ActivityRenderFrame,
  ActivityEvent,
  TurnOutcome,
  FinalDeliveryReceipt,
} from "@comis/core";
// 5 levels up from <ch>/__tests__/ — same depth as shared/strategies/X.test.ts.
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createEchoActivityRenderer } from "../echo-activity.js";
import { createFakeEchoAdapter } from "../../__tests__/fakes/echo-fake.js";
import { readFixture } from "../../__tests__/fixture-harness.js";

// --- Deterministic builders (no randomUUID, no timestamps) -----------------

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
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
    defaultLabel: "working",
    ...overrides,
  } as ActivityEvent;
}

function makeFrame(frameSeq: number, events: readonly ActivityEvent[]): ActivityRenderFrame {
  return {
    frameSeq,
    visibleEvents: events,
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added: [], edited: [], removed: [] },
  };
}

const RECEIPT: FinalDeliveryReceipt = {
  ok: true,
  deliveredChunks: 1,
  lastChunkMessageId: "msg-final",
  deliveredAtMs: 5000,
};

// A stable JSON projection of what TestSink recorded. This is the exact shape
// the golden fixtures pin (frame count + each frame's visibleEvents + outcome).
function serialiseRecorded(recorded: {
  frames: readonly ActivityRenderFrame[];
  outcome?: TurnOutcome;
}): unknown {
  return JSON.parse(JSON.stringify({ frames: recorded.frames, outcome: recorded.outcome ?? null }));
}

// --- Behavior tests ----------------------------------------------------------

describe("createEchoActivityRenderer (canonical fidelity)", () => {
  it("captures every apply frame verbatim with coalescing NOT applied plus the finalize outcome", async () => {
    const renderer = createEchoActivityRenderer();
    expect(renderer.strategy).toBe("TestSink");
    expect(renderer.canEdit).toBe(false);
    expect(renderer.canDelete).toBe(false);

    // Six un-coalesced frames (duplicate-shaped frames stay distinct — no coalesce).
    const dupEvent = makeEvent();
    const frames = [
      makeFrame(0, [makeEvent({ activityId: "00000000-0000-0000-0000-000000000001" })]),
      makeFrame(1, [makeEvent({ activityId: "00000000-0000-0000-0000-000000000002" })]),
      makeFrame(2, [dupEvent]),
      makeFrame(3, [dupEvent]),
      makeFrame(4, [makeEvent({ activityId: "00000000-0000-0000-0000-000000000005" })]),
      makeFrame(5, [makeEvent({ activityId: "00000000-0000-0000-0000-000000000006" })]),
    ];
    for (const f of frames) {
      const r = await renderer.apply(f);
      expect(r.ok).toBe(true);
    }
    const outcome: TurnOutcome = { kind: "success", trivial: false, delivery: RECEIPT };
    const fin = await renderer.finalize(outcome);
    expect(fin.ok).toBe(true);

    // Every frame captured (6, not collapsed) and the outcome recorded.
    expect(renderer.recorded.frames).toHaveLength(6);
    expect(renderer.recorded.frames.map((f) => f.frameSeq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(renderer.recorded.outcome?.kind).toBe("success");
  });
});

describe("createFakeEchoAdapter (recording shape, deterministic ids)", () => {
  it("records the full ChannelPort surface into an ordered call-log with echo-msg-N ids and NO timestamps", async () => {
    const fake = createFakeEchoAdapter();

    const send0 = await fake.sendMessage("chan-a", "hello");
    expect(send0.ok && send0.value).toBe("echo-msg-0");
    const send1 = await fake.sendMessage("chan-a", "second");
    expect(send1.ok && send1.value).toBe("echo-msg-1");

    expect(fake.editMessage).toBeDefined();
    await fake.editMessage?.("chan-a", "echo-msg-0", "edited");
    expect(fake.reactToMessage).toBeDefined();
    await fake.reactToMessage?.("chan-a", "echo-msg-0", "👍");
    expect(fake.removeReaction).toBeDefined();
    await fake.removeReaction?.("chan-a", "echo-msg-0", "👍");
    expect(fake.deleteMessage).toBeDefined();
    await fake.deleteMessage?.("chan-a", "echo-msg-1");

    // The serialised call-log is an ordered array of discriminated entries with
    // deterministic ids and NO timestamp keys (would flap fixtures).
    expect(fake.recorded.calls).toEqual([
      { op: "send", id: "echo-msg-0", text: "hello" },
      { op: "send", id: "echo-msg-1", text: "second" },
      { op: "edit", id: "echo-msg-0", text: "edited" },
      { op: "react", id: "echo-msg-0", emoji: "👍" },
      { op: "removeReaction", id: "echo-msg-0", emoji: "👍" },
      { op: "delete", id: "echo-msg-1" },
    ]);
    const serialised = JSON.stringify(fake.recorded.calls);
    expect(serialised).not.toMatch(/timestamp|ts"|deliveredAtMs/);
  });

  it("surfaces an injected platform error through the Result err branch without throwing (classifier seam)", async () => {
    const fake = createFakeEchoAdapter();
    fake.nextError = { error_code: 429, parameters: { retry_after: 3 } };
    const r = await fake.sendMessage("chan-a", "boom");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toEqual({ error_code: 429, parameters: { retry_after: 3 } });
    }
    // One-shot: the next call succeeds again.
    const r2 = await fake.sendMessage("chan-a", "ok-now");
    expect(r2.ok).toBe(true);
  });
});

describe("readFixture (read-from-disk helper)", () => {
  it("throws a clear pin-it error for a scenario whose golden fixture is absent", () => {
    expect(() => readFixture("echo", "DOES_NOT_EXIST")).toThrow(/Missing golden fixture/);
  });
});

// --- Scenario cases (S1-S7, S10-S12; no S8, S9 n/a) ---

/**
 * Build the recorded {frames, outcome} for a scenario, drive the Echo renderer,
 * and assert the serialised projection equals the on-disk golden fixture.
 * Coalescing is NOT applied — the frame the renderer records is the frame given.
 */
async function runScenario(
  scenario: string,
  frames: readonly ActivityRenderFrame[],
  outcome: TurnOutcome,
): Promise<void> {
  // Time discipline: fixtures are deterministic, but exercise the fake clock/timer
  // to prove no wall-clock leaks into the recorder.
  createFakeTimers();
  createFakeClock(0);

  const renderer = createEchoActivityRenderer();
  for (const f of frames) {
    const r = await renderer.apply(f);
    expect(r.ok).toBe(true);
  }
  const fin = await renderer.finalize(outcome);
  expect(fin.ok).toBe(true);

  const serialised = serialiseRecorded(renderer.recorded);
  expect(serialised).toEqual(readFixture("echo", scenario));
}

// Helper events keyed to the S1-S12 scenario cases.
function ev(id: number, over: Partial<ActivityEvent> = {}): ActivityEvent {
  return makeEvent({
    activityId: `00000000-0000-0000-0000-00000000000${id}`,
    ...over,
  });
}

const okReceipt: FinalDeliveryReceipt = {
  ok: true,
  deliveredChunks: 1,
  lastChunkMessageId: "msg-final",
  deliveredAtMs: 5000,
};

describe("Echo golden fixtures (TestSink recordings — readFixture + toEqual)", () => {
  it("S1 trivial chat — zero activity events, kind:success trivial", async () => {
    await runScenario("S1", [], { kind: "success", trivial: true, delivery: okReceipt });
  });

  it("S2 one fast tool — all 2 events captured, kind:success", async () => {
    await runScenario(
      "S2",
      [
        makeFrame(0, [ev(1, { phase: "start", defaultLabel: "running tool" })]),
        makeFrame(1, [ev(1, { phase: "end", status: "completed", defaultLabel: "tool done" })]),
      ],
      { kind: "success", trivial: false, delivery: okReceipt },
    );
  });

  it("S3 multi-step success — all 6 events captured, coalescing NOT applied", async () => {
    const frames = [0, 1, 2, 3, 4, 5].map((i) =>
      makeFrame(i, [ev(i + 1, { defaultLabel: `step ${i + 1}` })]),
    );
    await runScenario("S3", frames, { kind: "success", trivial: false, delivery: okReceipt });
  });

  it("S4 outright failure — failure event captured, kind:failure (no recovery)", async () => {
    await runScenario(
      "S4",
      [
        makeFrame(0, [ev(1, { phase: "start", defaultLabel: "running tool" })]),
        makeFrame(1, [ev(1, { phase: "end", status: "failed", semanticPhase: "error", defaultLabel: "tool failed", errorKind: "dependency" })]),
      ],
      { kind: "failure", errorKind: "dependency", failedEvents: [ev(1, { status: "failed", errorKind: "dependency" })] },
    );
  });

  it("S5 recovered failure — failure then recovery events captured, kind:success_with_recovered_failures", async () => {
    const recovered = ev(1, { status: "failed", errorKind: "network" });
    await runScenario(
      "S5",
      [
        makeFrame(0, [ev(1, { phase: "start", defaultLabel: "attempt 1" })]),
        makeFrame(1, [ev(1, { status: "failed", semanticPhase: "error", defaultLabel: "attempt 1 failed", errorKind: "network" })]),
        makeFrame(2, [ev(2, { phase: "start", defaultLabel: "attempt 2" })]),
        makeFrame(3, [ev(2, { phase: "end", status: "completed", defaultLabel: "attempt 2 ok" })]),
      ],
      {
        kind: "success_with_recovered_failures",
        trivial: false,
        delivery: okReceipt,
        recoveredFailures: [recovered],
      },
    );
  });

  it("S6 plan-state — every plan-state event captured, deleted on success", async () => {
    const plan = {
      entries: [
        { id: "p1", label: "step one", status: "done" as const },
        { id: "p2", label: "step two", status: "in_progress" as const },
      ],
    };
    await runScenario(
      "S6",
      [
        { ...makeFrame(0, [ev(1, { defaultLabel: "planning" })]), planSnapshot: plan },
        { ...makeFrame(1, [ev(2, { defaultLabel: "executing" })]), planSnapshot: plan },
      ],
      { kind: "success", trivial: false, delivery: okReceipt },
    );
  });

  it("S7 subagent — subagent events captured (no expand affordance for TestSink)", async () => {
    await runScenario(
      "S7",
      [
        makeFrame(0, [ev(1, { kind: "subagent", semanticPhase: "thinking", defaultLabel: "subagent: 3 steps" })]),
        makeFrame(1, [ev(1, { kind: "subagent", phase: "end", status: "completed", defaultLabel: "subagent done" })]),
      ],
      { kind: "success", trivial: false, delivery: okReceipt },
    );
  });

  it("S10 verbose — same as normal, every event renders (TestSink records all)", async () => {
    const frames = [0, 1, 2].map((i) => makeFrame(i, [ev(i + 1, { defaultLabel: `verbose ${i + 1}` })]));
    await runScenario("S10", frames, { kind: "success", trivial: false, delivery: okReceipt });
  });

  it("S11 silent verbosity — same as normal, TestSink is verbosity-agnostic", async () => {
    await runScenario(
      "S11",
      [makeFrame(0, [ev(1, { defaultLabel: "single event" })])],
      { kind: "success", trivial: false, delivery: okReceipt },
    );
  });

  it("S12 silent sentinel — all events incl. suppressed, kind:silent", async () => {
    await runScenario(
      "S12",
      [makeFrame(0, [ev(1, { kind: "lifecycle", semanticPhase: "done", defaultLabel: "suppressed reply" })])],
      { kind: "silent", reason: "NO_REPLY" },
    );
  });
});
