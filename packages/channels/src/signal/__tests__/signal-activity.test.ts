// SPDX-License-Identifier: Apache-2.0
/**
 * Signal DeleteAndRepost renderer tests (CHAN-06, CHAN-11; §18.3 Signal column).
 *
 * Signal is the ONLY one of the 5 non-EditPlace channels with a real
 * `deleteMessage` — it is the canonical DeleteAndRepost wiring. The single
 * net-new piece of logic here is `classifySignalError` — Signal exposes NO
 * structured numeric code for send/delete failures (the live adapter returns
 * `err(result.error)`, a raw signal-cli RPC Error), so the classifier defaults
 * to `internal` and reads the error structurally ONLY (never renders the
 * `.message` as activity text — SEC-05/§19.3). `makeSignalRenderActions` maps
 * each ChannelPort call through it and guards the absent `editMessage`;
 * `createSignalActivityRenderer` wires the Phase-70 `createDeleteAndRepostRenderer`
 * (no duplicated state machine).
 *
 * Time discipline: every fixture test drives the injected FakeTimers/FakeClock —
 * no raw setTimeout/Date.now (globals.test.ts fails the build otherwise). Golden
 * fixtures assert via readFixture + toEqual (NEVER toMatchSnapshot — auto-write
 * self-heals, Pitfall 3).
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

// --- Task 1: classifySignalError + makeSignalRenderActions -----------------

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
