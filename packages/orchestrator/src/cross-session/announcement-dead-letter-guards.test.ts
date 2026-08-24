// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  isAnnouncementProducerHandoffRecord,
  isAnnouncementProducerRecoveryOutcome,
  isAnnouncementProducerReservationRecord,
  isAnnouncementResultRef,
  isAnnouncementRetirementProducer,
  isDeadLetterAttachmentSnapshot,
  isDeadLetterEntry,
  isParentDecisionReservationRecord,
  reservedDeadLetterSnapshotBytes,
  sameRetirementProducer,
  validateDeadLetterSnapshotAdmission,
} from "./announcement-dead-letter-guards.js";

describe("dead-letter storage guard boundaries", () => {
  it("rejects primitive attachment, outcome, result, and stored-record values", () => {
    expect(isDeadLetterAttachmentSnapshot("snapshot")).toBe(false);
    expect(isAnnouncementProducerRecoveryOutcome("outcome")).toBe(false);
    expect(isAnnouncementResultRef("result")).toBe(false);
    expect(isAnnouncementRetirementProducer("producer")).toBe(false);
    expect(isAnnouncementProducerHandoffRecord("handoff")).toBe(false);
    expect(isParentDecisionReservationRecord(null)).toBe(false);
    expect(isAnnouncementProducerReservationRecord([])).toBe(false);
    expect(isDeadLetterEntry(null)).toBe(false);
  });

  it("rejects malformed tool-result recovery outcomes at every nested boundary", () => {
    const base = {
      kind: "tool_result",
      terminalReason: "completed",
      completedAtMs: 1,
      response: "done",
      stats: { runtimeMs: 1, totalTokens: 1, totalCost: 0 },
    };
    const invalid = [
      { ...base, terminalReason: "other" },
      { ...base, completedAtMs: -1 },
      { ...base, responseRef: [] },
      { ...base, responseRef: { kind: "session_metadata", operationId: "" } },
      { ...base, turnsCompleted: -1 },
      { ...base, announced: "yes" },
      { ...base, stats: [] },
      {
        kind: "tool_result",
        terminalReason: "failed",
        completedAtMs: 1,
        errorKind: "internal",
        summary: "failed safely",
      },
    ];
    for (const outcome of invalid.slice(0, -1)) {
      expect(isAnnouncementProducerRecoveryOutcome(outcome)).toBe(false);
    }
    expect(isAnnouncementProducerRecoveryOutcome(invalid.at(-1))).toBe(true);
  });

  it("rejects row-count, serialization, and oversized-row snapshot reservations", () => {
    expect(reservedDeadLetterSnapshotBytes(new Array(201) as never)).toMatchObject({ ok: false });
    expect(reservedDeadLetterSnapshotBytes([{ value: 1n }] as never)).toMatchObject({ ok: false });
    expect(reservedDeadLetterSnapshotBytes([{
      announcementText: "x".repeat(1_048_577),
    }] as never)).toMatchObject({ ok: false });
    expect(validateDeadLetterSnapshotAdmission(new Array(201) as never, [])).toMatchObject({ ok: false });
    expect(validateDeadLetterSnapshotAdmission([], new Array(201) as never)).toMatchObject({ ok: false });
  });

  it("compares distinct retirement producer kinds and identities", () => {
    const session = {
      kind: "session" as const,
      tenantId: "default",
      agentId: "agent-a",
      conversationRef: `cv_${"f".repeat(43)}` as never,
      checkpointId: "checkpoint-a",
    };
    const graph = { kind: "graph" as const, tenantId: "default", graphId: "graph-a" };
    const tool = {
      kind: "tool_result" as const,
      tenantId: "default",
      agentId: "agent-a",
      conversationRef: session.conversationRef,
      toolCallId: "tool-a",
      operationId: "operation-a",
    };
    expect(sameRetirementProducer(session, graph)).toBe(false);
    expect(sameRetirementProducer(graph, session)).toBe(false);
    expect(sameRetirementProducer(session, { ...session, agentId: "agent-b" })).toBe(false);
    expect(sameRetirementProducer(tool, session)).toBe(false);
    expect(sameRetirementProducer(session, tool)).toBe(false);
    expect(isAnnouncementRetirementProducer({ kind: "unknown", tenantId: "default" })).toBe(false);
    expect(isAnnouncementRetirementProducer({ kind: "graph", tenantId: "" })).toBe(false);
  });
});
