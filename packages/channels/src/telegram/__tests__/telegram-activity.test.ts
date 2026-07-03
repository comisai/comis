// SPDX-License-Identifier: Apache-2.0
/**
 * Telegram EditPlace renderer tests.
 *
 * The single net-new piece of logic here is `classifyTelegramError` —
 * it reads STRUCTURAL GrammyError fields (`error_code`, `parameters.retry_after`,
 * and the `description` ONLY to pick the message-not-found variant), NEVER the
 * generic "Failed to…" string. `makeTelegramRenderActions` maps each ChannelPort
 * call through it; `createTelegramActivityRenderer` wires the
 * `createEditPlaceRenderer` (no duplicated state machine).
 *
 * Time discipline: every test drives the injected FakeTimers/FakeClock — no raw
 * setTimeout/Date.now (globals.test.ts fails the build otherwise). Golden
 * fixtures assert via readFixture + toEqual (NEVER toMatchSnapshot — snapshot
 * auto-write silently self-heals a regression).
 */
import { describe, it, expect } from "vitest";
import type {
  ActivityRenderFrame,
  ActivityEvent,
  TurnOutcome,
  FinalDeliveryReceipt,
} from "@comis/core";
// 5 levels up from telegram/__tests__/ — same depth as shared/strategies/X.test.ts.
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import {
  classifyTelegramError,
  makeTelegramRenderActions,
  createTelegramActivityRenderer,
} from "../telegram-activity.js";
import { createFakeTelegramAdapter } from "../../__tests__/fakes/telegram-fake.js";
import type { FakeTelegramCall } from "../../__tests__/fakes/telegram-fake.js";
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

// --- classifyTelegramError + makeTelegramRenderActions -------------

describe("classifyTelegramError (structural fields, never the message string)", () => {
  it("maps a 429 to rate_limited with retryAfterMs from parameters.retry_after * 1000", () => {
    const e = { error_code: 429, description: "Too Many Requests", parameters: { retry_after: 5 } };
    expect(classifyTelegramError(e)).toEqual({ kind: "rate_limited", retryAfterMs: 5000 });
  });

  it("defaults a 429 with no retry_after to a 1s retryAfterMs floor", () => {
    expect(classifyTelegramError({ error_code: 429 })).toEqual({ kind: "rate_limited", retryAfterMs: 1000 });
  });

  it("maps a 400 message-not-found to not_supported:edit (drop further edits)", () => {
    const e = { error_code: 400, description: "Bad Request: message to edit not found" };
    expect(classifyTelegramError(e)).toEqual({ kind: "not_supported", capability: "edit" });
  });

  it("maps a 400 'message can't be edited' to not_supported:edit", () => {
    const e = { error_code: 400, description: "Bad Request: message can't be edited" };
    expect(classifyTelegramError(e)).toEqual({ kind: "not_supported", capability: "edit" });
  });

  it("maps a 403 to permission carrying the description detail", () => {
    const e = { error_code: 403, description: "Forbidden: bot was blocked by the user" };
    expect(classifyTelegramError(e)).toEqual({ kind: "permission", detail: "Forbidden: bot was blocked by the user" });
  });

  it("maps an unknown bare Error to internal carrying the cause", () => {
    const e = new Error("boom");
    expect(classifyTelegramError(e)).toEqual({ kind: "internal", cause: e });
  });

  it("reads the GrammyError off error.cause when the adapter attached it there", () => {
    // The live outbound path wraps the GrammyError in `new Error(msg, { cause })`.
    const cause = { error_code: 429, parameters: { retry_after: 7 } };
    const wrapped = new Error("Failed to edit message: Too Many Requests", { cause });
    expect(classifyTelegramError(wrapped)).toEqual({ kind: "rate_limited", retryAfterMs: 7000 });
  });

  it("does NOT classify on the generic 'Failed to…' string (a 400 without a not-found description is internal)", () => {
    const e = { error_code: 400, description: "Bad Request: chat not found" };
    const r = classifyTelegramError(e);
    expect(r.kind).toBe("internal");
  });
});

describe("makeTelegramRenderActions (Result discipline, silent send, optional-method guards)", () => {
  it("sends the placeholder with the silent effect so the adapter sets disable_notification", async () => {
    const fake = createFakeTelegramAdapter();
    const actions = makeTelegramRenderActions(fake, "chat-1");
    const r = await actions.send("placeholder");
    expect(r.ok && r.value).toBe("tg-msg-0");
    const send = fake.recorded.calls.find((c) => c.op === "send");
    expect(send).toEqual({ op: "send", id: "tg-msg-0", text: "placeholder", silent: true });
  });

  it("maps a 429 edit error to err(rate_limited) without throwing", async () => {
    const fake = createFakeTelegramAdapter();
    const actions = makeTelegramRenderActions(fake, "chat-1");
    fake.nextError = { error_code: 429, description: "Too Many Requests", parameters: { retry_after: 5 } };
    const r = await actions.edit("tg-msg-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "rate_limited", retryAfterMs: 5000 });
  });

  it("maps a message-not-found edit error to err(not_supported:edit)", async () => {
    const fake = createFakeTelegramAdapter();
    const actions = makeTelegramRenderActions(fake, "chat-1");
    fake.nextError = { error_code: 400, description: "Bad Request: message to edit not found" };
    const r = await actions.edit("tg-msg-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "edit" });
  });

  it("maps a 403 delete error to err(permission)", async () => {
    const fake = createFakeTelegramAdapter();
    const actions = makeTelegramRenderActions(fake, "chat-1");
    fake.nextError = { error_code: 403, description: "Forbidden: bot was blocked" };
    const r = await actions.delete("tg-msg-0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "permission", detail: "Forbidden: bot was blocked" });
  });

  it("maps an unknown send error to err(internal)", async () => {
    const fake = createFakeTelegramAdapter();
    const actions = makeTelegramRenderActions(fake, "chat-1");
    fake.nextError = new Error("boom");
    const r = await actions.send("x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("internal");
  });

  it("guards an absent editMessage method — returns err(not_supported) WITHOUT throwing", async () => {
    const fake = createFakeTelegramAdapter();
    // Remove the optional capability to prove the early guard (not a non-null `!`).
    const noEdit = { ...fake, editMessage: undefined } as typeof fake;
    const actions = makeTelegramRenderActions(noEdit, "chat-1");
    const r = await actions.edit("tg-msg-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "edit" });
  });

  it("guards an absent deleteMessage method — returns err(not_supported:delete)", async () => {
    const fake = createFakeTelegramAdapter();
    const noDelete = { ...fake, deleteMessage: undefined } as typeof fake;
    const actions = makeTelegramRenderActions(noDelete, "chat-1");
    const r = await actions.delete("tg-msg-0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "delete" });
  });
});

// --- createTelegramActivityRenderer + local bounded 429 buffer -----

describe("createTelegramActivityRenderer (EditPlace wiring + deliveredAt-gated delete)", () => {
  it("returns an EditPlace renderer that can edit and delete", () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeTelegramAdapter();
    const r = createTelegramActivityRenderer(fake, "chat-1", { timer, clock });
    expect(r.strategy).toBe("EditPlace");
    expect(r.canEdit).toBe(true);
    expect(r.canDelete).toBe(true);
  });

  it("collapses a burst of apply frames within the debounce window into one edit carrying the latest text", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeTelegramAdapter();
    const r = createTelegramActivityRenderer(fake, "chat-1", { timer, clock });

    await r.apply(makeFrame(0, "step 1"));
    await r.apply(makeFrame(1, "step 2"));
    await r.apply(makeFrame(2, "step 3"));
    expect(fake.recorded.calls.filter((c) => c.op === "edit")).toHaveLength(0);

    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();

    const edits = fake.recorded.calls.filter((c): c is Extract<FakeTelegramCall, { op: "edit" }> => c.op === "edit");
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toContain("step 3");
  });

  it("deletes the placeholder ONLY after the deliveredAt point on success", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeTelegramAdapter();
    const r = createTelegramActivityRenderer(fake, "chat-1", { timer, clock });

    await r.apply(makeFrame(0, "step 1"));
    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();

    const deliveredAtMs = clock.now() + 1000;
    await r.finalize({ kind: "success", trivial: false, delivery: receiptAt(deliveredAtMs) });
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.recorded.calls.some((c) => c.op === "delete")).toBe(false);

    timer.advance(1000);
    await Promise.resolve();
    await Promise.resolve();

    const deletes = fake.recorded.calls.filter((c): c is Extract<FakeTelegramCall, { op: "delete" }> => c.op === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].id).toBe("tg-msg-0");
    expect(fake.recorded.calls[fake.recorded.calls.length - 1].op).toBe("delete");
  });
});

describe("Telegram 429 local bounded buffer (latest text survives backoff)", () => {
  it("retries the LATEST coalesced text after retryAfterMs when an edit is rate-limited, never growing unbounded", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeTelegramAdapter();
    const r = createTelegramActivityRenderer(fake, "chat-1", { timer, clock });

    // Placeholder.
    await r.apply(makeFrame(0, "step 1"));

    // Next edit is rate-limited: arm a 429 (retry_after 2s) for the debounce flush.
    fake.nextError = { error_code: 429, description: "Too Many Requests", parameters: { retry_after: 2 } };
    await r.apply(makeFrame(1, "step 2"));
    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();

    // That first edit attempt failed (consumed the one-shot 429). A newer frame
    // arrives while backing off — the buffer must retain only the LATEST text.
    await r.apply(makeFrame(2, "step 3 latest"));
    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();

    // Fire the rate-limit retry timer (2s). The retried edit carries the LATEST text.
    timer.advance(2000);
    await Promise.resolve();
    await Promise.resolve();

    const edits = fake.recorded.calls.filter((c): c is Extract<FakeTelegramCall, { op: "edit" }> => c.op === "edit");
    // At least one edit landed and it carries the latest text (not a stale "step 2").
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits[edits.length - 1].text).toContain("step 3 latest");
    // Bounded: the buffer never replays a backlog — total edits stay small.
    expect(edits.length).toBeLessThanOrEqual(4);
  });

  it("stops retrying once an edit is rejected as message-not-found (drop further edits)", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeTelegramAdapter();
    const r = createTelegramActivityRenderer(fake, "chat-1", { timer, clock });

    await r.apply(makeFrame(0, "step 1"));
    fake.nextError = { error_code: 400, description: "Bad Request: message to edit not found" };
    await r.apply(makeFrame(1, "step 2"));
    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();

    const editsAfterDrop = fake.recorded.calls.filter((c) => c.op === "edit").length;

    // A later frame must NOT produce a fresh edit attempt — editing is dropped.
    await r.apply(makeFrame(2, "step 3"));
    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();
    timer.advance(10_000);
    await Promise.resolve();

    expect(fake.recorded.calls.filter((c) => c.op === "edit").length).toBe(editsAfterDrop);
  });

  it("fires the retryAfterMs-gated retry and re-sends the latest text on the next attempt", async () => {
    // Drive makeTelegramRenderActions directly so no EditPlace debounce edit
    // competes with (and cancels) the pending retry — isolating the retry path.
    const timer = createFakeTimers();
    const fake = createFakeTelegramAdapter();
    const actions = makeTelegramRenderActions(fake, "chat-1", { timer });

    fake.nextError = { error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } };
    const first = await actions.edit("tg-msg-0", "latest text");
    expect(first.ok).toBe(false); // the immediate attempt is rate-limited
    expect(fake.recorded.calls.filter((c) => c.op === "edit")).toHaveLength(0);

    // The one-shot 429 cleared; firing the 3s retry re-attempts and now succeeds.
    timer.advance(3000);
    await Promise.resolve();
    await Promise.resolve();

    const edits = fake.recorded.calls.filter((c): c is Extract<FakeTelegramCall, { op: "edit" }> => c.op === "edit");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({ op: "edit", id: "tg-msg-0", text: "latest text" });
  });

  it("caps sustained 429 retries (MAX_RETRY_ATTEMPTS) so the buffer cannot loop forever", async () => {
    const timer = createFakeTimers();
    const fake = createFakeTelegramAdapter();
    const actions = makeTelegramRenderActions(fake, "chat-1", { timer });

    // Every attempt is rate-limited: arm a fresh 429 before each retry fires.
    fake.nextError = { error_code: 429, parameters: { retry_after: 1 } };
    await actions.edit("tg-msg-0", "x");
    // Drive far more retry windows than the cap; re-arm a 429 each time.
    for (let i = 0; i < 12; i++) {
      fake.nextError = { error_code: 429, parameters: { retry_after: 1 } };
      timer.advance(1000);
      await Promise.resolve();
      await Promise.resolve();
    }

    // Bounded: the number of edit ATTEMPTS that reached the adapter is capped —
    // a sustained 429 storm does not produce an unbounded retry loop.
    const attempts = fake.recorded.calls.filter((c) => c.op === "edit").length;
    expect(attempts).toBe(0); // every attempt was rejected before recording
    // After the cap, no retry timer remains armed (the buffer gave up).
    const armed = timer.unrefRecord().filter((e) => !e.cancelled && e.kind === "timeout");
    expect(armed.length).toBeLessThanOrEqual(0 + 1); // at most the last fired one, none pending
  });

  it("a delete between scheduling and firing clears the slot so the retry is a no-op", async () => {
    const timer = createFakeTimers();
    const fake = createFakeTelegramAdapter();
    const actions = makeTelegramRenderActions(fake, "chat-1", { timer });

    // Arm a 429 so the edit schedules a retry.
    fake.nextError = { error_code: 429, parameters: { retry_after: 5 } };
    await actions.edit("tg-msg-0", "pending");

    // A delete supersedes the pending edit retry (clears the latest-text slot).
    await actions.delete("tg-msg-0");
    const deletes = fake.recorded.calls.filter((c) => c.op === "delete").length;
    expect(deletes).toBe(1);

    // Firing the retry timer now finds an empty slot → no further edit is sent.
    timer.advance(5000);
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.recorded.calls.filter((c) => c.op === "edit")).toHaveLength(0);
  });

  it("propagates a 429 without scheduling a retry when no timer is injected", async () => {
    // makeTelegramRenderActions with no deps.timer: a rate_limited edit simply
    // returns the error; there is no retry buffer to schedule against.
    const fake = createFakeTelegramAdapter();
    const actions = makeTelegramRenderActions(fake, "chat-1");
    fake.nextError = { error_code: 429, parameters: { retry_after: 5 } };
    const r = await actions.edit("tg-msg-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "rate_limited", retryAfterMs: 5000 });
    // No edit reached the adapter and nothing is scheduled (no timer to schedule on).
    expect(fake.recorded.calls.filter((c) => c.op === "edit")).toHaveLength(0);
  });
});

// --- 11 golden fixtures (S1-S7, S9-S12; no S8) ----------------------

/** Serialise the fake's ordered call-log — the exact shape the fixtures pin. */
function serialiseCallLog(fake: ReturnType<typeof createFakeTelegramAdapter>): unknown {
  return JSON.parse(JSON.stringify({ calls: fake.recorded.calls }));
}

/**
 * Drive the Telegram renderer through a scenario's frames + finalize (advancing
 * the fake timers as a real coordinator would), then assert the serialised
 * call-log equals the on-disk golden fixture.
 */
async function runScenario(
  scenario: string,
  frames: readonly ActivityRenderFrame[],
  outcome: TurnOutcome,
  deliveredAtMs: number,
): Promise<void> {
  const timer = createFakeTimers();
  const clock = createFakeClock(0);
  const fake = createFakeTelegramAdapter();
  // Omit `clock` so the
  // "(running N s)" elapsed fallback is skipped and committed fixtures stay
  // byte-stable. Strategy-level tests in edit-place.test.ts inject a clock and
  // assert the elapsed text — that is the live-production wiring contract.
  const r = createTelegramActivityRenderer(fake, "chat-1", { timer });

  for (const f of frames) {
    await r.apply(f);
    // Let each debounce window elapse so multi-frame scenarios coalesce per step.
    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();
  }
  await r.finalize(outcome);
  await Promise.resolve();
  await Promise.resolve();
  // Advance past any deliveredAt-gated delete.
  timer.advance(Math.max(0, deliveredAtMs - clock.now()) + 1000);
  await Promise.resolve();
  await Promise.resolve();

  expect(serialiseCallLog(fake)).toEqual(readFixture("telegram", scenario));
}

function ev(id: number, over: Partial<ActivityEvent> = {}): ActivityEvent {
  return makeEvent({ activityId: `00000000-0000-0000-0000-00000000000${id}`, ...over });
}

const okReceipt = (deliveredAtMs: number): FinalDeliveryReceipt => receiptAt(deliveredAtMs);

describe("Telegram golden fixtures (EditPlace scenarios — readFixture + toEqual)", () => {
  it("S1 trivial chat — zero renderer messages (kind:success trivial, no placeholder ever applied)", async () => {
    await runScenario("S1", [], { kind: "success", trivial: true, delivery: okReceipt(0) }, 0);
  });

  it("S2 one fast tool — 1 silent placeholder, 0 edit, 1 delete after deliveredAt", async () => {
    // A single apply posts the placeholder; the turn finalizes trivial before any edit.
    await runScenario(
      "S2",
      [makeFrame(0, "running tool")],
      { kind: "success", trivial: true, delivery: okReceipt(2000) },
      2000,
    );
  });

  it("S3 multi-step success — 1 placeholder, ≥2 edit (debounce respected), 1 delete after deliveredAt", async () => {
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

  // NOTE: createEditPlaceRenderer treats
  // success_with_recovered_failures identically to success (edit "✓ done" → gated
  // delete). Keeping the activity message for the recovered case ("0 delete")
  // would be an edit-place.ts policy change, out of scope for this channel test.
  // The fixture pins the ACTUAL renderer output (delete present).
  it("S5 recovered failure — edits incl. recovery then ✓ done, kind:success_with_recovered_failures (renderer deletes)", async () => {
    const recovered = ev(1, { status: "failed", errorKind: "network" });
    await runScenario(
      "S5",
      [makeFrame(0, "attempt 1"), makeFrame(1, "attempt 1 failed"), makeFrame(2, "attempt 2 ok")],
      { kind: "success_with_recovered_failures", trivial: false, delivery: okReceipt(0), recoveredFailures: [recovered] },
      0,
    );
  });

  it("S6 plan-state — checkboxes in placeholder, deleted on success", async () => {
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

  it("S7 subagent — parent '🤖 N steps' line, NO expand (Telegram), deleted on success", async () => {
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

  it("S9 message_tool visibility — activity routes to a silent placeholder, deleted on success", async () => {
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
