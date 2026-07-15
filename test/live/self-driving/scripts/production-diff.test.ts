// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type {
  CanonicalProductionEvent,
  CanonicalProductionTranscript,
} from "./production-transcript.js";
import {
  diffProductionReplay,
  type ReplayObservedRecord,
} from "./production-diff.js";

function digest(character: string): string {
  return character.repeat(64);
}

function event(
  seq: number,
  eventId: string,
  payloadDigest = digest("a"),
  parent: string | null = null,
): CanonicalProductionEvent {
  return {
    seq,
    source: { kind: "state", id: "state-source", seq },
    kind: "state.mutation.committed",
    eventId,
    traceId: null,
    sessionId: null,
    runId: null,
    jobId: null,
    clockId: "clock-a",
    wallTimeMs: 1_752_560_000_000 + seq,
    monotonicTimeNs: String(seq),
    causalParentEventId: parent,
    actor: { kind: "service", id: "daemon", trust: "system", origin: "state" },
    replay: {
      policy: "assert",
      idempotencyKey: digest("b"),
      payloadDigest,
      blobDigest: null,
    },
  };
}

function transcript(events: readonly CanonicalProductionEvent[]): CanonicalProductionTranscript {
  return {
    schema: "comis-canonical-production-transcript",
    schemaVersion: 1,
    captureId: "capture-a",
    createdAtMs: 1_752_560_000_000,
    events,
  };
}

function record(
  surface: ReplayObservedRecord["surface"],
  recordId: string,
  valueDigest: string,
  causalEventId: string | null,
): ReplayObservedRecord {
  return { surface, recordId, valueDigest, causalEventId };
}

describe("production replay causal diff", () => {
  it("returns stable matching hashes for identical activity and state", () => {
    const activity = transcript([event(1, "event-1"), event(2, "event-2", digest("c"), "event-1")]);
    const state = [record("sqlite", "memory:1", digest("d"), "event-2")];

    const result = diffProductionReplay({
      expectedTranscript: activity,
      actualTranscript: structuredClone(activity),
      expectedRecords: state,
      actualRecords: structuredClone(state),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.matched).toBe(true);
    expect(result.value.divergence).toBeNull();
    expect(result.value.expectedTranscriptDigest).toBe(result.value.actualTranscriptDigest);
    expect(result.value.expectedStateDigest).toBe(result.value.actualStateDigest);
  });

  it("reports the earliest changed activity event without exposing payload content", () => {
    const expected = transcript([
      event(1, "event-1"),
      event(2, "event-2", digest("c"), "event-1"),
      event(3, "event-3", digest("d"), "event-2"),
    ]);
    const actual = transcript([
      event(1, "event-1"),
      event(2, "event-2", digest("e"), "event-1"),
      event(3, "event-3", digest("f"), "event-2"),
    ]);

    const result = diffProductionReplay({
      expectedTranscript: expected,
      actualTranscript: actual,
      expectedRecords: [],
      actualRecords: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.divergence).toEqual({
      kind: "event_changed",
      causalSeq: 2,
      expectedEventId: "event-2",
      actualEventId: "event-2",
      surface: "activity",
      recordId: null,
    });
    expect(JSON.stringify(result.value)).not.toContain("prompt");
  });

  it("orders a durable-state divergence by its causal event before a later activity mismatch", () => {
    const expected = transcript([
      event(1, "event-1"),
      event(2, "event-2", digest("c"), "event-1"),
      event(3, "event-3", digest("d"), "event-2"),
    ]);
    const actual = transcript([
      event(1, "event-1"),
      event(2, "event-2", digest("c"), "event-1"),
      event(3, "event-3", digest("e"), "event-2"),
    ]);

    const result = diffProductionReplay({
      expectedTranscript: expected,
      actualTranscript: actual,
      expectedRecords: [record("delivery", "mirror:1", digest("a"), "event-1")],
      actualRecords: [record("delivery", "mirror:1", digest("b"), "event-1")],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.divergence).toEqual({
      kind: "state_changed",
      causalSeq: 1,
      expectedEventId: "event-1",
      actualEventId: "event-1",
      surface: "delivery",
      recordId: "mirror:1",
    });
  });

  it("distinguishes missing wire output from an unexpected extra output", () => {
    const activity = transcript([event(1, "event-1")]);
    const expectedRecords = [record("wire", "telegram:message-1", digest("a"), "event-1")];

    const missing = diffProductionReplay({
      expectedTranscript: activity,
      actualTranscript: activity,
      expectedRecords,
      actualRecords: [],
    });
    expect(missing.ok && missing.value.divergence?.kind).toBe("state_missing");

    const unexpected = diffProductionReplay({
      expectedTranscript: activity,
      actualTranscript: activity,
      expectedRecords: [],
      actualRecords: expectedRecords,
    });
    expect(unexpected.ok && unexpected.value.divergence?.kind).toBe("state_unexpected");
  });

  it("rejects duplicate or content-bearing state record identities", () => {
    const activity = transcript([event(1, "event-1")]);
    const duplicate = record("file", "workspace:file-a", digest("a"), "event-1");

    const result = diffProductionReplay({
      expectedTranscript: activity,
      actualTranscript: activity,
      expectedRecords: [duplicate, duplicate],
      actualRecords: [],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_diff_input",
        message: "Replay diff records are invalid or duplicated",
      },
    });
  });
});
