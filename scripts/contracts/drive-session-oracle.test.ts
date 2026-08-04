// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  directConversationFinished,
  driveTextFilePath,
  findAssistantReplyAfterInbound,
  findTelegramConversationWireAnswer,
  isDriveProgressText,
  reconcileDriveOutbound,
  selectMainTrajectoryPath,
  telegramInboundGuid,
  telegramInjectAddressingError,
  trajectoryTurnEnded,
  wireQuiescenceFinished,
  wireContainsAssistantReply,
} from "../../test/live/self-driving/scripts/drive-session-oracle.mjs";

const ownInboundId = "f8cd362e-d29e-5887-836b-df7b3ea26ffa";

function sessionRecord(value: unknown): string {
  return JSON.stringify(value);
}

describe("live driver session correlation", () => {
  it("treats deterministic approval acknowledgements as progress", () => {
    expect(isDriveProgressText("Approved: exec (Ab3Cd5Ef7Gh9)")).toBe(true);
    expect(isDriveProgressText("Denied: exec (Ab3Cd5Ef7Gh9)")).toBe(true);
  });

  it("recovers same-message edits from the final emulator snapshot", () => {
    const initial = [{ method: "sendMessage", messageId: 40, text: "old" }];
    const sent = { method: "sendMessage", messageId: 41, text: "running" };
    const edited = {
      method: "editMessageText",
      messageId: 41,
      text: "approval required",
      raw: { reply_markup: { inline_keyboard: [[{ text: "Approve" }]] } },
    };

    expect(reconcileDriveOutbound(initial, [sent], [...initial, sent, edited])).toEqual([
      sent,
      edited,
    ]);
  });

  it("does not use wire quiescence while an authoritative trajectory is available", () => {
    expect(wireQuiescenceFinished({
      trajectoryAvailable: true,
      sawAnswer: true,
      lastNewMs: 1_000,
      nowMs: 20_000,
      quiesceMs: 8_000,
    })).toBe(false);
    expect(wireQuiescenceFinished({
      trajectoryAvailable: false,
      sawAnswer: true,
      lastNewMs: 1_000,
      nowMs: 20_000,
      quiesceMs: 8_000,
    })).toBe(true);
  });

  it("waits for delayed direct-message delivery after the trajectory turn ends", () => {
    expect(directConversationFinished({
      sawAnswer: false,
      turnEnded: true,
      turnEndedAtMs: 10_000,
      nowMs: 39_999,
      deliveryGraceMs: 30_000,
    })).toBe(false);
    expect(directConversationFinished({
      sawAnswer: true,
      turnEnded: true,
      turnEndedAtMs: 10_000,
      nowMs: 10_001,
      deliveryGraceMs: 30_000,
    })).toBe(true);
    expect(directConversationFinished({
      sawAnswer: false,
      turnEnded: true,
      turnEndedAtMs: 10_000,
      nowMs: 40_000,
      deliveryGraceMs: 30_000,
    })).toBe(true);
  });

  it("derives the normalized Telegram identity returned by the channel mapper", () => {
    expect(telegramInboundGuid(12345, -1_001_234_567_890, 134)).toBe(ownInboundId);
  });

  it("ignores another concurrent reply before the requested inbound turn", () => {
    const source = [
      sessionRecord({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Answer for the other sender" }],
        },
      }),
      sessionRecord({
        type: "message",
        message: {
          role: "user",
          content: [{
            type: "text",
            text: `[System context]\n{"message_id":"${ownInboundId}"}\n\nPick a place nearby`,
          }],
        },
      }),
      sessionRecord({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "reasoning" }],
        },
      }),
      sessionRecord({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Nearby to which city?" }],
        },
      }),
    ].join("\n");

    expect(findAssistantReplyAfterInbound(source, ownInboundId)).toBe("Nearby to which city?");
  });

  it("does not accept an unrelated group wire reply as this drive's answer", () => {
    const outbound = [
      { method: "sendMessage", text: "Answer for the other sender" },
    ];

    expect(wireContainsAssistantReply(outbound, "Nearby to which city?")).toBe(false);
    expect(
      wireContainsAssistantReply(
        [...outbound, { method: "sendMessage", text: "Nearby to which city?" }],
        "Nearby to which city?",
      ),
    ).toBe(true);
  });

  it("correlates Markdown session text with Telegram rendered HTML", () => {
    expect(
      wireContainsAssistantReply(
        [{
          method: "sendMessage",
          text: "Got it—category: <b>groceries</b>. Please resend it.",
        }],
        "Got it—category: **groceries**. Please resend it.",
      ),
    ).toBe(true);
  });

  it("selects a corrected wire reply only from the injected forum topic", () => {
    const outbound = [
      {
        method: "sendMessage",
        messageThreadId: 13,
        text: "A reply from a parallel topic.",
      },
      {
        method: "sendMessage",
        messageThreadId: 14,
        text: "🔧 researching",
      },
      {
        method: "sendMessage",
        messageThreadId: 14,
        text: "I could not complete that delegation.",
      },
    ];

    expect(findTelegramConversationWireAnswer(outbound, 14))
      .toBe("I could not complete that delegation.");
    expect(findTelegramConversationWireAnswer(outbound, 13))
      .toBe("A reply from a parallel topic.");
    expect(findTelegramConversationWireAnswer(outbound, 15)).toBeNull();
  });

  it("rejects a synthetic mention entity when the bot handle is absent", () => {
    expect(
      telegramInjectAddressingError(
        "reply here again",
        { mention: true, thread: 7 },
        "test_bot",
      ),
    ).toContain("@test_bot");
    expect(
      telegramInjectAddressingError(
        "@test_bot reply here again",
        { mention: true, thread: 7 },
        "test_bot",
      ),
    ).toBeUndefined();
  });

  it("distinguishes a literal bot mention from an absolute message file", () => {
    expect(driveTextFilePath("@test_bot reply here again")).toBeUndefined();
    expect(driveTextFilePath("@/tmp/live-message.txt")).toBe("/tmp/live-message.txt");
  });

  it("selects the parent Telegram trajectory when a newer sub-agent shares its principal", () => {
    const sessionsRoot = "/tmp/comis/workspace/sessions";
    const principal = "platform_same-principal";
    const suffix = `${principal}~peer~${principal}.jsonl.trajectory.jsonl`;
    const parent = `${sessionsRoot}/default/telegram/${suffix}`;
    const child =
      `${sessionsRoot}/default/sub-agent@3aruntime@3achild-run/${suffix}`;

    expect(
      selectMainTrajectoryPath(
        [
          { path: parent, mtimeMs: 100 },
          { path: child, mtimeMs: 200 },
        ],
        sessionsRoot,
        "default",
        "telegram",
        suffix,
      ),
    ).toBe(parent);
  });
});

// ---------------------------------------------------------------------------
// trajectoryTurnEnded — a terminal record alone is not turn-end when the turn
// handed work off. Both hand-off paths were observed live on heavy questions and
// each one caused an interim "I'm running it now" promise to be reported as the
// substantive answer, 30-384s before the real answer existed.
// ---------------------------------------------------------------------------
describe("trajectoryTurnEnded", () => {
  const summary = '{"type":"session.summary","data":{"endReason":"success"}}';
  const bgPendingSummary =
    '{"type":"session.summary","finishReason":"background_pending","data":{}}';
  const aborted = '{"type":"execution.aborted","data":{}}';
  const spawned = '{"type":"subagent.spawned","data":{}}';
  const spawnCompleted = '{"type":"subagent.completed","data":{}}';
  const spawnKilled = '{"type":"subagent.killed","data":{}}';

  it("a clean summary with no hand-off ends the turn", () => {
    expect(trajectoryTurnEnded([summary])).toBe(true);
  });

  it("an execution.aborted ends the turn", () => {
    expect(trajectoryTurnEnded([aborted])).toBe(true);
  });

  it("no terminal record at all is not turn-end", () => {
    expect(trajectoryTurnEnded(['{"type":"model.completed","data":{}}'])).toBe(false);
  });

  it("a background_pending summary is NOT turn-end (the turn is done, the work is not)", () => {
    expect(trajectoryTurnEnded([bgPendingSummary])).toBe(false);
  });

  it("a background_pending summary followed by a clean one IS turn-end", () => {
    expect(trajectoryTurnEnded([bgPendingSummary, summary])).toBe(true);
  });

  it("a spawned sub-agent with no completion is NOT turn-end even with a clean summary", () => {
    expect(trajectoryTurnEnded([spawned, summary])).toBe(false);
  });

  it("a spawned sub-agent that completed IS turn-end", () => {
    expect(trajectoryTurnEnded([spawned, summary, spawnCompleted])).toBe(true);
  });

  it("a killed sub-agent counts as settled", () => {
    expect(trajectoryTurnEnded([spawned, summary, spawnKilled])).toBe(true);
  });

  it("two spawns with one completion is NOT turn-end", () => {
    expect(trajectoryTurnEnded([spawned, spawned, spawnCompleted, summary])).toBe(false);
  });

  it("two spawns with two completions IS turn-end", () => {
    expect(
      trajectoryTurnEnded([spawned, spawned, spawnCompleted, spawnCompleted, summary]),
    ).toBe(true);
  });

  it("is pure — same lines yield the same verdict", () => {
    const lines = [spawned, summary, spawnCompleted];
    expect(trajectoryTurnEnded(lines)).toBe(trajectoryTurnEnded(lines));
  });
});

// ---------------------------------------------------------------------------
// directConversationFinished — the post-turn grace must measure SILENCE, not an
// absolute clock from turn-end.
//
// A background completion's DELIVERY can trail its terminal record: measured live,
// a turn ended correctly (spawned workers balanced) and the substantive answer
// arrived after the fixed 120s window, so the drive reported the interim
// acknowledgement as the answer. Raising the fixed bound trades against
// answerless-turn latency; measuring from the last outbound instead keeps the
// window open exactly while the runtime is still emitting, and closes promptly on
// real silence.
// ---------------------------------------------------------------------------

describe("directConversationFinished — silence-based grace", () => {
  it("still returns immediately once an answer is seen", () => {
    expect(directConversationFinished({
      sawAnswer: true, turnEnded: true, turnEndedAtMs: 0, nowMs: 1, deliveryGraceMs: 1000,
    })).toBe(true);
  });

  it("is not finished before the grace elapses", () => {
    expect(directConversationFinished({
      sawAnswer: false, turnEnded: true, turnEndedAtMs: 0, nowMs: 500, deliveryGraceMs: 1000,
    })).toBe(false);
  });

  it("finishes after the grace when nothing more arrives", () => {
    expect(directConversationFinished({
      sawAnswer: false, turnEnded: true, turnEndedAtMs: 0, nowMs: 1000, deliveryGraceMs: 1000,
    })).toBe(true);
  });

  it("EXTENDS the window when an outbound arrived after turn-end", () => {
    // Turn ended at 0, grace 1000, now 1200 — the old absolute rule would finish.
    // A card arrived at 900, so the runtime is still emitting: keep waiting.
    expect(directConversationFinished({
      sawAnswer: false, turnEnded: true, turnEndedAtMs: 0, nowMs: 1200,
      deliveryGraceMs: 1000, lastOutboundAtMs: 900,
    })).toBe(false);
  });

  it("finishes once the silence since the last outbound exceeds the grace", () => {
    expect(directConversationFinished({
      sawAnswer: false, turnEnded: true, turnEndedAtMs: 0, nowMs: 1901,
      deliveryGraceMs: 1000, lastOutboundAtMs: 900,
    })).toBe(true);
  });

  it("ignores an outbound that predates turn-end (no retro-extension)", () => {
    expect(directConversationFinished({
      sawAnswer: false, turnEnded: true, turnEndedAtMs: 1000, nowMs: 2000,
      deliveryGraceMs: 1000, lastOutboundAtMs: 200,
    })).toBe(true);
  });

  it("is unchanged when lastOutboundAtMs is omitted (backward compatible)", () => {
    expect(directConversationFinished({
      sawAnswer: false, turnEnded: true, turnEndedAtMs: 0, nowMs: 1000, deliveryGraceMs: 1000,
    })).toBe(true);
  });

  it("never finishes while the turn has not ended", () => {
    expect(directConversationFinished({
      sawAnswer: false, turnEnded: false, turnEndedAtMs: undefined, nowMs: 99999,
      deliveryGraceMs: 1000, lastOutboundAtMs: 1,
    })).toBe(false);
  });
});
