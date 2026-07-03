// SPDX-License-Identifier: Apache-2.0
/**
 * IRC LinePerEvent renderer tests.
 *
 * IRC is text-only: no in-place edit, no delete, a hard 512-char per-line
 * cap. The renderer wires the `createLinePerEventRenderer` — that
 * strategy OWNS the 512-cap/`…` truncation and the closing summary line; this
 * file proves the wiring (one send per `changeSet.added` event, `✓ done · N steps`
 * on success, `[ERR] {errorKind}` on failure) and the thin classifier.
 *
 * The single net-new piece of logic here is `classifyIrcError` — IRC wraps send
 * failures in `new Error("Failed to send IRC message: …")` with NO structured
 * numeric code, so the classifier defaults to `internal` and reads the error for
 * NOTHING user-facing (it selects the variant only and is NEVER rendered as
 * activity text). `makeIrcRenderActions` maps `send` through it and
 * answers `edit`/`delete` with `not_supported` (IRC has neither);
 * `createIrcActivityRenderer` wires the strategy (no duplicated state machine).
 *
 * Time discipline: every fixture test drives the injected FakeClock — no raw
 * wall-time call (globals.test.ts fails the build otherwise). IRC needs only a
 * clock (the elapsed-time suffix on the success closing line); LinePerEvent takes
 * NO timer. Golden fixtures assert via readFixture + toEqual (NEVER an
 * auto-writing inline/file snapshot, which self-heals a wrong fixture).
 */
import { describe, it, expect } from "vitest";
import type {
  ActivityRenderFrame,
  ActivityEvent,
  TurnOutcome,
} from "@comis/core";
// 5 levels up from irc/__tests__/ — same depth as signal/__tests__/X.test.ts.
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import {
  classifyIrcError,
  makeIrcRenderActions,
  createIrcActivityRenderer,
} from "../irc-activity.js";
import { createFakeIrcAdapter } from "../../__tests__/fakes/irc-fake.js";
import type { FakeIrcCall } from "../../__tests__/fakes/irc-fake.js";
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

// --- classifyIrcError + makeIrcRenderActions --------------------------------

describe("classifyIrcError (structural only, never the wrapped message string)", () => {
  it("maps an unknown bare Error to internal carrying the cause (IRC has no numeric code)", () => {
    const e = new Error("Failed to send IRC message: write EPIPE");
    expect(classifyIrcError(e)).toEqual({ kind: "internal", cause: e });
  });

  it("maps an undefined error to internal (defensive default)", () => {
    const r = classifyIrcError(undefined);
    expect(r.kind).toBe("internal");
  });

  it("maps an arbitrary error object to internal — it does not invent a rich classifier", () => {
    const e = { message: "something went wrong", code: "ENOTFOUND" };
    const r = classifyIrcError(e);
    // Default branch: IRC exposes no structured code to map a richer variant.
    expect(r.kind).toBe("internal");
  });

  it("does NOT render the wrapped error message as activity text — only selects the variant", () => {
    // The live adapter wraps send failures as `new Error("Failed to send IRC message: <msg>")`.
    const e = new Error("Failed to send IRC message: secret-bearing-detail");
    const r = classifyIrcError(e);
    expect(r.kind).toBe("internal");
    if (r.kind === "internal") expect(r.cause).toBe(e);
  });
});

describe("makeIrcRenderActions (Result discipline, no silent, edit+delete unsupported)", () => {
  it("sends a line and resolves to the minted id (no silent effect, no buttons)", async () => {
    const fake = createFakeIrcAdapter();
    const actions = makeIrcRenderActions(fake, "chan-1");
    const r = await actions.send("running tool");
    expect(r.ok && r.value).toBe("irc-msg-0");
    const send = fake.recorded.calls.find((c) => c.op === "send");
    // No `silent` field is recorded — IRC has no rich effects.
    expect(send).toEqual({ op: "send", id: "irc-msg-0", text: "running tool" });
  });

  it("maps an unknown send error to err(internal) without throwing", async () => {
    const fake = createFakeIrcAdapter();
    const actions = makeIrcRenderActions(fake, "chan-1");
    fake.nextError = new Error("Failed to send IRC message: write EPIPE");
    const r = await actions.send("x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("internal");
  });

  it("edit always returns err(not_supported:edit) WITHOUT throwing (IRC has no in-place edit)", async () => {
    const fake = createFakeIrcAdapter();
    const actions = makeIrcRenderActions(fake, "chan-1");
    const r = await actions.edit("irc-msg-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "edit" });
    // No call reached the adapter — the early return short-circuits before the port.
    expect(fake.recorded.calls).toHaveLength(0);
  });

  it("delete always returns err(not_supported:delete) WITHOUT throwing (IRC cannot delete)", async () => {
    const fake = createFakeIrcAdapter();
    const actions = makeIrcRenderActions(fake, "chan-1");
    const r = await actions.delete("irc-msg-0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "delete" });
    expect(fake.recorded.calls).toHaveLength(0);
  });
});

describe("createIrcActivityRenderer (LinePerEvent wiring, clock-only deps)", () => {
  it("returns a LinePerEvent renderer that can neither edit nor delete", () => {
    const clock = createFakeClock(0);
    const fake = createFakeIrcAdapter();
    const r = createIrcActivityRenderer(fake, "chan-1", { clock });
    expect(r.strategy).toBe("LinePerEvent");
    expect(r.canEdit).toBe(false);
    expect(r.canDelete).toBe(false);
  });

  it("emits one send per added event (one line per surviving event)", async () => {
    const clock = createFakeClock(0);
    const fake = createFakeIrcAdapter();
    const r = createIrcActivityRenderer(fake, "chan-1", { clock });

    await r.apply({
      frameSeq: 0,
      visibleEvents: [makeEvent({ activityId: "a-1", defaultLabel: "step one" })],
      groupedActivityIds: {},
      planSnapshot: undefined,
      changeSet: { added: ["a-1"], edited: [], removed: [] },
    });

    // The tool-event line carries the running 🔧 marker (per-step glyph
    // derived by eventLabel); the one-send-per-added-event invariant is the
    // load-bearing assertion.
    expect(fake.recorded.calls).toEqual([{ op: "send", id: "irc-msg-0", text: "🔧 step one" }]);
  });
});

// --- 11 golden fixtures (S1-S7, S9-S12; no S8) ------------------------------

/** Serialise the fake's ordered call-log — the exact shape the fixtures pin. */
function serialiseCallLog(fake: ReturnType<typeof createFakeIrcAdapter>): unknown {
  return JSON.parse(JSON.stringify({ calls: fake.recorded.calls }));
}

/**
 * Build one event with an explicit `activityId` so a frame's `changeSet.added`
 * can name it — that is what makes LinePerEvent emit a line for it.
 */
function ev(id: string, label: string): ActivityEvent {
  return makeEvent({ activityId: id, defaultLabel: label });
}

/**
 * One frame that introduces a single new event (its id listed in
 * `changeSet.added`, the trigger LinePerEvent reads). Unlike the EditPlace
 * makeFrame, this POPULATES `added` so a line is emitted.
 */
function addedFrame(seq: number, id: string, label: string): ActivityRenderFrame {
  return {
    frameSeq: seq,
    visibleEvents: [ev(id, label)],
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added: [id], edited: [], removed: [] },
  };
}

/**
 * Drive the IRC renderer through a scenario's frames + finalize, advancing a
 * deterministic clock by ELAPSED_MS once before finalize so the `· Xs` suffix on
 * the success closing line is byte-stable, then RETURN the serialised call-log so
 * each `it()` can assert it `toEqual(readFixture("irc", scenario))`.
 */
async function runScenario(
  frames: readonly ActivityRenderFrame[],
  outcome: TurnOutcome,
): Promise<unknown> {
  const clock = createFakeClock(0);
  const fake = createFakeIrcAdapter();
  const r = createIrcActivityRenderer(fake, "chan-1", { clock });

  for (const f of frames) {
    await r.apply(f);
  }
  // Advance a fixed delta so the success closing-line elapsed suffix is stable
  // (LinePerEvent computes (now - startMs)/1000; 2000ms → "2.0s").
  clock.advance(ELAPSED_MS);
  await r.finalize(outcome);

  return serialiseCallLog(fake);
}

/** Fixed elapsed delta → the success closing line reads `· 2.0s`. */
const ELAPSED_MS = 2000;

describe("IRC golden fixtures (LinePerEvent rows — readFixture + toEqual)", () => {
  it("S1 trivial chat — zero lines (success trivial, no added events)", async () => {
    const log = await runScenario([], { kind: "success", trivial: true, delivery: receipt(0) });
    expect(log).toEqual(readFixture("irc", "S1"));
  });

  it("S2 one fast tool — 1 line + closing ✓ done · 1 steps · Xs (success non-trivial)", async () => {
    const log = await runScenario(
      [addedFrame(0, "a-1", "running tool")],
      { kind: "success", trivial: false, delivery: receipt(2000) },
    );
    expect(log).toEqual(readFixture("irc", "S2"));
  });

  it("S3 multi-step — one line per added event + closing ✓ done · N steps · Xs", async () => {
    const frames = [0, 1, 2].map((i) => addedFrame(i, `a-${i}`, `step ${i + 1}`));
    const log = await runScenario(frames, { kind: "success", trivial: false, delivery: receipt(5000) });
    expect(log).toEqual(readFixture("irc", "S3"));
  });

  it("S4 outright failure — per-event line(s) + closing [ERR] {errorKind}", async () => {
    const log = await runScenario(
      [addedFrame(0, "a-0", "running tool"), addedFrame(1, "a-1", "tool failed")],
      { kind: "failure", errorKind: "dependency", failedEvents: [ev("a-1", "tool failed")] },
    );
    expect(log).toEqual(readFixture("irc", "S4"));
  });

  // The shipped createLinePerEventRenderer treats
  // success_with_recovered_failures identically to success (a closing ✓ done line).
  // The fixture pins the ACTUAL renderer output.
  it("S5 recovered failure — per-event lines + ✓ done · N steps (treated like success)", async () => {
    const recovered = ev("a-1", "attempt 1 failed");
    const log = await runScenario(
      [addedFrame(0, "a-0", "attempt 1"), addedFrame(1, "a-1", "attempt 1 failed"), addedFrame(2, "a-2", "attempt 2 ok")],
      { kind: "success_with_recovered_failures", trivial: false, delivery: receipt(0), recoveredFailures: [recovered] },
    );
    expect(log).toEqual(readFixture("irc", "S5"));
  });

  it("S6 plan-state — IRC inlines plan progress as the events' lines + success closing", async () => {
    const log = await runScenario(
      [addedFrame(0, "a-0", "planning"), addedFrame(1, "a-1", "executing")],
      { kind: "success", trivial: false, delivery: receipt(3000) },
    );
    expect(log).toEqual(readFixture("irc", "S6"));
  });

  it("S7 subagent — added events carry a `↳ ` depth prefix in defaultLabel", async () => {
    const log = await runScenario(
      [addedFrame(0, "a-0", "↳ subagent: search"), addedFrame(1, "a-1", "↳ subagent: done")],
      { kind: "success", trivial: false, delivery: receipt(4000) },
    );
    expect(log).toEqual(readFixture("irc", "S7"));
  });

  it("S9 message_tool visibility — per-event line + success closing", async () => {
    const log = await runScenario(
      [addedFrame(0, "a-0", "running tool")],
      { kind: "success", trivial: false, delivery: receipt(2000) },
    );
    expect(log).toEqual(readFixture("irc", "S9"));
  });

  it("S10 verbose — every added event renders a line + success closing", async () => {
    const frames = [0, 1, 2].map((i) => addedFrame(i, `a-${i}`, `verbose ${i + 1}`));
    const log = await runScenario(frames, { kind: "success", trivial: false, delivery: receipt(5000) });
    expect(log).toEqual(readFixture("irc", "S10"));
  });

  it("S11 silent verbosity — zero lines (kind:silent, no added events)", async () => {
    const log = await runScenario([], { kind: "silent", reason: "SILENT" });
    expect(log).toEqual(readFixture("irc", "S11"));
  });

  it("S12 silent sentinel — the per-event line only, no closing (silent finalize emits nothing)", async () => {
    const log = await runScenario(
      [addedFrame(0, "a-0", "suppressed reply")],
      { kind: "silent", reason: "NO_REPLY" },
    );
    expect(log).toEqual(readFixture("irc", "S12"));
  });
});

/** Minimal FinalDeliveryReceipt the success outcomes carry (deliveredAt unused by LinePerEvent). */
function receipt(deliveredAtMs: number): { ok: true; deliveredChunks: number; lastChunkMessageId: string; deliveredAtMs: number } {
  return { ok: true, deliveredChunks: 1, lastChunkMessageId: "msg-final", deliveredAtMs };
}

// Touch the imported call type so the unused-import lint stays quiet while the
// fixture rows keep their narrow op shape documented.
export type _FakeIrcCall = FakeIrcCall;
