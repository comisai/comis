// SPDX-License-Identifier: Apache-2.0
/**
 * iMessage AppendOnly renderer tests (CHAN-07, CHAN-11; §18.3 iMessage column).
 *
 * iMessage is send-only — it has no in-place edit and no delete, so it wires the
 * Phase-70 AppendOnly strategy: ONE opening status (the first non-trivial frame),
 * later frames are no-ops, the closing follow-up is SUPPRESSED on success (the
 * assistant reply is the signal), and a failure posts exactly one
 * `❌ {errorKind}` follow-up. The single net-new piece of logic here is
 * `classifyIMessageError` — the live adapter wraps send failures in
 * `new Error("Failed to send iMessage: …")` with no structured numeric code, so
 * the classifier defaults to `internal` and reads the error structurally ONLY
 * (never renders the `.message` as activity text — SEC-05/§19.3).
 * `makeIMessageRenderActions` maps `send` through it and guards the absent
 * `editMessage` / `deleteMessage`; `createIMessageActivityRenderer` wires the
 * Phase-70 `createAppendOnlyRenderer` (no duplicated state machine, NO timer/clock).
 *
 * Golden fixtures assert via readFixture + toEqual (NEVER an auto-writing
 * inline/file snapshot, which self-heals a wrong fixture — Pitfall 3).
 */
import { describe, it, expect } from "vitest";
import type { ActivityRenderFrame, ActivityEvent, TurnOutcome, FinalDeliveryReceipt } from "@comis/core";
import {
  classifyIMessageError,
  makeIMessageRenderActions,
  createIMessageActivityRenderer,
} from "../imessage-activity.js";
import { createFakeIMessageAdapter } from "../../__tests__/fakes/imessage-fake.js";
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

// --- Task 1: classifyIMessageError + makeIMessageRenderActions -------------

describe("classifyIMessageError (structural only, never the message string)", () => {
  it("maps an unknown bare Error to internal carrying the cause (iMessage has no numeric code)", () => {
    const e = new Error("Failed to send iMessage: bridge offline");
    expect(classifyIMessageError(e)).toEqual({ kind: "internal", cause: e });
  });

  it("maps an undefined error to internal (defensive default)", () => {
    const r = classifyIMessageError(undefined);
    expect(r.kind).toBe("internal");
  });

  it("maps an arbitrary error object to internal — it does not invent a rich classifier", () => {
    const e = { message: "imsg request failed", code: "EPIPE" };
    const r = classifyIMessageError(e);
    expect(r.kind).toBe("internal");
  });

  it("does NOT render the wrapped 'Failed to send …' message as activity text — only selects the variant", () => {
    const e = new Error("Failed to send iMessage: secret-bearing-bridge-detail");
    const r = classifyIMessageError(e);
    expect(r.kind).toBe("internal");
    if (r.kind === "internal") expect(r.cause).toBe(e);
  });
});

describe("makeIMessageRenderActions (Result discipline, no silent, edit+delete guards)", () => {
  it("sends the opening status and resolves to the minted id (no silent effect, no buttons)", async () => {
    const fake = createFakeIMessageAdapter();
    const actions = makeIMessageRenderActions(fake, "chat-1");
    const r = await actions.send("opening status");
    expect(r.ok && r.value).toBe("imsg-msg-0");
    const send = fake.recorded.calls.find((c) => c.op === "send");
    // No `silent` field is recorded — iMessage does not send the silent effect.
    expect(send).toEqual({ op: "send", id: "imsg-msg-0", text: "opening status" });
  });

  it("maps an unknown send error to err(internal) without throwing", async () => {
    const fake = createFakeIMessageAdapter();
    const actions = makeIMessageRenderActions(fake, "chat-1");
    fake.nextError = new Error("Failed to send iMessage: boom");
    const r = await actions.send("x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("internal");
  });

  it("edit always returns err(not_supported:edit) WITHOUT throwing (iMessage has no editMessage)", async () => {
    const fake = createFakeIMessageAdapter();
    const actions = makeIMessageRenderActions(fake, "chat-1");
    const r = await actions.edit("imsg-msg-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "edit" });
    // The guard short-circuits before touching the port — no call recorded.
    expect(fake.recorded.calls.length).toBe(0);
  });

  it("delete always returns err(not_supported:delete) WITHOUT throwing (iMessage has no deleteMessage)", async () => {
    const fake = createFakeIMessageAdapter();
    const actions = makeIMessageRenderActions(fake, "chat-1");
    const r = await actions.delete("imsg-msg-0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "delete" });
    expect(fake.recorded.calls.length).toBe(0);
  });
});

describe("createIMessageActivityRenderer (AppendOnly wiring)", () => {
  it("returns an AppendOnly renderer that can neither edit nor delete", () => {
    const fake = createFakeIMessageAdapter();
    const r = createIMessageActivityRenderer(fake, "chat-1");
    expect(r.strategy).toBe("AppendOnly");
    expect(r.canEdit).toBe(false);
    expect(r.canDelete).toBe(false);
  });

  it("posts the opening status ONCE; later frames are no-ops (cannot edit, do not spam)", async () => {
    const fake = createFakeIMessageAdapter();
    const r = createIMessageActivityRenderer(fake, "chat-1");

    await r.apply(makeFrame(0, "step 1"));
    await r.apply(makeFrame(1, "step 2"));
    await r.apply(makeFrame(2, "step 3"));

    const sends = fake.recorded.calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toEqual({ op: "send", id: "imsg-msg-0", text: "step 1" });
  });

  it("SUPPRESSES the closing follow-up on success (the assistant reply is the signal)", async () => {
    const fake = createFakeIMessageAdapter();
    const r = createIMessageActivityRenderer(fake, "chat-1");

    await r.apply(makeFrame(0, "step 1"));
    await r.finalize({ kind: "success", trivial: false, delivery: okReceipt(1000) });

    // Exactly the opening send — no closing on success.
    const sends = fake.recorded.calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(1);
  });

  it("posts exactly one ❌ {errorKind} follow-up on failure", async () => {
    const fake = createFakeIMessageAdapter();
    const r = createIMessageActivityRenderer(fake, "chat-1");

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
