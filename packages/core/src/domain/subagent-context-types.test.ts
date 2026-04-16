import { describe, expect, it } from "vitest";
import {
  SubagentResultSchema,
  SubagentEndReasonSchema,
  parseSubagentResult,
} from "./subagent-context-types.js";
import type {
  SpawnPacket,
  CondensedResult,
  SubagentResult,
} from "./subagent-context-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskComplete: true,
    summary: "Successfully analyzed the codebase structure.",
    conclusions: ["The architecture follows hexagonal patterns"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SubagentResultSchema
// ---------------------------------------------------------------------------

describe("SubagentResultSchema", () => {
  describe("valid data", () => {
    it("accepts valid minimal result", () => {
      const result = SubagentResultSchema.safeParse(validResult());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.taskComplete).toBe(true);
        expect(result.data.summary).toBe("Successfully analyzed the codebase structure.");
        expect(result.data.conclusions).toEqual(["The architecture follows hexagonal patterns"]);
      }
    });

    it("accepts valid full result", () => {
      const result = SubagentResultSchema.safeParse(validResult({
        filePaths: ["/src/index.ts", "/src/types.ts"],
        actionableItems: ["Review the port interfaces"],
        errors: ["Minor: unused import in file.ts"],
        keyData: { linesOfCode: 1500, coverage: 0.85 },
        confidence: 0.92,
      }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.filePaths).toEqual(["/src/index.ts", "/src/types.ts"]);
        expect(result.data.actionableItems).toEqual(["Review the port interfaces"]);
        expect(result.data.errors).toEqual(["Minor: unused import in file.ts"]);
        expect(result.data.keyData).toEqual({ linesOfCode: 1500, coverage: 0.85 });
        expect(result.data.confidence).toBe(0.92);
      }
    });
  });

  describe("invalid data", () => {
    it("rejects missing required field taskComplete", () => {
      const { taskComplete: _, ...rest } = validResult();
      const result = SubagentResultSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("rejects missing required field summary", () => {
      const { summary: _, ...rest } = validResult();
      const result = SubagentResultSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("rejects missing required field conclusions", () => {
      const { conclusions: _, ...rest } = validResult();
      const result = SubagentResultSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("rejects empty summary", () => {
      const result = SubagentResultSchema.safeParse(validResult({ summary: "" }));
      expect(result.success).toBe(false);
    });

    it("rejects empty conclusions array", () => {
      const result = SubagentResultSchema.safeParse(validResult({ conclusions: [] }));
      expect(result.success).toBe(false);
    });

    it("rejects confidence outside 0-1 range", () => {
      const tooHigh = SubagentResultSchema.safeParse(validResult({ confidence: 1.5 }));
      expect(tooHigh.success).toBe(false);

      const tooLow = SubagentResultSchema.safeParse(validResult({ confidence: -0.1 }));
      expect(tooLow.success).toBe(false);
    });

    it("rejects unknown keys", () => {
      const result = SubagentResultSchema.safeParse(validResult({ unknownField: "surprise" }));
      expect(result.success).toBe(false);
    });
  });

  describe("parseSubagentResult", () => {
    it("returns ok() on valid input", () => {
      const result = parseSubagentResult(validResult());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.taskComplete).toBe(true);
        expect(result.value.summary).toBe("Successfully analyzed the codebase structure.");
      }
    });

    it("returns err() on invalid input", () => {
      const result = parseSubagentResult({ taskComplete: "not a boolean" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// SubagentEndReasonSchema
// ---------------------------------------------------------------------------

describe("SubagentEndReasonSchema", () => {
  it("accepts valid reasons", () => {
    const reasons = ["completed", "failed", "killed", "swept"] as const;
    for (const reason of reasons) {
      const result = SubagentEndReasonSchema.safeParse(reason);
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid reason", () => {
    const result = SubagentEndReasonSchema.safeParse("cancelled");
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Type Assertion Tests (compile-time only)
// ---------------------------------------------------------------------------

describe("Type assertions", () => {
  it("SpawnPacket literal satisfies the interface", () => {
    const packet: SpawnPacket = {
      task: "analyze codebase",
      artifactRefs: ["/src/index.ts"],
      domainKnowledge: ["hexagonal architecture"],
      toolGroups: ["coding"],
      objective: "Understand the project structure",
      workspaceDir: "/workspace",
      depth: 1,
      maxDepth: 3,
    };
    // Compile-time check: if this file compiles, the type assertion holds
    expect(packet satisfies SpawnPacket).toBeTruthy();
  });

  it("SpawnPacket accepts optional parentSummary", () => {
    const packet: SpawnPacket = {
      task: "analyze codebase",
      artifactRefs: [],
      domainKnowledge: [],
      toolGroups: [],
      objective: "Understand the project structure",
      parentSummary: "Parent was working on auth module",
      workspaceDir: "/workspace",
      depth: 0,
      maxDepth: 3,
    };
    expect(packet satisfies SpawnPacket).toBeTruthy();
    expect(packet.parentSummary).toBe("Parent was working on auth module");
  });

  it("SpawnPacket accepts optional agentWorkspaces", () => {
    const packet: SpawnPacket = {
      task: "update agent configs",
      artifactRefs: [],
      domainKnowledge: [],
      toolGroups: [],
      objective: "Modify workspace files for all agents",
      workspaceDir: "/workspace",
      depth: 1,
      maxDepth: 3,
      agentWorkspaces: {
        "default": "/home/user/.comis/workspace",
        "technical-analyst": "/home/user/.comis/workspace-technical-analyst",
      },
    };
    expect(packet satisfies SpawnPacket).toBeTruthy();
    expect(packet.agentWorkspaces).toBeDefined();
    expect(Object.keys(packet.agentWorkspaces!)).toHaveLength(2);
  });

  it("CondensedResult literal satisfies the interface", () => {
    const condensed: CondensedResult = {
      level: 2,
      result: {
        taskComplete: true,
        summary: "Completed analysis",
        conclusions: ["All good"],
      } as SubagentResult,
      originalTokens: 5000,
      condensedTokens: 2000,
      compressionRatio: 0.4,
      diskPath: "/tmp/result-001.json",
    };
    expect(condensed satisfies CondensedResult).toBeTruthy();
  });
});
