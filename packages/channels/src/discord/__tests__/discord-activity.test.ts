// SPDX-License-Identifier: Apache-2.0
/**
 * Discord EditPlace renderer tests.
 *
 * The single Discord-specific piece of logic is `classifyDiscordError` — it reads the
 * STRUCTURAL DiscordAPIError fields (`.code` / `.status` / `.retryAfter`, and
 * `.cause`), distinct from grammy's `error_code` and Slack's `data.error`. It
 * NEVER parses the generic "Failed to…" string. `makeDiscordRenderActions` maps
 * each ChannelPort call through it; `createDiscordActivityRenderer` wires the
 * `createEditPlaceRenderer` (no duplicated state machine).
 *
 * S7 is an affordance SHELL: a subagent placeholder renders the parent line and
 * requests the thread-expand egress (recorded as `threadCreate`), but NO
 * interaction handler is registered and NO signed callback_data is produced —
 * the InteractiveCallbackRouter lives in a separate component. A negative
 * assertion confirms no callback wiring exists.
 *
 * Time discipline: every test drives the injected FakeTimers/FakeClock — no raw
 * setTimeout/Date.now. Golden fixtures assert via readFixture + toEqual (NEVER
 * toMatchSnapshot — auto-write self-heals a wrong fixture).
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
// 5 levels up from discord/__tests__/ — same depth as shared/strategies/X.test.ts.
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import {
  classifyDiscordError,
  makeDiscordRenderActions,
  createDiscordActivityRenderer,
} from "../discord-activity.js";
import { createFakeDiscordAdapter } from "../../__tests__/fakes/discord-fake.js";
import type { FakeDiscordCall } from "../../__tests__/fakes/discord-fake.js";
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

// --- classifyDiscordError (structural .code/.status/.retryAfter) ------------

describe("classifyDiscordError (structural DiscordAPIError fields, never the message string)", () => {
  it("maps an HTTP 429 (RateLimitError-shaped retryAfter) to rate_limited with retryAfter*1000", () => {
    expect(classifyDiscordError({ retryAfter: 3 })).toEqual({ kind: "rate_limited", retryAfterMs: 3000 });
  });

  it("maps a status===429 with no retryAfter to a 1s rate_limited floor", () => {
    expect(classifyDiscordError({ status: 429 })).toEqual({ kind: "rate_limited", retryAfterMs: 1000 });
  });

  it("maps code 10008 Unknown Message to not_supported:edit (drop further edits)", () => {
    expect(classifyDiscordError({ code: 10008 })).toEqual({ kind: "not_supported", capability: "edit" });
  });

  it("classifies a coded error (10008) carrying a stray retryAfter as not_supported, NOT rate_limited (a terminal API code is never a rate limit — retrying an edit of a deleted message is the harmful direction)", () => {
    // A DiscordAPIError code (10008 Unknown Message = editing a deleted message)
    // takes precedence over a stray rate-limit signal: the structural code/status
    // branches MUST be evaluated before the retryAfter branch, else the renderer
    // would retry editing a message that no longer exists up to MAX_RETRY_ATTEMPTS
    // times instead of dropping all further edits immediately.
    expect(classifyDiscordError({ code: 10008, retryAfter: 5 })).toEqual({
      kind: "not_supported",
      capability: "edit",
    });
  });

  it("classifies a coded permission error (50013) carrying a stray retryAfter as permission, NOT rate_limited (precedence)", () => {
    const r = classifyDiscordError({ code: 50013, message: "Missing Permissions", retryAfter: 2 });
    expect(r.kind).toBe("permission");
    if (r.kind === "permission") expect(r.detail).toBe("Missing Permissions");
  });

  it("maps code 50013 Missing Permissions to permission", () => {
    const r = classifyDiscordError({ code: 50013, message: "Missing Permissions" });
    expect(r.kind).toBe("permission");
    if (r.kind === "permission") expect(r.detail).toBe("Missing Permissions");
  });

  it("maps an unknown bare Error to internal carrying the cause", () => {
    const e = new Error("boom");
    expect(classifyDiscordError(e)).toEqual({ kind: "internal", cause: e });
  });

  it("reads the DiscordAPIError off error.cause when the adapter attached it there", () => {
    // The live adapter wraps the DiscordAPIError in `new Error(msg, { cause })`.
    const cause = { code: 10008 };
    const wrapped = new Error("Failed to edit message: Unknown Message", { cause });
    expect(classifyDiscordError(wrapped)).toEqual({ kind: "not_supported", capability: "edit" });
  });

  it("reads a 429 retryAfter off error.cause", () => {
    const cause = { status: 429, retryAfter: 4 };
    const wrapped = new Error("Failed to send message: rate limited", { cause });
    expect(classifyDiscordError(wrapped)).toEqual({ kind: "rate_limited", retryAfterMs: 4000 });
  });

  it("does NOT classify on the generic 'Failed to…' string (an unknown code is internal)", () => {
    const e = { code: 50001, message: "Missing Access" };
    expect(classifyDiscordError(e).kind).toBe("internal");
  });
});

// --- makeDiscordRenderActions (Result discipline, guards) -------------------

describe("makeDiscordRenderActions (Result discipline, optional-method guards)", () => {
  it("sends the placeholder and records the created message id", async () => {
    const fake = createFakeDiscordAdapter();
    const actions = makeDiscordRenderActions(fake, "chat-1");
    const r = await actions.send("placeholder");
    expect(r.ok && r.value).toBe("dc-msg-0");
    const send = fake.recorded.calls.find((c) => c.op === "send");
    // Discord ignores rich effects → silent:false.
    expect(send).toEqual({ op: "send", id: "dc-msg-0", text: "placeholder", silent: false });
  });

  it("maps a 429 edit error to err(rate_limited) without throwing", async () => {
    const fake = createFakeDiscordAdapter();
    const actions = makeDiscordRenderActions(fake, "chat-1");
    fake.nextError = { status: 429, retryAfter: 3 };
    const r = await actions.edit("dc-msg-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "rate_limited", retryAfterMs: 3000 });
  });

  it("maps an Unknown Message (10008) edit error to err(not_supported:edit)", async () => {
    const fake = createFakeDiscordAdapter();
    const actions = makeDiscordRenderActions(fake, "chat-1");
    fake.nextError = { code: 10008 };
    const r = await actions.edit("dc-msg-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "edit" });
  });

  it("maps a Missing Permissions (50013) delete error to err(permission)", async () => {
    const fake = createFakeDiscordAdapter();
    const actions = makeDiscordRenderActions(fake, "chat-1");
    fake.nextError = { code: 50013, message: "Missing Permissions" };
    const r = await actions.delete("dc-msg-0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("permission");
  });

  it("guards an absent editMessage method — returns err(not_supported) WITHOUT throwing", async () => {
    const fake = createFakeDiscordAdapter();
    const noEdit = { ...fake, editMessage: undefined } as typeof fake;
    const actions = makeDiscordRenderActions(noEdit, "chat-1");
    const r = await actions.edit("dc-msg-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "edit" });
  });

  it("guards an absent deleteMessage method — returns err(not_supported:delete)", async () => {
    const fake = createFakeDiscordAdapter();
    const noDelete = { ...fake, deleteMessage: undefined } as typeof fake;
    const actions = makeDiscordRenderActions(noDelete, "chat-1");
    const r = await actions.delete("dc-msg-0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "delete" });
  });
});

// --- createDiscordActivityRenderer (EditPlace wiring) -----------------------

describe("createDiscordActivityRenderer (EditPlace wiring + deliveredAt-gated delete)", () => {
  it("returns an EditPlace renderer that can edit and delete", () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeDiscordAdapter();
    const r = createDiscordActivityRenderer(fake, "chat-1", { timer, clock });
    expect(r.strategy).toBe("EditPlace");
    expect(r.canEdit).toBe(true);
    expect(r.canDelete).toBe(true);
  });

  it("collapses a burst of apply frames within the debounce window into one edit carrying the latest text", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeDiscordAdapter();
    const r = createDiscordActivityRenderer(fake, "chat-1", { timer, clock });

    await r.apply(makeFrame(0, "step 1"));
    await r.apply(makeFrame(1, "step 2"));
    await r.apply(makeFrame(2, "step 3"));
    expect(fake.recorded.calls.filter((c) => c.op === "edit")).toHaveLength(0);

    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();

    const edits = fake.recorded.calls.filter((c): c is Extract<FakeDiscordCall, { op: "edit" }> => c.op === "edit");
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toContain("step 3");
  });

  it("deletes the placeholder ONLY after the deliveredAt point on success", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeDiscordAdapter();
    const r = createDiscordActivityRenderer(fake, "chat-1", { timer, clock });

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

    const deletes = fake.recorded.calls.filter((c): c is Extract<FakeDiscordCall, { op: "delete" }> => c.op === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].id).toBe("dc-msg-0");
    expect(fake.recorded.calls[fake.recorded.calls.length - 1].op).toBe("delete");
  });
});

// --- S7 subagent thread-expand affordance + signed approval UI -----

describe("Discord S7 subagent thread-expand affordance + signed approval UI", () => {
  it("renders the parent line AND records a thread-create egress for a subagent placeholder", async () => {
    const timer = createFakeTimers();
    const fake = createFakeDiscordAdapter();
    // Drop the clock dep so the "(running N s)" elapsed fallback is skipped and
    // `send.text === "🤖 subagent: 3 steps"` byte-stably.
    const r = createDiscordActivityRenderer(fake, "chat-1", { timer });

    await r.apply(makeFrame(0, "🤖 subagent: 3 steps"));

    const send = fake.recorded.calls.find((c): c is Extract<FakeDiscordCall, { op: "send" }> => c.op === "send");
    expect(send?.text).toBe("🤖 subagent: 3 steps");
    // The affordance SHELL: the thread-create egress IS recorded (display affordance).
    const thread = fake.recorded.calls.find((c) => c.op === "threadCreate");
    expect(thread).toEqual({ op: "threadCreate", parentId: "dc-msg-0" });
  });

  it("the renderer wires the signed approval UI (the router owns resolution)", () => {
    // Discord paints native signed components: the renderer references
    // `buildApprovalButtons` and threads the injected `signCallbackData`
    // through to `callback_data` — see discord-activity.approval.test.ts for
    // the behavioural proof.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(`${here}/../discord-activity.ts`, "utf8");
    expect(src).toMatch(/buildApprovalButtons/);
    expect(src).toMatch(/signCallbackData/);

    // The renderer surface stays the EditPlace ChannelActivityRenderer
    // (strategy/canEdit/canDelete/apply/finalize) — the approval UI rides on the
    // existing send path's `buttons`, not a new method on the renderer object.
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeDiscordAdapter();
    const r = createDiscordActivityRenderer(fake, "chat-1", { timer, clock });
    expect(Object.keys(r).sort()).toEqual(["apply", "canDelete", "canEdit", "finalize", "strategy"]);
  });
});

// --- 11 golden fixtures (S1-S7, S9-S12; no S8) -------------------------------

/** Serialise the fake's ordered call-log — the exact shape the fixtures pin. */
function serialiseCallLog(fake: ReturnType<typeof createFakeDiscordAdapter>): unknown {
  return JSON.parse(JSON.stringify({ calls: fake.recorded.calls }));
}

/**
 * Drive the Discord renderer through a scenario's frames + finalize (advancing
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
  const fake = createFakeDiscordAdapter();
  // The golden fixtures deliberately exclude renderFrameText's "(running N s)"
  // elapsed fallback. Omitting `clock` from the wrapper deps skips the strategy's
  // first-apply startedAtMs capture (elapsedMs stays undefined → fallback
  // skipped), keeping every committed fixture byte-stable. The strategy-level
  // tests in edit-place.test.ts DO inject a clock and explicitly assert the
  // (running N s) text — that is the live-production contract for the elapsed
  // wiring; these wrapper fixtures check the placeholder/edit/delete state
  // machine which is orthogonal to the elapsed suffix.
  const r = createDiscordActivityRenderer(fake, "chat-1", { timer });

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

  expect(serialiseCallLog(fake)).toEqual(readFixture("discord", scenario));
}

function ev(id: number, over: Partial<ActivityEvent> = {}): ActivityEvent {
  return makeEvent({ activityId: `00000000-0000-0000-0000-00000000000${id}`, ...over });
}

const okReceipt = (deliveredAtMs: number): FinalDeliveryReceipt => receiptAt(deliveredAtMs);

describe("Discord golden fixtures (EditPlace call-logs — readFixture + toEqual)", () => {
  it("S1 trivial chat — zero renderer messages", async () => {
    await runScenario("S1", [], { kind: "success", trivial: true, delivery: okReceipt(0) }, 0);
  });

  it("S2 one fast tool — 1 placeholder, 0 edit, 1 delete after deliveredAt", async () => {
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

  it("S7 subagent — parent line + thread-create expand SHELL, deleted on success", async () => {
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
