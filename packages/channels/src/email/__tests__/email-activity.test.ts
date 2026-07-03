// SPDX-License-Identifier: Apache-2.0
/**
 * Email DigestOnly renderer tests.
 *
 * Email is the largest-cap, send-only channel — it wires the DigestOnly
 * strategy: buffer the trail in `apply`, send NOTHING mid-turn, send NOTHING on
 * success (the assistant reply IS the activity), and on failure emit exactly ONE
 * `[FAILED] {errorKind}` digest carrying the activity trail (one `• <label>` line
 * per trailed event). The single net-new piece of logic here is
 * `classifyEmailError` — the live adapter returns a bare nodemailer `Error`
 * (`err(error)`) on an SMTP send failure with no structured numeric code attached
 * to the returned object, so the classifier defaults to `internal` and reads the
 * error structurally ONLY (never renders the `.message` as activity
 * text). `makeEmailRenderActions` maps `send` through it and returns
 * `not_supported` for edit/delete (Email is send-only);
 * `createEmailActivityRenderer` wires the `createDigestOnlyRenderer`
 * (no duplicated state machine, NO timer/clock — DigestOnly is purely end-of-turn).
 *
 * Boundary note: the `Re: <thread>` part of the "[FAILED] Re: <thread>"
 * digest is the EMAIL TRANSPORT SUBJECT (the adapter's reply-threading concern on
 * its own send path), NOT the `send(text)` BODY the renderer controls. The body
 * the strategy produces — and these fixtures pin — is `[FAILED] {errorKind}` +
 * the `• <label>` trail. No `Re:` is injected into the body. The signed
 * single-use approval LINK is delivered separately — none of these 5 fixtures involves it.
 *
 * Golden fixtures assert via readFixture + toEqual (NEVER an auto-writing
 * inline/file snapshot, which self-heals a wrong fixture). DigestOnly
 * takes NO timer — there is no fake-timer advance anywhere here.
 */
import { describe, it, expect } from "vitest";
import type { ActivityRenderFrame, ActivityEvent, TurnOutcome, FinalDeliveryReceipt } from "@comis/core";
import {
  classifyEmailError,
  makeEmailRenderActions,
  createEmailActivityRenderer,
} from "../email-activity.js";
import { createFakeEmailAdapter } from "../../__tests__/fakes/email-fake.js";
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

/** A frame carrying an explicit multi-event trail (so the digest body has lines). */
function makeTrailFrame(frameSeq: number, events: ActivityEvent[]): ActivityRenderFrame {
  return {
    frameSeq,
    visibleEvents: events,
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added: [], edited: [], removed: [] },
  };
}

function okReceipt(deliveredAtMs: number): FinalDeliveryReceipt {
  return { ok: true, deliveredChunks: 1, lastChunkMessageId: "msg-final", deliveredAtMs };
}

// --- classifyEmailError + makeEmailRenderActions ----------------------------

describe("classifyEmailError (structural only, never the SMTP message string)", () => {
  it("maps an unknown bare Error to internal carrying the cause (SMTP send returns a raw nodemailer Error)", () => {
    const e = new Error("connect ECONNREFUSED smtp.example.com:587");
    expect(classifyEmailError(e)).toEqual({ kind: "internal", cause: e });
  });

  it("maps an undefined error to internal (defensive default)", () => {
    const r = classifyEmailError(undefined);
    expect(r.kind).toBe("internal");
  });

  it("maps an arbitrary error object to internal — it does not invent a rich classifier", () => {
    const e = { message: "smtp send failed", code: "ETIMEDOUT" };
    const r = classifyEmailError(e);
    expect(r.kind).toBe("internal");
  });

  it("does NOT render the SMTP error message as activity text — only selects the variant", () => {
    const e = new Error("535 5.7.8 Authentication credentials: super-secret-smtp-token");
    const r = classifyEmailError(e);
    expect(r.kind).toBe("internal");
    if (r.kind === "internal") expect(r.cause).toBe(e);
  });
});

describe("makeEmailRenderActions (Result discipline, no silent, edit+delete unsupported)", () => {
  it("sends the digest body and resolves to the minted id (no silent effect, no buttons)", async () => {
    const fake = createFakeEmailAdapter();
    const actions = makeEmailRenderActions(fake, "inbox-1");
    const r = await actions.send("[FAILED] internal");
    expect(r.ok && r.value).toBe("email-msg-0");
    const send = fake.recorded.calls.find((c) => c.op === "send");
    // No `silent` field is recorded — Email does not send a silent effect.
    expect(send).toEqual({ op: "send", id: "email-msg-0", text: "[FAILED] internal" });
  });

  it("maps an unknown send error to err(internal) without throwing", async () => {
    const fake = createFakeEmailAdapter();
    const actions = makeEmailRenderActions(fake, "inbox-1");
    fake.nextError = new Error("connect ECONNREFUSED smtp.example.com:587");
    const r = await actions.send("[FAILED] internal");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("internal");
  });

  it("edit always returns err(not_supported:edit) WITHOUT throwing (Email is send-only)", async () => {
    const fake = createFakeEmailAdapter();
    const actions = makeEmailRenderActions(fake, "inbox-1");
    const r = await actions.edit("email-msg-0", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "edit" });
    // The early return short-circuits before touching the port — no call recorded.
    expect(fake.recorded.calls.length).toBe(0);
  });

  it("delete always returns err(not_supported:delete) WITHOUT throwing (Email is send-only)", async () => {
    const fake = createFakeEmailAdapter();
    const actions = makeEmailRenderActions(fake, "inbox-1");
    const r = await actions.delete("email-msg-0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "not_supported", capability: "delete" });
    expect(fake.recorded.calls.length).toBe(0);
  });
});

describe("createEmailActivityRenderer (DigestOnly wiring)", () => {
  it("returns a DigestOnly renderer that can neither edit nor delete", () => {
    const fake = createFakeEmailAdapter();
    const r = createEmailActivityRenderer(fake, "inbox-1");
    expect(r.strategy).toBe("DigestOnly");
    expect(r.canEdit).toBe(false);
    expect(r.canDelete).toBe(false);
  });

  it("sends NOTHING mid-turn — apply buffers the trail, never posts (silent during the turn)", async () => {
    const fake = createFakeEmailAdapter();
    const r = createEmailActivityRenderer(fake, "inbox-1");

    await r.apply(makeFrame(0, "step 1"));
    await r.apply(makeFrame(1, "step 2"));
    await r.apply(makeFrame(2, "step 3"));

    expect(fake.recorded.calls).toHaveLength(0);
  });

  it("SUPPRESSES everything on success — zero sends (the assistant reply is the activity)", async () => {
    const fake = createFakeEmailAdapter();
    const r = createEmailActivityRenderer(fake, "inbox-1");

    await r.apply(makeFrame(0, "step 1"));
    await r.finalize({ kind: "success", trivial: false, delivery: okReceipt(1000) });

    expect(fake.recorded.calls).toHaveLength(0);
  });

  it("emits exactly ONE [FAILED] {errorKind} digest carrying the trail on failure", async () => {
    const fake = createFakeEmailAdapter();
    const r = createEmailActivityRenderer(fake, "inbox-1");

    await r.apply(
      makeTrailFrame(0, [
        makeEvent({ defaultLabel: "fetch data" }),
        makeEvent({ defaultLabel: "transform" }),
      ]),
    );
    await r.finalize({
      kind: "failure",
      errorKind: "dependency",
      failedEvents: [makeEvent({ status: "failed", errorKind: "dependency" })],
    });

    const sends = fake.recorded.calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(1);
    const send = sends[0];
    if (send && send.op === "send") {
      // Body is `[FAILED] {errorKind}` then one `• <label>` per trailed event.
      // Per-event bullet labels carry the running 🔧 marker (kind:"tool" +
      // status:"running" non-failed events); the header text and
      // no-stack-trace invariants are the load-bearing assertions.
      expect(send.text).toBe("[FAILED] dependency\n  • 🔧 fetch data\n  • 🔧 transform");
      // The raw SMTP error body is NEVER rendered; only the errorKind + labels.
      expect(send.text).not.toContain("ECONNREFUSED");
      // No `Re:` is injected into the body — that is the adapter's transport subject.
      expect(send.text).not.toContain("Re:");
    }
  });
});

// --- 5 golden fixtures (S4, S5, S10, S11, S12 only; S1-S3/S6/S7/S9 n/a; no S8) ---
//
// Email needs ONLY S4, S5, S10, S11, S12: success generates no email beyond
// the assistant reply, so S1-S3/S6/S7/S9 are n/a, and the approval scenario S8
// is covered by email-activity.approval.test.ts. Each scenario drives the
// renderer and asserts the serialised FakeEmailAdapter call-log against the
// committed fixture (readFixture + toEqual — never an auto-writing inline/file
// snapshot, which self-heals a wrong fixture). 4 of the 5 are empty call-logs
// (silent on success/recovered/silent); only S4 has content (the single
// failure digest).

/** Serialise the fake's ordered call-log — the exact shape the fixtures pin. */
function serialiseCallLog(fake: ReturnType<typeof createFakeEmailAdapter>): unknown {
  return JSON.parse(JSON.stringify({ calls: fake.recorded.calls }));
}

/**
 * Drive the Email DigestOnly renderer through a scenario's frames + finalize and
 * RETURN the serialised call-log. DigestOnly takes NO timer/clock — the factory
 * call is `createEmailActivityRenderer(fake, "inbox-1")` with no deps, and there is
 * no delete to gate behind a deliveredAt timer (a fake-timer advance for
 * Email is a warning sign). Each `it(...)` asserts `toEqual(readFixture("email", …))`
 * itself (never an auto-writing snapshot) so the on-disk fixture cannot self-heal.
 */
async function runScenario(
  frames: readonly ActivityRenderFrame[],
  outcome: TurnOutcome,
): Promise<unknown> {
  const fake = createFakeEmailAdapter();
  const r = createEmailActivityRenderer(fake, "inbox-1");

  for (const f of frames) {
    await r.apply(f);
    await Promise.resolve();
  }
  await r.finalize(outcome);
  await Promise.resolve();

  return serialiseCallLog(fake);
}

function ev(id: number, over: Partial<ActivityEvent> = {}): ActivityEvent {
  return makeEvent({ activityId: `00000000-0000-0000-0000-00000000000${id}`, ...over });
}

const okFinal = (deliveredAtMs: number): FinalDeliveryReceipt => okReceipt(deliveredAtMs);

describe("Email golden fixtures (DigestOnly rows — readFixture + toEqual)", () => {
  it("S4 outright failure — ONE [FAILED] {errorKind} digest carrying the trail (• per event)", async () => {
    const log = await runScenario(
      [
        makeTrailFrame(0, [ev(1, { defaultLabel: "fetch data" })]),
        makeTrailFrame(1, [
          ev(1, { defaultLabel: "fetch data" }),
          ev(2, { status: "failed", errorKind: "dependency", defaultLabel: "transform" }),
        ]),
      ],
      {
        kind: "failure",
        errorKind: "dependency",
        failedEvents: [ev(2, { status: "failed", errorKind: "dependency", defaultLabel: "transform" })],
      },
    );
    expect(log).toEqual(readFixture("email", "S4"));
  });

  it("S5 recovered failure — treated like success: ZERO sends (the assistant reply is the activity)", async () => {
    const recovered = ev(1, { status: "failed", errorKind: "network", defaultLabel: "attempt 1 failed" });
    const log = await runScenario(
      [makeFrame(0, "attempt 1"), makeFrame(1, "attempt 1 failed"), makeFrame(2, "attempt 2 ok")],
      { kind: "success_with_recovered_failures", trivial: false, delivery: okFinal(0), recoveredFailures: [recovered] },
    );
    expect(log).toEqual(readFixture("email", "S5"));
  });

  it("S10 verbose — ZERO sends (silent on success regardless of verbosity; the trail is buffered, never sent)", async () => {
    const frames = [0, 1, 2].map((i) => makeFrame(i, `verbose ${i + 1}`));
    const log = await runScenario(frames, { kind: "success", trivial: false, delivery: okFinal(5000) });
    expect(log).toEqual(readFixture("email", "S10"));
  });

  it("S11 silent verbosity — ZERO sends (kind:silent, no frame applied)", async () => {
    const log = await runScenario([], { kind: "silent", reason: "SILENT" });
    expect(log).toEqual(readFixture("email", "S11"));
  });

  it("S12 silent sentinel — ZERO sends (a frame buffered, but the silent finalize emits nothing)", async () => {
    const log = await runScenario(
      [makeFrame(0, "suppressed reply")],
      { kind: "silent", reason: "NO_REPLY" },
    );
    expect(log).toEqual(readFixture("email", "S12"));
  });
});
