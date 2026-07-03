// SPDX-License-Identifier: Apache-2.0
/**
 * DigestOnly strategy tests.
 *
 * Used by Email (largest cap, end-of-turn only). On success NO message is sent
 * (the assistant reply IS the activity). On failure exactly one "[FAILED]"
 * digest is produced carrying the activity trail. Nothing is sent mid-turn.
 */
import { describe, it, expect } from "vitest";
import type { Result } from "@comis/shared";
import { ok } from "@comis/shared";
import type {
  ActivityRenderFrame,
  ActivityEvent,
  TurnOutcome,
  FinalDeliveryReceipt,
  ActivityRenderError,
} from "@comis/core";
import type { ActivityStatusMarkers } from "@comis/core";
import { createDigestOnlyRenderer } from "./digest-only.js";
import type { ActivityRenderActions } from "./actions.js";

/** The locked `ascii` theme markers: every glyph is bracketed ASCII. */
const ASCII_MARKERS: ActivityStatusMarkers = {
  success: "[OK]",
  failure: "[ERR]",
  subagent: "[SUB]",
  running: "[..]",
};

function makeRecordingActions(): { actions: ActivityRenderActions; sent: string[] } {
  const sent: string[] = [];
  let seq = 0;
  const actions: ActivityRenderActions = {
    async send(text): Promise<Result<string, ActivityRenderError>> {
      sent.push(text);
      return ok(`msg-${seq++}`);
    },
    async edit(): Promise<Result<void, ActivityRenderError>> {
      return ok(undefined);
    },
    async delete(): Promise<Result<void, ActivityRenderError>> {
      return ok(undefined);
    },
  };
  return { actions, sent };
}

function makeEvent(label: string): ActivityEvent {
  return {
    schemaVersion: 1,
    activityId: "11111111-1111-1111-1111-111111111111",
    sessionKey: "s", agentId: "main", traceId: "t",
    ts: "2026-05-26T00:00:00.000Z",
    phase: "progress", status: "running", kind: "tool", semanticPhase: "tool",
    defaultLabel: label,
  } as ActivityEvent;
}

function makeFrame(frameSeq: number, events: readonly ActivityEvent[]): ActivityRenderFrame {
  return {
    frameSeq,
    visibleEvents: events,
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added: [], edited: [], removed: [] },
  };
}

const RECEIPT: FinalDeliveryReceipt = {
  ok: true, deliveredChunks: 1, lastChunkMessageId: "final", deliveredAtMs: 0,
};

describe("createDigestOnlyRenderer", () => {
  it("reports a DigestOnly identity that cannot edit or delete", () => {
    const { actions } = makeRecordingActions();
    const r = createDigestOnlyRenderer({ actions });
    expect(r.strategy).toBe("DigestOnly");
    expect(r.canEdit).toBe(false);
    expect(r.canDelete).toBe(false);
  });

  it("sends nothing during the turn (apply buffers silently)", async () => {
    const { actions, sent } = makeRecordingActions();
    const r = createDigestOnlyRenderer({ actions });

    await r.apply(makeFrame(0, [makeEvent("step 1")]));
    await r.apply(makeFrame(1, [makeEvent("step 1"), makeEvent("step 2")]));

    expect(sent).toHaveLength(0);
  });

  it("sends NO message on success (the assistant reply is the activity)", async () => {
    const { actions, sent } = makeRecordingActions();
    const r = createDigestOnlyRenderer({ actions });

    await r.apply(makeFrame(0, [makeEvent("step 1")]));
    const success: TurnOutcome = { kind: "success", trivial: false, delivery: RECEIPT };
    await r.finalize(success);

    expect(sent).toHaveLength(0);
  });

  it("sends exactly one [FAILED] digest carrying the activity trail on failure", async () => {
    const { actions, sent } = makeRecordingActions();
    const r = createDigestOnlyRenderer({ actions });

    await r.apply(makeFrame(0, [makeEvent("fetch quote")]));
    await r.apply(makeFrame(1, [makeEvent("fetch quote"), makeEvent("compute average")]));
    const failure: TurnOutcome = {
      kind: "failure",
      errorKind: "dependency",
      failedEvents: [makeEvent("compute average")],
    };
    await r.finalize(failure);

    expect(sent).toHaveLength(1);
    const digest = sent[0];
    expect(digest).toContain("[FAILED]");
    expect(digest).toContain("dependency");
    // The trail is carried in the digest body.
    expect(digest).toContain("fetch quote");
    expect(digest).toContain("compute average");
  });

  it("sends nothing on a trivial turn", async () => {
    const { actions, sent } = makeRecordingActions();
    const r = createDigestOnlyRenderer({ actions });
    const trivial: TurnOutcome = { kind: "success", trivial: true, delivery: RECEIPT };
    await r.finalize(trivial);
    expect(sent).toHaveLength(0);
  });

  it("uses the themed failure marker on the digest header under the ascii theme", async () => {
    const { actions, sent } = makeRecordingActions();
    const r = createDigestOnlyRenderer({ actions, markers: ASCII_MARKERS });

    await r.apply(makeFrame(0, [makeEvent("fetch quote")]));
    const failure: TurnOutcome = {
      kind: "failure",
      errorKind: "dependency",
      failedEvents: [makeEvent("fetch quote")],
    };
    await r.finalize(failure);

    const digest = sent[0];
    // The theme governs the header MARKER glyph, not the "  • " bullet layout of
    // the trail body (U+2022 is theme-independent formatting). Assert the HEADER line
    // carries no non-ASCII codepoint (stricter than Extended_Pictographic) and
    // follows the resolved theme marker, not the hardcoded "[FAILED]".
    const header = digest.split("\n")[0];
    expect(header).not.toMatch(/[^\x00-\x7F]/);
    expect(header).toBe("[ERR] dependency");
    expect(digest).not.toContain("[FAILED]");
  });

  it("preserves the default [FAILED] digest header when markers are absent", async () => {
    const { actions, sent } = makeRecordingActions();
    const r = createDigestOnlyRenderer({ actions });

    await r.apply(makeFrame(0, [makeEvent("fetch quote")]));
    const failure: TurnOutcome = {
      kind: "failure",
      errorKind: "dependency",
      failedEvents: [makeEvent("fetch quote")],
    };
    await r.finalize(failure);

    // Byte-for-byte parity with the original body: the header stays "[FAILED]".
    expect(sent[0]).toContain("[FAILED] dependency");
  });
});
