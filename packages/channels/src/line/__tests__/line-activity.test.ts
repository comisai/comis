// SPDX-License-Identifier: Apache-2.0
/**
 * LINE AppendOnly renderer tests.
 *
 * LINE is send-only for the activity renderer — it has no in-place edit and no
 * delete, so it wires the AppendOnly strategy IDENTICALLY to iMessage:
 * ONE opening status (the first non-trivial frame), later frames are no-ops, the
 * closing follow-up is SUPPRESSED on success (the assistant reply is the signal),
 * and a failure posts exactly one `❌ {errorKind}` follow-up.
 *
 * Scope: only the AppendOnly RENDERING half is covered here. The LINE
 * Quick Reply approval-chip affordance is covered in
 * `line-activity.approval.test.ts` (so there are no S8 fixtures here).
 * The single net-new piece of logic is `classifyLineError` — the live
 * adapter wraps send failures in `new Error("Failed to send LINE message: …")`
 * with no structured numeric code, so the classifier defaults to `internal` and
 * reads the error structurally ONLY (never renders the `.message` as activity
 * text). `makeLineRenderActions` maps `send` through it and guards
 * the absent `editMessage` / `deleteMessage`; `createLineActivityRenderer` wires
 * the `createAppendOnlyRenderer` (no duplicated state machine, NO timer/clock).
 *
 * Golden fixtures assert via readFixture + toEqual (NEVER an auto-writing
 * inline/file snapshot, which self-heals a wrong fixture).
 */
import { describe, it, expect } from "vitest";
import type { ActivityRenderFrame, ActivityEvent, TurnOutcome, FinalDeliveryReceipt } from "@comis/core";
import {
  classifyLineError,
  makeLineRenderActions,
  createLineActivityRenderer,
} from "../line-activity.js";
import { createFakeLineAdapter } from "../../__tests__/fakes/line-fake.js";
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

function makeFrame(frameSeq: number, label: string): ActivityRenderFrame {
  return {
    frameSeq,
    visibleEvents: [makeEvent({ defaultLabel: label })],
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added: [], edited: [], removed: [] },
  };
}

function okReceipt(deliveredAtMs: number): FinalDeliveryReceipt {
  return { ok: true, deliveredChunks: 1, lastChunkMessageId: "msg-final", deliveredAtMs };
}

// --- classifyLineError + makeLineRenderActions ------------------------------

describe("classifyLineError (structural only, never the message string)", () => {
  it("maps an unknown bare Error to internal carrying the cause (LINE has no numeric code)", () => {
    const e = new Error("Failed to send LINE message: push quota exceeded");
    expect(classifyLineError(e)).toEqual({ kind: "internal", cause: e });
  });

  it("maps an undefined error to internal (defensive default)", () => {
    const r = classifyLineError(undefined);
    expect(r.kind).toBe("internal");
  });

  it("maps an arbitrary error object to internal — it does not invent a rich classifier", () => {
    const e = { message: "LINE SDK HTTP 429", statusCode: 429 };
    const r = classifyLineError(e);
    expect(r.kind).toBe("internal");
  });

  it("does NOT render the wrapped 'Failed to send …' message as activity text — only selects the variant", () => {
    const e = new Error("Failed to send LINE message: secret-bearing-token-detail");
    const r = classifyLineError(e);
    expect(r.kind).toBe("internal");
    if (r.kind === "internal") expect(r.cause).toBe(e);
  });
});

describe("makeLineRenderActions (Result discipline, no silent, edit+delete guards)", () => {
  it("sends the opening status and resolves to the minted id (no silent effect, no buttons)", async () => {
    const fake = createFakeLineAdapter();
    const actions = makeLineRenderActions(fake, "chat-1");
    const r = await actions.send("opening status");
    expect(r.ok && r.value).toBe("line-msg-0");
    const send = fake.recorded.calls.find((c) => c.op === "send");
    // No `silent` field is recorded — LINE does not send the silent effect.
    expect(send).toEqual({ op: "send", id: "line-msg-0", text: "opening status" });
  });

  it("maps an unknown send error to err(internal) without throwing", async () => {
    const fake = createFakeLineAdapter();
    const actions = makeLineRenderActions(fake, "chat-1");
    fake.nextError = new Error("Failed to send LINE message: boom");
    const r = await actions.send("x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("internal");
  });

  it("edit always returns err(not_supported:edit) WITHOUT throwing (LINE has no editMessage)", async () => {
    const fake = createFakeLineAdapter();
    const actions = makeLineRenderActions(fake, "chat-1");
    const r = await actions.edit("line-msg-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "edit" });
    // The guard short-circuits before touching the port — no call recorded.
    expect(fake.recorded.calls.length).toBe(0);
  });

  it("delete always returns err(not_supported:delete) WITHOUT throwing (LINE has no deleteMessage)", async () => {
    const fake = createFakeLineAdapter();
    const actions = makeLineRenderActions(fake, "chat-1");
    const r = await actions.delete("line-msg-0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "delete" });
    expect(fake.recorded.calls.length).toBe(0);
  });
});

describe("createLineActivityRenderer (AppendOnly wiring)", () => {
  it("returns an AppendOnly renderer that can neither edit nor delete", () => {
    const fake = createFakeLineAdapter();
    const r = createLineActivityRenderer(fake, "chat-1");
    expect(r.strategy).toBe("AppendOnly");
    expect(r.canEdit).toBe(false);
    expect(r.canDelete).toBe(false);
  });

  it("posts the opening status ONCE; later frames are no-ops (cannot edit, do not spam)", async () => {
    const fake = createFakeLineAdapter();
    const r = createLineActivityRenderer(fake, "chat-1");

    await r.apply(makeFrame(0, "step 1"));
    await r.apply(makeFrame(1, "step 2"));
    await r.apply(makeFrame(2, "step 3"));

    const sends = fake.recorded.calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(1);
    // First frame's event line carries
    // the running 🔧 marker; the post-once / no-spam invariant is the
    // load-bearing assertion.
    expect(sends[0]).toEqual({ op: "send", id: "line-msg-0", text: "🔧 step 1" });
  });

  it("SUPPRESSES the closing follow-up on success (the assistant reply is the signal)", async () => {
    const fake = createFakeLineAdapter();
    const r = createLineActivityRenderer(fake, "chat-1");

    await r.apply(makeFrame(0, "step 1"));
    await r.finalize({ kind: "success", trivial: false, delivery: okReceipt(1000) });

    // Exactly the opening send — no closing on success.
    const sends = fake.recorded.calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(1);
  });

  it("posts exactly one ❌ {errorKind} follow-up on failure", async () => {
    const fake = createFakeLineAdapter();
    const r = createLineActivityRenderer(fake, "chat-1");

    await r.apply(makeFrame(0, "step 1"));
    await r.finalize({
      kind: "failure",
      errorKind: "dependency",
      failedEvents: [makeEvent({ status: "failed", errorKind: "dependency" })],
    });

    const last = fake.recorded.calls[fake.recorded.calls.length - 1];
    expect(last.op).toBe("send");
    if (last.op === "send") {
      expect(last.text).toContain("❌");
      expect(last.text).toContain("dependency");
    }
    // Opening + the single ❌ closing.
    expect(fake.recorded.calls.filter((c) => c.op === "send")).toHaveLength(2);
  });
});

// --- 11 golden fixtures (S1-S7, S9-S12; no S8) ------------------------------

/** Serialise the fake's ordered call-log — the exact shape the fixtures pin. */
function serialiseCallLog(fake: ReturnType<typeof createFakeLineAdapter>): unknown {
  return JSON.parse(JSON.stringify({ calls: fake.recorded.calls }));
}

/**
 * Drive the LINE AppendOnly renderer through a scenario's frames + finalize and
 * RETURN the serialised call-log. AppendOnly takes NO timer/clock — the factory
 * call is `createLineActivityRenderer(fake, "chat-1")` with no deps, and there is
 * no delete to gate behind a deliveredAt timer (contrast the DeleteAndRepost
 * runScenario). Each `it(...)` asserts `toEqual(readFixture("line", …))` itself
 * (never an auto-writing snapshot) so the on-disk fixture cannot self-heal.
 */
async function runScenario(
  frames: readonly ActivityRenderFrame[],
  outcome: TurnOutcome,
): Promise<unknown> {
  const fake = createFakeLineAdapter();
  const r = createLineActivityRenderer(fake, "chat-1");

  for (const f of frames) {
    await r.apply(f);
    await Promise.resolve();
  }
  await r.finalize(outcome);
  await Promise.resolve();

  return serialiseCallLog(fake);
}

function ev(id: number, over: Partial<ActivityEvent> = {}): ActivityEvent {
  return makeEvent({ activityId: `00000000-0000-0000-0000-00000000000${id}`, ...over });
}

const okFinal = (deliveredAtMs: number): FinalDeliveryReceipt => okReceipt(deliveredAtMs);

describe("LINE golden fixtures (AppendOnly call-log — readFixture + toEqual)", () => {
  it("S1 trivial chat — zero renderer messages (kind:success trivial, no frame ever applied)", async () => {
    const log = await runScenario([], { kind: "success", trivial: true, delivery: okFinal(0) });
    expect(log).toEqual(readFixture("line", "S1"));
  });

  it("S2 one fast tool — 1 opening status, NO closing (success trivial)", async () => {
    const log = await runScenario(
      [makeFrame(0, "running tool")],
      { kind: "success", trivial: true, delivery: okFinal(2000) },
    );
    expect(log).toEqual(readFixture("line", "S2"));
  });

  it("S3 multi-step success — opening posted ONCE; later applies are no-ops; NO closing on success (suppress-on-success)", async () => {
    const frames = [0, 1, 2].map((i) => makeFrame(i, `step ${i + 1}`));
    const log = await runScenario(frames, { kind: "success", trivial: false, delivery: okFinal(5000) });
    expect(log).toEqual(readFixture("line", "S3"));
  });

  it("S4 outright failure — 1 opening status + exactly one ❌ {errorKind} closing", async () => {
    const log = await runScenario(
      [makeFrame(0, "running tool"), makeFrame(1, "tool failed")],
      { kind: "failure", errorKind: "dependency", failedEvents: [ev(1, { status: "failed", errorKind: "dependency" })] },
    );
    expect(log).toEqual(readFixture("line", "S4"));
  });

  it("S5 recovered failure — treated like success: 1 opening status, NO closing (kind:success_with_recovered_failures)", async () => {
    const recovered = ev(1, { status: "failed", errorKind: "network" });
    const log = await runScenario(
      [makeFrame(0, "attempt 1"), makeFrame(1, "attempt 1 failed"), makeFrame(2, "attempt 2 ok")],
      { kind: "success_with_recovered_failures", trivial: false, delivery: okFinal(0), recoveredFailures: [recovered] },
    );
    expect(log).toEqual(readFixture("line", "S5"));
  });

  it("S6 plan-state — the opening status is the first frame's visible-events line, NO closing on success", async () => {
    const plan = {
      entries: [
        { id: "p1", label: "step one", status: "done" as const },
        { id: "p2", label: "step two", status: "in_progress" as const },
      ],
    };
    const log = await runScenario(
      [
        { ...makeFrame(0, "planning"), planSnapshot: plan },
        { ...makeFrame(1, "executing"), planSnapshot: plan },
      ],
      { kind: "success", trivial: false, delivery: okFinal(3000) },
    );
    expect(log).toEqual(readFixture("line", "S6"));
  });

  it("S7 subagent — the '↳ subagent' line is data on the event (renderer adds no prefix), opening only on success", async () => {
    const log = await runScenario(
      [
        makeFrame(0, "↳ subagent: 3 steps"),
        makeFrame(1, "↳ subagent done"),
      ],
      { kind: "success", trivial: false, delivery: okFinal(4000) },
    );
    expect(log).toEqual(readFixture("line", "S7"));
  });

  it("S9 message_tool visibility — 1 opening status, NO closing on success", async () => {
    const log = await runScenario(
      [makeFrame(0, "running tool")],
      { kind: "success", trivial: false, delivery: okFinal(2000) },
    );
    expect(log).toEqual(readFixture("line", "S9"));
  });

  it("S10 verbose — opening posted ONCE then no-ops, NO closing on success", async () => {
    const frames = [0, 1, 2].map((i) => makeFrame(i, `verbose ${i + 1}`));
    const log = await runScenario(frames, { kind: "success", trivial: false, delivery: okFinal(5000) });
    expect(log).toEqual(readFixture("line", "S10"));
  });

  it("S11 silent verbosity — zero renderer messages (kind:silent, no frame applied)", async () => {
    const log = await runScenario([], { kind: "silent", reason: "SILENT" });
    expect(log).toEqual(readFixture("line", "S11"));
  });

  it("S12 silent sentinel — 1 opening status, NO closing (silent finalize emits nothing)", async () => {
    const log = await runScenario(
      [makeFrame(0, "suppressed reply")],
      { kind: "silent", reason: "NO_REPLY" },
    );
    expect(log).toEqual(readFixture("line", "S12"));
  });
});
