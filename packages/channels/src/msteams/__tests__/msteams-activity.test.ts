// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams EditPlace renderer tests.
 *
 * The net-new logic is `classifyMSTeamsError` — it maps a Connector failure
 * onto the CLOSED `ActivityRenderError` union (rate_limited / permission /
 * not_supported / internal), NOT the send-path `ClassifiedMsTeamsError` shape.
 * It reads the STRUCTURAL numeric `status` (and optional `retryAfter` seconds)
 * off the error AND off `error.cause` — never by parsing the message string
 * (mirroring the Slack renderer's structural discipline).
 *
 * `makeMSTeamsRenderActions` maps each ChannelPort call through it, guards the
 * optional `editMessage` / `deleteMessage` methods (early not_supported, no
 * non-null cluster), and drives a bounded latest-text 429-retry buffer through
 * the injected FakeTimers. `createMSTeamsActivityRenderer` wraps the shared
 * `createEditPlaceRenderer` — no duplicated state machine — and is plain-text in
 * this phase (`buildButtons: undefined`; no signer / native buttons).
 *
 * Time discipline: every test drives the injected FakeTimers / FakeClock — no
 * raw setTimeout / Date.now. The fake adapter records every op and exposes a
 * structural-status error seam so the classifier is driven off `e.status`.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { ok, err, type Result } from "@comis/shared";
import type {
  ChannelPort,
  ChannelStatus,
  MessageHandler,
  ActivityRenderFrame,
  ActivityEvent,
  TurnOutcome,
  FinalDeliveryReceipt,
} from "@comis/core";
// 5 levels up from msteams/__tests__/ — same depth as slack/__tests__/X.test.ts.
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import {
  classifyMSTeamsError,
  makeMSTeamsRenderActions,
  createMSTeamsActivityRenderer,
} from "../msteams-activity.js";

const DEBOUNCE_MS = 800;

// --- Fake ChannelPort (records ops; structural-status error seams) -----------

/** One recorded adapter call — discriminated by `op`, deterministic ids. */
type FakeCall =
  | { op: "send"; id: string; text: string }
  | { op: "edit"; id: string; text: string }
  | { op: "delete"; id: string };

/**
 * A Connector-shaped failure carrying the STRUCTURAL numeric `status` (and the
 * optional `retryAfter` seconds) the renderer classifier reads. This is the
 * error shape the adapter's edit/delete failure branch attaches so the renderer
 * can classify + back off — never the message string.
 */
interface RenderError extends Error {
  status?: number;
  retryAfter?: number;
}

interface FakeMsTeamsAdapter extends ChannelPort {
  /** Ordered call-log — deterministic `msteams-msg-N` ids, no timestamps. */
  readonly recorded: { calls: FakeCall[] };
  /** One-shot: the NEXT recording op returns `err(nextError)`, then clears. */
  nextError: RenderError | undefined;
  /** Persistent: EVERY `editMessage` returns `err(alwaysEditError)` until cleared. */
  alwaysEditError: RenderError | undefined;
  /** Count of `editMessage` invocations (incl. failed) — proves the retry bound. */
  editAttempts(): number;
}

function mkError(fields: { status?: number; retryAfter?: number; message?: string }): RenderError {
  const e = new Error(fields.message ?? "connector activity failed") as RenderError;
  if (fields.status !== undefined) e.status = fields.status;
  if (fields.retryAfter !== undefined) e.retryAfter = fields.retryAfter;
  return e;
}

function createFakeMsTeamsAdapter(channelId = "conv-1"): FakeMsTeamsAdapter {
  const recorded: { calls: FakeCall[] } = { calls: [] };
  let counter = 0;
  let edits = 0;

  const adapter: FakeMsTeamsAdapter = {
    channelId,
    channelType: "msteams",
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

    async sendMessage(_channelId: string, text: string): Promise<Result<string, Error>> {
      if (adapter.nextError) {
        const e = adapter.nextError;
        adapter.nextError = undefined;
        return err(e);
      }
      const id = `msteams-msg-${counter++}`;
      recorded.calls.push({ op: "send", id, text });
      return ok(id);
    },

    async editMessage(
      _channelId: string,
      messageId: string,
      text: string,
    ): Promise<Result<void, Error>> {
      edits += 1;
      if (adapter.alwaysEditError) return err(adapter.alwaysEditError);
      if (adapter.nextError) {
        const e = adapter.nextError;
        adapter.nextError = undefined;
        return err(e);
      }
      recorded.calls.push({ op: "edit", id: messageId, text });
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
      return { connected: true, channelId, channelType: "msteams" };
    },
  };

  return adapter;
}

// --- Deterministic frame builders (no randomUUID, no timestamps) -------------

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

// --- classifyMSTeamsError (structural status → renderer union) ---------------

describe("classifyMSTeamsError (structural status onto the closed ActivityRenderError union)", () => {
  it("maps a 429 with retryAfter to rate_limited with retryAfter*1000", () => {
    expect(classifyMSTeamsError(mkError({ status: 429, retryAfter: 2 }))).toEqual({
      kind: "rate_limited",
      retryAfterMs: 2000,
    });
  });

  it("defaults a 429 with no retryAfter to a 1s floor", () => {
    expect(classifyMSTeamsError(mkError({ status: 429 }))).toEqual({
      kind: "rate_limited",
      retryAfterMs: 1000,
    });
  });

  it("maps a 401 to permission (no token/body copied into detail)", () => {
    const r = classifyMSTeamsError(mkError({ status: 401 }));
    expect(r.kind).toBe("permission");
    if (r.kind === "permission") {
      expect(r.detail).toContain("401");
      expect(r.detail).not.toContain("Bearer");
    }
  });

  it("maps a 403 to permission", () => {
    expect(classifyMSTeamsError(mkError({ status: 403 })).kind).toBe("permission");
  });

  it("maps a 404 to not_supported:edit (drop further edits)", () => {
    expect(classifyMSTeamsError(mkError({ status: 404 }))).toEqual({
      kind: "not_supported",
      capability: "edit",
    });
  });

  it("maps a 500 to internal (not a rate-limit; carries the cause)", () => {
    const e = mkError({ status: 500 });
    expect(classifyMSTeamsError(e)).toEqual({ kind: "internal", cause: e });
  });

  it("maps a status-less bare Error (transport fault) to internal carrying the cause", () => {
    const e = new Error("boom");
    expect(classifyMSTeamsError(e)).toEqual({ kind: "internal", cause: e });
  });

  it("reads the status off error.cause when the adapter wrapped it there", () => {
    const cause = mkError({ status: 429, retryAfter: 3 });
    const wrapped = new Error("connector edit failed", { cause });
    expect(classifyMSTeamsError(wrapped)).toEqual({ kind: "rate_limited", retryAfterMs: 3000 });
  });
});

// --- makeMSTeamsRenderActions (Result discipline, guards, bounded 429 retry) --

describe("makeMSTeamsRenderActions (Result discipline, optional-method guards, bounded retry)", () => {
  it("sends the placeholder and records the created message id", async () => {
    const fake = createFakeMsTeamsAdapter();
    const actions = makeMSTeamsRenderActions(fake, "conv-1");
    const r = await actions.send("placeholder");
    expect(r.ok && r.value).toBe("msteams-msg-0");
    expect(fake.recorded.calls).toEqual([{ op: "send", id: "msteams-msg-0", text: "placeholder" }]);
  });

  it("maps a failing sendMessage through the classifier without throwing", async () => {
    const fake = createFakeMsTeamsAdapter();
    const actions = makeMSTeamsRenderActions(fake, "conv-1");
    fake.nextError = mkError({ status: 403 });
    const r = await actions.send("placeholder");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("permission");
  });

  it("retries a 429 edit once via the timer then resolves by editing the latest text", async () => {
    const timer = createFakeTimers();
    const fake = createFakeMsTeamsAdapter();
    const actions = makeMSTeamsRenderActions(fake, "conv-1", { timer });

    // One-shot 429 on the first edit attempt; the scheduled retry then succeeds.
    fake.nextError = mkError({ status: 429, retryAfter: 1 });
    const r = await actions.edit("msteams-msg-0", "updated");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "rate_limited", retryAfterMs: 1000 });
    // First attempt failed → nothing recorded yet.
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
    const fake = createFakeMsTeamsAdapter();
    const actions = makeMSTeamsRenderActions(fake, "conv-1", { timer });

    fake.alwaysEditError = mkError({ status: 429, retryAfter: 1 });
    const r = await actions.edit("msteams-msg-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("rate_limited");

    // Advance well past any plausible retry budget.
    for (let i = 0; i < 20; i++) {
      timer.advance(1000);
      await Promise.resolve();
      await Promise.resolve();
    }

    // The retry buffer is bounded: attempts stop far short of the 20 windows.
    expect(fake.editAttempts()).toBeGreaterThan(1); // retries did occur
    expect(fake.editAttempts()).toBeLessThanOrEqual(5); // initial + MAX_RETRY_ATTEMPTS(4)
    // Never silently succeeded.
    expect(fake.recorded.calls.some((c) => c.op === "edit")).toBe(false);
  });

  it("guards an absent editMessage method — returns err(not_supported:edit) WITHOUT throwing", async () => {
    const fake = createFakeMsTeamsAdapter();
    const noEdit = { ...fake, editMessage: undefined } as unknown as FakeMsTeamsAdapter;
    const actions = makeMSTeamsRenderActions(noEdit, "conv-1");
    const r = await actions.edit("msteams-msg-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "edit" });
  });

  it("guards an absent deleteMessage method — returns err(not_supported:delete)", async () => {
    const fake = createFakeMsTeamsAdapter();
    const noDelete = { ...fake, deleteMessage: undefined } as unknown as FakeMsTeamsAdapter;
    const actions = makeMSTeamsRenderActions(noDelete, "conv-1");
    const r = await actions.delete("msteams-msg-0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "delete" });
  });

  it("maps a 403 delete error to err(permission)", async () => {
    const fake = createFakeMsTeamsAdapter();
    const actions = makeMSTeamsRenderActions(fake, "conv-1");
    fake.nextError = mkError({ status: 403 });
    const r = await actions.delete("msteams-msg-0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("permission");
  });
});

// --- createMSTeamsActivityRenderer (EditPlace wiring; plain-text) ------------

describe("createMSTeamsActivityRenderer (EditPlace wiring + delete-on-success)", () => {
  it("returns the EditPlace ChannelActivityRenderer surface", () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeMsTeamsAdapter();
    const r = createMSTeamsActivityRenderer(fake, "conv-1", { timer, clock });
    expect(r.strategy).toBe("EditPlace");
    expect(r.canEdit).toBe(true);
    expect(r.canDelete).toBe(true);
    expect(Object.keys(r).sort()).toEqual(["apply", "canDelete", "canEdit", "finalize", "strategy"]);
  });

  it("posts a placeholder on first apply and collapses a burst into one edit carrying the latest text", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeMsTeamsAdapter();
    const r = createMSTeamsActivityRenderer(fake, "conv-1", { timer, clock });

    await r.apply(makeFrame(0, "step 1"));
    await r.apply(makeFrame(1, "step 2"));
    await r.apply(makeFrame(2, "step 3"));
    expect(fake.recorded.calls.filter((c) => c.op === "send")).toHaveLength(1);
    expect(fake.recorded.calls.filter((c) => c.op === "edit")).toHaveLength(0);

    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();

    const edits = fake.recorded.calls.filter((c): c is Extract<FakeCall, { op: "edit" }> => c.op === "edit");
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toContain("step 3");
  });

  it("deletes the placeholder ONLY after the deliveredAt point on success", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeMsTeamsAdapter();
    const r = createMSTeamsActivityRenderer(fake, "conv-1", { timer, clock });

    await r.apply(makeFrame(0, "step 1"));
    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();

    const deliveredAtMs = clock.now() + 1000;
    await r.finalize({ kind: "success", trivial: false, delivery: receiptAt(deliveredAtMs) });
    await Promise.resolve();
    await Promise.resolve();

    // Must NOT delete before the assistant answer lands.
    expect(fake.recorded.calls.some((c) => c.op === "delete")).toBe(false);

    timer.advance(1000);
    await Promise.resolve();
    await Promise.resolve();

    const deletes = fake.recorded.calls.filter((c): c is Extract<FakeCall, { op: "delete" }> => c.op === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].id).toBe("msteams-msg-0");
  });

  it("is plain-text: buildButtons is undefined and no native approval buttons are wired", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(`${here}/../msteams-activity.ts`, "utf8");
    expect(src).toMatch(/buildButtons:\s*undefined/);
    expect(src).not.toMatch(/buildApprovalButtons/);
  });
});
