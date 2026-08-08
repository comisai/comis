// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { auditConversationEvidence } from "./conversation-audit-oracle.mjs";

function trajectoryRecord(
  type: string,
  traceId: string,
  ts: string,
  data: Record<string, unknown> = {},
) {
  return { type, traceId, ts, data };
}

describe("conversation evidence audit oracle", () => {
  it("names every production-shaped approval locale grounding and budget defect", () => {
    const population = Array.from({ length: 6 }, (_, index) => `entity_${index + 1}`);
    const report = auditConversationEvidence({
      trajectoryRecords: [
        trajectoryRecord("approval.requested", "trace_a", "2026-08-07T16:47:00.000Z", {
          requestId: "approval_a",
        }),
        trajectoryRecord("background_task.promoted", "trace_a", "2026-08-07T16:47:10.000Z", {
          taskId: "task_a",
        }),
        trajectoryRecord("approval.resolved", "trace_a", "2026-08-07T16:47:15.000Z", {
          requestId: "approval_a",
          approved: true,
        }),
        trajectoryRecord("background_task.completed", "trace_a", "2026-08-07T16:47:15.500Z", {
          taskId: "task_a",
        }),
        trajectoryRecord("tool.call", "trace_a", "2026-08-07T16:47:16.000Z", {
          toolName: "asset_snapshot",
          toolCallId: "call_a",
        }),
        trajectoryRecord("tool.result", "trace_a", "2026-08-07T16:47:17.000Z", {
          toolName: "asset_snapshot",
          toolCallId: "call_a",
          success: false,
        }),
        ...Array.from({ length: 5 }, (_, index) => trajectoryRecord(
          "model.completed",
          `trace_${index}`,
          `2026-08-07T16:48:0${index}.000Z`,
          { promptTokens: 100_000, completionTokens: 1_000 },
        )),
      ],
      wireRecords: [
        {
          method: "sendMessage",
          messageId: 41,
          text: "Approval required: connect integration",
          replyMarkup: {
            inline_keyboard: [[
              { text: "Approve", callback_data: "opaque-capability" },
              { text: "Deny", callback_data: "opaque-capability" },
            ]],
          },
        },
        {
          method: "editMessageText",
          messageId: 41,
          text: "Approved",
          replyMarkup: {
            inline_keyboard: [[
              { text: "Approve", callback_data: "opaque-capability" },
              { text: "Deny", callback_data: "opaque-capability" },
            ]],
          },
        },
        {
          method: "sendMessage",
          messageId: 42,
          text: "This callback is no longer valid (it may have already been resolved or expired).",
        },
        {
          method: "sendMessage",
          messageId: 43,
          text: "Background work is still running: managing MCP servers.",
        },
      ],
      sessionRecords: [{ role: "user", content: "test-secret-value" }],
      incidentReport: {
        cost: { costUsd: 7.426 },
        failures: [],
      },
      contract: {
        expectedLocale: "he",
        forbiddenSurfaceTexts: [
          "This callback is no longer valid",
          "Background work is still running",
        ],
        sensitiveCanaries: ["test-secret-value"],
        budgets: {
          maxModelCalls: 3,
          maxInputTokens: 300_000,
          maxCostUsd: 2,
        },
        grounding: {
          entitySets: {
            population,
            located: population,
            fresh: population.slice(0, 5),
            recent: population.slice(0, 2),
            aged: population.slice(2, 5),
            stale: [population[5]],
            no_transmissions: [population[0]],
          },
          assertions: [
            {
              id: "coverage_means_freshness",
              kind: "set_covers",
              claimed: true,
              set: "fresh",
              universe: "population",
            },
            {
              id: "equal_counts_mean_same_vehicles",
              kind: "sets_equal",
              claimed: true,
              left: "stale",
              right: "no_transmissions",
            },
            {
              id: "freshness_buckets_are_exclusive",
              kind: "partition",
              whole: "population",
              parts: ["recent", "aged", "stale"],
            },
          ],
        },
      },
    });

    expect(report.verdict).toBe("fail");
    expect(report.metrics).toMatchObject({
      modelCalls: 5,
      inputTokens: 500_000,
      costUsd: 7.426,
    });
    expect(report.violations.map((violation) => violation.code)).toEqual([
      "approval_controls_still_actionable",
      "background_promoted_during_approval",
      "locale_fallback_visible",
      "secret_canary_persisted",
      "grounding_set_coverage_false",
      "grounding_set_equality_false",
      "model_call_budget_exceeded",
      "input_token_budget_exceeded",
      "cost_budget_exceeded",
      "incident_report_omits_tool_failure",
    ]);
    expect(JSON.stringify(report)).not.toContain("test-secret-value");
    expect(JSON.stringify(report)).not.toContain("opaque-capability");
  });

  it("passes a localized bounded and fully reconciled conversation", () => {
    const report = auditConversationEvidence({
      trajectoryRecords: [
        trajectoryRecord("approval.requested", "trace_ok", "2026-08-07T16:47:00.000Z", {
          requestId: "approval_ok",
        }),
        trajectoryRecord("approval.resolved", "trace_ok", "2026-08-07T16:47:02.000Z", {
          requestId: "approval_ok",
          approved: true,
        }),
        trajectoryRecord("tool.call", "trace_ok", "2026-08-07T16:47:03.000Z", {
          toolName: "asset_snapshot",
          toolCallId: "call_ok",
        }),
        trajectoryRecord("tool.result", "trace_ok", "2026-08-07T16:47:04.000Z", {
          toolName: "asset_snapshot",
          toolCallId: "call_ok",
          success: true,
        }),
        trajectoryRecord("model.completed", "trace_ok", "2026-08-07T16:47:05.000Z", {
          promptTokens: 1_000,
          completionTokens: 80,
        }),
      ],
      wireRecords: [
        {
          method: "sendMessage",
          messageId: 51,
          text: "נדרש אישור",
          replyMarkup: {
            inline_keyboard: [[
              { text: "אישור", callback_data: "opaque-capability" },
              { text: "דחייה", callback_data: "opaque-capability" },
            ]],
          },
        },
        {
          method: "editMessageText",
          messageId: 51,
          text: "אושר",
          replyMarkup: { inline_keyboard: [] },
        },
        { method: "sendMessage", messageId: 52, text: "הבדיקה הושלמה" },
      ],
      sessionRecords: [{ role: "user", content: "secret://integration_password" }],
      incidentReport: { cost: { costUsd: 0.08 }, failures: [] },
      contract: {
        expectedLocale: "he",
        forbiddenSurfaceTexts: [
          "This callback is no longer valid",
          "Background work is still running",
        ],
        sensitiveCanaries: ["test-secret-value"],
        budgets: {
          maxModelCalls: 3,
          maxInputTokens: 10_000,
          maxCostUsd: 1,
        },
        grounding: {
          entitySets: {
            population: ["entity_1", "entity_2", "entity_3"],
            fresh: ["entity_1", "entity_2", "entity_3"],
            recent: ["entity_1"],
            aged: ["entity_2"],
            stale: ["entity_3"],
            no_transmissions: ["entity_3"],
          },
          assertions: [
            {
              id: "freshness_is_complete",
              kind: "set_covers",
              claimed: true,
              set: "fresh",
              universe: "population",
            },
            {
              id: "stale_vehicle_has_no_transmissions",
              kind: "sets_equal",
              claimed: true,
              left: "stale",
              right: "no_transmissions",
            },
            {
              id: "freshness_buckets_are_exclusive",
              kind: "partition",
              whole: "population",
              parts: ["recent", "aged", "stale"],
            },
          ],
        },
      },
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      verdict: "pass",
      violations: [],
      metrics: {
        approvalRequests: 1,
        approvalResolutions: 1,
        modelCalls: 1,
        inputTokens: 1_000,
        outputTokens: 80,
        costUsd: 0.08,
        groundedAssertions: 3,
      },
    });
  });

  it("rejects corrupt evidence and unmatched lifecycle records instead of passing empty", () => {
    const report = auditConversationEvidence({
      trajectoryRecords: [
        { type: "tool.call", traceId: "trace_bad", ts: "not-a-time", data: {} },
        trajectoryRecord("approval.resolved", "trace_bad", "2026-08-07T16:47:00.000Z", {
          requestId: "missing_request",
        }),
        trajectoryRecord("background_task.promoted", "trace_bad", "2026-08-07T16:47:01.000Z", {
          taskId: "task_missing_terminal",
        }),
      ],
      wireRecords: [],
      sessionRecords: [],
      incidentReport: undefined,
      contract: {},
    });

    expect(report.verdict).toBe("fail");
    expect(report.violations.map((violation) => violation.code)).toEqual([
      "trajectory_timestamp_invalid",
      "approval_resolution_unmatched",
      "tool_call_unmatched",
      "background_task_unmatched",
      "wire_evidence_empty",
      "incident_report_unavailable",
    ]);
  });
});
