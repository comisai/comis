// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  approvalButtons,
  classifyApprovalRetirement,
} from "./approval-retirement-oracle.mjs";

describe("approval control retirement oracle", () => {
  it("accepts only explicit control removal or message deletion", () => {
    const prompt = {
      method: "sendMessage",
      messageId: 81,
      reply_markup: {
        inline_keyboard: [[
          { text: "Approve", callback_data: "capability_a" },
          { text: "Deny", callback_data: "capability_b" },
        ]],
      },
    };
    expect(approvalButtons(prompt)).toEqual([
      { label: "Approve", data: "capability_a" },
      { label: "Deny", data: "capability_b" },
    ]);
    expect(classifyApprovalRetirement({
      messages: [prompt, {
        method: "editMessageText",
        messageId: 81,
        replyMarkup: { inline_keyboard: [] },
      }],
      messageId: 81,
      afterEventCount: 1,
      elapsedMs: 30,
      maxRetirementMs: 500,
    })).toEqual({ state: "retired", method: "editMessageText", eventIndex: 1 });
    expect(classifyApprovalRetirement({
      messages: [prompt, { method: "deleteMessage", messageId: 81 }],
      messageId: 81,
      afterEventCount: 1,
      elapsedMs: 30,
      maxRetirementMs: 500,
    })).toEqual({ state: "retired", method: "deleteMessage", eventIndex: 1 });
  });

  it("does not mistake an unrelated edit or omitted markup for retirement", () => {
    expect(classifyApprovalRetirement({
      messages: [
        { method: "editMessageText", messageId: 90, replyMarkup: { inline_keyboard: [] } },
        { method: "editMessageText", messageId: 89, text: "Approved" },
      ],
      messageId: 89,
      afterEventCount: 0,
      elapsedMs: 100,
      maxRetirementMs: 500,
    })).toEqual({ state: "pending" });
  });

  it("fails immediately when a post-tap mutation keeps controls actionable", () => {
    expect(classifyApprovalRetirement({
      messages: [{
        method: "editMessageText",
        messageId: 91,
        replyMarkup: {
          inline_keyboard: [[{ text: "Approve", callback_data: "capability" }]],
        },
      }],
      messageId: 91,
      afterEventCount: 0,
      elapsedMs: 20,
      maxRetirementMs: 500,
    })).toEqual({ state: "still_actionable", eventIndex: 0 });
  });

  it("fails at the latency budget instead of accepting eventual cleanup", () => {
    expect(classifyApprovalRetirement({
      messages: [],
      messageId: 92,
      afterEventCount: 0,
      elapsedMs: 501,
      maxRetirementMs: 500,
    })).toEqual({ state: "late", elapsedMs: 501, maxRetirementMs: 500 });
  });

  it("rejects a retirement event first observed after the latency budget", () => {
    expect(classifyApprovalRetirement({
      messages: [{
        method: "editMessageText",
        messageId: 93,
        replyMarkup: { inline_keyboard: [] },
      }],
      messageId: 93,
      afterEventCount: 0,
      elapsedMs: 501,
      maxRetirementMs: 500,
    })).toEqual({ state: "late", elapsedMs: 501, maxRetirementMs: 500 });
  });
});
