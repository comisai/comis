// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  buildSkillsSection,
  buildMemoryRecallSection,
  buildWorkspaceSection,
} from "./skills-memory-sections.js";

// ---------------------------------------------------------------------------
// buildSkillsSection
// ---------------------------------------------------------------------------

describe("buildSkillsSection", () => {
  it("returns empty for minimal mode", () => {
    expect(buildSkillsSection("skills prompt", true)).toEqual([]);
  });

  it("returns empty when no skillsPrompt and no prompt skills provided", () => {
    expect(buildSkillsSection(undefined, false)).toEqual([]);
  });

  it("returns Skills heading with scan instruction and prompt content (filesystem only)", () => {
    const result = buildSkillsSection("Available: code-review, deploy", false);
    const joined = result.join("\n");
    expect(joined).toContain("## Skills");
    expect(joined).toContain("scan the available skill descriptions");
    expect(joined).toContain("Available: code-review, deploy");
    // No subsection headers when only filesystem skills present
    expect(joined).not.toContain("### Filesystem Skills");
    expect(joined).not.toContain("### Prompt Skills");
  });

  it("with both skillsPrompt and promptSkillsXml uses subsection headers", () => {
    const result = buildSkillsSection(
      "code-review skill",
      false,
      '<available_skills><skill name="test"/></available_skills>',
    );
    const joined = result.join("\n");
    expect(joined).toContain("## Skills");
    expect(joined).toContain("### Filesystem Skills");
    expect(joined).toContain("code-review skill");
    expect(joined).toContain("### Prompt Skills");
    expect(joined).toContain("<available_skills>");
    expect(joined).toContain("resolve it against the skill directory");
  });

  it("with only promptSkillsXml (no skillsPrompt) has Prompt Skills subsection", () => {
    const xml = '<available_skills><skill name="test"/></available_skills>';
    const result = buildSkillsSection(undefined, false, xml);
    const joined = result.join("\n");
    expect(joined).toContain("## Skills");
    expect(joined).toContain("### Prompt Skills");
    expect(joined).toContain(xml);
    expect(joined).not.toContain("### Filesystem Skills");
  });

  it("with only activePromptSkillContent has Prompt Skills subsection", () => {
    const result = buildSkillsSection(undefined, false, undefined, "Active skill content");
    const joined = result.join("\n");
    expect(joined).toContain("## Skills");
    expect(joined).toContain("### Prompt Skills");
    expect(joined).toContain("Active skill content");
  });

  it("with skillsPrompt and activePromptSkillContent includes both", () => {
    const result = buildSkillsSection("fs-skills", false, undefined, "active content");
    const joined = result.join("\n");
    expect(joined).toContain("### Filesystem Skills");
    expect(joined).toContain("fs-skills");
    expect(joined).toContain("### Prompt Skills");
    expect(joined).toContain("active content");
  });

  it("isMinimal returns empty even with all args", () => {
    expect(buildSkillsSection("skills", true, "<xml/>", "active")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildMemoryRecallSection
// ---------------------------------------------------------------------------

describe("buildMemoryRecallSection", () => {
  it("returns empty for minimal mode", () => {
    expect(buildMemoryRecallSection(true, true)).toEqual([]);
  });

  it("returns empty when hasMemoryTools is false", () => {
    expect(buildMemoryRecallSection(false, false)).toEqual([]);
  });

  it("returns Memory heading with mandatory recall topics and tool descriptions", () => {
    const result = buildMemoryRecallSection(true, false);
    const joined = result.join("\n");
    expect(joined).toContain("## Memory");
    expect(joined).toContain("### Mandatory Recall");
    expect(joined).toContain("memory_search");
    expect(joined).toContain("memory_store");
    expect(joined).toContain("### When to Store");
  });

  it("includes secret storage prohibition in What to NEVER Store section", () => {
    const result = buildMemoryRecallSection(true, false);
    const joined = result.join("\n");
    expect(joined).toContain("### What to NEVER Store");
    expect(joined).toContain("Never store credentials");
    expect(joined).toContain("API keys");
    expect(joined).toContain("do not echo, repeat, or memorize its value");
  });

  it("includes Proactive Storage subsection with immediate storage guidance", () => {
    const result = buildMemoryRecallSection(true, false);
    const joined = result.join("\n");
    expect(joined).toContain("### Proactive Storage");
    expect(joined).toContain("store it immediately via memory_store");
    expect(joined).toContain("TOOLS.md");
  });

  it("includes WRONG/RIGHT recall anti-examples", () => {
    const result = buildMemoryRecallSection(true, false);
    const joined = result.join("\n");
    expect(joined).toContain("### Recall Anti-Patterns");
    expect(joined).toContain("WRONG:");
    expect(joined).toContain("RIGHT:");
    expect(joined).toContain("memory_search");
    expect(joined).toContain("general knowledge");
  });
});

// ---------------------------------------------------------------------------
// buildWorkspaceSection
// ---------------------------------------------------------------------------

describe("buildWorkspaceSection", () => {
  it("returns empty when no workspaceDir", () => {
    expect(buildWorkspaceSection(undefined, false)).toEqual([]);
  });

  it("returns Workspace heading with directory path", () => {
    const result = buildWorkspaceSection("/home/agent/ws", false);
    const joined = result.join("\n");
    expect(joined).toContain("## Workspace");
    expect(joined).toContain("/home/agent/ws");
  });

  it("works in minimal mode (isMinimal is unused)", () => {
    const result = buildWorkspaceSection("/home/agent/ws", true);
    expect(result.length).toBeGreaterThan(0);
    expect(result.join("\n")).toContain("/home/agent/ws");
  });
});
