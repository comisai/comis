// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  scoreResetBurst,
  selectResetBurstTrajectoryRecords,
} from "./reset-burst-oracle.mjs";

const injects = Array.from({ length: 10 }, (_, index) => ({
  index,
  inboundGuid: `${String(index + 1).padStart(8, "0")}-2222-5222-8222-222222222222`,
}));

const terms = [
  "violet bridge",
  "3 bullets",
  "c6-3=9",
  "c6-4=16",
  "c6-5=25",
  "VIOLET-BRIDGE-CHECKPOINT",
  "c6-7=49",
  "c6-8=64",
  "c6-9=81",
  "c6-10=100",
];

const provenance = (entries: typeof injects): string => JSON.stringify({
  type: "custom",
  customType: "comis.inbound-message-provenance",
  data: {
    messages: entries.map((entry) => ({ id: entry.inboundGuid, text: `request ${entry.index}` })),
  },
});

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

const trajectory = (): Array<Record<string, unknown>> => injects.flatMap((_, index) => [
  record("queue.enqueued", `trace-${index}`, 1_000 + index, { mode: "steer+followup" }),
  record("session.summary", `trace-${index}`, 2_000 + index, {
    costUsd: 0.01,
    totalTokens: 100,
  }),
]);

const wire = (): Array<Record<string, unknown>> => terms.map((term) => ({
  method: "sendMessage",
  text: term,
}));

describe("session-reset burst ground-truth oracle", () => {
  it("selects prompt bases and SDK steer dispositions as ten accepted owners", () => {
    const records = injects.flatMap((_, index) => index === 0 || index === 5
      ? [record("prompt.submitted", `trace-${index}`, 1_000 + index)]
      : [record("queue.steer_injected", `trace-${index}`, 1_000 + index)]);

    const selected = selectResetBurstTrajectoryRecords(records, {
      fromMs: 1_000,
      expectedTraceCount: 10,
    });

    expect([...new Set(selected.map((entry) => entry.traceId))]).toHaveLength(10);
  });

  it("accounts for steered physical messages through their accepted dispositions", () => {
    const records = injects.flatMap((_, index) => index === 0 || index === 5
      ? [
          record("prompt.submitted", `trace-${index}`, 1_000 + index),
          record("session.summary", `trace-${index}`, 2_000 + index),
        ]
      : [record("queue.steer_injected", `trace-${index}`, 1_000 + index)]);
    const scored = scoreResetBurst({
      injects,
      transcriptSources: [provenance([injects[0]!]), provenance([injects[5]!])],
      trajectoryRecords: records,
      wire: wire(),
      expectedAnswerTerms: terms,
      successfulResets: 2,
    });

    expect(scored.verdict.verdict).toBe("ok");
    expect(scored.reset.provenanceAccounted).toBe(2);
    expect(scored.reset.forwardedAccounted).toBe(8);
    expect(scored.reset.sourceMessagesAccounted).toBe(10);
  });

  it("accepts two reset segments with durable recall and terminal ownership", () => {
    const scored = scoreResetBurst({
      injects,
      transcriptSources: [provenance(injects.slice(0, 5)), provenance(injects.slice(5))],
      trajectoryRecords: trajectory(),
      wire: wire(),
      expectedAnswerTerms: terms,
      successfulResets: 2,
    });

    expect(scored.verdict.verdict).toBe("ok");
    expect(scored.verdict.counts).toEqual({
      injected: 10,
      answered: 10,
      ambiguous: 0,
      unanswered: 0,
    });
    expect(scored.reset).toEqual({
      successfulResets: 2,
      provenanceAccounted: 10,
      forwardedAccounted: 0,
      sourceMessagesAccounted: 10,
      ownedTraces: 10,
      terminalTraces: 10,
      costUsd: 0.1,
      totalTokens: 1000,
    });
    expect(scored.openTraceIds).toEqual([]);
  });

  it("rejects a reset burst whose durable preference answer disappeared", () => {
    const missingPreference = wire().filter((entry) => entry.text !== "3 bullets");
    const scored = scoreResetBurst({
      injects,
      transcriptSources: [provenance(injects.slice(0, 5)), provenance(injects.slice(5))],
      trajectoryRecords: trajectory(),
      wire: missingPreference,
      expectedAnswerTerms: terms,
      successfulResets: 2,
    });

    expect(scored.verdict.verdict).toBe("fail");
    expect(scored.verdict.hard.map((entry: { kind: string }) => entry.kind)).toContain(
      "missing-reset-burst-answer",
    );
  });

  it("rejects accepted work left unterminated across a session reset", () => {
    const openTrajectory = trajectory().filter(
      (entry) => !(entry.type === "session.summary" && entry.traceId === "trace-4"),
    );
    const scored = scoreResetBurst({
      injects,
      transcriptSources: [provenance(injects.slice(0, 5)), provenance(injects.slice(5))],
      trajectoryRecords: openTrajectory,
      wire: wire(),
      expectedAnswerTerms: terms,
      successfulResets: 2,
    });

    expect(scored.verdict.verdict).toBe("fail");
    expect(scored.openTraceIds).toEqual(["trace-4"]);
    expect(scored.verdict.hard.map((entry: { kind: string }) => entry.kind)).toContain(
      "reset-burst-trace-not-terminal",
    );
  });
});
