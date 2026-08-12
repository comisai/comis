// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scoreCollectBurst } from "./collect-oracle.mjs";

const injects = Array.from({ length: 10 }, (_, index) => ({
  index,
  inboundGuid: `${String(index + 1).padStart(8, "0")}-1111-5111-8111-111111111111`,
}));

const record = (
  type: string,
  traceId: string,
  atMs: number,
  data?: Record<string, unknown>,
): Record<string, unknown> => ({
  type,
  traceId,
  ts: new Date(atMs).toISOString(),
  ...(data === undefined ? {} : { data }),
});

const provenanceRecord = (messages: Array<{ id: string; text: string }>): string =>
  JSON.stringify({
    type: "custom",
    customType: "comis.inbound-message-provenance",
    data: { schemaVersion: 1, batchId: messages.at(-1)?.id, messages },
  });

const expectedAnswerTerms = Array.from(
  { length: 10 },
  (_, index) => `n${index + 1}=${(index + 1) ** 2}`,
);

const collectTrajectory = (): Array<Record<string, unknown>> => [
  ...injects.map((_, index) => record(
    "queue.enqueued",
    `trace-${index + 1}`,
    1_000 + index,
    { mode: "collect", queueDepth: index + 1 },
  )),
  record("session.summary", "trace-1", 2_000),
  record("queue.coalesced", "trace-10", 2_010, { messageCount: 9 }),
  record("session.summary", "trace-10", 3_000),
];

const collectTranscript = (): string => [
  provenanceRecord([{ id: injects[0]!.inboundGuid, text: "burst 1 reply n1=1" }]),
  provenanceRecord(injects.slice(1).map((inject, index) => ({
    id: inject.inboundGuid,
    text: `burst ${index + 2} reply ${expectedAnswerTerms[index + 1]}`,
  }))),
].join("\n");

const collectWire = (): Array<Record<string, unknown>> => [
  { method: "sendMessage", text: "n1=1" },
  { method: "sendMessage", text: expectedAnswerTerms.slice(1).join("\n") },
];

describe("collect burst ground-truth oracle", () => {
  it("accepts one direct turn plus one visible nine-message coalesced turn", () => {
    const scored = scoreCollectBurst({
      injects,
      transcriptSource: collectTranscript(),
      trajectoryRecords: collectTrajectory(),
      wire: collectWire(),
      expectedAnswerTerms,
    });

    expect(scored.verdict.verdict).toBe("ok");
    expect(scored.verdict.counts).toEqual({
      injected: 10,
      answered: 10,
      ambiguous: 0,
      unanswered: 0,
    });
    expect(scored.collect).toEqual({
      enqueued: 10,
      executedTurns: 2,
      coalescedEvents: 1,
      coalescedMessages: 9,
      provenanceAccounted: 10,
    });
    expect(scored.wire.rawSubstantiveOutbound).toBe(2);
    expect(scored.wire.unattributedOutbound).toBe(0);
    expect(scored.openTraceIds).toEqual([]);
  });

  it("accepts durable provenance when pre-session enqueue events are not recordable", () => {
    const trajectory = collectTrajectory()
      .filter((entry) => entry.type !== "queue.enqueued")
      .concat([
        record("prompt.submitted", "trace-1", 1_100),
        record("prompt.submitted", "trace-10", 2_100),
      ]);
    const scored = scoreCollectBurst({
      injects,
      transcriptSource: collectTranscript(),
      trajectoryRecords: trajectory,
      wire: collectWire(),
      expectedAnswerTerms,
    });

    expect(scored.verdict.verdict).toBe("ok");
    expect(scored.collect.enqueued).toBe(0);
    expect(scored.collect.provenanceAccounted).toBe(10);
    expect(scored.collect.coalescedMessages).toBe(9);
    expect(scored.collect.executedTurns).toBe(2);
  });

  it("accepts one recorded enqueue for the queued half of a two-message collect", () => {
    const pair = injects.slice(0, 2);
    const terms = expectedAnswerTerms.slice(0, 2);
    const trajectory = [
      record("session.summary", "trace-1", 2_000),
      record("queue.enqueued", "trace-2", 2_005, { mode: "collect", queueDepth: 1 }),
      record("queue.coalesced", "trace-2", 2_010, { messageCount: 1 }),
      record("session.summary", "trace-2", 3_000),
    ];
    const transcript = [
      provenanceRecord([{ id: pair[0]!.inboundGuid, text: "first" }]),
      provenanceRecord([{ id: pair[1]!.inboundGuid, text: "second" }]),
    ].join("\n");
    const scored = scoreCollectBurst({
      injects: pair,
      transcriptSource: transcript,
      trajectoryRecords: trajectory,
      wire: [
        { method: "sendMessage", text: terms[0] },
        { method: "sendMessage", text: terms[1] },
      ],
      expectedAnswerTerms: terms,
    });

    expect(scored.verdict.verdict).toBe("ok");
    expect(scored.collect.enqueued).toBe(1);
    expect(scored.collect.coalescedMessages).toBe(1);
    expect(scored.collect.provenanceAccounted).toBe(2);
  });

  it("rejects a coalesced answer that silently omits one source request", () => {
    const wire = collectWire();
    wire[1] = {
      method: "sendMessage",
      text: expectedAnswerTerms.slice(1, -1).join("\n"),
    };
    const scored = scoreCollectBurst({
      injects,
      transcriptSource: collectTranscript(),
      trajectoryRecords: collectTrajectory(),
      wire,
      expectedAnswerTerms,
    });

    expect(scored.verdict.verdict).toBe("fail");
    expect(scored.verdict.counts.unanswered).toBe(1);
    expect(scored.verdict.hard.map((entry: { kind: string }) => entry.kind)).toContain(
      "missing-collect-answer",
    );
  });

  it("rejects ten accepted queue entries without the configured coalescing event", () => {
    const scored = scoreCollectBurst({
      injects,
      transcriptSource: collectTranscript(),
      trajectoryRecords: collectTrajectory().filter((entry) => entry.type !== "queue.coalesced"),
      wire: collectWire(),
      expectedAnswerTerms,
    });

    expect(scored.verdict.verdict).toBe("fail");
    expect(scored.verdict.hard.map((entry: { kind: string }) => entry.kind)).toContain(
      "missing-collect-coalescing",
    );
  });

  it("routes collect mode and explicit answer terms through the live verifier", () => {
    const source = readFileSync(new URL("./burst-verify.mjs", import.meta.url), "utf8");

    expect(source).toContain("token === '--collect-burst'");
    expect(source).toContain("flags.get('expected-answer-terms')");
    expect(source).toContain("scoreCollectBurst({");
  });
});
