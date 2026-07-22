// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { TaskExtractionItem } from "./task-extraction-queue.js";
import { parseTaskExtractionOutput } from "./task-extractor.js";

function item(overrides: Partial<TaskExtractionItem> = {}): TaskExtractionItem {
  return {
    itemId: "item-a",
    sourceExecutionId: "execution-a",
    origin: {
      turnScope: {
        conversation: { tenantId: "tenant-a", agentId: "agent-a", partition: { kind: "agent" } },
        principal: { principalId: "user-a" },
        endpoint: {
          channelType: "echo",
          channelInstanceId: "echo-main",
          conversationId: "conversation-a",
          conversationKind: "direct",
        },
      },
      conversationRef: "cv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as never,
      deliveryOrigin: {
        tenantId: "tenant-a",
        channelType: "echo",
        channelId: "conversation-a",
        userId: "user-a",
      },
      traceId: "trace-a",
      backgroundHopCount: 0,
    },
    workspacePolicySnapshot: { agentId: "agent-a", sections: [], combinedHash: "a".repeat(64) },
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    capturedAtMs: 1_000,
    minimumDueAtMs: 61_000,
    userText: "check later",
    deliveredAssistantText: "I will follow up",
    ...overrides,
  };
}

describe("task extraction output parser", () => {
  it("binds candidates to runtime items and derives immutable due windows", () => {
    const result = parseTaskExtractionOutput({
      raw: JSON.stringify({ candidates: [{
        itemId: "item-a",
        text: "Check the outcome",
        dueInSecondsEarliest: 60,
        confidence: 0.9,
      }] }),
      items: [item()],
      batchMax: 8,
      defaultWindowMs: 12_000,
    });

    expect(result).toEqual({
      ok: true,
      value: [{
        item: expect.objectContaining({ itemId: "item-a", sourceExecutionId: "execution-a" }),
        text: "Check the outcome",
        confidence: 0.9,
        dueEarliestMs: 61_000,
        dueLatestMs: 73_000,
        expiresAtMs: 2_592_001_000,
      }],
    });
  });

  it("rejects unknown and duplicate runtime item ids", () => {
    const unknown = parseTaskExtractionOutput({
      raw: JSON.stringify({ candidates: [{
        itemId: "item-unknown", text: "Check", dueInSecondsEarliest: 60, confidence: 0.9,
      }] }),
      items: [item()], batchMax: 8, defaultWindowMs: 1_000,
    });
    expect(unknown).toMatchObject({ ok: false, error: { code: "unknown_item" } });

    const duplicate = parseTaskExtractionOutput({
      raw: JSON.stringify({ candidates: [
        { itemId: "item-a", text: "Check", dueInSecondsEarliest: 60, confidence: 0.9 },
        { itemId: "item-a", text: "Check again", dueInSecondsEarliest: 61, confidence: 0.9 },
      ] }),
      items: [item()], batchMax: 8, defaultWindowMs: 1_000,
    });
    expect(duplicate).toMatchObject({ ok: false, error: { code: "duplicate_item" } });
  });

  it("rejects model-authored routing fields through the strict schema", () => {
    expect(parseTaskExtractionOutput({
      raw: JSON.stringify({ candidates: [{
        itemId: "item-a",
        text: "Check",
        dueInSecondsEarliest: 60,
        confidence: 0.9,
        agentId: "agent-other",
      }] }),
      items: [item()], batchMax: 8, defaultWindowMs: 1_000,
    })).toMatchObject({ ok: false, error: { code: "invalid_output" } });
  });

  it("rejects unsafe or contradictory relative time ranges", () => {
    const parse = (earliest: number, latest?: number) => parseTaskExtractionOutput({
      raw: JSON.stringify({ candidates: [{
        itemId: "item-a", text: "Check", dueInSecondsEarliest: earliest,
        ...(latest === undefined ? {} : { dueInSecondsLatest: latest }), confidence: 0.9,
      }] }),
      items: [item()], batchMax: 8, defaultWindowMs: 1_000,
    });
    expect(parse(0)).toMatchObject({ ok: false, error: { code: "invalid_time_range" } });
    expect(parse(60, 59)).toMatchObject({ ok: false, error: { code: "invalid_time_range" } });
    expect(parse(30)).toMatchObject({ ok: false, error: { code: "before_minimum_due" } });
    expect(parse(30 * 24 * 60 * 60 + 1)).toMatchObject({
      ok: false,
      error: { code: "invalid_time_range" },
    });
  });

  it("rejects oversized raw output and multibyte candidate text", () => {
    expect(parseTaskExtractionOutput({
      raw: "x".repeat(64 * 1_024 + 1),
      items: [item()], batchMax: 8, defaultWindowMs: 1_000,
    })).toMatchObject({ ok: false, error: { code: "output_too_large" } });

    expect(parseTaskExtractionOutput({
      raw: JSON.stringify({ candidates: [{
        itemId: "item-a",
        text: "🙂".repeat(1_025),
        dueInSecondsEarliest: 60,
        confidence: 0.9,
      }] }),
      items: [item()], batchMax: 8, defaultWindowMs: 1_000,
    })).toMatchObject({ ok: false, error: { code: "candidate_too_large" } });
  });

  it("rejects overflow instead of clamping epochs", () => {
    expect(parseTaskExtractionOutput({
      raw: JSON.stringify({ candidates: [{
        itemId: "item-a", text: "Check", dueInSecondsEarliest: 60, confidence: 0.9,
      }] }),
      items: [item({
        capturedAtMs: Number.MAX_SAFE_INTEGER - 10,
        minimumDueAtMs: Number.MAX_SAFE_INTEGER - 5,
      })],
      batchMax: 8,
      defaultWindowMs: 1_000,
    })).toMatchObject({ ok: false, error: { code: "time_overflow" } });
  });
});
