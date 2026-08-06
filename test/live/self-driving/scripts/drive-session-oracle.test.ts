// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findTelegramConversationWireAnswer,
  normalizeWireText,
  normalizedInboundTextError,
  outboundVisibleText,
  reconcileAssistantSurfaces,
  selectTelegramConversationTrajectoryPath,
  sharedConversationFinished,
  telegramInjectAddressingError,
} from "./drive-session-oracle.mjs";

describe("drive inbound validation", () => {
  it("rejects text beyond the deployed normalized-message limit before injection", () => {
    expect(normalizedInboundTextError("x".repeat(65_536), 65_536)).toBeUndefined();
    expect(normalizedInboundTextError("x".repeat(65_537), 65_536)).toBe(
      "message text is 65537 characters; the deployed normalized-message limit is 65536",
    );
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
