// SPDX-License-Identifier: Apache-2.0
/**
 * Signal DeleteAndRepost renderer tests.
 *
 * Signal is the ONLY one of the 5 non-EditPlace channels with a real
 * `deleteMessage` — it is the canonical DeleteAndRepost wiring. The single
 * net-new piece of logic here is `classifySignalError` — Signal exposes NO
 * structured numeric code for send/delete failures (the live adapter returns
 * `err(result.error)`, a raw signal-cli RPC Error), so the classifier defaults
 * to `internal` and reads the error structurally ONLY (never renders the
 * `.message` as activity text). `makeSignalRenderActions` maps
 * each ChannelPort call through it and guards the absent `editMessage`;
 * `createSignalActivityRenderer` wires the `createDeleteAndRepostRenderer`
 * (no duplicated state machine).
 *
 * Time discipline: every fixture test drives the injected FakeTimers/FakeClock —
 * no raw wall-time call (globals.test.ts fails the build otherwise). Golden
 * fixtures assert via readFixture + toEqual (NEVER an auto-writing inline/file
 * snapshot, which self-heals a wrong fixture).
 */
import { describe, it, expect } from "vitest";
import type {
  ActivityRenderFrame,
  ActivityEvent,
  TurnOutcome,
  FinalDeliveryReceipt,
} from "@comis/core";
// 5 levels up from signal/__tests__/ — same depth as telegram/__tests__/X.test.ts.
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import {
  classifySignalError,
  makeSignalRenderActions,
  createSignalActivityRenderer,
} from "../signal-activity.js";
import { createFakeSignalAdapter } from "../../__tests__/fakes/signal-fake.js";
import type { FakeSignalCall } from "../../__tests__/fakes/signal-fake.js";
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

function receiptAt(deliveredAtMs: number): FinalDeliveryReceipt {
  return { ok: true, deliveredChunks: 1, lastChunkMessageId: "msg-final", deliveredAtMs };
}

// --- classifySignalError + makeSignalRenderActions -------------------------

describe("classifySignalError (structural only, never the message string)", () => {
  it("maps an unknown bare Error to internal carrying the cause (Signal has no numeric code)", () => {
    const e = new Error("send failed");
    expect(classifySignalError(e)).toEqual({ kind: "internal", cause: e });
  });

  it("maps an undefined error to internal (defensive default)", () => {
    const r = classifySignalError(undefined);
    expect(r.kind).toBe("internal");
  });

  it("maps an arbitrary RPC error object to internal — it does not invent a rich classifier", () => {
    const e = { message: "JSON-RPC error -32000: failure", code: -32000 };
    const r = classifySignalError(e);
    // Default branch: no structured Signal code maps to a richer variant.
    expect(r.kind).toBe("internal");
  });

  it("does NOT render the error message as activity text — only selects the variant", () => {
    const e = new Error("secret-bearing-rpc-detail");
    const r = classifySignalError(e);
    // The classifier returns a variant; it never produces user-facing text.
    expect(r.kind).toBe("internal");
    if (r.kind === "internal") expect(r.cause).toBe(e);
  });
});

describe("makeSignalRenderActions (Result discipline, no silent, edit guard)", () => {
  it("sends the placeholder and resolves to the minted id (no silent effect, no buttons)", async () => {
    const fake = createFakeSignalAdapter();
    const actions = makeSignalRenderActions(fake, "chat-1");
    const r = await actions.send("placeholder");
    expect(r.ok && r.value).toBe("sig-msg-0");
    const send = fake.recorded.calls.find((c) => c.op === "send");
    // No `silent` field is recorded — Signal does not send the silent effect.
    expect(send).toEqual({ op: "send", id: "sig-msg-0", text: "placeholder" });
  });

  it("maps an unknown send error to err(internal) without throwing", async () => {
    const fake = createFakeSignalAdapter();
    const actions = makeSignalRenderActions(fake, "chat-1");
    fake.nextError = new Error("boom");
    const r = await actions.send("x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("internal");
  });

  it("edit always returns err(not_supported:edit) WITHOUT throwing (Signal has no editMessage)", async () => {
    const fake = createFakeSignalAdapter();
    const actions = makeSignalRenderActions(fake, "chat-1");
    const r = await actions.edit("sig-msg-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "edit" });
    // No edit op was recorded — the guard short-circuits before touching the port.
    expect(fake.recorded.calls.some((c) => c.op === "send")).toBe(false);
  });

  it("delete maps ok(undefined) on success", async () => {
    const fake = createFakeSignalAdapter();
    const actions = makeSignalRenderActions(fake, "chat-1");
    const r = await actions.delete("sig-msg-0");
    expect(r.ok).toBe(true);
    expect(fake.recorded.calls).toEqual([{ op: "delete", id: "sig-msg-0" }]);
  });

  it("maps an unknown delete error to err(internal)", async () => {
    const fake = createFakeSignalAdapter();
    const actions = makeSignalRenderActions(fake, "chat-1");
    fake.nextError = new Error("delete rpc failed");
    const r = await actions.delete("sig-msg-0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("internal");
  });

  it("guards an absent deleteMessage method — returns err(not_supported:delete) WITHOUT a non-null assertion", async () => {
    const fake = createFakeSignalAdapter();
    // Remove the optional capability to prove the early guard (not a non-null `!`).
    const noDelete = { ...fake, deleteMessage: undefined } as typeof fake;
    const actions = makeSignalRenderActions(noDelete, "chat-1");
    const r = await actions.delete("sig-msg-0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "delete" });
  });
});

describe("createSignalActivityRenderer (DeleteAndRepost wiring)", () => {
  it("returns a DeleteAndRepost renderer that can delete but not edit", () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeSignalAdapter();
    const r = createSignalActivityRenderer(fake, "chat-1", { timer, clock });
    expect(r.strategy).toBe("DeleteAndRepost");
    expect(r.canDelete).toBe(true);
    expect(r.canEdit).toBe(false);
  });

  it("deletes the previous message and posts a fresh one on each transition", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeSignalAdapter();
    const r = createSignalActivityRenderer(fake, "chat-1", { timer, clock });

    await r.apply(makeFrame(0, "step 1")); // send only — nothing to delete yet
    await r.apply(makeFrame(1, "step 2")); // delete sig-msg-0 + send sig-msg-1

    const ops = fake.recorded.calls.map((c) => c.op);
    expect(ops).toEqual(["send", "delete", "send"]);
  });

  it("deletes the final activity message only after deliveredAt on a non-trivial success", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeSignalAdapter();
    const r = createSignalActivityRenderer(fake, "chat-1", { timer, clock });

    await r.apply(makeFrame(0, "step 1"));
    const deliveredAtMs = clock.now() + 1000;
    await r.finalize({ kind: "success", trivial: false, delivery: receiptAt(deliveredAtMs) });
    await Promise.resolve();

    // Not yet — the delete is gated behind the deliveredAt timer.
    expect(fake.recorded.calls.some((c) => c.op === "delete")).toBe(false);

    timer.advance(1000);
    await Promise.resolve();
    await Promise.resolve();

    const deletes = fake.recorded.calls.filter((c): c is Extract<FakeSignalCall, { op: "delete" }> => c.op === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].id).toBe("sig-msg-0");
    expect(fake.recorded.calls[fake.recorded.calls.length - 1].op).toBe("delete");
  });

  it("on failure deletes the running activity then posts a KEPT ❌ message", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeSignalAdapter();
    const r = createSignalActivityRenderer(fake, "chat-1", { timer, clock });

    await r.apply(makeFrame(0, "step 1"));
    await r.finalize({
      kind: "failure",
      errorKind: "dependency",
      failedEvents: [makeEvent({ status: "failed", errorKind: "dependency" })],
    });
    await Promise.resolve();

    const last = fake.recorded.calls[fake.recorded.calls.length - 1];
    expect(last.op).toBe("send");
    if (last.op === "send") {
      expect(last.text).toContain("❌");
      expect(last.text).toContain("dependency");
      // The ❌ message is NEVER deleted (kept trail).
      const deletedIds = fake.recorded.calls.filter((c) => c.op === "delete").map((c) => c.id);
      expect(deletedIds).not.toContain(last.id);
    }
  });
});

// --- 11 golden fixtures (S1-S7, S9-S12; no S8) ------------------------------

/** Serialise the fake's ordered call-log — the exact shape the fixtures pin. */
function serialiseCallLog(fake: ReturnType<typeof createFakeSignalAdapter>): unknown {
  return JSON.parse(JSON.stringify({ calls: fake.recorded.calls }));
}

/**
 * Drive the Signal DeleteAndRepost renderer through a scenario's frames +
 * finalize (advancing the fake timers as a real coordinator would — the
 * deliveredAt-gated success delete fires behind the timer) and RETURN the
 * serialised call-log. Each `it(...)` asserts `toEqual(readFixture("signal", …))`
 * itself (never an auto-writing snapshot) so the on-disk fixture cannot self-heal.
 */
async function runScenario(
  frames: readonly ActivityRenderFrame[],
  outcome: TurnOutcome,
  deliveredAtMs: number,
): Promise<unknown> {
  const timer = createFakeTimers();
  const clock = createFakeClock(0);
  const fake = createFakeSignalAdapter();
  // Omit `clock` so the "(running N s)" elapsed fallback is skipped and
  // committed fixtures stay byte-stable. Strategy-level tests in
  // delete-and-repost.test.ts inject a clock and assert the elapsed text — that
  // is the live-production contract.
  const r = createSignalActivityRenderer(fake, "chat-1", { timer });

  for (const f of frames) {
    await r.apply(f);
    await Promise.resolve();
  }
  await r.finalize(outcome);
  await Promise.resolve();
  await Promise.resolve();
  // Advance past any deliveredAt-gated success delete.
  timer.advance(Math.max(0, deliveredAtMs - clock.now()) + 1000);
  await Promise.resolve();
  await Promise.resolve();

  return serialiseCallLog(fake);
}

function ev(id: number, over: Partial<ActivityEvent> = {}): ActivityEvent {
  return makeEvent({ activityId: `00000000-0000-0000-0000-00000000000${id}`, ...over });
}

const okReceipt = (deliveredAtMs: number): FinalDeliveryReceipt => receiptAt(deliveredAtMs);

describe("Signal golden fixtures (DeleteAndRepost — readFixture + toEqual)", () => {
  it("S1 trivial chat — zero renderer messages (kind:success trivial, no message ever posted)", async () => {
    const log = await runScenario([], { kind: "success", trivial: true, delivery: okReceipt(0) }, 0);
    expect(log).toEqual(readFixture("signal", "S1"));
  });

  it("S2 one fast tool — 1 posted message, then 1 delete after deliveredAt (success trivial)", async () => {
    const log = await runScenario(
      [makeFrame(0, "running tool")],
      { kind: "success", trivial: true, delivery: okReceipt(2000) },
      2000,
    );
    expect(log).toEqual(readFixture("signal", "S2"));
  });

  it("S3 multi-step success — delete-prev + post-new per transition, then a final delete after deliveredAt", async () => {
    const frames = [0, 1, 2].map((i) => makeFrame(i, `step ${i + 1}`));
    const log = await runScenario(frames, { kind: "success", trivial: false, delivery: okReceipt(5000) }, 5000);
    expect(log).toEqual(readFixture("signal", "S3"));
  });

  it("S4 outright failure — running activity deleted, then a KEPT ❌ {errorKind} send (no trailing delete)", async () => {
    const log = await runScenario(
      [makeFrame(0, "running tool"), makeFrame(1, "tool failed")],
      { kind: "failure", errorKind: "dependency", failedEvents: [ev(1, { status: "failed", errorKind: "dependency" })] },
      0,
    );
    expect(log).toEqual(readFixture("signal", "S4"));
  });

  // NOTE: the shipped createDeleteAndRepostRenderer treats
  // success_with_recovered_failures identically to success (delete the last
  // activity after deliveredAt). A "0 delete" keep-policy for the recovered
  // case would live in delete-and-repost.ts and is out of
  // scope for this wiring. The fixture pins the ACTUAL renderer output (the
  // delete is present) — mirroring the Telegram/Discord/Slack/WhatsApp S5 decision.
  it("S5 recovered failure — repost-per-transition then a final delete, kind:success_with_recovered_failures (renderer deletes)", async () => {
    const recovered = ev(1, { status: "failed", errorKind: "network" });
    const log = await runScenario(
      [makeFrame(0, "attempt 1"), makeFrame(1, "attempt 1 failed"), makeFrame(2, "attempt 2 ok")],
      { kind: "success_with_recovered_failures", trivial: false, delivery: okReceipt(0), recoveredFailures: [recovered] },
      0,
    );
    expect(log).toEqual(readFixture("signal", "S5"));
  });

  it("S6 plan-state — each transition reposts the visible-events line, deleted on success", async () => {
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
      { kind: "success", trivial: false, delivery: okReceipt(3000) },
      3000,
    );
    expect(log).toEqual(readFixture("signal", "S6"));
  });

  it("S7 subagent — the '↳ subagent' line is data on the event (renderer adds no prefix), deleted on success", async () => {
    const log = await runScenario(
      [
        makeFrame(0, "↳ subagent: 3 steps"),
        makeFrame(1, "↳ subagent done"),
      ],
      { kind: "success", trivial: false, delivery: okReceipt(4000) },
      4000,
    );
    expect(log).toEqual(readFixture("signal", "S7"));
  });

  it("S9 message_tool visibility — activity reposts the running line, deleted on success", async () => {
    const log = await runScenario(
      [makeFrame(0, "running tool")],
      { kind: "success", trivial: false, delivery: okReceipt(2000) },
      2000,
    );
    expect(log).toEqual(readFixture("signal", "S9"));
  });

  it("S10 verbose — every event reposts per transition, deleted on success", async () => {
    const frames = [0, 1, 2].map((i) => makeFrame(i, `verbose ${i + 1}`));
    const log = await runScenario(frames, { kind: "success", trivial: false, delivery: okReceipt(5000) }, 5000);
    expect(log).toEqual(readFixture("signal", "S10"));
  });

  it("S11 silent verbosity — zero activity messages from the renderer", async () => {
    const log = await runScenario([], { kind: "silent", reason: "SILENT" }, 0);
    expect(log).toEqual(readFixture("signal", "S11"));
  });

  it("S12 silent sentinel — the placeholder is deleted silently, kind:silent", async () => {
    const log = await runScenario(
      [makeFrame(0, "suppressed reply")],
      { kind: "silent", reason: "NO_REPLY" },
      0,
    );
    expect(log).toEqual(readFixture("signal", "S12"));
  });
});
