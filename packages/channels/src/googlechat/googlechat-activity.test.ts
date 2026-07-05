// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat EditPlace renderer tests.
 *
 * Three parts under test:
 *   1. classifyGoogleChatRenderError — maps a Chat REST failure onto the CLOSED
 *      ActivityRenderError union by its STRUCTURAL numeric status (read off the
 *      error AND off error.cause), never the send-path taxonomy.
 *   2. makeGoogleChatRenderActions — the ActivityRenderActions adapter. send
 *      paints signed approval buttons and records the message as a card frame;
 *      the bounded 429 retry buffer mirrors the shipped card-channel renderer.
 *   3. createGoogleChatActivityRenderer — wires the shared createEditPlaceRenderer.
 *
 * The correctness edge (retire TIMING): the shared EditPlace machine calls the
 * SAME 2-arg edit(id, text) for both the debounced streaming refresh
 * (renderFrameText) and the terminal finalize success closing render
 * (successLabel(markers)). The render-actions must recognize ONLY the terminal
 * render — by exact-matching successLabel(markers) — and retire the buttons there
 * via a button-less cardsV2 patch; every mid-wait refresh must patch text only so
 * Approve/Deny stay clickable, and a plain completion must stay text. The
 * end-to-end suite drives the REAL renderer (apply → fire-debounce → finalize) and
 * proves the buttons survive mid-wait and are retired only on resolve.
 *
 * Time discipline: every test drives the injected FakeTimers / FakeClock — no raw
 * setTimeout / Date.now. The fake adapter records every op (incl. the 4th-arg
 * cards patch on edit and the buttons on send) and exposes a structural-status
 * error seam so the classifier is driven off e.status.
 */
import { describe, it, expect } from "vitest";
import { ok, err, type Result } from "@comis/shared";
import { signCallbackData } from "@comis/core";
import type {
  ChannelPort,
  ChannelStatus,
  MessageHandler,
  SendMessageOptions,
  ActivityRenderFrame,
  ActivityEvent,
  ApprovalCorrelation,
  TurnOutcome,
  FinalDeliveryReceipt,
  RichButton,
  RichCard,
} from "@comis/core";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { successLabel } from "../shared/strategies/render.js";
import {
  classifyGoogleChatRenderError,
  makeGoogleChatRenderActions,
  createGoogleChatActivityRenderer,
} from "./googlechat-activity.js";

const DEBOUNCE_MS = 800;

// --- Fake ChannelPort (records ops incl. send buttons + edit cards patch) -----

/** One recorded adapter call — discriminated by `op`, deterministic ids. */
type FakeCall =
  | { op: "send"; id: string; text: string; buttons?: RichButton[][] }
  | { op: "edit"; id: string; text: string; cards?: RichCard[] }
  | { op: "delete"; id: string };

/**
 * A Chat-REST-shaped failure carrying the STRUCTURAL numeric `status` (and the
 * optional `retryAfter` seconds) the renderer classifier reads — never the
 * message string.
 */
interface RenderError extends Error {
  status?: number;
  retryAfter?: number;
}

interface FakeGoogleChatAdapter extends ChannelPort {
  readonly recorded: { calls: FakeCall[] };
  /** One-shot: the NEXT recording op returns `err(nextError)`, then clears. */
  nextError: RenderError | undefined;
  /** Persistent: EVERY `editMessage` returns `err(alwaysEditError)` until cleared. */
  alwaysEditError: RenderError | undefined;
  /** Count of `editMessage` invocations (incl. failed) — proves the retry bound. */
  editAttempts(): number;
}

function mkError(fields: { status?: number; retryAfter?: number; message?: string }): RenderError {
  const e = new Error(fields.message ?? "chat rest failed") as RenderError;
  if (fields.status !== undefined) e.status = fields.status;
  if (fields.retryAfter !== undefined) e.retryAfter = fields.retryAfter;
  return e;
}

function createFakeGoogleChatAdapter(channelId = "spaces/AAAA"): FakeGoogleChatAdapter {
  const recorded: { calls: FakeCall[] } = { calls: [] };
  let counter = 0;
  let edits = 0;

  const adapter: FakeGoogleChatAdapter = {
    channelId,
    channelType: "googlechat",
    recorded,
    nextError: undefined,
    alwaysEditError: undefined,
    editAttempts: () => edits,

    async start(): Promise<Result<void, Error>> {
      return ok(undefined);
    },
    async stop(): Promise<Result<void, Error>> {
      return ok(undefined);
    },

    async sendMessage(
      _channelId: string,
      text: string,
      options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      if (adapter.nextError) {
        const e = adapter.nextError;
        adapter.nextError = undefined;
        return err(e);
      }
      const id = `googlechat-msg-${counter++}`;
      recorded.calls.push({ op: "send", id, text, buttons: options?.buttons });
      return ok(id);
    },

    async editMessage(
      _channelId: string,
      messageId: string,
      text: string,
      options?: SendMessageOptions,
    ): Promise<Result<void, Error>> {
      edits += 1;
      if (adapter.alwaysEditError) return err(adapter.alwaysEditError);
      if (adapter.nextError) {
        const e = adapter.nextError;
        adapter.nextError = undefined;
        return err(e);
      }
      recorded.calls.push({ op: "edit", id: messageId, text, cards: options?.cards });
      return ok(undefined);
    },

    async deleteMessage(_channelId: string, messageId: string): Promise<Result<void, Error>> {
      if (adapter.nextError) {
        const e = adapter.nextError;
        adapter.nextError = undefined;
        return err(e);
      }
      recorded.calls.push({ op: "delete", id: messageId });
      return ok(undefined);
    },

    onMessage(_handler: MessageHandler): void {
      // no-op: this fake never receives inbound messages.
    },

    async platformAction(
      action: string,
      params: Record<string, unknown>,
    ): Promise<Result<unknown, Error>> {
      return ok({ action, params });
    },

    getStatus(): ChannelStatus {
      return { connected: true, channelId, channelType: "googlechat" };
    },
  };

  return adapter;
}

// --- Deterministic frame builders --------------------------------------------

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    schemaVersion: 1,
    activityId: "00000000-0000-0000-0000-000000000000",
    sessionKey: "sess-a",
    agentId: "main",
    traceId: "trace-a",
    ts: "2026-07-05T00:00:00.000Z",
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

function approval(overrides: Partial<ApprovalCorrelation> = {}): ApprovalCorrelation {
  return {
    shortId: "GcH789Abc012",
    expiresAt: 300000,
    choices: [
      { id: "approve", defaultLabel: "Approve", style: "primary" },
      { id: "deny", defaultLabel: "Deny", style: "danger" },
    ],
    ...overrides,
  };
}

function approvalFrame(corr: ApprovalCorrelation = approval()): ActivityRenderFrame {
  const event: ActivityEvent = {
    schemaVersion: 1,
    activityId: "00000000-0000-0000-0000-000000000000",
    sessionKey: "sess-a",
    agentId: "main",
    traceId: "trace-a",
    ts: "2026-07-05T00:00:00.000Z",
    phase: "progress",
    status: "running",
    kind: "approval",
    semanticPhase: "tool",
    defaultLabel: "approval required: bash",
    approval: corr,
  } as ActivityEvent;
  return {
    frameSeq: 0,
    visibleEvents: [event],
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added: [], edited: [], removed: [] },
  };
}

function receiptAt(deliveredAtMs: number): FinalDeliveryReceipt {
  return { ok: true, deliveredChunks: 1, lastChunkMessageId: "msg-final", deliveredAtMs };
}

const SECRET = "test-callback-signing-secret-0123456789";
const sign = (choice: "approve" | "deny" | "details", shortId: string): string =>
  signCallbackData(SECRET, choice, shortId);

const btnRow: RichButton[][] = [[{ text: "Approve", callback_data: "v1.approve.x.y" }]];

// --- classifyGoogleChatRenderError (structural status → renderer union) -------

describe("classifyGoogleChatRenderError (structural status onto the closed ActivityRenderError union)", () => {
  it("maps a 429 with retryAfter to rate_limited with retryAfter*1000", () => {
    expect(classifyGoogleChatRenderError(mkError({ status: 429, retryAfter: 2 }))).toEqual({
      kind: "rate_limited",
      retryAfterMs: 2000,
    });
  });

  it("defaults a 429 with no retryAfter to a 1s floor", () => {
    expect(classifyGoogleChatRenderError(mkError({ status: 429 }))).toEqual({
      kind: "rate_limited",
      retryAfterMs: 1000,
    });
  });

  it("maps a 401 to permission (status only — no token/body copied into detail)", () => {
    const r = classifyGoogleChatRenderError(mkError({ status: 401 }));
    expect(r.kind).toBe("permission");
    if (r.kind === "permission") {
      expect(r.detail).toContain("401");
      expect(r.detail).not.toContain("Bearer");
    }
  });

  it("maps a 403 to permission", () => {
    expect(classifyGoogleChatRenderError(mkError({ status: 403 })).kind).toBe("permission");
  });

  it("maps a 404 to not_supported:edit (drop further edits)", () => {
    expect(classifyGoogleChatRenderError(mkError({ status: 404 }))).toEqual({
      kind: "not_supported",
      capability: "edit",
    });
  });

  it("maps a 500 to internal (not a rate-limit; carries the cause)", () => {
    const e = mkError({ status: 500 });
    expect(classifyGoogleChatRenderError(e)).toEqual({ kind: "internal", cause: e });
  });

  it("maps a status-less bare Error (transport fault) to internal carrying the cause", () => {
    const e = new Error("boom");
    expect(classifyGoogleChatRenderError(e)).toEqual({ kind: "internal", cause: e });
  });

  it("reads the status off error.cause when the adapter wrapped it there", () => {
    const cause = mkError({ status: 429, retryAfter: 3 });
    const wrapped = new Error("chat edit failed", { cause });
    expect(classifyGoogleChatRenderError(wrapped)).toEqual({ kind: "rate_limited", retryAfterMs: 3000 });
  });
});

// --- makeGoogleChatRenderActions (send/edit/delete, card-frame tracking) ------

describe("makeGoogleChatRenderActions (Result discipline, card-frame tracking, guards)", () => {
  it("send WITH buttons posts a card, records the id, and forwards { buttons }", async () => {
    const fake = createFakeGoogleChatAdapter();
    const actions = makeGoogleChatRenderActions(fake, "spaces/AAAA");
    const r = await actions.send("placeholder", { buttons: btnRow });
    expect(r.ok && r.value).toBe("googlechat-msg-0");
    const send = fake.recorded.calls.find((c): c is Extract<FakeCall, { op: "send" }> => c.op === "send");
    expect(send?.buttons).toEqual(btnRow);
  });

  it("send WITHOUT buttons is a plain send (undefined options) and records NO card frame", async () => {
    const fake = createFakeGoogleChatAdapter();
    const actions = makeGoogleChatRenderActions(fake, "spaces/AAAA");
    const sent = await actions.send("plain");
    expect(sent.ok).toBe(true);
    const send = fake.recorded.calls.find((c): c is Extract<FakeCall, { op: "send" }> => c.op === "send");
    expect(send?.buttons).toBeUndefined();

    // A subsequent finalize-shaped edit (successLabel) on this NON-card frame stays
    // text-only — a plain completion is never turned into a card.
    if (sent.ok) {
      await actions.edit(sent.value, successLabel());
      const edit = fake.recorded.calls.find((c): c is Extract<FakeCall, { op: "edit" }> => c.op === "edit");
      expect(edit?.cards).toBeUndefined();
    }
  });

  it("maps a failing sendMessage through the classifier without throwing", async () => {
    const fake = createFakeGoogleChatAdapter();
    const actions = makeGoogleChatRenderActions(fake, "spaces/AAAA");
    fake.nextError = mkError({ status: 403 });
    const r = await actions.send("placeholder");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("permission");
  });

  it("RETIRE TIMING: a mid-wait streaming edit of a card frame patches TEXT ONLY (buttons kept)", async () => {
    const fake = createFakeGoogleChatAdapter();
    const actions = makeGoogleChatRenderActions(fake, "spaces/AAAA");
    const sent = await actions.send("card", { buttons: btnRow });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    // An intermediate render (anything other than the terminal successLabel).
    const r = await actions.edit(sent.value, "🔧 still working");
    expect(r.ok).toBe(true);
    const edit = fake.recorded.calls.find((c): c is Extract<FakeCall, { op: "edit" }> => c.op === "edit");
    expect(edit?.text).toBe("🔧 still working");
    // No cardsV2 patch → the card + buttons are left intact by the text-only mask.
    expect(edit?.cards).toBeUndefined();
  });

  it("RETIRE TIMING: the terminal successLabel edit of a card frame patches a button-less card", async () => {
    const fake = createFakeGoogleChatAdapter();
    const actions = makeGoogleChatRenderActions(fake, "spaces/AAAA");
    const sent = await actions.send("card", { buttons: btnRow });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    const r = await actions.edit(sent.value, successLabel());
    expect(r.ok).toBe(true);
    const edit = fake.recorded.calls.find((c): c is Extract<FakeCall, { op: "edit" }> => c.op === "edit");
    // A cardsV2 patch is fired, and the resolved card carries NO buttons → the
    // interactive widgets are retired in place.
    expect(edit?.cards).toBeDefined();
    expect(edit?.cards?.length).toBeGreaterThan(0);
    expect(edit?.cards?.[0]?.buttons).toBeUndefined();
  });

  it("RETIRE TIMING: a successLabel edit of a NON-card frame stays text-only (no cards)", async () => {
    const fake = createFakeGoogleChatAdapter();
    const actions = makeGoogleChatRenderActions(fake, "spaces/AAAA");
    // Never sent with buttons → not a card frame, even for the terminal label.
    const r = await actions.edit("spaces/AAAA/messages/plain", successLabel());
    expect(r.ok).toBe(true);
    const edit = fake.recorded.calls.find((c): c is Extract<FakeCall, { op: "edit" }> => c.op === "edit");
    expect(edit?.cards).toBeUndefined();
  });

  it("guards an absent editMessage method — returns err(not_supported:edit) WITHOUT throwing", async () => {
    const fake = createFakeGoogleChatAdapter();
    const noEdit = { ...fake, editMessage: undefined } as unknown as FakeGoogleChatAdapter;
    const actions = makeGoogleChatRenderActions(noEdit, "spaces/AAAA");
    const r = await actions.edit("googlechat-msg-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "edit" });
  });

  it("retries a 429 edit once via the timer then resolves by editing the latest text", async () => {
    const timer = createFakeTimers();
    const fake = createFakeGoogleChatAdapter();
    const actions = makeGoogleChatRenderActions(fake, "spaces/AAAA", { timer });

    fake.nextError = mkError({ status: 429, retryAfter: 1 });
    const r = await actions.edit("googlechat-msg-0", "updated");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "rate_limited", retryAfterMs: 1000 });
    expect(fake.recorded.calls.filter((c) => c.op === "edit")).toHaveLength(0);

    timer.advance(1000);
    await Promise.resolve();
    await Promise.resolve();

    const edits = fake.recorded.calls.filter((c): c is Extract<FakeCall, { op: "edit" }> => c.op === "edit");
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toBe("updated");
  });

  it("bounds a sustained 429 storm (never unbounded) and stays terminal rate_limited", async () => {
    const timer = createFakeTimers();
    const fake = createFakeGoogleChatAdapter();
    const actions = makeGoogleChatRenderActions(fake, "spaces/AAAA", { timer });

    fake.alwaysEditError = mkError({ status: 429, retryAfter: 1 });
    const r = await actions.edit("googlechat-msg-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("rate_limited");

    for (let i = 0; i < 20; i++) {
      timer.advance(1000);
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(fake.editAttempts()).toBeGreaterThan(1);
    expect(fake.editAttempts()).toBeLessThanOrEqual(5);
    expect(fake.recorded.calls.some((c) => c.op === "edit")).toBe(false);
  });

  it("stops all further edits after a 404 (message gone) not_supported classification", async () => {
    const timer = createFakeTimers();
    const fake = createFakeGoogleChatAdapter();
    const actions = makeGoogleChatRenderActions(fake, "spaces/AAAA", { timer });

    fake.nextError = mkError({ status: 404 });
    const first = await actions.edit("googlechat-msg-0", "gone");
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error).toEqual({ kind: "not_supported", capability: "edit" });

    // A subsequent edit is short-circuited without touching the adapter again.
    const attemptsAfterFirst = fake.editAttempts();
    const second = await actions.edit("googlechat-msg-0", "again");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.kind).toBe("not_supported");
    expect(fake.editAttempts()).toBe(attemptsAfterFirst);
  });

  it("delete → deleteMessage; a missing method returns err(not_supported:delete)", async () => {
    const fake = createFakeGoogleChatAdapter();
    const actions = makeGoogleChatRenderActions(fake, "spaces/AAAA");
    const okDel = await actions.delete("googlechat-msg-0");
    expect(okDel.ok).toBe(true);
    expect(fake.recorded.calls.some((c) => c.op === "delete")).toBe(true);

    const noDelete = { ...fake, deleteMessage: undefined } as unknown as FakeGoogleChatAdapter;
    const actions2 = makeGoogleChatRenderActions(noDelete, "spaces/AAAA");
    const r = await actions2.delete("googlechat-msg-0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "delete" });
  });
});

// --- createGoogleChatActivityRenderer (EditPlace wiring; retire timing E2E) ----

describe("createGoogleChatActivityRenderer (EditPlace wiring + signer consumption)", () => {
  it("returns the EditPlace ChannelActivityRenderer surface", () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeGoogleChatAdapter();
    const r = createGoogleChatActivityRenderer(fake, "spaces/AAAA", { timer, clock });
    expect(r.strategy).toBe("EditPlace");
    expect(r.canEdit).toBe(true);
    expect(r.canDelete).toBe(true);
    expect(typeof r.apply).toBe("function");
    expect(typeof r.finalize).toBe("function");
  });

  it("paints a kind:'approval' frame as signed RichButton rows via the injected signer", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeGoogleChatAdapter();
    const r = createGoogleChatActivityRenderer(fake, "spaces/AAAA", { timer, clock, signCallbackData: sign });

    await r.apply(approvalFrame());

    const send = fake.recorded.calls.find((c): c is Extract<FakeCall, { op: "send" }> => c.op === "send");
    expect(send?.buttons).toBeDefined();
    const flat = (send?.buttons ?? []).flat();
    expect(flat).toHaveLength(2);
    expect(flat[0]).toEqual({
      text: "Approve",
      callback_data: `v1.approve.GcH789Abc012.${sign("approve", "GcH789Abc012")}`,
      style: "primary",
    });
  });

  it("a non-approval frame carries NO buttons (button-less send stays byte-stable)", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeGoogleChatAdapter();
    const r = createGoogleChatActivityRenderer(fake, "spaces/AAAA", { timer, clock, signCallbackData: sign });

    await r.apply(makeFrame(0, "running tool"));

    const send = fake.recorded.calls.find((c): c is Extract<FakeCall, { op: "send" }> => c.op === "send");
    expect(send?.buttons).toBeUndefined();
  });

  it("END-TO-END retire timing: buttons SURVIVE a mid-wait streaming edit, RETIRE on the resolve", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeGoogleChatAdapter();
    const r = createGoogleChatActivityRenderer(fake, "spaces/AAAA", { timer, clock, signCallbackData: sign });

    // 1) Approval frame → the placeholder posts a card WITH buttons.
    await r.apply(approvalFrame());
    const send = fake.recorded.calls.find((c): c is Extract<FakeCall, { op: "send" }> => c.op === "send");
    expect(send?.buttons).toBeDefined();

    // 2) A refresh mid-wait schedules the debounce; firing it flushes ONE
    //    streaming edit. It must be TEXT ONLY — the buttons stay clickable.
    clock.advance(500);
    await r.apply(makeFrame(1, "still working"));
    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();

    const midEdits = fake.recorded.calls.filter((c): c is Extract<FakeCall, { op: "edit" }> => c.op === "edit");
    expect(midEdits).toHaveLength(1);
    expect(midEdits[0].cards).toBeUndefined();

    // 3) Resolve (finalize success). deliveredAtMs in the future defers the delete
    //    so it does not race this assertion. The closing edit is a button-less
    //    cardsV2 patch — the buttons are retired in place.
    const deliveredAtMs = clock.now() + 10_000;
    await r.finalize({ kind: "success", trivial: false, delivery: receiptAt(deliveredAtMs) });
    await Promise.resolve();
    await Promise.resolve();

    const edits = fake.recorded.calls.filter((c): c is Extract<FakeCall, { op: "edit" }> => c.op === "edit");
    const resolveEdit = edits[edits.length - 1];
    expect(resolveEdit.text).toBe(successLabel());
    expect(resolveEdit.cards).toBeDefined();
    expect(resolveEdit.cards?.[0]?.buttons).toBeUndefined();
    // No delete raced the resolve (deliveredAt is in the future).
    expect(fake.recorded.calls.some((c) => c.op === "delete")).toBe(false);
  });

  it("END-TO-END: a non-approval completion stays TEXT-ONLY through its own finalize", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeGoogleChatAdapter();
    const r = createGoogleChatActivityRenderer(fake, "spaces/AAAA", { timer, clock, signCallbackData: sign });

    await r.apply(makeFrame(0, "tool"));
    const deliveredAtMs = clock.now() + 10_000;
    await r.finalize({ kind: "success", trivial: false, delivery: receiptAt(deliveredAtMs) });
    await Promise.resolve();
    await Promise.resolve();

    const edits = fake.recorded.calls.filter((c): c is Extract<FakeCall, { op: "edit" }> => c.op === "edit");
    // The finalize success edit exists and is text-only — no card is ever attached.
    expect(edits.length).toBeGreaterThan(0);
    for (const e of edits) expect(e.cards).toBeUndefined();
  });
});
