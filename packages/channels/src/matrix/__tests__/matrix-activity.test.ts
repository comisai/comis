// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix EditPlace renderer tests.
 *
 * The net-new logic is `classifyMatrixRenderError` — it maps a Matrix
 * Client-Server failure onto the CLOSED `ActivityRenderError` union
 * (rate_limited / permission / not_supported / internal), NOT the send-path
 * `ClassifiedMatrixError` logging shape. It reads the STRUCTURAL `errcode` and
 * numeric `httpStatus` (and, for a 429, the body's `retry_after_ms`) off the
 * error AND off `error.cause` — never by parsing the message string.
 *
 * `makeMatrixRenderActions` maps each ChannelPort call through it, guards the
 * optional `editMessage` / `deleteMessage` methods (early not_supported, no
 * non-null cluster), and drives a bounded latest-text 429-retry buffer through
 * the injected FakeTimers. `createMatrixActivityRenderer` wraps the shared
 * `createEditPlaceRenderer` — no duplicated state machine — and paints NO
 * buttons: Matrix has no button surface, so an approval frame degrades to a
 * plain text prompt (buildButtons is undefined; nothing fake is rendered).
 *
 * Time discipline: every test drives the injected FakeTimers / FakeClock — no
 * raw setTimeout / Date.now. The fake adapter records every op and exposes a
 * structural error seam so the classifier is driven off `e.errcode`/`e.httpStatus`.
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
  SendMessageOptions,
  ActivityRenderFrame,
  ActivityEvent,
  TurnOutcome,
  FinalDeliveryReceipt,
  ApprovalCorrelation,
  RichButton,
} from "@comis/core";
// 5 levels up from matrix/__tests__/ — same depth as msteams/__tests__/X.test.ts.
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import {
  classifyMatrixRenderError,
  makeMatrixRenderActions,
  createMatrixActivityRenderer,
} from "../matrix-activity.js";

const DEBOUNCE_MS = 800;

// --- Fake ChannelPort (records ops incl. buttons; structural error seams) -----

/** One recorded adapter call — discriminated by `op`, deterministic ids. */
type FakeCall =
  | { op: "send"; id: string; text: string; buttons: RichButton[][] | undefined }
  | { op: "edit"; id: string; text: string }
  | { op: "delete"; id: string };

/**
 * A Matrix-shaped failure carrying the STRUCTURAL `errcode` + numeric
 * `httpStatus` the renderer classifier reads, and (for a 429) the body's
 * `retry_after_ms`. This mirrors the SDK `MatrixError` shape the adapter's
 * edit/delete failure branch returns — never the message string.
 */
interface RenderError extends Error {
  errcode?: string;
  httpStatus?: number;
  data?: { retry_after_ms?: number };
}

interface FakeMatrixAdapter extends ChannelPort {
  /** Ordered call-log — deterministic `$evt-N` ids, no timestamps. */
  readonly recorded: { calls: FakeCall[] };
  /** One-shot: the NEXT recording op returns `err(nextError)`, then clears. */
  nextError: RenderError | undefined;
  /** Persistent: EVERY `editMessage` returns `err(alwaysEditError)` until cleared. */
  alwaysEditError: RenderError | undefined;
  /** Count of `editMessage` invocations (incl. failed) — proves the retry bound. */
  editAttempts(): number;
}

function mkError(fields: {
  errcode?: string;
  httpStatus?: number;
  retryAfterMs?: number;
  message?: string;
}): RenderError {
  const e = new Error(fields.message ?? "matrix event failed") as RenderError;
  if (fields.errcode !== undefined) e.errcode = fields.errcode;
  if (fields.httpStatus !== undefined) e.httpStatus = fields.httpStatus;
  if (fields.retryAfterMs !== undefined) e.data = { retry_after_ms: fields.retryAfterMs };
  return e;
}

function createFakeMatrixAdapter(channelId = "!room:hs"): FakeMatrixAdapter {
  const recorded: { calls: FakeCall[] } = { calls: [] };
  let counter = 0;
  let edits = 0;

  const adapter: FakeMatrixAdapter = {
    channelId,
    channelType: "matrix",
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
      const id = `$evt-${counter++}`;
      recorded.calls.push({ op: "send", id, text, buttons: options?.buttons });
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
      return { connected: true, channelId, channelType: "matrix" };
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

function approvalFrame(): ActivityRenderFrame {
  const corr: ApprovalCorrelation = {
    shortId: "Mtrx89Abc012",
    expiresAt: 300000,
    choices: [
      { id: "approve", defaultLabel: "Approve", style: "primary" },
      { id: "deny", defaultLabel: "Deny", style: "danger" },
    ],
  };
  const event: ActivityEvent = {
    schemaVersion: 1,
    activityId: "00000000-0000-0000-0000-000000000000",
    sessionKey: "sess-a",
    agentId: "main",
    traceId: "trace-a",
    ts: "2026-05-26T00:00:00.000Z",
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

// --- classifyMatrixRenderError (structural errcode/status → renderer union) ---

describe("classifyMatrixRenderError (structural errcode/status onto the closed ActivityRenderError union)", () => {
  it("maps M_LIMIT_EXCEEDED with retry_after_ms to rate_limited carrying that backoff", () => {
    expect(classifyMatrixRenderError(mkError({ errcode: "M_LIMIT_EXCEEDED", retryAfterMs: 2000 }))).toEqual({
      kind: "rate_limited",
      retryAfterMs: 2000,
    });
  });

  it("maps a bare 429 (no retry_after_ms) to rate_limited with a 1s floor", () => {
    expect(classifyMatrixRenderError(mkError({ httpStatus: 429 }))).toEqual({
      kind: "rate_limited",
      retryAfterMs: 1000,
    });
  });

  it("maps a 401 to permission (no token/body copied into detail)", () => {
    const r = classifyMatrixRenderError(mkError({ httpStatus: 401 }));
    expect(r.kind).toBe("permission");
    if (r.kind === "permission") {
      expect(r.detail).toContain("401");
      expect(r.detail).not.toContain("Bearer");
    }
  });

  it("maps a 403 to permission", () => {
    expect(classifyMatrixRenderError(mkError({ httpStatus: 403 })).kind).toBe("permission");
  });

  it("maps M_FORBIDDEN to permission", () => {
    expect(classifyMatrixRenderError(mkError({ errcode: "M_FORBIDDEN" })).kind).toBe("permission");
  });

  it("maps a 404 (edit target gone) to not_supported:edit (drop further edits)", () => {
    expect(classifyMatrixRenderError(mkError({ httpStatus: 404 }))).toEqual({
      kind: "not_supported",
      capability: "edit",
    });
  });

  it("maps M_NOT_FOUND (edit target gone) to not_supported:edit", () => {
    expect(classifyMatrixRenderError(mkError({ errcode: "M_NOT_FOUND" }))).toEqual({
      kind: "not_supported",
      capability: "edit",
    });
  });

  it("maps a 500 to internal (not a rate-limit; carries the cause)", () => {
    const e = mkError({ httpStatus: 500 });
    expect(classifyMatrixRenderError(e)).toEqual({ kind: "internal", cause: e });
  });

  it("maps a status-less bare Error (transport fault) to internal carrying the cause", () => {
    const e = new Error("boom");
    expect(classifyMatrixRenderError(e)).toEqual({ kind: "internal", cause: e });
  });

  it("reads the errcode/status off error.cause when the adapter wrapped it there", () => {
    const cause = mkError({ httpStatus: 429, retryAfterMs: 3000 });
    const wrapped = new Error("matrix edit failed", { cause });
    expect(classifyMatrixRenderError(wrapped)).toEqual({ kind: "rate_limited", retryAfterMs: 3000 });
  });
});

// --- makeMatrixRenderActions (Result discipline, guards, bounded 429 retry) ---

describe("makeMatrixRenderActions (Result discipline, optional-method guards, bounded retry)", () => {
  it("sends the placeholder and records the created event id", async () => {
    const fake = createFakeMatrixAdapter();
    const actions = makeMatrixRenderActions(fake, "!room:hs");
    const r = await actions.send("placeholder");
    expect(r.ok && r.value).toBe("$evt-0");
    expect(fake.recorded.calls).toEqual([
      { op: "send", id: "$evt-0", text: "placeholder", buttons: undefined },
    ]);
  });

  it("maps a failing sendMessage through the classifier without throwing", async () => {
    const fake = createFakeMatrixAdapter();
    const actions = makeMatrixRenderActions(fake, "!room:hs");
    fake.nextError = mkError({ httpStatus: 403 });
    const r = await actions.send("placeholder");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("permission");
  });

  it("retries a 429 edit once via the timer then resolves by editing the latest text", async () => {
    const timer = createFakeTimers();
    const fake = createFakeMatrixAdapter();
    const actions = makeMatrixRenderActions(fake, "!room:hs", { timer });

    // One-shot 429 on the first edit attempt; the scheduled retry then succeeds.
    fake.nextError = mkError({ httpStatus: 429, retryAfterMs: 1000 });
    const r = await actions.edit("$evt-0", "updated");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "rate_limited", retryAfterMs: 1000 });
    // First attempt failed → nothing recorded yet.
    expect(fake.recorded.calls.filter((c) => c.op === "edit")).toHaveLength(0);

    timer.advance(1000);
    await Promise.resolve();
    await Promise.resolve();

    const edits = fake.recorded.calls.filter(
      (c): c is Extract<FakeCall, { op: "edit" }> => c.op === "edit",
    );
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toBe("updated");
  });

  it("bounds a sustained 429 storm (never unbounded) and stays terminal rate_limited", async () => {
    const timer = createFakeTimers();
    const fake = createFakeMatrixAdapter();
    const actions = makeMatrixRenderActions(fake, "!room:hs", { timer });

    fake.alwaysEditError = mkError({ httpStatus: 429, retryAfterMs: 1000 });
    const r = await actions.edit("$evt-0", "x");
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
    const fake = createFakeMatrixAdapter();
    const noEdit = { ...fake, editMessage: undefined } as unknown as FakeMatrixAdapter;
    const actions = makeMatrixRenderActions(noEdit, "!room:hs");
    const r = await actions.edit("$evt-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "edit" });
  });

  it("guards an absent deleteMessage method — returns err(not_supported:delete)", async () => {
    const fake = createFakeMatrixAdapter();
    const noDelete = { ...fake, deleteMessage: undefined } as unknown as FakeMatrixAdapter;
    const actions = makeMatrixRenderActions(noDelete, "!room:hs");
    const r = await actions.delete("$evt-0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "delete" });
  });

  it("maps a 403 delete error to err(permission)", async () => {
    const fake = createFakeMatrixAdapter();
    const actions = makeMatrixRenderActions(fake, "!room:hs");
    fake.nextError = mkError({ httpStatus: 403 });
    const r = await actions.delete("$evt-0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("permission");
  });
});

// --- createMatrixActivityRenderer (EditPlace wiring; NO buttons ever) ---------

describe("createMatrixActivityRenderer (EditPlace wiring + delete-on-success + text-only approvals)", () => {
  it("returns the EditPlace ChannelActivityRenderer surface", () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeMatrixAdapter();
    const r = createMatrixActivityRenderer(fake, "!room:hs", { timer, clock });
    expect(r.strategy).toBe("EditPlace");
    expect(r.canEdit).toBe(true);
    expect(r.canDelete).toBe(true);
    expect(Object.keys(r).sort()).toEqual(["apply", "canDelete", "canEdit", "finalize", "strategy"]);
  });

  it("posts a placeholder on first apply and collapses a burst into one edit carrying the latest text", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeMatrixAdapter();
    const r = createMatrixActivityRenderer(fake, "!room:hs", { timer, clock });

    await r.apply(makeFrame(0, "step 1"));
    await r.apply(makeFrame(1, "step 2"));
    await r.apply(makeFrame(2, "step 3"));
    expect(fake.recorded.calls.filter((c) => c.op === "send")).toHaveLength(1);
    expect(fake.recorded.calls.filter((c) => c.op === "edit")).toHaveLength(0);

    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();

    const edits = fake.recorded.calls.filter(
      (c): c is Extract<FakeCall, { op: "edit" }> => c.op === "edit",
    );
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toContain("step 3");
  });

  it("deletes the placeholder ONLY after the deliveredAt point on success", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeMatrixAdapter();
    const r = createMatrixActivityRenderer(fake, "!room:hs", { timer, clock });

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

    const deletes = fake.recorded.calls.filter(
      (c): c is Extract<FakeCall, { op: "delete" }> => c.op === "delete",
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0].id).toBe("$evt-0");
  });

  it("renders an approval frame as TEXT with NO buttons (Matrix has no button surface)", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeMatrixAdapter();
    const r = createMatrixActivityRenderer(fake, "!room:hs", { timer, clock });

    await r.apply(approvalFrame());

    const send = fake.recorded.calls.find(
      (c): c is Extract<FakeCall, { op: "send" }> => c.op === "send",
    );
    expect(send).toBeDefined();
    // No fake actionable control is ever painted — degrade to plain text.
    expect(send?.buttons).toBeUndefined();
    // The approval frame still rendered as (non-empty) text.
    expect((send?.text ?? "").length).toBeGreaterThan(0);
  });

  it("wires buildButtons to undefined and pulls in no approval-button builder (no fake buttons EVER)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(`${here}/../matrix-activity.ts`, "utf8");
    // buildButtons resolves to undefined — the no-button path.
    expect(src).toMatch(/buildButtons:\s*undefined/);
    // And the renderer never reaches for the signed-approval-button builder.
    expect(src).not.toMatch(/buildApprovalButtons/);
  });
});
