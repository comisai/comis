// SPDX-License-Identifier: Apache-2.0
/**
 * Slack EditPlace renderer tests.
 *
 * The single net-new piece of logic is `classifySlackError` — it reads the
 * STRUCTURAL Slack-Bolt error field `e.data.error` (and `e.cause?.data?.error`),
 * distinct from grammy's `error_code` and discord's `.code`. It NEVER parses the
 * generic "Failed to…" string. `makeSlackRenderActions` maps each ChannelPort
 * call through it; `createSlackActivityRenderer` wires the
 * `createEditPlaceRenderer` (no duplicated state machine).
 *
 * `chat.delete` on success (the required delete-on-success op) fires after
 * `deliveredAtMs` — proven by the delete-on-success test.
 *
 * Approval frames: the renderer paints signed Block Kit
 * `actions` (each element's callback value is the signed callback wire string)
 * and opens a thread (thread_ts) for a subagent expand. The wiring is asserted
 * positively (`buildApprovalButtons`/`signCallbackData` present); the
 * behavioural proof lives in slack-activity.approval.test.ts /
 * slack-activity.subagent.test.ts.
 *
 * Time discipline: every test drives the injected FakeTimers/FakeClock — no raw
 * setTimeout/Date.now. Golden fixtures assert via readFixture + toEqual (NEVER
 * toMatchSnapshot — snapshot auto-write silently self-heals a regression).
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type {
  ActivityRenderFrame,
  ActivityEvent,
  TurnOutcome,
  FinalDeliveryReceipt,
} from "@comis/core";
// 5 levels up from slack/__tests__/ — same depth as shared/strategies/X.test.ts.
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import {
  classifySlackError,
  makeSlackRenderActions,
  createSlackActivityRenderer,
} from "../slack-activity.js";
import { createFakeSlackAdapter } from "../../__tests__/fakes/slack-fake.js";
import type { FakeSlackCall } from "../../__tests__/fakes/slack-fake.js";
import { readFixture } from "../../__tests__/fixture-harness.js";

const DEBOUNCE_MS = 800;

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

// --- classifySlackError (structural e.data.error) ----------------------------

describe("classifySlackError (structural data.error, never the message string)", () => {
  it("maps a ratelimited error to rate_limited with retryAfter*1000", () => {
    expect(classifySlackError({ data: { error: "ratelimited" }, retryAfter: 2 })).toEqual({
      kind: "rate_limited",
      retryAfterMs: 2000,
    });
  });

  it("defaults a ratelimited error with no retryAfter to a 1s floor", () => {
    expect(classifySlackError({ data: { error: "ratelimited" } })).toEqual({
      kind: "rate_limited",
      retryAfterMs: 1000,
    });
  });

  it("maps message_not_found to not_supported:edit (drop further edits)", () => {
    expect(classifySlackError({ data: { error: "message_not_found" } })).toEqual({
      kind: "not_supported",
      capability: "edit",
    });
  });

  it("maps cant_update_message to not_supported:edit", () => {
    expect(classifySlackError({ data: { error: "cant_update_message" } })).toEqual({
      kind: "not_supported",
      capability: "edit",
    });
  });

  it("maps not_in_channel to permission carrying the data.error detail", () => {
    const r = classifySlackError({ data: { error: "not_in_channel" } });
    expect(r.kind).toBe("permission");
    if (r.kind === "permission") expect(r.detail).toBe("not_in_channel");
  });

  it("maps cant_delete_message to permission", () => {
    expect(classifySlackError({ data: { error: "cant_delete_message" } }).kind).toBe("permission");
  });

  it("maps an unknown bare Error to internal carrying the cause", () => {
    const e = new Error("boom");
    expect(classifySlackError(e)).toEqual({ kind: "internal", cause: e });
  });

  it("reads the Slack error off error.cause when the adapter attached it there", () => {
    // The live adapter wraps the Slack error in `new Error(msg, { cause })`.
    const cause = { data: { error: "ratelimited" }, retryAfter: 7 };
    const wrapped = new Error("Failed to edit Slack message: ratelimited", { cause });
    expect(classifySlackError(wrapped)).toEqual({ kind: "rate_limited", retryAfterMs: 7000 });
  });

  it("does NOT classify on the generic 'Failed to…' string (an unknown data.error is internal)", () => {
    expect(classifySlackError({ data: { error: "channel_not_found" } }).kind).toBe("internal");
  });
});

// --- makeSlackRenderActions (Result discipline, guards) ----------------------

describe("makeSlackRenderActions (Result discipline, optional-method guards)", () => {
  it("sends the placeholder and records the created message id", async () => {
    const fake = createFakeSlackAdapter();
    const actions = makeSlackRenderActions(fake, "chat-1");
    const r = await actions.send("placeholder");
    expect(r.ok && r.value).toBe("sl-msg-0");
    const send = fake.recorded.calls.find((c) => c.op === "send");
    // Slack has no silent effect → silent:false.
    expect(send).toEqual({ op: "send", id: "sl-msg-0", text: "placeholder", silent: false });
  });

  it("maps a ratelimited edit error to err(rate_limited) without throwing", async () => {
    const fake = createFakeSlackAdapter();
    const actions = makeSlackRenderActions(fake, "chat-1");
    fake.nextError = { data: { error: "ratelimited" }, retryAfter: 2 };
    const r = await actions.edit("sl-msg-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "rate_limited", retryAfterMs: 2000 });
  });

  it("maps a message_not_found edit error to err(not_supported:edit)", async () => {
    const fake = createFakeSlackAdapter();
    const actions = makeSlackRenderActions(fake, "chat-1");
    fake.nextError = { data: { error: "message_not_found" } };
    const r = await actions.edit("sl-msg-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "edit" });
  });

  it("maps a not_in_channel delete error to err(permission)", async () => {
    const fake = createFakeSlackAdapter();
    const actions = makeSlackRenderActions(fake, "chat-1");
    fake.nextError = { data: { error: "not_in_channel" } };
    const r = await actions.delete("sl-msg-0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("permission");
  });

  it("guards an absent editMessage method — returns err(not_supported) WITHOUT throwing", async () => {
    const fake = createFakeSlackAdapter();
    const noEdit = { ...fake, editMessage: undefined } as typeof fake;
    const actions = makeSlackRenderActions(noEdit, "chat-1");
    const r = await actions.edit("sl-msg-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "edit" });
  });

  it("guards an absent deleteMessage method — returns err(not_supported:delete)", async () => {
    const fake = createFakeSlackAdapter();
    const noDelete = { ...fake, deleteMessage: undefined } as typeof fake;
    const actions = makeSlackRenderActions(noDelete, "chat-1");
    const r = await actions.delete("sl-msg-0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "delete" });
  });
});

// --- createSlackActivityRenderer + chat.delete on success --------------------

describe("createSlackActivityRenderer (EditPlace wiring + chat.delete on success)", () => {
  it("returns an EditPlace renderer that can edit and delete", () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeSlackAdapter();
    const r = createSlackActivityRenderer(fake, "chat-1", { timer, clock });
    expect(r.strategy).toBe("EditPlace");
    expect(r.canEdit).toBe(true);
    expect(r.canDelete).toBe(true);
  });

  it("collapses a burst of apply frames within the debounce window into one edit carrying the latest text", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeSlackAdapter();
    const r = createSlackActivityRenderer(fake, "chat-1", { timer, clock });

    await r.apply(makeFrame(0, "step 1"));
    await r.apply(makeFrame(1, "step 2"));
    await r.apply(makeFrame(2, "step 3"));
    expect(fake.recorded.calls.filter((c) => c.op === "edit")).toHaveLength(0);

    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();

    const edits = fake.recorded.calls.filter((c): c is Extract<FakeSlackCall, { op: "edit" }> => c.op === "edit");
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toContain("step 3");
  });

  it("calls chat.delete (deleteMessage) ONLY after the deliveredAt point on success", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeSlackAdapter();
    const r = createSlackActivityRenderer(fake, "chat-1", { timer, clock });

    await r.apply(makeFrame(0, "step 1"));
    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();

    const deliveredAtMs = clock.now() + 1000;
    await r.finalize({ kind: "success", trivial: false, delivery: receiptAt(deliveredAtMs) });
    await Promise.resolve();
    await Promise.resolve();

    // chat.delete must NOT fire before the assistant answer lands.
    expect(fake.recorded.calls.some((c) => c.op === "delete")).toBe(false);

    timer.advance(1000);
    await Promise.resolve();
    await Promise.resolve();

    const deletes = fake.recorded.calls.filter((c): c is Extract<FakeSlackCall, { op: "delete" }> => c.op === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].id).toBe("sl-msg-0");
    expect(fake.recorded.calls[fake.recorded.calls.length - 1].op).toBe("delete");
  });
});

// --- S8 Block Kit approval UI (signed callback wiring) -----------------------

describe("Slack Block Kit approval UI (signed callback wiring)", () => {
  it("wires the signed Block Kit approval UI through buildApprovalButtons/signCallbackData", () => {
    // Slack paints signed Block Kit action elements: the renderer references
    // `buildApprovalButtons` and threads the injected `signCallbackData` through
    // to each action's callback value — see slack-activity.approval.test.ts for
    // the behavioural proof.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(`${here}/../slack-activity.ts`, "utf8");
    expect(src).toMatch(/buildApprovalButtons/);
    expect(src).toMatch(/signCallbackData/);

    // The renderer surface stays the EditPlace ChannelActivityRenderer
    // (strategy/canEdit/canDelete/apply/finalize) — the approval UI rides on the
    // existing send path's `buttons`, not a new method on the renderer object.
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeSlackAdapter();
    const r = createSlackActivityRenderer(fake, "chat-1", { timer, clock });
    expect(Object.keys(r).sort()).toEqual(["apply", "canDelete", "canEdit", "finalize", "strategy"]);
  });
});

// --- 11 golden fixtures (S1-S7, S9-S12; no S8) -------------------------------

/** Serialise the fake's ordered call-log — the exact shape the fixtures pin. */
function serialiseCallLog(fake: ReturnType<typeof createFakeSlackAdapter>): unknown {
  return JSON.parse(JSON.stringify({ calls: fake.recorded.calls }));
}

/**
 * Drive the Slack renderer through a scenario's frames + finalize (advancing the
 * fake timers as a real coordinator would), then assert the serialised call-log
 * equals the on-disk golden fixture.
 */
async function runScenario(
  scenario: string,
  frames: readonly ActivityRenderFrame[],
  outcome: TurnOutcome,
  deliveredAtMs: number,
): Promise<void> {
  const timer = createFakeTimers();
  const clock = createFakeClock(0);
  const fake = createFakeSlackAdapter();
  // Omit `clock` so the "(running N s)" elapsed fallback is skipped and
  // committed fixtures stay byte-stable. Strategy-level tests in
  // edit-place.test.ts inject a clock and assert the elapsed text — that is the
  // live-production wiring contract.
  const r = createSlackActivityRenderer(fake, "chat-1", { timer });

  for (const f of frames) {
    await r.apply(f);
    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();
  }
  await r.finalize(outcome);
  await Promise.resolve();
  await Promise.resolve();
  timer.advance(Math.max(0, deliveredAtMs - clock.now()) + 1000);
  await Promise.resolve();
  await Promise.resolve();

  expect(serialiseCallLog(fake)).toEqual(readFixture("slack", scenario));
}

function ev(id: number, over: Partial<ActivityEvent> = {}): ActivityEvent {
  return makeEvent({ activityId: `00000000-0000-0000-0000-00000000000${id}`, ...over });
}

const okReceipt = (deliveredAtMs: number): FinalDeliveryReceipt => receiptAt(deliveredAtMs);

describe("Slack golden fixtures (EditPlace scenarios — readFixture + toEqual)", () => {
  it("S1 trivial chat — zero renderer messages", async () => {
    await runScenario("S1", [], { kind: "success", trivial: true, delivery: okReceipt(0) }, 0);
  });

  it("S2 one fast tool — 1 placeholder, 0 edit, 1 chat.delete after deliveredAt", async () => {
    await runScenario(
      "S2",
      [makeFrame(0, "running tool")],
      { kind: "success", trivial: true, delivery: okReceipt(2000) },
      2000,
    );
  });

  it("S3 multi-step success — 1 placeholder, ≥2 edit (debounce respected), 1 chat.delete after deliveredAt", async () => {
    const frames = [0, 1, 2].map((i) => makeFrame(i, `step ${i + 1}`));
    await runScenario("S3", frames, { kind: "success", trivial: false, delivery: okReceipt(5000) }, 5000);
  });

  it("S4 outright failure — 1 placeholder, ≥1 edit ending in ❌, 0 delete (message persists)", async () => {
    await runScenario(
      "S4",
      [makeFrame(0, "running tool"), makeFrame(1, "tool failed")],
      { kind: "failure", errorKind: "dependency", failedEvents: [ev(1, { status: "failed", errorKind: "dependency" })] },
      0,
    );
  });

  it("S5 recovered failure — edits incl. recovery then ✓ done, kind:success_with_recovered_failures (renderer deletes)", async () => {
    const recovered = ev(1, { status: "failed", errorKind: "network" });
    await runScenario(
      "S5",
      [makeFrame(0, "attempt 1"), makeFrame(1, "attempt 1 failed"), makeFrame(2, "attempt 2 ok")],
      { kind: "success_with_recovered_failures", trivial: false, delivery: okReceipt(0), recoveredFailures: [recovered] },
      0,
    );
  });

  it("S6 plan-state — Block Kit plan in placeholder, deleted on success", async () => {
    const plan = {
      entries: [
        { id: "p1", label: "step one", status: "done" as const },
        { id: "p2", label: "step two", status: "in_progress" as const },
      ],
    };
    await runScenario(
      "S6",
      [
        { ...makeFrame(0, "planning"), planSnapshot: plan },
        { ...makeFrame(1, "executing"), planSnapshot: plan },
      ],
      { kind: "success", trivial: false, delivery: okReceipt(3000) },
      3000,
    );
  });

  it("S7 subagent — parent line + thread (thread_ts) expand, deleted on success", async () => {
    await runScenario(
      "S7",
      [
        makeFrame(0, "🤖 subagent: 3 steps"),
        makeFrame(1, "🤖 subagent done"),
      ],
      { kind: "success", trivial: false, delivery: okReceipt(4000) },
      4000,
    );
  });

  it("S9 message_tool visibility — activity routes to a placeholder, deleted on success", async () => {
    await runScenario(
      "S9",
      [makeFrame(0, "running tool")],
      { kind: "success", trivial: false, delivery: okReceipt(2000) },
      2000,
    );
  });

  it("S10 verbose — every event renders, debounce still coalesces per window", async () => {
    const frames = [0, 1, 2].map((i) => makeFrame(i, `verbose ${i + 1}`));
    await runScenario("S10", frames, { kind: "success", trivial: false, delivery: okReceipt(5000) }, 5000);
  });

  it("S11 silent verbosity — zero activity messages from the renderer", async () => {
    await runScenario("S11", [], { kind: "silent", reason: "SILENT" }, 0);
  });

  it("S12 silent sentinel — placeholder deleted silently, kind:silent", async () => {
    await runScenario(
      "S12",
      [makeFrame(0, "suppressed reply")],
      { kind: "silent", reason: "NO_REPLY" },
      0,
    );
  });
});
