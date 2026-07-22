// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  InstructionSectionSchema,
  WorkspacePolicySnapshotSchema,
  computeWorkspacePolicyCombinedHash,
  hashWorkspacePolicyContent,
  parseWorkspacePolicySnapshot,
  verifyWorkspacePolicySnapshot,
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

  it("computes and verifies canonical section and snapshot hashes", () => {
    const content = "# Role\n\nHandle the configured task scope.";
    const section = {
      ...(validSnapshot().sections as Array<Record<string, unknown>>)[0],
      content,
      contentHash: hashWorkspacePolicyContent(content),
    };
    const combinedHash = computeWorkspacePolicyCombinedHash([section as never]);
    const snapshot = WorkspacePolicySnapshotSchema.parse({
      agentId: "agent_a",
      sections: [section],
      combinedHash,
    });

    expect(verifyWorkspacePolicySnapshot(snapshot)).toEqual({ ok: true, value: undefined });
  });

  it("rejects duplicate sections and mismatched policy hashes", () => {
    const content = "policy";
    const section = {
      ...(validSnapshot().sections as Array<Record<string, unknown>>)[0],
      content,
      contentHash: hashWorkspacePolicyContent(content),
    };
    const duplicate = WorkspacePolicySnapshotSchema.parse({
      agentId: "agent_a",
      sections: [section, section],
      combinedHash: computeWorkspacePolicyCombinedHash([section as never, section as never]),
    });
    expect(verifyWorkspacePolicySnapshot(duplicate)).toMatchObject({
      ok: false,
      error: { code: "duplicate_section" },
    });

    const mismatched = WorkspacePolicySnapshotSchema.parse({
      agentId: "agent_a",
      sections: [section],
      combinedHash: "f".repeat(64),
    });
    expect(verifyWorkspacePolicySnapshot(mismatched)).toMatchObject({
      ok: false,
      error: { code: "combined_hash_mismatch" },
    });
  });
});
