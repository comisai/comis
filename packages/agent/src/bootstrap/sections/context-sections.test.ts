// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  buildPersonaSection,
  buildProjectContextSection,
  buildPostCompactionRecoverySection,
  buildSubagentContextSection,
  buildSubagentRoleSection,
  buildTaskPlanningSection,
} from "./context-sections.js";
import { MAX_POST_COMPACTION_CHARS } from "../section-extractor.js";
import type { BootstrapContextFile } from "../types.js";

// ---------------------------------------------------------------------------
// buildTaskPlanningSection
// ---------------------------------------------------------------------------

describe("buildTaskPlanningSection", () => {
  it("returns Task Planning section when sepEnabled is true and not minimal", () => {
    const result = buildTaskPlanningSection(true, false);
    expect(result.length).toBeGreaterThan(0);
    const joined = result.join("\n");
    expect(joined).toContain("## Task Planning");
    expect(joined).toContain("numbered steps");
    expect(joined).toContain("verify the result");
  });

  it("returns empty array when sepEnabled is false", () => {
    expect(buildTaskPlanningSection(false, false)).toEqual([]);
  });

  it("returns empty array when isMinimal is true", () => {
    expect(buildTaskPlanningSection(true, true)).toEqual([]);
  });

  it("returns empty array when both are false/true", () => {
    expect(buildTaskPlanningSection(false, true)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildPersonaSection
// ---------------------------------------------------------------------------

describe("buildPersonaSection", () => {
  it("returns empty when no SOUL.md in files", () => {
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "Agent instructions" },
    ];
    expect(buildPersonaSection(files)).toEqual([]);
  });

  it("returns empty for empty files array", () => {
    expect(buildPersonaSection([])).toEqual([]);
  });

  it("returns persona heading and content when SOUL.md present", () => {
    const files: BootstrapContextFile[] = [
      { path: "SOUL.md", content: "Be cheerful and helpful." },
    ];
    const result = buildPersonaSection(files);
    const joined = result.join("\n");
    expect(joined).toContain("## Persona");
    expect(joined).toContain("persona definition");
    expect(joined).toContain("Be cheerful and helpful.");
  });

  it("handles case-insensitive match (soul.md)", () => {
    const files: BootstrapContextFile[] = [
      { path: "soul.md", content: "Be witty." },
    ];
    const result = buildPersonaSection(files);
    const joined = result.join("\n");
    expect(joined).toContain("## Persona");
    expect(joined).toContain("Be witty.");
  });

  it("ignores non-SOUL files", () => {
    const files: BootstrapContextFile[] = [
      { path: "TOOLS.md", content: "Tool info." },
      { path: "SOUL.md", content: "Be fun." },
    ];
    const result = buildPersonaSection(files);
    const joined = result.join("\n");
    expect(joined).toContain("Be fun.");
    expect(joined).not.toContain("Tool info.");
  });
});

// ---------------------------------------------------------------------------
// buildProjectContextSection
// ---------------------------------------------------------------------------

describe("buildProjectContextSection", () => {
  it("returns empty for empty files array", () => {
    expect(buildProjectContextSection([], false)).toEqual([]);
  });

  it("returns Project Context heading with file path and content", () => {
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "Agent instructions here" },
    ];
    const result = buildProjectContextSection(files, false);
    const joined = result.join("\n");
    expect(joined).toContain("## Project Context");
    expect(joined).toContain("### AGENTS.md");
    expect(joined).toContain("Agent instructions here");
  });

  it("skips SOUL.md files (handled by buildPersonaSection)", () => {
    const files: BootstrapContextFile[] = [
      { path: "SOUL.md", content: "Be cheerful and helpful." },
    ];
    const result = buildProjectContextSection(files, false);
    expect(result).toEqual([]);
  });

  it("skips SOUL.md case-insensitively", () => {
    const files: BootstrapContextFile[] = [
      { path: "soul.md", content: "Be witty." },
    ];
    const result = buildProjectContextSection(files, false);
    expect(result).toEqual([]);
  });

  it("does NOT inject persona for non-SOUL files", () => {
    const files: BootstrapContextFile[] = [
      { path: "TOOLS.md", content: "Tool info." },
    ];
    const result = buildProjectContextSection(files, false);
    const joined = result.join("\n");
    expect(joined).not.toContain("persona definition");
    expect(joined).toContain("Tool info.");
  });

  it("handles multiple files, skipping SOUL.md", () => {
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "Agents" },
      { path: "SOUL.md", content: "Soul" },
      { path: "TOOLS.md", content: "Tools" },
    ];
    const result = buildProjectContextSection(files, false);
    const joined = result.join("\n");
    expect(joined).toContain("### AGENTS.md");
    expect(joined).not.toContain("### SOUL.md");
    expect(joined).toContain("### TOOLS.md");
  });
});

// ---------------------------------------------------------------------------
// buildProjectContextSection excludeFiles
// ---------------------------------------------------------------------------

describe("buildProjectContextSection excludeFiles", () => {
  it("excludeFiles containing 'BOOTSTRAP.md' skips that file from output", () => {
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "Agents" },
      { path: "BOOTSTRAP.md", content: "Bootstrap content" },
      { path: "TOOLS.md", content: "Tools" },
    ];
    const result = buildProjectContextSection(files, false, new Set(["BOOTSTRAP.md"]));
    const joined = result.join("\n");
    expect(joined).toContain("### AGENTS.md");
    expect(joined).toContain("### TOOLS.md");
    expect(joined).not.toContain("### BOOTSTRAP.md");
    expect(joined).not.toContain("Bootstrap content");
  });

  it("empty Set preserves current behavior (all files included)", () => {
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "Agents" },
      { path: "BOOTSTRAP.md", content: "Bootstrap content" },
    ];
    const result = buildProjectContextSection(files, false, new Set());
    const joined = result.join("\n");
    expect(joined).toContain("### AGENTS.md");
    expect(joined).toContain("### BOOTSTRAP.md");
  });

  it("undefined excludeFiles preserves current behavior (backward compat)", () => {
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "Agents" },
      { path: "BOOTSTRAP.md", content: "Bootstrap content" },
    ];
    const result = buildProjectContextSection(files, false, undefined);
    const joined = result.join("\n");
    expect(joined).toContain("### AGENTS.md");
    expect(joined).toContain("### BOOTSTRAP.md");
  });

  it("multiple files in excludeFiles are all skipped", () => {
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "Agents" },
      { path: "BOOTSTRAP.md", content: "Bootstrap" },
      { path: "TOOLS.md", content: "Tools" },
      { path: "HEARTBEAT.md", content: "Heartbeat" },
    ];
    const result = buildProjectContextSection(files, false, new Set(["BOOTSTRAP.md", "HEARTBEAT.md"]));
    const joined = result.join("\n");
    expect(joined).toContain("### AGENTS.md");
    expect(joined).toContain("### TOOLS.md");
    expect(joined).not.toContain("### BOOTSTRAP.md");
    expect(joined).not.toContain("### HEARTBEAT.md");
  });
});

// ---------------------------------------------------------------------------
// buildSubagentContextSection
// ---------------------------------------------------------------------------

describe("buildSubagentContextSection", () => {
  it("returns empty for undefined", () => {
    expect(buildSubagentContextSection(undefined)).toEqual([]);
  });

  it("returns empty for empty string (falsy)", () => {
    expect(buildSubagentContextSection("")).toEqual([]);
  });

  it("returns Additional Context heading with prompt content", () => {
    const result = buildSubagentContextSection("Do task X");
    expect(result).toEqual(["## Additional Context", "Do task X"]);
  });
});

// ---------------------------------------------------------------------------
// buildSubagentRoleSection
// ---------------------------------------------------------------------------

describe("buildSubagentRoleSection", () => {
  it("returns empty for undefined params", () => {
    expect(buildSubagentRoleSection(undefined)).toEqual([]);
  });

  it("includes Subagent Role heading and task text", () => {
    const result = buildSubagentRoleSection({ task: "Analyze logs" });
    const joined = result.join("\n");
    expect(joined).toContain("## Subagent Role");
    expect(joined).toContain("Analyze logs");
  });

  it("uses 'main agent' as parent label at depth 1", () => {
    const result = buildSubagentRoleSection({ task: "Task", depth: 1 });
    const joined = result.join("\n");
    expect(joined).toContain("main agent");
  });

  it("uses 'parent orchestrator' as parent label at depth >= 2", () => {
    const result = buildSubagentRoleSection({ task: "Task", depth: 2 });
    const joined = result.join("\n");
    expect(joined).toContain("parent orchestrator");
  });

  it("uses 'parent orchestrator' at depth 3", () => {
    const result = buildSubagentRoleSection({ task: "Task", depth: 3 });
    const joined = result.join("\n");
    expect(joined).toContain("parent orchestrator");
  });

  it("includes CAN spawn when depth < maxSpawnDepth", () => {
    const result = buildSubagentRoleSection({
      task: "Task",
      depth: 1,
      maxSpawnDepth: 3,
    });
    const joined = result.join("\n");
    expect(joined).toContain("Sub-Agent Spawning");
    expect(joined).toContain("You CAN spawn");
  });

  it("includes leaf worker message when depth >= maxSpawnDepth", () => {
    const result = buildSubagentRoleSection({
      task: "Task",
      depth: 3,
      maxSpawnDepth: 3,
    });
    const joined = result.join("\n");
    expect(joined).toContain("leaf worker");
    expect(joined).toContain("CANNOT spawn");
  });

  it("includes Additional Context when extraContext provided", () => {
    const result = buildSubagentRoleSection({
      task: "Task",
      extraContext: "Extra info here",
    });
    const joined = result.join("\n");
    expect(joined).toContain("### Additional Context");
    expect(joined).toContain("Extra info here");
  });

  it("omits Additional Context when extraContext not provided", () => {
    const result = buildSubagentRoleSection({ task: "Task" });
    const joined = result.join("\n");
    expect(joined).not.toContain("### Additional Context");
  });
});

// ---------------------------------------------------------------------------
// buildPostCompactionRecoverySection
// ---------------------------------------------------------------------------

describe("buildPostCompactionRecoverySection", () => {
  const agentsMdWithSections: BootstrapContextFile = {
    path: "AGENTS.md",
    content: [
      "# AGENTS.md",
      "",
      "## Session Startup",
      "Do startup things. Read workspace files.",
      "",
      "## Red Lines",
      "Never reveal secrets.",
      "",
      "## Other Section",
      "Some other content.",
    ].join("\n"),
  };

  it("returns empty when isMinimal is true", () => {
    expect(buildPostCompactionRecoverySection([agentsMdWithSections], true)).toEqual([]);
  });

  it("returns empty when no AGENTS.md in files", () => {
    const files: BootstrapContextFile[] = [
      { path: "SOUL.md", content: "Be helpful." },
    ];
    expect(buildPostCompactionRecoverySection(files, false)).toEqual([]);
  });

  it("returns empty when AGENTS.md content starts with '[MISSING]'", () => {
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "[MISSING] File not found." },
    ];
    expect(buildPostCompactionRecoverySection(files, false)).toEqual([]);
  });

  it("returns empty when configured sections not found in content", () => {
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "## Unrelated Section\nSome stuff." },
    ];
    expect(buildPostCompactionRecoverySection(files, false)).toEqual([]);
  });

  it("returns recovery section with extracted content when sections match", () => {
    const result = buildPostCompactionRecoverySection([agentsMdWithSections], false);
    const joined = result.join("\n");
    expect(joined).toContain("Do startup things");
    expect(joined).toContain("Never reveal secrets");
  });

  it("includes 'Re-execute your startup sequence' instruction text", () => {
    const result = buildPostCompactionRecoverySection([agentsMdWithSections], false);
    const joined = result.join("\n");
    expect(joined).toContain("Re-execute your startup sequence");
  });

  it("includes 'Post-Compaction Recovery' heading", () => {
    const result = buildPostCompactionRecoverySection([agentsMdWithSections], false);
    expect(result[0]).toBe("## Post-Compaction Recovery");
  });

  it("uses custom sectionNames when provided", () => {
    const result = buildPostCompactionRecoverySection(
      [agentsMdWithSections],
      false,
      ["Other Section"],
    );
    const joined = result.join("\n");
    expect(joined).toContain("Some other content.");
    expect(joined).not.toContain("Do startup things");
  });

  it("truncates combined content exceeding MAX_POST_COMPACTION_CHARS", () => {
    const longContent = "x".repeat(MAX_POST_COMPACTION_CHARS + 500);
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: `## Session Startup\n${longContent}` },
    ];
    const result = buildPostCompactionRecoverySection(files, false);
    const joined = result.join("\n");
    expect(joined).toContain("...[truncated]...");
    // The combined section content should not exceed MAX_POST_COMPACTION_CHARS + truncation marker
    const combinedIdx = joined.indexOf("Critical instructions from AGENTS.md:");
    const afterCritical = joined.slice(combinedIdx);
    expect(afterCritical.length).toBeLessThan(MAX_POST_COMPACTION_CHARS + 200);
  });
});

// ---------------------------------------------------------------------------
// buildProjectContextSection: isTemplateOnly behavior
// ---------------------------------------------------------------------------

describe("buildProjectContextSection isTemplateOnly", () => {
  it("excludes template-only ROLE.md from output", () => {
    const templateContent = [
      "<!-- COMIS-TEMPLATE -->",
      "# ROLE.md - Your Role",
      "",
      "_(Define what this agent does and how it operates.)_",
      "",
      "## Purpose",
      "",
      "_(What is this agent's primary function?)_",
      "",
      "## Behavioral Guidelines",
      "",
      "_(How should this agent approach its work?)_",
    ].join("\n");

    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "Agent instructions" },
      { path: "ROLE.md", content: templateContent },
    ];
    const result = buildProjectContextSection(files, false);
    const joined = result.join("\n");
    expect(joined).toContain("### AGENTS.md");
    expect(joined).not.toContain("### ROLE.md");
  });

  it("includes ROLE.md with real user content after AGENTS.md", () => {
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "Agent instructions" },
      { path: "ROLE.md", content: "# Custom Role\nYou are a trading analyst." },
    ];
    const result = buildProjectContextSection(files, false);
    const joined = result.join("\n");
    expect(joined).toContain("### AGENTS.md");
    expect(joined).toContain("### ROLE.md");
    expect(joined).toContain("trading analyst");

    // ROLE.md appears after AGENTS.md
    const agentsIdx = joined.indexOf("### AGENTS.md");
    const roleIdx = joined.indexOf("### ROLE.md");
    expect(roleIdx).toBeGreaterThan(agentsIdx);
  });

  it("returns false for content without template marker (user-written)", () => {
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "Agent instructions" },
      { path: "ROLE.md", content: "No marker here — just role content." },
    ];
    const result = buildProjectContextSection(files, false);
    const joined = result.join("\n");
    expect(joined).toContain("### ROLE.md");
    expect(joined).toContain("No marker here");
  });

  it("returns false for marker plus real user content", () => {
    const content = [
      "<!-- COMIS-TEMPLATE -->",
      "# ROLE.md - Your Role",
      "",
      "This agent is a code reviewer.",
      "It checks pull requests for security issues.",
    ].join("\n");
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "Agent instructions" },
      { path: "ROLE.md", content },
    ];
    const result = buildProjectContextSection(files, false);
    const joined = result.join("\n");
    expect(joined).toContain("### ROLE.md");
    expect(joined).toContain("code reviewer");
  });

  it("excludes [MISSING] ROLE.md from output", () => {
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "Agent instructions" },
      { path: "ROLE.md", content: "[MISSING] Expected at: /workspace/ROLE.md" },
    ];
    const result = buildProjectContextSection(files, false);
    const joined = result.join("\n");
    expect(joined).toContain("### AGENTS.md");
    expect(joined).not.toContain("### ROLE.md");
  });
});

// ---------------------------------------------------------------------------
// buildProjectContextSection: specialist profile
// ---------------------------------------------------------------------------

describe("buildProjectContextSection workspace profile", () => {
  it("full profile includes full AGENTS.md content", () => {
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "Full 9K platform instructions here with lots of detail" },
    ];
    const result = buildProjectContextSection(files, false, undefined, "full");
    const joined = result.join("\n");
    expect(joined).toContain("Full 9K platform instructions");
    expect(joined).not.toContain("Platform Instructions (Specialist)");
  });

  it("specialist profile uses minimal extract", () => {
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "Full 9K platform instructions here with lots of detail" },
    ];
    const result = buildProjectContextSection(files, false, undefined, "specialist");
    const joined = result.join("\n");
    expect(joined).toContain("Platform Instructions (Specialist)");
    expect(joined).not.toContain("Full 9K platform instructions");
  });

  it("specialist profile preserves ROLE.md composition", () => {
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "Full platform instructions" },
      { path: "ROLE.md", content: "You are a data analyst." },
    ];
    const result = buildProjectContextSection(files, false, undefined, "specialist");
    const joined = result.join("\n");
    expect(joined).toContain("Platform Instructions (Specialist)");
    expect(joined).toContain("### ROLE.md");
    expect(joined).toContain("data analyst");
  });

  it("undefined profile includes full AGENTS.md (backward compat)", () => {
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "Full instructions" },
    ];
    const result = buildProjectContextSection(files, false, undefined, undefined);
    const joined = result.join("\n");
    expect(joined).toContain("Full instructions");
    expect(joined).not.toContain("Platform Instructions (Specialist)");
  });
});

// ---------------------------------------------------------------------------
// buildSubagentRoleSection: Enriched SpawnPacket fields
// ---------------------------------------------------------------------------

describe("buildSubagentRoleSection (enriched fields)", () => {
  it("renders artifact refs as bullet list", () => {
    const result = buildSubagentRoleSection({
      task: "Review code",
      artifactRefs: ["/src/main.ts", "/src/utils.ts", "/config/settings.yaml"],
    });
    const joined = result.join("\n");
    expect(joined).toContain("### Artifact References");
    expect(joined).toContain("- /src/main.ts");
    expect(joined).toContain("- /src/utils.ts");
    expect(joined).toContain("- /config/settings.yaml");
    expect(joined).toContain("Read them as needed using your file tools");
  });

  it("renders objective section", () => {
    const result = buildSubagentRoleSection({
      task: "Fix bug",
      objective: "Ensure all error paths return Result<T,E>",
    });
    const joined = result.join("\n");
    expect(joined).toContain("### Objective");
    expect(joined).toContain("Ensure all error paths return Result<T,E>");
    expect(joined).toContain("Stay focused on this objective");
  });

  it("renders domain knowledge", () => {
    const result = buildSubagentRoleSection({
      task: "Write tests",
      domainKnowledge: ["Use vitest for all tests", "Co-locate test files with source"],
    });
    const joined = result.join("\n");
    expect(joined).toContain("### Domain Knowledge");
    expect(joined).toContain("Use vitest for all tests");
    expect(joined).toContain("Co-locate test files with source");
  });

  it("renders workspace directory", () => {
    const result = buildSubagentRoleSection({
      task: "Deploy",
      workspaceDir: "/home/agent/project",
    });
    const joined = result.join("\n");
    expect(joined).toContain("### Workspace");
    expect(joined).toContain("/home/agent/project");
    expect(joined).toContain("inherited from your parent agent");
  });

  it("renders parent summary", () => {
    const result = buildSubagentRoleSection({
      task: "Continue work",
      parentSummary: "The parent agent has completed steps 1-3 of the deployment pipeline.",
    });
    const joined = result.join("\n");
    expect(joined).toContain("### Parent Context");
    expect(joined).toContain("completed steps 1-3 of the deployment pipeline");
  });

  it("omits sections when fields are empty/undefined", () => {
    const result = buildSubagentRoleSection({ task: "Simple task" });
    const joined = result.join("\n");
    expect(joined).not.toContain("### Objective");
    expect(joined).not.toContain("### Artifact References");
    expect(joined).not.toContain("### Domain Knowledge");
    expect(joined).not.toContain("### Workspace");
    expect(joined).not.toContain("### Parent Context");
    // Core sections should still be present
    expect(joined).toContain("### Your Task");
    expect(joined).toContain("### Rules");
  });

  it("preserves existing depth-aware spawn hints alongside new fields", () => {
    const result = buildSubagentRoleSection({
      task: "Complex analysis",
      depth: 1,
      maxSpawnDepth: 3,
      objective: "Find bugs",
      artifactRefs: ["/src/app.ts"],
      domainKnowledge: ["TypeScript codebase"],
      workspaceDir: "/ws",
      parentSummary: "Parent completed setup.",
    });
    const joined = result.join("\n");

    // New enriched sections present
    expect(joined).toContain("### Objective");
    expect(joined).toContain("### Artifact References");
    expect(joined).toContain("### Domain Knowledge");
    expect(joined).toContain("### Workspace");
    expect(joined).toContain("### Parent Context");

    // Existing spawn section still works
    expect(joined).toContain("### Sub-Agent Spawning");
    expect(joined).toContain("You CAN spawn");

    // New sections appear BEFORE Rules
    const objectiveIdx = joined.indexOf("### Objective");
    const rulesIdx = joined.indexOf("### Rules");
    expect(objectiveIdx).toBeLessThan(rulesIdx);

    // Artifact refs appear BEFORE Rules
    const artifactIdx = joined.indexOf("### Artifact References");
    expect(artifactIdx).toBeLessThan(rulesIdx);
  });
});
