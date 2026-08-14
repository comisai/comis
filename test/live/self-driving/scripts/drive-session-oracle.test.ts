// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  directConversationFinished,
  findTelegramConversationWireAnswer,
  followupWaitFinished,
  isDriveProgressText,
  logicalSubstantiveAnswerCount,
  normalizeWireText,
  normalizeDriveStdinText,
  normalizedInboundTextError,
  outboundVisibleContent,
  outboundVisibleText,
  reconcileAssistantSurfaces,
  selectTelegramConversationTrajectoryPath,
  sharedConversationFinished,
  telegramInjectAddressingError,
  trajectoryBaselineLineCount,
  trajectoryTurnEnded,
} from "./drive-session-oracle.mjs";

describe("opt-in follow-up delivery wait", () => {
  it("distinguishes a chunked long answer from a separate short completion", () => {
    expect(logicalSubstantiveAnswerCount([
      { messageId: 10, text: "x".repeat(4_059) },
      { messageId: 11, text: "x".repeat(2_958) },
    ])).toBe(1);
    expect(logicalSubstantiveAnswerCount([
      { messageId: 20, text: "launch acknowledgement" },
      { messageId: 21, text: "terminal graph result" },
    ])).toBe(2);
  });

  it("keeps polling after the launch acknowledgement until a second answer arrives", () => {
    expect(followupWaitFinished({
      followupAnswerCount: 0,
      firstAnswerAtMs: 1_000,
      nowMs: 5_000,
      waitMs: 30_000,
    })).toBe(false);
    expect(followupWaitFinished({
      followupAnswerCount: 1,
      firstAnswerAtMs: 1_000,
      nowMs: 5_000,
      waitMs: 30_000,
    })).toBe(true);
  });

  it("ends honestly when the bounded follow-up window expires", () => {
    expect(followupWaitFinished({
      followupAnswerCount: 0,
      firstAnswerAtMs: 1_000,
      nowMs: 31_000,
      waitMs: 30_000,
    })).toBe(true);
    expect(followupWaitFinished({
      followupAnswerCount: 0,
      firstAnswerAtMs: undefined,
      nowMs: 90_000,
      waitMs: 30_000,
    })).toBe(false);
  });
});

describe("drive inbound validation", () => {
  it("rejects text beyond the deployed normalized-message limit before injection", () => {
    expect(normalizedInboundTextError("x".repeat(65_536), 65_536)).toBeUndefined();
    expect(normalizedInboundTextError("x".repeat(65_537), 65_536)).toBe(
      "message text is 65537 characters; the deployed normalized-message limit is 65536",
    );
  });

  it("preserves multiline stdin while removing only its transport newline", () => {
    expect(normalizeDriveStdinText(
      "from: synthetic sender\ncan you confirm the window?\n",
    )).toBe("from: synthetic sender\ncan you confirm the window?");
    expect(normalizeDriveStdinText("one line\r\n")).toBe("one line");
  });
});

describe("drive trajectory completion", () => {
  it("excludes the trailing JSONL separator from the trajectory baseline", () => {
    expect(trajectoryBaselineLineCount('{"type":"prompt.submitted"}\n')).toBe(1);
    expect(trajectoryBaselineLineCount([
      '{"type":"prompt.submitted"}',
      '{"type":"model.started"}',
      "",
    ].join("\n"))).toBe(2);
  });

  it("ends a pre-model clarification turn without waiting for a model summary", () => {
    expect(trajectoryTurnEnded([
      JSON.stringify({
        type: "request.clarification_required",
        data: {
          reason: "opaque_payload_missing_instruction",
          inputChars: 43_000,
        },
      }),
    ])).toBe(true);
  });

  it("does not treat an unrelated request event as a terminal turn", () => {
    expect(trajectoryTurnEnded([
      JSON.stringify({ type: "prompt.submitted", data: {} }),
    ])).toBe(false);
  });

  it("drains a bounded quiet window after a post-terminal answer", () => {
    expect(directConversationFinished({
      sawAnswer: true,
      turnEnded: true,
      turnEndedAtMs: 10_000,
      nowMs: 10_001,
      deliveryGraceMs: 120_000,
      answerQuiesceMs: 8_000,
      lastOutboundAtMs: 9_000,
      lastAnswerAtMs: 10_000,
    })).toBe(false);
    expect(directConversationFinished({
      sawAnswer: true,
      turnEnded: true,
      turnEndedAtMs: 10_000,
      nowMs: 19_000,
      deliveryGraceMs: 120_000,
      answerQuiesceMs: 8_000,
      lastOutboundAtMs: 9_000,
      lastAnswerAtMs: 10_000,
    })).toBe(true);
    expect(directConversationFinished({
      sawAnswer: true,
      turnEnded: true,
      turnEndedAtMs: 10_000,
      nowMs: 18_000,
      deliveryGraceMs: 120_000,
      answerQuiesceMs: 8_000,
      lastOutboundAtMs: 17_000,
      lastAnswerAtMs: 17_000,
    })).toBe(false);
  });

  it("does not let a pre-terminal launch acknowledgement shorten an answerless delivery drain", () => {
    expect(directConversationFinished({
      sawAnswer: true,
      turnEnded: true,
      turnEndedAtMs: 10_000,
      nowMs: 18_000,
      deliveryGraceMs: 120_000,
      answerQuiesceMs: 8_000,
      lastOutboundAtMs: 9_000,
      lastAnswerAtMs: 9_000,
    })).toBe(false);
    expect(directConversationFinished({
      sawAnswer: true,
      turnEnded: true,
      turnEndedAtMs: 10_000,
      nowMs: 19_000,
      deliveryGraceMs: 120_000,
      answerQuiesceMs: 8_000,
      lastOutboundAtMs: 11_000,
      lastAnswerAtMs: 11_000,
    })).toBe(true);
  });

  it("uses the normal quiet drain after a media delivery captured with the terminal poll", () => {
    expect(directConversationFinished({
      sawAnswer: true,
      sawMediaDelivery: true,
      turnEnded: true,
      turnEndedAtMs: 10_000,
      nowMs: 18_000,
      deliveryGraceMs: 120_000,
      answerQuiesceMs: 8_000,
      lastOutboundAtMs: 10_000,
      lastAnswerAtMs: 9_999,
    })).toBe(true);
  });
});

describe("drive outbound visibility", () => {
  it("canonicalizes a Markdown table and Telegram HTML table to the same wire text", () => {
    const markdown = [
      "## Verification Report",
      "",
      "| Item | Value |",
      "|---|---:|",
      "| Box count | 12 |",
    ].join("\n");
    const telegramHtml = [
      "<b>Verification Report</b>",
      "",
      "<pre><code>Item       Value",
      "---------- -------",
      "Box count  12</code></pre>",
    ].join("\n");

    expect(normalizeWireText(markdown)).toBe(normalizeWireText(telegramHtml));
  });

  it("treats an attachment caption as substantive user-visible text", () => {
    expect(outboundVisibleText({
      method: "sendDocument",
      messageId: 42,
      caption: "The requested transcript is attached.",
      mediaKind: "document",
    })).toBe("The requested transcript is attached.");
  });

  it("preserves ordinary message text and ignores an empty attachment caption", () => {
    expect(outboundVisibleText({
      method: "sendMessage",
      messageId: 43,
      text: "The answer",
    })).toBe("The answer");
    expect(outboundVisibleText({
      method: "sendDocument",
      messageId: 44,
      caption: "",
    })).toBe("");
  });

  it("classifies a captionless photo as a substantive wire delivery", () => {
    const photo = {
      method: "sendPhoto",
      messageId: 45,
      caption: "",
      mediaKind: "photo",
    };

    expect(outboundVisibleText(photo)).toBe("");
    expect(outboundVisibleContent(photo)).toBe("[photo delivered]");
    expect(findTelegramConversationWireAnswer([photo])).toBe("[photo delivered]");
  });

  it("keeps the persisted assistant draft separate from the corrected wire reply", () => {
    const surfaces = reconcileAssistantSurfaces(
      "Please re-upload the image and I can try again.",
      [
        {
          method: "sendMessage",
          messageId: 45,
          text: "Re-uploading the same image will not help until vision is configured.",
        },
        {
          method: "editMessageText",
          messageId: 44,
          text: "❌ dependency — a step failed outside the tool timeline",
        },
      ],
    );

    expect(surfaces).toEqual({
      sessionDraft: "Please re-upload the image and I can try again.",
      wireReply: "Re-uploading the same image will not help until vision is configured.",
    });

    const reconcileSource = readFileSync(
      fileURLToPath(new URL("./reconcile.mjs", import.meta.url)),
      "utf8",
    );
    expect(reconcileSource).toContain("last_assistant_session_draft");
    expect(reconcileSource).toContain("reconcileAssistantSurfaces(");
  });
});

describe("drive group conversation correlation", () => {
  it("fails loudly when literal bot text lacks Telegram mention metadata", () => {
    expect(telegramInjectAddressingError(
      "@test_bot can u check this",
      { thread: 9 },
      "test_bot",
    )).toContain("INJECT_OPTS.mention=true");
    expect(telegramInjectAddressingError(
      "@test_bot can u check this",
      { mention: true, thread: 9 },
      "test_bot",
    )).toBeUndefined();
  });

  it("selects the exact Telegram forum-thread trajectory", () => {
    const sessionsRoot = "/data/workspace/sessions";
    const expected =
      `${sessionsRoot}/default/telegram@3atelegram-12345@3a-1001234567890/`
      + "conversation~thread~6.jsonl.trajectory.jsonl";
    const candidates = [
      {
        path:
          `${sessionsRoot}/default/telegram/`
          + "platform_sender~peer~platform_sender.jsonl.trajectory.jsonl",
        mtimeMs: 30,
      },
      { path: expected, mtimeMs: 20 },
      {
        path:
          `${sessionsRoot}/default/telegram@3atelegram-12345@3a-1001234567890/`
          + "conversation~thread~5.jsonl.trajectory.jsonl",
        mtimeMs: 40,
      },
    ];

    expect(selectTelegramConversationTrajectoryPath(
      candidates,
      sessionsRoot,
      "default",
      12345,
      -1001234567890,
      6,
    )).toBe(expected);
  });

  it("falls back to the Telegram General topic trajectory", () => {
    const sessionsRoot = "/data/workspace/sessions";
    const directory =
      `${sessionsRoot}/default/telegram@3atelegram-12345@3a-1001234567890/`;
    const general = `${directory}conversation~thread~1.jsonl.trajectory.jsonl`;
    const candidates = [
      { path: `${directory}conversation~thread~2.jsonl.trajectory.jsonl`, mtimeMs: 30 },
      { path: general, mtimeMs: 20 },
    ];

    expect(selectTelegramConversationTrajectoryPath(
      candidates,
      sessionsRoot,
      "default",
      12345,
      -1001234567890,
      undefined,
    )).toBe(general);
  });

  it("accepts a visible corrected reply after the exact group turn ends", () => {
    const outbound = [{
      method: "sendMessage",
      text: "I could not complete that delegation.",
    }];

    expect(sharedConversationFinished({
      outbound,
      correlatedAnswer: "The pre-guard model draft claimed success.",
      sawAnswer: true,
      turnEnded: true,
    })).toBe(true);
    expect(sharedConversationFinished({
      outbound,
      correlatedAnswer: "The pre-guard model draft claimed success.",
      sawAnswer: true,
      turnEnded: false,
    })).toBe(false);
  });

  it("accepts an exact inbound reply as forum-thread routing evidence", () => {
    const outbound = [{
      method: "sendMessage",
      messageId: 6000446,
      text: "I heard the voice message.",
      raw: {
        chat_id: -1001234567890,
        text: "I heard the voice message.",
        reply_parameters: { message_id: 6000445 },
      },
    }];

    expect(findTelegramConversationWireAnswer(
      outbound,
      1,
      6000445,
    )).toBe("I heard the voice message.");
    expect(findTelegramConversationWireAnswer(
      outbound,
      1,
      6000999,
    )).toBeNull();
  });
});

describe("drive progress classification", () => {
  // A leading ✓/❌ marks the background-task progress frame, but the agent also
  // OPENS real answers with one — its Hebrew acknowledgement style is
  // "✓ <b>הובן.</b> …". Classifying those as progress made drive.mjs discard the
  // answer, wait out its whole window, and report "[NO SUBSTANTIVE ANSWER]" for
  // a turn the wire shows was answered correctly.
  //
  // Measured live on comis-moshe (2026-08-06): corpus rows 3, 4 and 6 each
  // delivered a real reply (emulator messages 286/288/292) while the drive
  // recorded a silent drop — three FALSE FAILURES against Track A's
  // "none silently dropped" predicate. A false failure costs a campaign exactly
  // what a false success does.
  it("treats a plain marker-led status frame as progress regardless of length", () => {
    expect(isDriveProgressText("✓ done")).toBe(true);
    expect(isDriveProgressText("❌ managing skills")).toBe(true);
    // Longer than several real answers — length cannot be the discriminator.
    expect(isDriveProgressText("❌ dependency — a step failed outside the tool timeline")).toBe(true);
    expect(isDriveProgressText("🔧 web_search")).toBe(true);
    expect(isDriveProgressText("⏳ working")).toBe(true);
  });

  it("treats a marker-led SUBSTANTIVE answer as the answer, not progress", () => {
    expect(
      isDriveProgressText("✓ <b>נכון.</b> משה — מנהל צי. נצר — עוזר אישי לניהול הצי. אנחנו גם יחד. 👍 מה צריך?"),
    ).toBe(false);
    expect(
      isDriveProgressText("✓ <b>הובן.</b> עוזר אישי למשה, מנהל צי 162 רכבים. קצר, תכליתי, בעברית. מוכן. 👍"),
    ).toBe(false);
    expect(
      isDriveProgressText("✓ <b>הובן.</b> משה — רם-און, ישראל, עברית. זה תואם לפרופיל שלך. 👍"),
    ).toBe(false);
  });

  it("still classifies the non-marker progress shapes as progress", () => {
    expect(isDriveProgressText("")).toBe(true);
    expect(isDriveProgressText("[ ] step one")).toBe(true);
    expect(isDriveProgressText("(step 2 of 5)")).toBe(true);
    expect(isDriveProgressText("reading ~/notes")).toBe(true);
    expect(isDriveProgressText("Approved: shell (abc123)")).toBe(true);
    expect(isDriveProgressText("Denied: shell (abc123)")).toBe(true);
    expect(isDriveProgressText("Approved 2 pending approval(s).")).toBe(true);
    expect(isDriveProgressText("Approved: deploy")).toBe(false);
  });

  it("keeps a plain substantive answer classified as an answer", () => {
    expect(isDriveProgressText('לא ברור. מה זה "לשיקולך"?')).toBe(false);
    expect(isDriveProgressText("<b>צריך URL עם commit SHA.</b> ה-xlsx skill כבר זמינה לך")).toBe(false);
  });

  it("keeps a denial explanation classified as an answer", () => {
    expect(isDriveProgressText(
      "Denied: the fixture credential is restricted to the fixture API. No request was made.",
    )).toBe(false);
  });
});
