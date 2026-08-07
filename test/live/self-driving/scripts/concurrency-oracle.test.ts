// SPDX-License-Identifier: Apache-2.0
/**
 * Contract tests for the parallel/burst attribution + overlap oracle.
 *
 * The NEGATIVE controls are the point. An oracle that only ever reports success
 * cannot score a concurrency row, so each of the four ways a burst can lie has
 * its own failing case here:
 *
 *   1. a reply is never produced        → `lost-reply`, verdict fail
 *   2. replies cannot be attributed     → `ambiguous`, NEVER ok
 *   3. one reply is delivered twice     → `duplicate-delivery`, verdict fail
 *   4. the run was silently serialized  → `no-overlap-observed`, verdict fail
 *
 * Run:
 *   npx vitest run --config test/live/vitest.config.ts \
 *     test/live/self-driving/scripts/concurrency-oracle.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  attributeBurst,
  burstVerdict,
  filterRecordsWindow,
  isBurstTranscriptFile,
  openTrajectoryTraceIds,
  overlapReport,
  parseJsonlRecords,
  recordTimeMs,
  selectBurstTrajectoryRecords,
  shouldSettleBurstEvidence,
  wireReconciliation,
} from "./concurrency-oracle.mjs";

const GUID = {
  one: "11111111-1111-5111-8111-111111111111",
  two: "22222222-2222-5222-8222-222222222222",
  three: "33333333-3333-5333-8333-333333333333",
};

const injects = [
  { index: 0, inboundGuid: GUID.one },
  { index: 1, inboundGuid: GUID.two },
];

/** One transcript user record carrying its normalized inbound id, as the runtime persists it. */
const userRecord = (guid: string, text: string): string =>
  JSON.stringify({
    type: "message",
    message: { role: "user", content: `[inbound ${guid}]\n${text}` },
  });

const assistantRecord = (text: string): string =>
  JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

const terminalAssistantRecord = (id: string, parentId: string, text: string): string =>
  JSON.stringify({
    type: "message",
    id,
    parentId,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
    },
  });

const trajectoryRecord = (
  traceId: string,
  ts: string,
  type = "model.completed",
): Record<string, unknown> => ({ type, traceId, ts, sessionId: "s1", seq: 1 });

describe("burst settling — unresolved live work stays open", () => {
  const activeRecords = [
    trajectoryRecord("trace-live", "2026-08-06T10:00:00.000Z", "queue.enqueued"),
    trajectoryRecord("trace-live", "2026-08-06T10:00:01.000Z", "queue.dequeued"),
    trajectoryRecord("trace-live", "2026-08-06T10:00:02.000Z", "prompt.submitted"),
  ];

  it("does not convert a quiet long model call into a lost reply while the daemon is reachable", () => {
    expect(openTrajectoryTraceIds(activeRecords)).toEqual(["trace-live"]);
    expect(shouldSettleBurstEvidence({
      resolvedAll: false,
      deliveryComplete: false,
      evidenceQuiet: true,
      openTraceCount: 1,
      gatewayReachable: true,
    })).toBe(false);
  });

  it("settles the stopped-daemon lost-reply negative control after evidence goes quiet", () => {
    expect(shouldSettleBurstEvidence({
      resolvedAll: false,
      deliveryComplete: false,
      evidenceQuiet: true,
      openTraceCount: 1,
      gatewayReachable: false,
    })).toBe(true);
  });

  it("settles terminal evidence but keeps fully answered work open until its trace closes", () => {
    const terminalRecords = [
      ...activeRecords,
      trajectoryRecord("trace-live", "2026-08-06T10:00:30.000Z", "session.summary"),
    ];
    expect(openTrajectoryTraceIds(terminalRecords)).toEqual([]);
    expect(shouldSettleBurstEvidence({
      resolvedAll: false,
      deliveryComplete: false,
      evidenceQuiet: true,
      openTraceCount: 0,
      gatewayReachable: true,
    })).toBe(true);
    expect(shouldSettleBurstEvidence({
      resolvedAll: true,
      deliveryComplete: true,
      evidenceQuiet: false,
      openTraceCount: 1,
      gatewayReachable: true,
    })).toBe(false);
  });

  it("keeps terminal transcript answers open until matching wire deliveries arrive", () => {
    expect(shouldSettleBurstEvidence({
      resolvedAll: true,
      deliveryComplete: false,
      evidenceQuiet: false,
      openTraceCount: 0,
      gatewayReachable: true,
    })).toBe(false);

    expect(shouldSettleBurstEvidence({
      resolvedAll: true,
      deliveryComplete: true,
      evidenceQuiet: false,
      openTraceCount: 0,
      gatewayReachable: true,
    })).toBe(true);

    expect(shouldSettleBurstEvidence({
      resolvedAll: true,
      deliveryComplete: false,
      evidenceQuiet: true,
      openTraceCount: 0,
      gatewayReachable: true,
    })).toBe(true);
  });

  it("keeps a terminal parent open while its spawned child can still deliver", () => {
    const spawned = {
      ...trajectoryRecord("trace-live", "2026-08-06T10:00:03.000Z", "subagent.spawned"),
      data: { runId: "child-1" },
    };
    const terminalWithChild = [
      ...activeRecords,
      spawned,
      trajectoryRecord("trace-live", "2026-08-06T10:00:04.000Z", "session.summary"),
    ];

    expect(openTrajectoryTraceIds(terminalWithChild)).toEqual(["trace-live"]);
    expect(shouldSettleBurstEvidence({
      resolvedAll: true,
      deliveryComplete: true,
      evidenceQuiet: true,
      openTraceCount: 1,
      gatewayReachable: true,
    })).toBe(false);

    expect(openTrajectoryTraceIds([
      ...terminalWithChild,
      {
        ...trajectoryRecord("trace-live", "2026-08-06T10:00:40.000Z", "subagent.completed"),
        data: { runId: "child-1" },
      },
    ])).toEqual([]);
  });
});

describe("burst trajectory selection — continuing relationships stay scoped", () => {
  it("keeps only the expected queue-enqueued trace identities after the manifest start", () => {
    const records = [
      trajectoryRecord("prior-trace", "2026-08-06T10:00:00.100Z", "learning.outcome_observed"),
      trajectoryRecord("burst-a", "2026-08-06T10:00:00.200Z", "queue.enqueued"),
      trajectoryRecord("burst-b", "2026-08-06T10:00:00.210Z", "queue.enqueued"),
      trajectoryRecord("burst-a", "2026-08-06T10:00:04.000Z", "session.summary"),
      trajectoryRecord("burst-b", "2026-08-06T10:00:05.000Z", "session.summary"),
      trajectoryRecord("future-trace", "2026-08-06T10:01:00.000Z", "queue.enqueued"),
      trajectoryRecord("future-trace", "2026-08-06T10:01:04.000Z", "session.summary"),
    ];

    const selected = selectBurstTrajectoryRecords(records, {
      fromMs: Date.parse("2026-08-06T10:00:00.000Z"),
      expectedTraceCount: 2,
    });

    expect([...new Set(selected.map((record) => record.traceId))]).toEqual([
      "burst-a",
      "burst-b",
    ]);
  });

  it("falls back to prompt-submitted identities when a fresh trajectory has no queue events", () => {
    const records = [
      trajectoryRecord("fresh-a", "2026-08-06T10:00:00.200Z", "prompt.submitted"),
      trajectoryRecord("fresh-a", "2026-08-06T10:00:04.000Z", "session.summary"),
      trajectoryRecord("fresh-b", "2026-08-06T10:00:04.100Z", "prompt.submitted"),
      trajectoryRecord("fresh-b", "2026-08-06T10:00:08.000Z", "session.summary"),
    ];

    const selected = selectBurstTrajectoryRecords(records, {
      fromMs: Date.parse("2026-08-06T10:00:00.000Z"),
      expectedTraceCount: 2,
    });

    expect([...new Set(selected.map((record) => record.traceId))]).toEqual([
      "fresh-a",
      "fresh-b",
    ]);
  });
});

describe("burst transcript selection — provenance ledgers are not conversations", () => {
  it("accepts the session transcript and rejects ledger and sidecar files", () => {
    expect(isBurstTranscriptFile("principal~peer~principal.jsonl")).toBe(true);
    expect(isBurstTranscriptFile("principal~peer~principal~ledger~inbound.jsonl")).toBe(false);
    expect(isBurstTranscriptFile("principal.jsonl.trajectory.jsonl")).toBe(false);
    expect(isBurstTranscriptFile("principal_session-metadata.jsonl")).toBe(false);
  });
});

describe("burst attribution — the honest pass", () => {
  it("binds every reply to its own inbound when the runtime serialized the turns", () => {
    const transcript = [
      userRecord(GUID.one, "first ask"),
      assistantRecord("🔧 reading files"),
      assistantRecord("answer to the first"),
      userRecord(GUID.two, "second ask"),
      assistantRecord("answer to the second"),
    ].join("\n");

    const attribution = attributeBurst({ injects, transcriptSource: transcript });

    expect(attribution.shape).toBe("serialized");
    expect(attribution.counts).toEqual({
      injected: 2,
      answered: 2,
      ambiguous: 0,
      unanswered: 0,
    });
    expect(attribution.bindings[0].answer).toBe("answer to the first");
    expect(attribution.bindings[1].answer).toBe("answer to the second");
    // The progress frame is counted, never mistaken for the answer.
    expect(attribution.bindings[0].progressReplies).toBe(1);
    expect(attribution.violations).toEqual([]);
  });

  it("keeps a turn open while only progress frames have arrived", () => {
    const transcript = [
      userRecord(GUID.one, "first ask"),
      assistantRecord("[ ] step one"),
      assistantRecord("(step 1 of 3)"),
    ].join("\n");

    const attribution = attributeBurst({
      injects: [injects[0]],
      transcriptSource: transcript,
    });

    expect(attribution.counts.answered).toBe(0);
    expect(attribution.counts.unanswered).toBe(1);
    expect(attribution.violations.map((violation) => violation.kind)).toEqual(["lost-reply"]);
  });

  it("binds the runtime replacement when terminal assistant siblings share one parent", () => {
    const transcript = [
      userRecord(GUID.one, "first ask"),
      terminalAssistantRecord("draft", "tool-result", "unverified completion claim"),
      terminalAssistantRecord("guarded", "tool-result", "honest runtime failure"),
    ].join("\n");

    const attribution = attributeBurst({
      injects: [injects[0]],
      transcriptSource: transcript,
    });

    expect(attribution.bindings[0].answer).toBe("honest runtime failure");
    expect(attribution.bindings[0].answerKey).toBe("honest runtime failure");
    expect(attribution.violations).toEqual([]);
  });
});

describe("burst attribution — negative control 1: a lost reply must fail", () => {
  it("reports lost-reply for an ingested inbound that never got an answer", () => {
    const transcript = [
      userRecord(GUID.one, "first ask"),
      assistantRecord("answer to the first"),
      userRecord(GUID.two, "second ask"),
    ].join("\n");

    const attribution = attributeBurst({ injects, transcriptSource: transcript });
    const verdict = burstVerdict({
      attribution,
      overlap: { overlapped: true, maxConcurrent: 2, traces: [] },
    });

    expect(attribution.counts.unanswered).toBe(1);
    expect(verdict.verdict).toBe("fail");
    expect(verdict.hard.map((violation) => violation.kind)).toContain("lost-reply");
  });

  it("distinguishes an inbound that never reached the transcript from one that got no reply", () => {
    const transcript = [
      userRecord(GUID.one, "first ask"),
      assistantRecord("answer to the first"),
    ].join("\n");

    const attribution = attributeBurst({ injects, transcriptSource: transcript });

    expect(attribution.violations.map((violation) => violation.kind)).toEqual([
      "inbound-never-ingested",
    ]);
  });
});

describe("burst attribution — negative control 2: interleaving must never bind", () => {
  it("returns ambiguous instead of binding a reply that could belong to either inbound", () => {
    const transcript = [
      userRecord(GUID.one, "first ask"),
      userRecord(GUID.two, "second ask"),
      assistantRecord("one answer, whose inbound is unknowable from the transcript"),
    ].join("\n");

    const attribution = attributeBurst({ injects, transcriptSource: transcript });

    expect(attribution.shape).toBe("interleaved");
    expect(attribution.counts.ambiguous).toBe(2);
    expect(attribution.counts.answered).toBe(0);
    expect(attribution.bindings[0].answer).toBeNull();
    expect(attribution.bindings[0].ambiguousWith).toEqual([0, 1]);
    expect(attribution.ambiguousAnswers).toHaveLength(1);
    expect(attribution.ambiguousAnswers[0].candidates).toEqual([0, 1]);
  });

  it("never reports ok while any inbound is ambiguous, even with zero hard violations", () => {
    const transcript = [
      userRecord(GUID.one, "first ask"),
      userRecord(GUID.two, "second ask"),
      assistantRecord("first of two answers"),
      assistantRecord("second of two answers"),
    ].join("\n");

    const attribution = attributeBurst({ injects, transcriptSource: transcript });
    const verdict = burstVerdict({
      attribution,
      overlap: { overlapped: true, maxConcurrent: 2, traces: [] },
    });

    // Both answers arrived, so nothing is lost — but neither can be attributed.
    expect(attribution.counts.unanswered).toBe(0);
    expect(verdict.hard).toEqual([]);
    expect(verdict.verdict).toBe("ambiguous");
  });

  it("marks a mixed run as mixed rather than claiming either shape", () => {
    const transcript = [
      userRecord(GUID.one, "first ask"),
      assistantRecord("answer to the first"),
      userRecord(GUID.two, "second ask"),
      userRecord(GUID.three, "third ask"),
      assistantRecord("an answer for one of the last two"),
    ].join("\n");

    const attribution = attributeBurst({
      injects: [...injects, { index: 2, inboundGuid: GUID.three }],
      transcriptSource: transcript,
    });

    expect(attribution.shape).toBe("mixed");
    expect(attribution.counts.answered).toBe(1);
    expect(attribution.counts.ambiguous).toBe(2);
  });
});

describe("burst attribution — harness self-protection", () => {
  it("fails loudly when the transcript contains none of the injected inbounds", () => {
    const attribution = attributeBurst({
      injects,
      transcriptSource: [
        userRecord("99999999-9999-5999-8999-999999999999", "someone else"),
        assistantRecord("not ours"),
      ].join("\n"),
    });

    expect(attribution.shape).toBe("empty");
    expect(attribution.violations.map((violation) => violation.kind)).toContain(
      "no-inbound-records",
    );
    expect(burstVerdict({ attribution }).verdict).toBe("fail");
  });

  it("flags coalesced injects rather than attributing them separately", () => {
    const transcript = [
      JSON.stringify({
        type: "message",
        message: { role: "user", content: `[inbound ${GUID.one}] [inbound ${GUID.two}] merged` },
      }),
      assistantRecord("one answer for the merged pair"),
    ].join("\n");

    const attribution = attributeBurst({ injects, transcriptSource: transcript });

    expect(attribution.violations.map((violation) => violation.kind)).toContain(
      "multi-inbound-user-record",
    );
  });

  it("ignores the conversation that happened BEFORE the burst", () => {
    // A continuing relationship's transcript carries hundreds of prior turns. Walking them all
    // reported every historical reply as `unattributed-reply` — a live 2-message control burst
    // produced 25 of them, drowning the real verdict.
    const priorHistory = [
      userRecord("00000000-0000-5000-8000-000000000000", "an earlier ask"),
      assistantRecord("an earlier answer"),
      assistantRecord("a trailing earlier delivery"),
    ];
    const transcript = [
      ...priorHistory,
      userRecord(GUID.one, "first ask"),
      assistantRecord("answer to the first"),
    ].join("\n");

    const attribution = attributeBurst({
      injects: [injects[0]],
      transcriptSource: transcript,
    });

    expect(attribution.counts.answered).toBe(1);
    expect(attribution.violations).toEqual([]);
  });

  it("records a reply with no outstanding inbound as unattributed, not as an answer", () => {
    // Inside the burst window a reply with nothing outstanding is a background or proactive
    // delivery — legal, but the operator must see it. (Before the burst it is prior history and
    // is skipped; see the pre-burst test above.)
    const transcript = [
      userRecord(GUID.one, "first ask"),
      assistantRecord("answer to the first"),
      assistantRecord("a background delivery after the turn closed"),
    ].join("\n");

    const attribution = attributeBurst({
      injects: [injects[0]],
      transcriptSource: transcript,
    });

    expect(attribution.counts.answered).toBe(1);
    expect(attribution.violations.map((violation) => violation.kind)).toEqual([
      "unattributed-reply",
    ]);
    // Soft: a proactive or background delivery is legal; the operator judges it.
    expect(burstVerdict({
      attribution,
      overlap: { overlapped: true, maxConcurrent: 2, traces: [] },
    }).verdict).toBe("ok");
  });

  it("survives a mid-write truncated transcript tail", () => {
    const transcript = `${[
      userRecord(GUID.one, "first ask"),
      assistantRecord("answer to the first"),
    ].join("\n")}\n{"type":"mess`;

    expect(parseJsonlRecords(transcript)).toHaveLength(2);
    expect(attributeBurst({
      injects: [injects[0]],
      transcriptSource: transcript,
    }).counts.answered).toBe(1);
  });
});

describe("wire reconciliation — negative control 3: duplicate delivery must fail", () => {
  it("detects the same substantive reply delivered twice", () => {
    const wire = [
      { method: "sendMessage", messageId: 1, text: "🔧 working" },
      { method: "sendMessage", messageId: 2, text: "**The** answer" },
      { method: "sendMessage", messageId: 3, text: "The answer" },
    ];

    const reconciliation = wireReconciliation({ wire, bindings: [] });

    expect(reconciliation.substantiveOutbound).toBe(2);
    expect(reconciliation.progressOutbound).toBe(1);
    // Markup is normalized away, so a re-send that only differs in formatting is still a duplicate.
    expect(reconciliation.violations.map((violation) => violation.kind)).toEqual([
      "duplicate-delivery",
    ]);
  });

  it("does not call two turns with identical answers a duplicate delivery", () => {
    // A live control burst asked "ping one" / "ping two" and got "pong" twice — two legitimate
    // deliveries for two turns. Counting identical text as a duplicate made that a HARD failure.
    const reconciliation = wireReconciliation({
      wire: [
        { method: "sendMessage", messageId: 1, text: "pong" },
        { method: "sendMessage", messageId: 2, text: "pong" },
      ],
      bindings: [
        { index: 0, status: "answered", answerKey: "pong" },
        { index: 1, status: "answered", answerKey: "pong" },
      ],
    });

    expect(reconciliation.substantiveOutbound).toBe(2);
    expect(reconciliation.violations).toEqual([]);
  });

  it("still catches one turn's answer delivered twice", () => {
    const reconciliation = wireReconciliation({
      wire: [
        { method: "sendMessage", messageId: 1, text: "pong" },
        { method: "sendMessage", messageId: 2, text: "pong" },
      ],
      bindings: [{ index: 0, status: "answered", answerKey: "pong" }],
    });

    expect(reconciliation.violations.map((violation) => violation.kind)).toEqual([
      "duplicate-delivery",
    ]);
  });

  it("compares against the FULL answer text, not a truncated preview", () => {
    const long = `${"a very long answer ".repeat(20)}tail`;
    const reconciliation = wireReconciliation({
      wire: [
        { method: "sendMessage", messageId: 1, text: long },
        { method: "sendMessage", messageId: 2, text: long },
      ],
      bindings: [
        { index: 0, status: "answered", answerKey: long.replace(/\s+/g, " ").trim() },
        { index: 1, status: "answered", answerKey: long.replace(/\s+/g, " ").trim() },
      ],
    });

    expect(reconciliation.violations).toEqual([]);
  });

  it("detects a transcript answer that never reached the wire", () => {
    const reconciliation = wireReconciliation({
      wire: [{ method: "sendMessage", messageId: 1, text: "only one delivery" }],
      bindings: [
        { index: 0, status: "answered" },
        { index: 1, status: "answered" },
      ],
    });

    expect(reconciliation.violations.map((violation) => violation.kind)).toEqual([
      "answer-not-delivered",
    ]);
  });

  it("separates an unrelated later delivery from the burst answer count", () => {
    const reconciliation = wireReconciliation({
      wire: [
        { method: "sendMessage", messageId: 1, text: "answer-a" },
        { method: "sendMessage", messageId: 2, text: "answer-b" },
        { method: "sendMessage", messageId: 3, text: "a later scheduled reminder" },
      ],
      bindings: [
        { index: 0, status: "answered", answerKey: "answer-a" },
        { index: 1, status: "answered", answerKey: "answer-b" },
      ],
    });

    expect(reconciliation.substantiveOutbound).toBe(2);
    expect(reconciliation.rawSubstantiveOutbound).toBe(3);
    expect(reconciliation.unattributedOutbound).toBe(1);
    expect(reconciliation.violations).toEqual([]);
  });

  it("counts an attachment caption as a substantive delivery", () => {
    const reconciliation = wireReconciliation({
      wire: [{ method: "sendDocument", messageId: 1, caption: "the report is attached" }],
      bindings: [],
    });

    expect(reconciliation.substantiveOutbound).toBe(1);
    expect(reconciliation.violations).toEqual([]);
  });
});

describe("overlap proof — negative control 4: a serialized run must not read as concurrent", () => {
  it("reports no overlap for turns whose windows do not intersect", () => {
    const overlap = overlapReport([
      trajectoryRecord("trace-a", "2026-08-06T10:00:00.000Z"),
      trajectoryRecord("trace-a", "2026-08-06T10:00:10.000Z"),
      trajectoryRecord("trace-b", "2026-08-06T10:00:20.000Z"),
      trajectoryRecord("trace-b", "2026-08-06T10:00:30.000Z"),
    ]);

    expect(overlap.traces).toHaveLength(2);
    expect(overlap.overlapped).toBe(false);
    expect(overlap.maxConcurrent).toBe(1);
  });

  it("fails a concurrency row whose turns were silently serialized", () => {
    const transcript = [
      userRecord(GUID.one, "first ask"),
      assistantRecord("answer to the first"),
      userRecord(GUID.two, "second ask"),
      assistantRecord("answer to the second"),
    ].join("\n");
    const attribution = attributeBurst({ injects, transcriptSource: transcript });

    const verdict = burstVerdict({
      attribution,
      overlap: overlapReport([
        trajectoryRecord("trace-a", "2026-08-06T10:00:00.000Z"),
        trajectoryRecord("trace-a", "2026-08-06T10:00:10.000Z"),
        trajectoryRecord("trace-b", "2026-08-06T10:00:20.000Z"),
        trajectoryRecord("trace-b", "2026-08-06T10:00:30.000Z"),
      ]),
    });

    // Every reply landed and every reply was attributable — and it STILL fails,
    // because nothing ran concurrently. This is the false pass the module exists to stop.
    expect(attribution.counts.answered).toBe(2);
    expect(verdict.verdict).toBe("fail");
    expect(verdict.hard.map((violation) => violation.kind)).toEqual(["no-overlap-observed"]);
  });

  it("proves overlap and peak concurrency for intersecting windows", () => {
    const overlap = overlapReport([
      trajectoryRecord("trace-a", "2026-08-06T10:00:00.000Z"),
      trajectoryRecord("trace-b", "2026-08-06T10:00:05.000Z"),
      trajectoryRecord("trace-c", "2026-08-06T10:00:06.000Z"),
      trajectoryRecord("trace-a", "2026-08-06T10:00:10.000Z"),
      trajectoryRecord("trace-b", "2026-08-06T10:00:12.000Z"),
      trajectoryRecord("trace-c", "2026-08-06T10:00:20.000Z"),
    ]);

    expect(overlap.overlapped).toBe(true);
    expect(overlap.maxConcurrent).toBe(3);
    expect(overlap.overlappingPairs).toHaveLength(3);
    expect(overlap.traces.every((trace) => trace.modelCalls === 2)).toBe(true);
  });

  it("does not let a steering row demand overlap it should not have", () => {
    const attribution = attributeBurst({
      injects: [injects[0]],
      transcriptSource: [
        userRecord(GUID.one, "first ask"),
        assistantRecord("the answer"),
      ].join("\n"),
    });

    expect(burstVerdict({
      attribution,
      overlap: overlapReport([trajectoryRecord("trace-a", "2026-08-06T10:00:00.000Z")]),
      expectOverlap: false,
    }).verdict).toBe("ok");
  });

  it("excludes earlier turns so their traces cannot inflate peak concurrency", () => {
    const records = [
      // Two turns from BEFORE the burst — sequential, but they overlap each other
      // in no way that concerns this row.
      trajectoryRecord("trace-old-a", "2026-08-06T09:00:00.000Z"),
      trajectoryRecord("trace-old-b", "2026-08-06T09:30:00.000Z"),
      trajectoryRecord("trace-a", "2026-08-06T10:00:00.000Z"),
      trajectoryRecord("trace-a", "2026-08-06T10:00:10.000Z"),
    ];
    const windowed = filterRecordsWindow(records, {
      fromMs: Date.parse("2026-08-06T09:59:00.000Z"),
    });

    expect(windowed).toHaveLength(2);
    // Unwindowed, the two pre-burst traces are counted alongside this burst's one.
    expect(overlapReport(records).traces).toHaveLength(3);
    expect(overlapReport(windowed).traces).toHaveLength(1);
    expect(overlapReport(windowed).maxConcurrent).toBe(1);
  });

  it("ignores records with no usable timestamp instead of collapsing a window", () => {
    expect(recordTimeMs({ ts: 1_756_000_000_000 })).toBe(1_756_000_000_000);
    expect(recordTimeMs({ ts: "2026-08-06T10:00:00.000Z" })).toBe(
      Date.parse("2026-08-06T10:00:00.000Z"),
    );
    expect(recordTimeMs({ ts: "not-a-date" })).toBeNull();
    expect(recordTimeMs({})).toBeNull();
    expect(overlapReport([{ type: "model.completed", traceId: "t", ts: "nope" }]).traces).toEqual(
      [],
    );
  });
});
