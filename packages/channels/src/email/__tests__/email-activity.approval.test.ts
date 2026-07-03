// SPDX-License-Identifier: Apache-2.0
/**
 * Email approval-link tests.
 *
 * Email cannot show buttons — the single-use, time-bounded, signed approval LINK
 * IS the approval action. When a `[FAILED]` digest's trail carries a
 * `kind:"approval"` event AND the composition root injected a `mintApprovalLink`
 * accessor, the digest body carries that link (a GET to the gateway approval-token
 * route). The body carries the LINK only — never a raw HMAC/secret (the token is
 * opaque, minted server-side at the composition root).
 *
 * When no link minter is injected (pre-wiring) OR the trail has no approval
 * event, the digest stays exactly the `[FAILED] {errorKind}` + bullet
 * trail — byte-stable, no link, so the 5 existing golden fixtures are unaffected.
 */
import { describe, it, expect } from "vitest";
import type { ActivityRenderFrame, ActivityEvent, TurnOutcome } from "@comis/core";
import { createEmailActivityRenderer } from "../email-activity.js";
import { createFakeEmailAdapter } from "../../__tests__/fakes/email-fake.js";

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

/** A `kind:"approval"` event carrying a redacted ApprovalCorrelation. */
function makeApprovalEvent(shortId = "abcDEF123456"): ActivityEvent {
  return makeEvent({
    kind: "approval",
    semanticPhase: "queued",
    status: "running",
    toolName: "shell",
    defaultLabel: "approval required: shell",
    approval: {
      shortId,
      expiresAt: 300_000,
      choices: [
        { id: "approve", defaultLabel: "Approve", style: "primary" },
        { id: "deny", defaultLabel: "Deny", style: "danger" },
      ],
    },
  });
}

function makeTrailFrame(frameSeq: number, events: ActivityEvent[]): ActivityRenderFrame {
  return {
    frameSeq,
    visibleEvents: events,
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added: [], edited: [], removed: [] },
  };
}

const failure: TurnOutcome = {
  kind: "failure",
  errorKind: "precondition",
  failedEvents: [makeEvent({ status: "failed", errorKind: "precondition" })],
};

describe("Email approval link (single-use, signed, time-bounded)", () => {
  it("includes the minted single-use approval link in the digest body when the trail carries an approval event", async () => {
    const fake = createFakeEmailAdapter();
    const link = "https://comis.example/approve/super-secret-token";
    const r = createEmailActivityRenderer(fake, "inbox-1", {
      mintApprovalLink: (event) =>
        event.approval !== undefined ? link : undefined,
    });

    await r.apply(makeTrailFrame(0, [makeApprovalEvent()]));
    await r.finalize(failure);

    const sends = fake.recorded.calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(1);
    const send = sends[0];
    if (send && send.op === "send") {
      expect(send.text).toContain(link);
    }
  });

  it("carries NO raw HMAC/secret in the body — only the opaque link", async () => {
    const fake = createFakeEmailAdapter();
    // A realistic opaque token (no `v1.<choice>.<shortId>.<hmac>` signed wire form).
    const link = "https://comis.example/approve/opaqueTokenABC123";
    const r = createEmailActivityRenderer(fake, "inbox-1", {
      mintApprovalLink: () => link,
    });

    await r.apply(makeTrailFrame(0, [makeApprovalEvent("abcDEF123456")]));
    await r.finalize(failure);

    const send = fake.recorded.calls.find((c) => c.op === "send");
    if (send && send.op === "send") {
      // The signed callback wire format (v1.<choice>.<shortId>.<hmac>) must NOT
      // appear in an email body — email uses the opaque single-use token only.
      expect(send.text).not.toMatch(/v1\.(approve|deny|details)\./);
      // The 12-char shortId is a server-side correlation id — never surfaced raw.
      expect(send.text).not.toContain("abcDEF123456");
    }
  });

  it("mints the link from the approval event (the accessor receives the kind:'approval' event)", async () => {
    const fake = createFakeEmailAdapter();
    const seen: ActivityEvent[] = [];
    const r = createEmailActivityRenderer(fake, "inbox-1", {
      mintApprovalLink: (event) => {
        seen.push(event);
        return "https://comis.example/approve/tok";
      },
    });

    await r.apply(makeTrailFrame(0, [makeApprovalEvent()]));
    await r.finalize(failure);

    expect(seen.some((e) => e.approval !== undefined)).toBe(true);
  });

  it("stays byte-stable (NO link) when no mintApprovalLink is injected — the failure digest is unchanged", async () => {
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

    const send = fake.recorded.calls.find((c) => c.op === "send");
    if (send && send.op === "send") {
      // Per-event bullet labels carry the running 🔧 marker (kind:"tool" +
      // status:"running" non-failed events); the [FAILED] header and the
      // no-http invariant are the load-bearing assertions.
      expect(send.text).toBe("[FAILED] dependency\n  • 🔧 fetch data\n  • 🔧 transform");
      expect(send.text).not.toContain("http");
    }
  });

  it("appends NO link when the trail has no approval event even if a minter is injected", async () => {
    const fake = createFakeEmailAdapter();
    const r = createEmailActivityRenderer(fake, "inbox-1", {
      mintApprovalLink: (event) =>
        event.approval !== undefined
          ? "https://comis.example/approve/tok"
          : undefined,
    });

    await r.apply(makeTrailFrame(0, [makeEvent({ defaultLabel: "fetch data" })]));
    await r.finalize(failure);

    const send = fake.recorded.calls.find((c) => c.op === "send");
    if (send && send.op === "send") {
      expect(send.text).not.toContain("http");
    }
  });
});
