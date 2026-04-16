/**
 * Integration tests for the full bootstrap-to-prompt pipeline.
 *
 * Exercises real filesystem operations with temp directories to verify:
 * - All 7 workspace files loaded
 * - Per-file truncation with head+tail strategy
 * - Missing file [MISSING] markers
 * - Sub-agent filtering (AGENTS.md + TOOLS.md only)
 * - 15+ section assembly in full mode
 * - Prompt verbosity modes (full > minimal > none)
 * - Runtime metadata injection
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WORKSPACE_FILE_NAMES } from "../workspace/templates.js";
import {
  loadWorkspaceBootstrapFiles,
  buildBootstrapContextFiles,
  filterBootstrapFilesForSubAgent,
} from "./workspace-loader.js";
import { assembleRichSystemPrompt } from "./system-prompt-assembler.js";

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "comis-bootstrap-test-"),
  );
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Load all workspace files
// ---------------------------------------------------------------------------

describe("Load all workspace files", () => {
  it("loads all 8 workspace files when all exist", async () => {
    // Write all 9 files with distinct content (BOOT.md excluded from loading)
    for (const name of WORKSPACE_FILE_NAMES) {
      await fs.writeFile(path.join(tempDir, name), `# ${name} content`);
    }

    const files = await loadWorkspaceBootstrapFiles(tempDir);

    expect(files).toHaveLength(8);
    for (const file of files) {
      expect(file.missing).toBe(false);
      expect(file.content).toBe(`# ${file.name} content`);
      expect(WORKSPACE_FILE_NAMES).toContain(file.name);
    }
  });

  it("loads available files and marks absent ones", async () => {
    // Write only AGENTS.md and TOOLS.md
    await fs.writeFile(path.join(tempDir, "AGENTS.md"), "# Agent instructions");
    await fs.writeFile(path.join(tempDir, "TOOLS.md"), "# Tool notes");

    const files = await loadWorkspaceBootstrapFiles(tempDir);

    expect(files).toHaveLength(8);

    const agentsFile = files.find((f) => f.name === "AGENTS.md");
    expect(agentsFile?.missing).toBe(false);
    expect(agentsFile?.content).toBe("# Agent instructions");

    const toolsFile = files.find((f) => f.name === "TOOLS.md");
    expect(toolsFile?.missing).toBe(false);
    expect(toolsFile?.content).toBe("# Tool notes");

    // Remaining 6 should be missing
    const missingFiles = files.filter(
      (f) => f.name !== "AGENTS.md" && f.name !== "TOOLS.md",
    );
    expect(missingFiles).toHaveLength(6);
    for (const file of missingFiles) {
      expect(file.missing).toBe(true);
      expect(file.content).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Per-file truncation
// ---------------------------------------------------------------------------

describe("Per-file truncation", () => {
  it("truncates large workspace files at configurable limit", async () => {
    // Write SOUL.md with 50,000 chars
    const largeContent = "x".repeat(50_000);
    await fs.writeFile(path.join(tempDir, "SOUL.md"), largeContent);

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const contextFiles = buildBootstrapContextFiles(files, { maxChars: 1000 });

    const soulFile = contextFiles.find((f) => f.path === "SOUL.md");
    expect(soulFile).toBeDefined();
    expect(soulFile!.content.length).toBeLessThan(50_000);
    expect(soulFile!.content).toContain("[...truncated");
    // Head starts with x characters
    expect(soulFile!.content.startsWith("x")).toBe(true);
    // Tail ends with x characters
    expect(soulFile!.content.endsWith("x")).toBe(true);
  });

  it("does not truncate files under the limit", async () => {
    const shortContent = "a".repeat(100);
    await fs.writeFile(path.join(tempDir, "AGENTS.md"), shortContent);

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const contextFiles = buildBootstrapContextFiles(files, {
      maxChars: 20_000,
    });

    const agentsFile = contextFiles.find((f) => f.path === "AGENTS.md");
    expect(agentsFile).toBeDefined();
    expect(agentsFile!.content).toBe(shortContent);
  });
});

// ---------------------------------------------------------------------------
// Missing file markers
// ---------------------------------------------------------------------------

describe("Missing file markers", () => {
  it("missing files produce [MISSING] markers in assembled output", async () => {
    // Empty tempDir -- no workspace files exist
    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const contextFiles = buildBootstrapContextFiles(files);

    // All 8 should have [MISSING] markers (9 files minus BOOT.md)
    expect(contextFiles).toHaveLength(8);
    for (const cf of contextFiles) {
      expect(cf.content).toMatch(/^\[MISSING\] Expected at:/);
    }

    // Feed into assembler and verify markers appear in prompt
    const prompt = assembleRichSystemPrompt({
      promptMode: "full",
      bootstrapFiles: contextFiles,
      agentName: "TestBot",
    });

    expect(prompt).toContain("[MISSING]");
    expect(prompt).toContain("## Project Context");
  });
});

// ---------------------------------------------------------------------------
// Sub-agent bootstrap filtering
// ---------------------------------------------------------------------------

describe("Sub-agent bootstrap filtering", () => {
  it("sub-agent receives only AGENTS.md, ROLE.md, and TOOLS.md", async () => {
    // Write all 9 files with identifiable content
    for (const name of WORKSPACE_FILE_NAMES) {
      await fs.writeFile(
        path.join(tempDir, name),
        `Unique content for ${name}`,
      );
    }

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const filtered = filterBootstrapFilesForSubAgent(files);

    // Only 3 files in sub-agent context
    expect(filtered).toHaveLength(3);
    const filteredNames = filtered.map((f) => f.name);
    expect(filteredNames).toContain("AGENTS.md");
    expect(filteredNames).toContain("ROLE.md");
    expect(filteredNames).toContain("TOOLS.md");

    // Build context files and assemble minimal prompt
    const contextFiles = buildBootstrapContextFiles(filtered);
    const prompt = assembleRichSystemPrompt({
      promptMode: "minimal",
      bootstrapFiles: contextFiles,
      agentName: "SubBot",
      toolNames: ["tool1"],
      workspaceDir: tempDir,
      runtimeInfo: { host: "test" },
    });

    // Prompt contains sub-agent files
    expect(prompt).toContain("Unique content for AGENTS.md");
    expect(prompt).toContain("Unique content for TOOLS.md");

    // Prompt does NOT contain primary-agent-only files
    expect(prompt).not.toContain("Unique content for SOUL.md");
    expect(prompt).not.toContain("Unique content for USER.md");
    expect(prompt).not.toContain("Unique content for IDENTITY.md");
    expect(prompt).not.toContain("Unique content for HEARTBEAT.md");
    expect(prompt).not.toContain("Unique content for BOOTSTRAP.md");
    expect(prompt).not.toContain("Unique content for BOOT.md");
  });
});

// ---------------------------------------------------------------------------
// 15+ section assembly
// ---------------------------------------------------------------------------

describe("15+ section assembly", () => {
  it("full mode prompt contains all expected section headings", async () => {
    // Write all 7 files
    for (const name of WORKSPACE_FILE_NAMES) {
      await fs.writeFile(path.join(tempDir, name), `# ${name}`);
    }

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const contextFiles = buildBootstrapContextFiles(files);

    const prompt = assembleRichSystemPrompt({
      agentName: "SectionBot",
      promptMode: "full",
      toolNames: ["memory_search", "message"],
      hasMemoryTools: true,
      workspaceDir: tempDir,
      reasoningEnabled: true,
      skillsPrompt: "Available skills: web_search",
      heartbeatPrompt: "Check scheduled tasks",
      runtimeInfo: {
        host: "test-host",
        os: "linux",
        arch: "x64",
        model: "claude-test",
        agentId: "test-agent",
      },
      bootstrapFiles: contextFiles,
    });

    // Count sections by "---" separators + 1
    const separatorCount = (prompt.match(/\n\n---\n\n/g) ?? []).length;
    const sectionCount = separatorCount + 1;
    expect(sectionCount).toBeGreaterThanOrEqual(15);

    // Verify key section headings are present
    expect(prompt).toContain("## Safety");
    expect(prompt).toContain("## Available Tools");
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain("## Runtime");
    expect(prompt).toContain("## Project Context");
    expect(prompt).toContain("## Skills");
    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("## Reply Tags");
    expect(prompt).toContain("## Extended Thinking");
  });
});

// ---------------------------------------------------------------------------
// Prompt verbosity modes
// ---------------------------------------------------------------------------

describe("Prompt verbosity modes", () => {
  it("none mode returns minimal identity-only prompt", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "none",
      agentName: "NoneBot",
    });

    expect(result).toContain("NoneBot");
    // Single line, no section headings or separators
    expect(result).not.toContain("##");
    expect(result).not.toContain("---");
  });

  it("minimal mode includes subset of sections", async () => {
    // Write workspace files for context
    for (const name of WORKSPACE_FILE_NAMES) {
      await fs.writeFile(path.join(tempDir, name), `# ${name}`);
    }

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const contextFiles = buildBootstrapContextFiles(files);

    const result = assembleRichSystemPrompt({
      promptMode: "minimal",
      agentName: "MinBot",
      toolNames: ["read_file"],
      workspaceDir: tempDir,
      runtimeInfo: { host: "test", os: "linux", arch: "x64", model: "m" },
      bootstrapFiles: contextFiles,
    });

    // Included in minimal
    expect(result).toContain("## Available Tools");
    expect(result).toContain("## Runtime");
    expect(result).toContain("## Project Context");

    // Excluded in minimal
    expect(result).not.toContain("## Safety");
    expect(result).not.toContain("## Skills");
    expect(result).not.toContain("## Reply Tags");
  });

  it("full mode prompt is larger than minimal mode prompt", async () => {
    for (const name of WORKSPACE_FILE_NAMES) {
      await fs.writeFile(path.join(tempDir, name), `# ${name} content`);
    }

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const contextFiles = buildBootstrapContextFiles(files);

    const sharedParams = {
      agentName: "SizeBot",
      toolNames: ["tool1", "message"],
      workspaceDir: tempDir,
      runtimeInfo: { host: "h", os: "linux", arch: "x64", model: "m" },
      bootstrapFiles: contextFiles,
      hasMemoryTools: true,
      reasoningEnabled: true,
      skillsPrompt: "skills here",
      heartbeatPrompt: "heartbeat here",
    };

    const fullPrompt = assembleRichSystemPrompt({
      ...sharedParams,
      promptMode: "full",
    });
    const minimalPrompt = assembleRichSystemPrompt({
      ...sharedParams,
      promptMode: "minimal",
    });

    expect(fullPrompt.length).toBeGreaterThan(minimalPrompt.length);
  });
});

// ---------------------------------------------------------------------------
// Runtime metadata
// ---------------------------------------------------------------------------

describe("Runtime metadata", () => {
  it("runtime section contains host, OS, model, and thinking level", () => {
    const prompt = assembleRichSystemPrompt({
      promptMode: "full",
      agentName: "RuntimeBot",
      runtimeInfo: {
        host: "prod-server",
        os: "linux",
        arch: "arm64",
        model: "claude-opus",
        agentId: "agent-1",
        thinkingLevel: "extended",
      },
    });

    expect(prompt).toContain("host=prod-server");
    expect(prompt).toContain("os=linux (arm64)");
    expect(prompt).toContain("model=claude-opus");
    expect(prompt).toContain("thinking=extended");
  });
});

// ---------------------------------------------------------------------------
// End-to-end pipeline
// ---------------------------------------------------------------------------

describe("End-to-end pipeline", () => {
  it("full pipeline: load -> truncate -> assemble produces valid prompt", async () => {
    // Write 3 workspace files with varying sizes
    await fs.writeFile(
      path.join(tempDir, "AGENTS.md"),
      "a".repeat(100),
    );
    await fs.writeFile(
      path.join(tempDir, "SOUL.md"),
      "s".repeat(40_000),
    );
    await fs.writeFile(
      path.join(tempDir, "TOOLS.md"),
      "t".repeat(500),
    );

    // Load (all 8 slots excluding BOOT.md, 3 present + 5 missing)
    const files = await loadWorkspaceBootstrapFiles(tempDir);
    expect(files).toHaveLength(8);

    // Build context with truncation limit
    const contextFiles = buildBootstrapContextFiles(files, { maxChars: 5000 });

    // Assemble rich system prompt
    const prompt = assembleRichSystemPrompt({
      promptMode: "full",
      agentName: "PipelineBot",
      bootstrapFiles: contextFiles,
      runtimeInfo: {
        host: "test",
        os: "linux",
        arch: "x64",
        model: "test-model",
      },
      workspaceDir: tempDir,
    });

    // Prompt is non-empty
    expect(prompt.length).toBeGreaterThan(0);

    // Contains agent name
    expect(prompt).toContain("PipelineBot");

    // AGENTS.md (100 chars) is under 5000 limit -- not truncated
    expect(prompt).toContain("a".repeat(100));

    // SOUL.md (40K chars) was truncated to ~5K
    expect(prompt).toContain("[...truncated");

    // Missing files produce [MISSING] markers
    expect(prompt).toContain("[MISSING]");

    // Verify specific missing files are marked
    // ROLE.md is excluded here because it's composed after AGENTS.md, not as a standalone section
    const missingNames = ["IDENTITY.md", "USER.md", "HEARTBEAT.md", "BOOTSTRAP.md"];
    for (const name of missingNames) {
      // Each missing file should have its path mentioned in the MISSING marker
      expect(prompt).toContain(`### ${name}`);
    }
  });
});
