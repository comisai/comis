// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  scoreCommandSteeringBurst,
  scoreSdkSteeringBurst,
  selectSdkSteeringTrajectoryRecords,
} from "./steering-oracle.mjs";

const BASE_GUID = "11111111-1111-5111-8111-111111111111";
const FOLLOW_GUID = "22222222-2222-5222-8222-222222222222";
const injects = [
  { index: 0, inboundGuid: BASE_GUID, sentAtMs: 1_000 },
  { index: 1, inboundGuid: FOLLOW_GUID, sentAtMs: 13_000 },
];

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

const userRecord = (guid: string, text: string): string => JSON.stringify({
  type: "message",
  message: { role: "user", content: `[inbound ${guid}]\n${text}` },
});

const assistantRecord = (text: string): string => JSON.stringify({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const assistantToolRecord = (
  atMs: number,
  name: string,
  args: Record<string, unknown>,
): string => JSON.stringify({
  type: "message",
  timestamp: new Date(atMs).toISOString(),
  message: {
    role: "assistant",
    content: [{ type: "toolCall", name, arguments: args }],
  },
});

const burstVerifySource = readFileSync(
  new URL("./burst-verify.mjs", import.meta.url),
  "utf8",
);

describe("SDK steering burst ground-truth oracle", () => {
  it("routes the steering CLI flag through the dedicated selector and scorer", () => {
    expect(burstVerifySource).toContain("token === '--sdk-steering'");
    expect(burstVerifySource).toContain("token === '--command-steering'");
    expect(burstVerifySource).toContain("selectSdkSteeringTrajectoryRecords(");
    expect(burstVerifySource).toContain("scoreSdkSteeringBurst({");
    expect(burstVerifySource).toContain("scoreCommandSteeringBurst({");
  });

  it("routes superseded-goal terms into both steering scorers", () => {
    expect(burstVerifySource).toContain("flags.get('superseded-goal-terms')");
    expect(burstVerifySource.match(/supersededGoalTerms,/g)).toHaveLength(2);
  });

  it("accepts a steered inbound that intentionally has no separate transcript turn", () => {
    const transcriptSource = [
      userRecord(BASE_GUID, "write a long report"),
      assistantRecord("- checkpoint\n- eta\n- box count"),
    ].join("\n");
    const trajectoryRecords = [
      record("queue.enqueued", "base-trace", 1_010),
      record("queue.dequeued", "base-trace", 1_020),
      record("queue.steer_injected", "follow-trace", 13_010),
      record("session.summary", "base-trace", 18_000),
      record("delivery.dispatched", "base-trace", 18_100),
    ];

    const scored = scoreSdkSteeringBurst({
      injects,
      transcriptSource,
      trajectoryRecords,
      wire: [{ method: "sendMessage", text: "- checkpoint\n- eta\n- box count" }],
    });

    expect(scored.verdict.verdict).toBe("ok");
    expect(scored.verdict.counts).toEqual({
      injected: 2,
      answered: 2,
      ambiguous: 0,
      unanswered: 0,
    });
    expect(scored.steering.disposition).toBe("steer_injected");
    expect(scored.attribution.bindings[1].status).toBe("steered");
    expect(scored.wire.rawSubstantiveOutbound).toBe(1);
    expect(scored.verdict.overlap).toEqual({
      overlapped: false,
      maxConcurrent: 1,
      traces: 1,
    });
    expect(scored.verdict.hard).toEqual([]);
  });

  it("binds the post-steer terminal response selected for channel delivery", () => {
    const transcriptSource = [
      userRecord(BASE_GUID, "write a long report"),
      assistantRecord("the undelivered pre-steer draft"),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "make it three bullets" },
      }),
      assistantRecord("the delivered post-steer response"),
    ].join("\n");
    const trajectoryRecords = [
      record("queue.enqueued", "base-trace", 1_010),
      record("queue.steer_injected", "follow-trace", 13_010),
      record("session.summary", "base-trace", 18_000),
      record("delivery.dispatched", "base-trace", 18_100),
    ];

    const scored = scoreSdkSteeringBurst({
      injects,
      transcriptSource,
      trajectoryRecords,
      wire: [{ method: "sendMessage", text: "the delivered post-steer response" }],
    });

    expect(scored.verdict.verdict).toBe("ok");
    expect(scored.attribution.bindings[0].answer).toBe(
      "the delivered post-steer response",
    );
    expect(scored.verdict.hard).toEqual([]);
    expect(scored.verdict.soft).toEqual([]);
  });

  it("fails when an accepted follow-up has no steering disposition event", () => {
    const scored = scoreSdkSteeringBurst({
      injects,
      transcriptSource: [
        userRecord(BASE_GUID, "write a long report"),
        assistantRecord("the original answer"),
      ].join("\n"),
      trajectoryRecords: [
        record("queue.enqueued", "base-trace", 1_010),
        record("session.summary", "base-trace", 18_000),
      ],
      wire: [{ method: "sendMessage", text: "the original answer" }],
    });

    expect(scored.verdict.verdict).toBe("fail");
    expect(scored.verdict.hard.map((violation) => violation.kind)).toContain(
      "missing-steering-disposition",
    );
  });

  it("fails when an injected steer produces a second substantive delivery", () => {
    const scored = scoreSdkSteeringBurst({
      injects,
      transcriptSource: [
        userRecord(BASE_GUID, "write a long report"),
        assistantRecord("the combined answer"),
      ].join("\n"),
      trajectoryRecords: [
        record("queue.enqueued", "base-trace", 1_010),
        record("queue.steer_injected", "follow-trace", 13_010),
        record("session.summary", "base-trace", 18_000),
        record("delivery.dispatched", "base-trace", 18_100),
        record("delivery.dispatched", "base-trace", 18_200),
      ],
      wire: [
        { method: "sendMessage", text: "the combined answer" },
        { method: "sendMessage", text: "a late answer to the old goal" },
      ],
    });

    expect(scored.verdict.verdict).toBe("fail");
    expect(scored.verdict.hard.map((violation) => violation.kind)).toContain(
      "unexpected-steering-delivery",
    );
  });

  it("ignores an unrelated future wire send after one scoped steer delivery", () => {
    const scored = scoreSdkSteeringBurst({
      injects,
      transcriptSource: [
        userRecord(BASE_GUID, "write a long report"),
        assistantRecord("the combined answer"),
      ].join("\n"),
      trajectoryRecords: [
        record("queue.enqueued", "base-trace", 1_010),
        record("queue.steer_injected", "follow-trace", 13_010),
        record("session.summary", "base-trace", 18_000),
        record("delivery.dispatched", "base-trace", 18_100),
      ],
      wire: [
        { method: "sendMessage", text: "the combined answer" },
        { method: "sendMessage", text: "a future turn answer" },
      ],
    });

    expect(scored.verdict.verdict).toBe("ok");
    expect(scored.wire.unattributedOutbound).toBe(1);
  });

  it("fails when an injected steer has no scoped delivery dispatch", () => {
    const scored = scoreSdkSteeringBurst({
      injects,
      transcriptSource: [
        userRecord(BASE_GUID, "write a long report"),
        assistantRecord("the combined answer"),
      ].join("\n"),
      trajectoryRecords: [
        record("queue.enqueued", "base-trace", 1_010),
        record("queue.steer_injected", "follow-trace", 13_010),
        record("session.summary", "base-trace", 18_000),
      ],
      wire: [{ method: "sendMessage", text: "the combined answer" }],
    });

    expect(scored.verdict.verdict).toBe("fail");
    expect(scored.verdict.hard.map((violation) => violation.kind)).toContain(
      "unexpected-steering-delivery",
    );
  });

  it("fails when a post-boundary tool call advances the superseded goal", () => {
    const scored = scoreSdkSteeringBurst({
      injects,
      supersededGoalTerms: ["paint", "material", "red"],
      transcriptSource: [
        userRecord(BASE_GUID, "plan the repainting work"),
        assistantToolRecord(13_500, "exec", {
          command: "calculate red paint materials for 12 boxes",
        }),
        assistantRecord("12 + 7 = 19"),
      ].join("\n"),
      trajectoryRecords: [
        record("queue.enqueued", "base-trace", 1_010),
        record("queue.steer_injected", "follow-trace", 13_010),
        record("session.summary", "base-trace", 18_000),
        record("delivery.dispatched", "base-trace", 18_100),
      ],
      wire: [{ method: "sendMessage", text: "12 + 7 = 19" }],
    });

    expect(scored.verdict.verdict).toBe("fail");
    expect(scored.steering.supersededGoalToolCalls).toEqual([
      { atMs: 13_500, toolName: "exec", matchedTerms: ["paint", "material", "red"] },
    ]);
    expect(scored.verdict.hard.map((violation) => violation.kind)).toContain(
      "superseded-goal-tool-call",
    );
  });

  it("allows superseded-goal tool work that completed before the boundary", () => {
    const scored = scoreSdkSteeringBurst({
      injects,
      supersededGoalTerms: ["paint", "material", "red"],
      transcriptSource: [
        userRecord(BASE_GUID, "plan the repainting work"),
        assistantToolRecord(12_500, "exec", {
          command: "calculate red paint materials for 12 boxes",
        }),
        assistantRecord("12 + 7 = 19"),
      ].join("\n"),
      trajectoryRecords: [
        record("queue.enqueued", "base-trace", 1_010),
        record("queue.steer_injected", "follow-trace", 13_010),
        record("session.summary", "base-trace", 18_000),
        record("delivery.dispatched", "base-trace", 18_100),
      ],
      wire: [{ method: "sendMessage", text: "12 + 7 = 19" }],
    });

    expect(scored.verdict.verdict).toBe("ok");
    expect(scored.steering.supersededGoalToolCalls).toEqual([]);
  });

  it("selects the base and follow-up traces without admitting a later steer", () => {
    const selected = selectSdkSteeringTrajectoryRecords([
      record("queue.enqueued", "base-trace", 1_010),
      record("queue.steer_injected", "follow-trace", 13_010),
      record("session.summary", "base-trace", 18_000),
      record("queue.enqueued", "future-base", 30_000),
      record("queue.steer_injected", "future-follow", 42_000),
    ], {
      fromMs: 1_000,
      followSentAtMs: 13_000,
    });

    expect([...new Set(selected.map((entry) => entry.traceId))]).toEqual([
      "base-trace",
      "follow-trace",
    ]);
  });

  it("selects a direct SDK base trace when no command-queue enqueue exists", () => {
    const selected = selectSdkSteeringTrajectoryRecords([
      record("prompt.submitted", "base-trace", 1_010),
      record("queue.steer_injected", "follow-trace", 13_010),
      record("session.summary", "base-trace", 18_000),
      record("delivery.dispatched", "base-trace", 18_100),
    ], {
      fromMs: 1_000,
      followSentAtMs: 13_000,
    });

    expect([...new Set(selected.map((entry) => entry.traceId))]).toEqual([
      "base-trace",
      "follow-trace",
    ]);
  });

  it("scores an SDK follow-up queue through its two normal transcript replies", () => {
    const transcriptSource = [
      userRecord(BASE_GUID, "write a long report"),
      assistantRecord("the original answer"),
      userRecord(FOLLOW_GUID, "make it short"),
      assistantRecord("the concise answer"),
    ].join("\n");
    const trajectoryRecords = [
      record("queue.enqueued", "base-trace", 1_010),
      record("queue.steer_rejected", "follow-trace", 13_005),
      record("queue.followup_queued", "follow-trace", 13_010),
      record("session.summary", "base-trace", 18_000),
    ];

    const scored = scoreSdkSteeringBurst({
      injects,
      transcriptSource,
      trajectoryRecords,
      wire: [
        { method: "sendMessage", text: "the original answer" },
        { method: "sendMessage", text: "the concise answer" },
      ],
    });

    expect(scored.verdict.verdict).toBe("ok");
    expect(scored.steering.disposition).toBe("followup_queued");
    expect(scored.attribution.bindings.map((binding) => binding.status)).toEqual([
      "answered",
      "answered",
    ]);
  });
});

describe("command-queue steering ground-truth oracle", () => {
  const commandSteerRecords = [
    record("prompt.submitted", "base-trace", 1_010),
    record("queue.enqueued", "follow-trace", 13_010, { mode: "steer" }),
    record("model.completed", "base-trace", 13_020, { stopReason: "aborted" }),
    record("session.summary", "base-trace", 13_030),
    record("activity.turn_finalized", "base-trace", 13_040, { outcome: "aborted" }),
    record("queue.coalesced", "follow-trace", 13_050, { messageCount: 1 }),
    record("queue.dequeued", "follow-trace", 13_060),
    record("model.completed", "follow-trace", 17_000, { stopReason: "stop" }),
    record("session.summary", "follow-trace", 17_010),
    record("delivery.dispatched", "follow-trace", 17_020),
  ];

  it("accounts for the aborted draft and binds only the replacement delivery", () => {
    const scored = scoreCommandSteeringBurst({
      injects,
      transcriptSource: [
        userRecord(BASE_GUID, "write a long report"),
        assistantRecord("an internal draft from the aborted turn"),
        userRecord(FOLLOW_GUID, "make it three bullets"),
        assistantRecord("the delivered replacement"),
      ].join("\n"),
      trajectoryRecords: commandSteerRecords,
      wire: [{ method: "sendMessage", text: "the delivered replacement" }],
    });

    expect(scored.verdict.verdict).toBe("ok");
    expect(scored.attribution.bindings.map((binding) => binding.status)).toEqual([
      "aborted",
      "answered",
    ]);
    expect(scored.attribution.bindings[1].answer).toBe("the delivered replacement");
    expect(scored.steering).toMatchObject({
      disposition: "abort_and_restart",
      baseTraceId: "base-trace",
      replacementTraceId: "follow-trace",
    });
    expect(scored.verdict.hard).toEqual([]);
  });

  it("fails when steer mode does not prove the original execution aborted", () => {
    const scored = scoreCommandSteeringBurst({
      injects,
      transcriptSource: [
        userRecord(BASE_GUID, "write a long report"),
        userRecord(FOLLOW_GUID, "make it three bullets"),
        assistantRecord("the delivered replacement"),
      ].join("\n"),
      trajectoryRecords: commandSteerRecords.filter(
        (entry) => entry.type !== "model.completed" || entry.traceId !== "base-trace",
      ).filter(
        (entry) => entry.type !== "activity.turn_finalized" || entry.traceId !== "base-trace",
      ),
      wire: [{ method: "sendMessage", text: "the delivered replacement" }],
    });

    expect(scored.verdict.verdict).toBe("fail");
    expect(scored.verdict.hard.map((violation) => violation.kind)).toContain(
      "missing-command-steer-abort",
    );
  });

  it("fails when the replacement trace dispatch count is not exactly one", () => {
    const scored = scoreCommandSteeringBurst({
      injects,
      transcriptSource: [
        userRecord(BASE_GUID, "write a long report"),
        userRecord(FOLLOW_GUID, "make it three bullets"),
        assistantRecord("the delivered replacement"),
      ].join("\n"),
      trajectoryRecords: commandSteerRecords.filter(
        (entry) => entry.type !== "delivery.dispatched",
      ),
      wire: [{ method: "sendMessage", text: "the delivered replacement" }],
    });

    expect(scored.verdict.verdict).toBe("fail");
    expect(scored.verdict.hard.map((violation) => violation.kind)).toContain(
      "unexpected-command-steer-delivery",
    );
  });

  it("reports a completed base before the boundary as not in flight", () => {
    const scored = scoreCommandSteeringBurst({
      injects,
      transcriptSource: [
        userRecord(BASE_GUID, "write a long report"),
        assistantRecord("the completed original answer"),
        userRecord(FOLLOW_GUID, "answer the replacement instead"),
        assistantRecord("the replacement answer"),
      ].join("\n"),
      trajectoryRecords: [
        record("prompt.submitted", "base-trace", 1_010),
        record("model.completed", "base-trace", 9_000, { stopReason: "stop" }),
        record("session.summary", "base-trace", 9_010),
        record("delivery.dispatched", "base-trace", 9_020),
        record("activity.turn_finalized", "base-trace", 9_030, { outcome: "success" }),
        record("queue.enqueued", "follow-trace", 13_010, { mode: "steer" }),
        record("queue.dequeued", "follow-trace", 13_020),
        record("prompt.submitted", "follow-trace", 13_030),
        record("model.completed", "follow-trace", 17_000, { stopReason: "stop" }),
        record("session.summary", "follow-trace", 17_010),
        record("delivery.dispatched", "follow-trace", 17_020),
      ],
      wire: [
        { method: "sendMessage", text: "the completed original answer" },
        { method: "sendMessage", text: "the replacement answer" },
      ],
    });

    expect(scored.steering.disposition).toBe("not_in_flight");
    expect(scored.attribution.bindings.map((binding) => binding.status)).toEqual([
      "answered",
      "answered",
    ]);
    expect(scored.verdict.hard.map((violation) => violation.kind)).toEqual([
      "command-steer-not-in-flight",
    ]);
    expect(scored.wire.substantiveOutbound).toBe(2);
  });
});
