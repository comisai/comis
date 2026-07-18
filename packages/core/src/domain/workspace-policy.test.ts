// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  InstructionSectionSchema,
  WorkspacePolicySnapshotSchema,
  parseWorkspacePolicySnapshot,
  type WorkspacePolicySnapshot,
} from "./workspace-policy.js";

function validSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: "agent_a",
    sections: [{
      id: "workspace:role",
      sourceKind: "operator",
      trust: "trusted",
      stability: "stable",
      content: "# Role\n\nHandle the configured task scope.",
      contentHash: "a".repeat(64),
      maxChars: 20_000,
    }],
    combinedHash: "b".repeat(64),
    ...overrides,
  };
}

describe("WorkspacePolicySnapshot", () => {
  it("parses strict attributed instruction sections", () => {
    const result = parseWorkspacePolicySnapshot(validSnapshot());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const snapshot: WorkspacePolicySnapshot = result.value;
      expect(snapshot.sections[0]?.sourceKind).toBe("operator");
      expect(snapshot.sections[0]?.trust).toBe("trusted");
    }
  });

  it("rejects unknown fields and invalid trust-source combinations", () => {
    expect(WorkspacePolicySnapshotSchema.safeParse(validSnapshot({ capturedAt: 1 })).success).toBe(false);
    expect(InstructionSectionSchema.safeParse({
      ...(validSnapshot().sections as Array<Record<string, unknown>>)[0],
      sourceKind: "agent_state",
      trust: "trusted",
    }).success).toBe(false);
  });

  it("accepts agent state only as untrusted turn-stable content", () => {
    const result = InstructionSectionSchema.safeParse({
      ...(validSnapshot().sections as Array<Record<string, unknown>>)[0],
      id: "workspace:bootstrap",
      sourceKind: "agent_state",
      trust: "untrusted",
      stability: "turn",
    });
    expect(result.success).toBe(true);
  });
});
