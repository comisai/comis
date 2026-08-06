// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  scoreSdkSteeringBurst,
  selectSdkSteeringTrajectoryRecords,
} from "./steering-oracle.mjs";

const BASE_GUID = "11111111-1111-5111-8111-111111111111";
const FOLLOW_GUID = "22222222-2222-5222-8222-222222222222";
const injects = [
  { index: 0, inboundGuid: BASE_GUID, sentAtMs: 1_000 },
  { index: 1, inboundGuid: FOLLOW_GUID, sentAtMs: 13_000 },
];

const record = (type: string, traceId: string, atMs: number): Record<string, unknown> => ({
  type,
  traceId,
  ts: new Date(atMs).toISOString(),
});

const userRecord = (guid: string, text: string): string => JSON.stringify({
  type: "message",
  message: { role: "user", content: `[inbound ${guid}]\n${text}` },
});

const assistantRecord = (text: string): string => JSON.stringify({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const burstVerifySource = readFileSync(
  new URL("./burst-verify.mjs", import.meta.url),
  "utf8",
);

describe("SDK steering burst ground-truth oracle", () => {
  it("routes the steering CLI flag through the dedicated selector and scorer", () => {
    expect(burstVerifySource).toContain("token === '--sdk-steering'");
    expect(burstVerifySource).toContain("selectSdkSteeringTrajectoryRecords(");
    expect(burstVerifySource).toContain("scoreSdkSteeringBurst({");
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
    expect(scored.verdict.hard).toEqual([]);
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
