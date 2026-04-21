// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createSpawnPacketBuilder } from "./spawn-packet-builder.js";
import type { SpawnPacketBuilderDeps, SpawnPacketBuildParams } from "./spawn-packet-builder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDefaultDeps(overrides?: Partial<SpawnPacketBuilderDeps>): SpawnPacketBuilderDeps {
  return {
    workspaceDir: "/home/agent/workspace",
    currentDepth: 1,
    maxSpawnDepth: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SpawnPacketBuilder", () => {
  it("build() returns SpawnPacket with all defaults when only task provided", () => {
    const builder = createSpawnPacketBuilder(createDefaultDeps());
    const packet = builder.build({ task: "Analyze logs" });

    expect(packet.task).toBe("Analyze logs");
    expect(packet.artifactRefs).toEqual([]);
    expect(packet.domainKnowledge).toEqual([]);
    expect(packet.toolGroups).toEqual([]);
    expect(packet.objective).toBe("");
    expect(packet.workspaceDir).toBe("/home/agent/workspace");
    expect(packet.depth).toBe(1);
    expect(packet.maxDepth).toBe(3);
    expect(packet.parentSummary).toBeUndefined();
  });

  it("build() passes through artifact refs", () => {
    const builder = createSpawnPacketBuilder(createDefaultDeps());
    const packet = builder.build({
      task: "Review code",
      artifactRefs: ["/src/main.ts", "/src/utils.ts"],
    });

    expect(packet.artifactRefs).toEqual(["/src/main.ts", "/src/utils.ts"]);
  });

  it("build() passes through objective", () => {
    const builder = createSpawnPacketBuilder(createDefaultDeps());
    const packet = builder.build({
      task: "Fix bug",
      objective: "Ensure all error paths return Result<T,E>",
    });

    expect(packet.objective).toBe("Ensure all error paths return Result<T,E>");
  });

  it("build() passes through domain knowledge", () => {
    const builder = createSpawnPacketBuilder(createDefaultDeps());
    const packet = builder.build({
      task: "Write tests",
      domainKnowledge: ["Use vitest", "Co-locate with source"],
    });

    expect(packet.domainKnowledge).toEqual(["Use vitest", "Co-locate with source"]);
  });

  it("build() passes through tool groups", () => {
    const builder = createSpawnPacketBuilder(createDefaultDeps());
    const packet = builder.build({
      task: "Deploy service",
      toolGroups: ["bash", "file_ops", "memory"],
    });

    expect(packet.toolGroups).toEqual(["bash", "file_ops", "memory"]);
  });

  it("build() inherits workspace from deps", () => {
    const builder = createSpawnPacketBuilder(createDefaultDeps({ workspaceDir: "/custom/workspace" }));
    const packet = builder.build({ task: "Run analysis" });

    expect(packet.workspaceDir).toBe("/custom/workspace");
  });

  it("build() computes depth from deps", () => {
    const builder = createSpawnPacketBuilder(createDefaultDeps({ currentDepth: 2, maxSpawnDepth: 5 }));
    const packet = builder.build({ task: "Sub-task" });

    expect(packet.depth).toBe(2);
    expect(packet.maxDepth).toBe(5);
  });

  it("build() passes through agentWorkspaces from deps", () => {
    const workspaces = {
      "default": "/ws/default",
      "analyst": "/ws/analyst",
    };
    const builder = createSpawnPacketBuilder(createDefaultDeps({ agentWorkspaces: workspaces }));
    const packet = builder.build({ task: "Cross-agent task" });
    expect(packet.agentWorkspaces).toEqual(workspaces);
  });

  it("build() omits agentWorkspaces when not provided in deps", () => {
    const builder = createSpawnPacketBuilder(createDefaultDeps());
    const packet = builder.build({ task: "Simple task" });
    expect(packet.agentWorkspaces).toBeUndefined();
  });

  it("build() with all params populated", () => {
    const deps: SpawnPacketBuilderDeps = {
      workspaceDir: "/ws/project",
      currentDepth: 2,
      maxSpawnDepth: 4,
      agentWorkspaces: { "default": "/ws/default", "analyst": "/ws/analyst" },
    };
    const params: SpawnPacketBuildParams = {
      task: "Comprehensive analysis",
      artifactRefs: ["/data/input.json", "/config/settings.yaml"],
      objective: "Identify performance bottlenecks",
      toolGroups: ["bash", "file_ops"],
      includeParentHistory: "summary",
      domainKnowledge: ["System uses Node.js 22", "Database is SQLite"],
    };

    const builder = createSpawnPacketBuilder(deps);
    const packet = builder.build(params);

    expect(packet.task).toBe("Comprehensive analysis");
    expect(packet.artifactRefs).toEqual(["/data/input.json", "/config/settings.yaml"]);
    expect(packet.objective).toBe("Identify performance bottlenecks");
    expect(packet.toolGroups).toEqual(["bash", "file_ops"]);
    expect(packet.domainKnowledge).toEqual(["System uses Node.js 22", "Database is SQLite"]);
    expect(packet.workspaceDir).toBe("/ws/project");
    expect(packet.depth).toBe(2);
    expect(packet.maxDepth).toBe(4);
    // parentSummary is not set by build() -- populated later by executeSubAgent
    expect(packet.parentSummary).toBeUndefined();
    // agentWorkspaces passed through from deps
    expect(packet.agentWorkspaces).toEqual({ "default": "/ws/default", "analyst": "/ws/analyst" });
  });
});
