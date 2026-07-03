// SPDX-License-Identifier: Apache-2.0
/**
 * WhatsApp windowed EditPlace renderer tests.
 * Copies the Telegram canonical test shape but exercises the
 * baileys-specific classifier:
 *
 *   - `classifyWhatsAppError` maps a windowed edit-expiry (a Boom with a 4xx
 *     `output.statusCode`) → `{kind:"not_supported", capability:"edit"}` (drop
 *     further edits — same semantics as Telegram message-not-found), the bare
 *     "WhatsApp not connected" Error → `{kind:"transient_network", cause}`, and
 *     everything else → `{kind:"internal", cause}`.
 *   - The approval is a plain-text instruction SHELL (`buttons:"none"`): the
 *     recorded `send` carries NO button surface.
 *   - 11 golden fixtures (S1-S7, S9-S12; no S8 — the buttoned-approval
 *     scenario does not apply to WhatsApp's button-less approval shell) assert
 *     the serialised `FakeWhatsAppAdapter` call-log via `readFixture` +
 *     `toEqual` (NEVER `toMatchSnapshot`).
 *
 * Time/timers come from the per-test fakes (`createFakeClock`/`createFakeTimers`,
 * 5-level test-support path) — never raw `setTimeout`/`Date.now`.
 */
import { describe, it, expect } from "vitest";
import {
  classifyWhatsAppError,
  makeWhatsAppRenderActions,
  createWhatsAppActivityRenderer,
} from "../whatsapp-activity.js";
import { createFakeWhatsAppAdapter } from "../../__tests__/fakes/whatsapp-fake.js";
import { readFixture } from "../../__tests__/fixture-harness.js";
import type {
  ActivityRenderFrame,
  TurnOutcome,
  ActivityEvent,
} from "@comis/core";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";

const CHANNEL_ID = "jid@s";
const EDIT_DEBOUNCE_MS = 800;

/** A Boom-shaped windowed edit-expiry rejection (4xx client error + the signal). */
const WINDOW_EXPIRED: { output: { statusCode: number }; message: string } = {
  output: { statusCode: 400 },
  message: "edit window expired",
};

// --- ActivityEvent / frame / outcome builders (mirror the Telegram test) ---

function ev(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    seq: 0,
    at: 0,
    kind: "tool",
    status: "running",
    defaultLabel: "running tool",
    ...overrides,
  } as ActivityEvent;
}

function frame(visibleEvents: ActivityEvent[]): ActivityRenderFrame {
  return { activityId: "act-1", frameSeq: 0, visibleEvents };
}

function successOutcome(deliveredAtMs: number, trivial = false): TurnOutcome {
  return {
    kind: "success",
    trivial,
    delivery: { deliveredAtMs },
  } as TurnOutcome;
}

function failureOutcome(): TurnOutcome {
  return { kind: "failure", errorKind: "dependency" } as TurnOutcome;
}

/** Drain microtasks so a fired timer callback's async body settles. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("classifyWhatsAppError", () => {
  it("maps a windowed edit-expiry Boom (4xx statusCode) to not_supported:edit", () => {
    expect(classifyWhatsAppError(WINDOW_EXPIRED)).toEqual({
      kind: "not_supported",
      capability: "edit",
    });
  });

  it("maps a forbidden (403) Boom window rejection to not_supported:edit", () => {
    expect(classifyWhatsAppError({ output: { statusCode: 403 }, message: "edit window expired" })).toEqual({
      kind: "not_supported",
      capability: "edit",
    });
  });

  it("reads the Boom off Error.cause when the adapter wrapped the throw", () => {
    const wrapped = new Error("Failed to edit message: edit window expired", {
      cause: WINDOW_EXPIRED,
    });
    expect(classifyWhatsAppError(wrapped)).toEqual({
      kind: "not_supported",
      capability: "edit",
    });
  });

  it("maps the WhatsApp not-connected Error to transient_network with cause", () => {
    const notConnected = new Error("WhatsApp not connected");
    const result = classifyWhatsAppError(notConnected);
    expect(result.kind).toBe("transient_network");
    if (result.kind === "transient_network") {
      expect(result.cause).toBe(notConnected);
    }
  });

  it("maps a not-connected Error wrapped as cause to transient_network", () => {
    const wrapped = new Error("Failed to send message: WhatsApp not connected", {
      cause: new Error("WhatsApp not connected"),
    });
    expect(classifyWhatsAppError(wrapped).kind).toBe("transient_network");
  });

  it("falls back to internal for an unrecognised error", () => {
    const weird = new Error("Failed to edit message: boom");
    const result = classifyWhatsAppError(weird);
    expect(result.kind).toBe("internal");
    if (result.kind === "internal") {
      expect(result.cause).toBe(weird);
    }
  });

  it("does NOT classify a 5xx Boom (badSession) as not_supported", () => {
    // A server-side 500 is transient, NOT a window-expiry; must not drop edits.
    expect(classifyWhatsAppError({ output: { statusCode: 500 } }).kind).toBe("internal");
  });
});

describe("makeWhatsAppRenderActions", () => {
  it("Test 1: a window-expiry edit resolves not_supported:edit", async () => {
    const fake = createFakeWhatsAppAdapter(CHANNEL_ID);
    const actions = makeWhatsAppRenderActions(fake, CHANNEL_ID);
    const placed = await actions.send("running tool");
    expect(placed.ok).toBe(true);
    fake.nextError = WINDOW_EXPIRED;
    const edited = await actions.edit("wa-msg-0", "still running");
    expect(edited.ok).toBe(false);
    if (!edited.ok) expect(edited.error).toEqual({ kind: "not_supported", capability: "edit" });
  });

  it("Test 2: a not-connected error resolves transient_network", async () => {
    const fake = createFakeWhatsAppAdapter(CHANNEL_ID);
    const actions = makeWhatsAppRenderActions(fake, CHANNEL_ID);
    fake.nextError = new Error("WhatsApp not connected");
    const sent = await actions.send("running tool");
    expect(sent.ok).toBe(false);
    if (!sent.ok) expect(sent.error.kind).toBe("transient_network");
  });

  it("contains a baileys throw without letting it escape the boundary", async () => {
    const fake = createFakeWhatsAppAdapter(CHANNEL_ID);
    const actions = makeWhatsAppRenderActions(fake, CHANNEL_ID);
    await actions.send("running tool");
    fake.nextThrow = WINDOW_EXPIRED;
    // The render-actions adapter must catch the throw and return a Result.
    const edited = await actions.edit("wa-msg-0", "x");
    expect(edited.ok).toBe(false);
    if (!edited.ok) expect(edited.error).toEqual({ kind: "not_supported", capability: "edit" });
  });

  it("Test 4: drops all further edits after a window-expiry not_supported", async () => {
    const fake = createFakeWhatsAppAdapter(CHANNEL_ID);
    const actions = makeWhatsAppRenderActions(fake, CHANNEL_ID);
    await actions.send("running tool");
    fake.nextError = WINDOW_EXPIRED;
    await actions.edit("wa-msg-0", "after-expiry-1"); // trips the drop latch
    const second = await actions.edit("wa-msg-0", "after-expiry-2");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toEqual({ kind: "not_supported", capability: "edit" });
    // No second editMessage reached the adapter (drop, no retry loop).
    const editCalls = fake.recorded.calls.filter((c) => c.op === "edit");
    expect(editCalls.length).toBe(0); // both edits short-circuited (1st by injected err, 2nd by latch)
  });

  it("guards an absent optional editMessage with not_supported (no non-null)", async () => {
    const fake = createFakeWhatsAppAdapter(CHANNEL_ID);
    // Strip the optional method to exercise the guard branch.
    const stripped = { ...fake, editMessage: undefined };
    const actions = makeWhatsAppRenderActions(stripped, CHANNEL_ID);
    const edited = await actions.edit("wa-msg-0", "x");
    expect(edited.ok).toBe(false);
    if (!edited.ok) expect(edited.error).toEqual({ kind: "not_supported", capability: "edit" });
  });

  it("guards an absent optional deleteMessage with not_supported:delete", async () => {
    const fake = createFakeWhatsAppAdapter(CHANNEL_ID);
    const stripped = { ...fake, deleteMessage: undefined };
    const actions = makeWhatsAppRenderActions(stripped, CHANNEL_ID);
    const deleted = await actions.delete("wa-msg-0");
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error).toEqual({ kind: "not_supported", capability: "delete" });
  });

  it("Test 5: the plain-text approval send carries NO button surface (buttons:none)", async () => {
    const fake = createFakeWhatsAppAdapter(CHANNEL_ID);
    const actions = makeWhatsAppRenderActions(fake, CHANNEL_ID);
    // The approval shell is a plain-text instruction line — no button/components.
    const sent = await actions.send("Approve this action? Reply 'approve' or 'deny'.");
    expect(sent.ok).toBe(true);
    const send = fake.recorded.calls.find((c) => c.op === "send");
    expect(send).toBeDefined();
    if (send && send.op === "send") {
      expect(send.buttons).toBe(false); // buttons:"none" — no button surface attached
      expect(send.silent).toBe(false); // WhatsApp ignores the silent effect
    }
  });
});

describe("createWhatsAppActivityRenderer", () => {
  it("Test 3: debounces a burst of edits to a single edit carrying the latest text", async () => {
    const fake = createFakeWhatsAppAdapter(CHANNEL_ID);
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const renderer = createWhatsAppActivityRenderer(fake, CHANNEL_ID, { timer, clock });

    await renderer.apply(frame([ev({ seq: 0, defaultLabel: "step 1" })]));
    await renderer.apply(frame([ev({ seq: 1, defaultLabel: "step 2" })]));
    await renderer.apply(frame([ev({ seq: 2, defaultLabel: "step 3" })]));
    timer.advance(EDIT_DEBOUNCE_MS);
    await flush();

    const edits = fake.recorded.calls.filter((c) => c.op === "edit");
    expect(edits.length).toBe(1);
    if (edits[0]?.op === "edit") expect(edits[0].text).toContain("step 3");
  });

  it("Test 3: deletes the placeholder only AFTER deliveredAtMs on success", async () => {
    const fake = createFakeWhatsAppAdapter(CHANNEL_ID);
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const renderer = createWhatsAppActivityRenderer(fake, CHANNEL_ID, { timer, clock });

    await renderer.apply(frame([ev({ seq: 0, defaultLabel: "running" })]));
    const deliveredAtMs = clock.now() + 1000;
    await renderer.finalize(successOutcome(deliveredAtMs));
    // ✓ done edit happened; delete must NOT have fired yet.
    expect(fake.recorded.calls.some((c) => c.op === "delete")).toBe(false);
    timer.advance(1000);
    await flush();
    const calls = fake.recorded.calls;
    expect(calls[calls.length - 1]?.op).toBe("delete");
  });

  it("keeps the message (0 delete) on outright failure", async () => {
    const fake = createFakeWhatsAppAdapter(CHANNEL_ID);
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const renderer = createWhatsAppActivityRenderer(fake, CHANNEL_ID, { timer, clock });

    await renderer.apply(frame([ev({ seq: 0, defaultLabel: "running tool" })]));
    await renderer.finalize(failureOutcome());
    expect(fake.recorded.calls.some((c) => c.op === "delete")).toBe(false);
    const lastEdit = [...fake.recorded.calls].reverse().find((c) => c.op === "edit");
    expect(lastEdit?.op === "edit" && lastEdit.text).toContain("❌");
  });
});

// --- 11 golden fixtures (S1-S7, S9-S12; no S8) -------------------------------
//
// Each scenario drives the renderer through a representative frame/outcome
// sequence and asserts the serialised FakeWhatsAppAdapter call-log against the
// committed fixture (readFixture + toEqual — never toMatchSnapshot).

interface ScenarioDriver {
  (renderer: ReturnType<typeof createWhatsAppActivityRenderer>, ctx: {
    timer: ReturnType<typeof createFakeTimers>;
    clock: ReturnType<typeof createFakeClock>;
  }): Promise<void>;
}

async function runScenario(drive: ScenarioDriver): Promise<FakeWhatsAppCallLog> {
  const fake = createFakeWhatsAppAdapter(CHANNEL_ID);
  const timer = createFakeTimers();
  const clock = createFakeClock(0);
  // The golden fixtures do not include the "(running N s)" elapsed
  // fallback renderFrameText can emit. Omitting `clock` from the wrapper deps here skips the strategy's
  // first-apply startedAtMs capture (elapsedMs stays undefined → fallback
  // skipped), keeping every committed fixture byte-stable. The strategy-level
  // tests in edit-place.test.ts DO inject a clock and explicitly assert the
  // (running N s) text — that is the live-production contract for the elapsed
  // wiring; the fixture-level tests here check the wrapper-level state machine
  // (placeholder/edit/delete sequencing) which is orthogonal to the elapsed
  // suffix. `clock` is still threaded into `drive(...)` so individual `it(...)`
  // scenarios that need it (none currently) can request it via the ctx arg.
  const renderer = createWhatsAppActivityRenderer(fake, CHANNEL_ID, { timer });
  await drive(renderer, { timer, clock });
  return { calls: fake.recorded.calls };
}

type FakeWhatsAppCallLog = { calls: ReturnType<typeof createFakeWhatsAppAdapter>["recorded"]["calls"] };

async function debounceEdit(
  renderer: ReturnType<typeof createWhatsAppActivityRenderer>,
  timer: ReturnType<typeof createFakeTimers>,
  events: ActivityEvent[],
): Promise<void> {
  await renderer.apply(frame(events));
  timer.advance(EDIT_DEBOUNCE_MS);
  await flush();
}

describe("WhatsApp golden fixtures (S1-S7,S9-S12 — readFixture + toEqual)", () => {
  it("S1: trivial chat — zero placeholder/edit/delete", async () => {
    const log = await runScenario(async (renderer) => {
      await renderer.finalize(successOutcome(0, true));
    });
    expect(log).toEqual(readFixture("whatsapp", "S1"));
  });

  it("S2: one fast tool — silent-less placeholder, no edit, delete after delivery", async () => {
    const log = await runScenario(async (renderer, { timer, clock }) => {
      await renderer.apply(frame([ev({ seq: 0, defaultLabel: "running tool" })]));
      const deliveredAtMs = clock.now() + 500;
      await renderer.finalize(successOutcome(deliveredAtMs));
      timer.advance(500);
      await flush();
    });
    expect(log).toEqual(readFixture("whatsapp", "S2"));
  });

  it("S3: multi-step success — placeholder, debounced edits, delete after delivery", async () => {
    const log = await runScenario(async (renderer, { timer, clock }) => {
      await renderer.apply(frame([ev({ seq: 0, defaultLabel: "step 1" })]));
      await debounceEdit(renderer, timer, [ev({ seq: 1, defaultLabel: "step 2" })]);
      await debounceEdit(renderer, timer, [ev({ seq: 2, defaultLabel: "step 3" })]);
      const deliveredAtMs = clock.now() + 100;
      await renderer.finalize(successOutcome(deliveredAtMs));
      timer.advance(100);
      await flush();
    });
    expect(log).toEqual(readFixture("whatsapp", "S3"));
  });

  it("S4: outright failure — placeholder, ❌ edit, 0 delete (message persists)", async () => {
    const log = await runScenario(async (renderer, { timer }) => {
      await renderer.apply(frame([ev({ seq: 0, defaultLabel: "running tool" })]));
      await debounceEdit(renderer, timer, [
        ev({ seq: 1, status: "failed", defaultLabel: "tool failed" }),
      ]);
      await renderer.finalize(failureOutcome());
    });
    expect(log).toEqual(readFixture("whatsapp", "S4"));
  });

  it("S5: recovered failure — edits include ❌ and ✓, then delete after delivery", async () => {
    const log = await runScenario(async (renderer, { timer, clock }) => {
      await renderer.apply(frame([ev({ seq: 0, defaultLabel: "step 1" })]));
      await debounceEdit(renderer, timer, [
        ev({ seq: 1, status: "failed", defaultLabel: "step failed" }),
      ]);
      await debounceEdit(renderer, timer, [
        ev({ seq: 2, status: "completed", defaultLabel: "recovered" }),
      ]);
      const deliveredAtMs = clock.now() + 100;
      await renderer.finalize({
        kind: "success_with_recovered_failures",
        delivery: { deliveredAtMs },
      } as TurnOutcome);
      timer.advance(100);
      await flush();
    });
    expect(log).toEqual(readFixture("whatsapp", "S5"));
  });

  it("S6: plan-state — placeholder + step updates, deleted on success", async () => {
    const log = await runScenario(async (renderer, { timer, clock }) => {
      await renderer.apply(frame([ev({ seq: 0, kind: "lifecycle", defaultLabel: "plan: 2 steps" })]));
      await debounceEdit(renderer, timer, [
        ev({ seq: 1, kind: "lifecycle", defaultLabel: "plan: step 1 done" }),
      ]);
      const deliveredAtMs = clock.now() + 100;
      await renderer.finalize(successOutcome(deliveredAtMs));
      timer.advance(100);
      await flush();
    });
    expect(log).toEqual(readFixture("whatsapp", "S6"));
  });

  it("S7: subagent — parent line, NO expand affordance (WhatsApp has no thread/button)", async () => {
    const log = await runScenario(async (renderer, { timer, clock }) => {
      await renderer.apply(frame([ev({ seq: 0, kind: "subagent", defaultLabel: "🤖 subagent: 3 steps" })]));
      await debounceEdit(renderer, timer, [
        ev({ seq: 1, kind: "subagent", defaultLabel: "🤖 subagent done" }),
      ]);
      const deliveredAtMs = clock.now() + 100;
      await renderer.finalize(successOutcome(deliveredAtMs));
      timer.advance(100);
      await flush();
    });
    const fixture = readFixture("whatsapp", "S7") as FakeWhatsAppCallLog;
    expect(log).toEqual(fixture);
    // Collapse-only: no thread/button op ever recorded (WhatsApp has no such surface).
    expect(
      log.calls.every((c) => c.op === "send" || c.op === "edit" || c.op === "delete"),
    ).toBe(true);
  });

  it("S9: message_tool routing — activity placeholder/edit/delete still rendered", async () => {
    const log = await runScenario(async (renderer, { timer, clock }) => {
      await renderer.apply(frame([ev({ seq: 0, defaultLabel: "running tool" })]));
      await debounceEdit(renderer, timer, [ev({ seq: 1, defaultLabel: "tool done" })]);
      const deliveredAtMs = clock.now() + 100;
      await renderer.finalize(successOutcome(deliveredAtMs));
      timer.advance(100);
      await flush();
    });
    expect(log).toEqual(readFixture("whatsapp", "S9"));
  });

  it("S10: verbose — every event renders, no coalescing within the frame", async () => {
    const log = await runScenario(async (renderer, { timer, clock }) => {
      await renderer.apply(
        frame([
          ev({ seq: 0, defaultLabel: "a" }),
          ev({ seq: 1, defaultLabel: "b" }),
          ev({ seq: 2, defaultLabel: "c" }),
        ]),
      );
      await debounceEdit(renderer, timer, [
        ev({ seq: 0, defaultLabel: "a" }),
        ev({ seq: 1, defaultLabel: "b" }),
        ev({ seq: 2, defaultLabel: "c" }),
        ev({ seq: 3, defaultLabel: "d" }),
      ]);
      const deliveredAtMs = clock.now() + 100;
      await renderer.finalize(successOutcome(deliveredAtMs));
      timer.advance(100);
      await flush();
    });
    expect(log).toEqual(readFixture("whatsapp", "S10"));
  });

  it("S11: silent — zero activity messages", async () => {
    const log = await runScenario(async (renderer) => {
      await renderer.finalize({ kind: "silent" } as TurnOutcome);
    });
    expect(log).toEqual(readFixture("whatsapp", "S11"));
  });

  it("S12: [SILENT]/HEARTBEAT_OK — placeholder deleted silently, outcome silent", async () => {
    const log = await runScenario(async (renderer) => {
      await renderer.apply(frame([ev({ seq: 0, defaultLabel: "thinking" })]));
      await renderer.finalize({ kind: "silent" } as TurnOutcome);
    });
    expect(log).toEqual(readFixture("whatsapp", "S12"));
  });
});
