// SPDX-License-Identifier: Apache-2.0
/**
 * LINE AppendOnly renderer tests (CHAN-08, CHAN-11; §18.3 LINE column).
 *
 * LINE is send-only for the activity renderer — it has no in-place edit and no
 * delete, so it wires the Phase-70 AppendOnly strategy IDENTICALLY to iMessage:
 * ONE opening status (the first non-trivial frame), later frames are no-ops, the
 * closing follow-up is SUPPRESSED on success (the assistant reply is the signal),
 * and a failure posts exactly one `❌ {errorKind}` follow-up.
 *
 * CHAN-08 scope: only the AppendOnly RENDERING half is covered here. The LINE
 * Quick Reply approval-chip affordance rides with Phase 73 (the port is
 * `send(text)`-only; no button param, no `kind:"approval"` event yet, ZERO S8
 * fixtures). The single net-new piece of logic is `classifyLineError` — the live
 * adapter wraps send failures in `new Error("Failed to send LINE message: …")`
 * with no structured numeric code, so the classifier defaults to `internal` and
 * reads the error structurally ONLY (never renders the `.message` as activity
 * text — SEC-05/§19.3). `makeLineRenderActions` maps `send` through it and guards
 * the absent `editMessage` / `deleteMessage`; `createLineActivityRenderer` wires
 * the Phase-70 `createAppendOnlyRenderer` (no duplicated state machine, NO timer/clock).
 *
 * Golden fixtures assert via readFixture + toEqual (NEVER an auto-writing
 * inline/file snapshot, which self-heals a wrong fixture — Pitfall 3).
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

// --- Task 1: classifyLineError + makeLineRenderActions ---------------------

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
    expect(sends[0]).toEqual({ op: "send", id: "line-msg-0", text: "step 1" });
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

// --- Task 2: 11 golden fixtures (S1-S7, S9-S12; no S8) ---------------------

void readFixture;
