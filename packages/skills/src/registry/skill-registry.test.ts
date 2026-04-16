/**
 * Tests for skill discovery and skill registry (progressive disclosure).
 *
 * Uses temporary directories with SKILL.md files to test filesystem discovery,
 * deduplication, prompt skill loading, and accessor methods.
 * Also tests ignore file support, collision diagnostics, and symlink deduplication.
 */

import type { TypedEventBus } from "@comis/core";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSkillManifest } from "../manifest/parser.js";
import { discoverSkills } from "./discovery.js";
import { createSkillRegistry } from "./skill-registry.js";
import { createMockEventBus as _createMockEventBus } from "../../../../test/support/mock-event-bus.js";

function createMockEventBus(): TypedEventBus & { events: { name: string; payload: unknown }[] } {
  const events: { name: string; payload: unknown }[] = [];
  const bus = _createMockEventBus({
    emit: vi.fn((name: string, payload: unknown) => { events.push({ name, payload }); }) as any,
  });
  return Object.assign(bus, { events });
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "comis-registry-test-"));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

/** Create a SKILL.md file in a named subdirectory. */
function createSkill(
  basePath: string,
  dirName: string,
  skillMd: string,
  entryCode?: string,
): string {
  const skillDir = path.join(basePath, dirName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMd, "utf-8");
  if (entryCode !== undefined) {
    fs.writeFileSync(path.join(skillDir, "index.js"), entryCode, "utf-8");
  }
  return skillDir;
}

/** Create a minimal valid SKILL.md content string. */
function makeSkillMd(name: string, description: string, entry = "index.js"): string {
  return `---
name: ${name}
description: "${description}"
type: code
entry: ${entry}
---

# ${name}

${description}
`;
}
/** Create a root .md prompt skill file in a directory. */
function createPromptSkill(
  basePath: string,
  name: string,
  description: string,
  body: string,
  opts?: { userInvocable?: boolean; disableModelInvocation?: boolean; argumentHint?: string; allowedTools?: string[] },
): void {
  const content = `---
name: ${name}
description: "${description}"
type: prompt
userInvocable: ${opts?.userInvocable ?? true}
disableModelInvocation: ${opts?.disableModelInvocation ?? false}
${opts?.allowedTools ? `allowedTools:\n${opts.allowedTools.map((t) => `  - ${t}`).join("\n")}` : ""}
${opts?.argumentHint ? `argumentHint: "${opts.argumentHint}"` : ""}
---

${body}
`;
  fs.writeFileSync(path.join(basePath, `${name}.md`), content, "utf-8");
}

/** Create a root .md prompt skill file with extended frontmatter fields. */
function createPromptSkillWithNewFields(
  basePath: string,
  name: string,
  description: string,
  body: string,
  fields: {
    os?: string | string[];
    requires?: { bins?: string[]; env?: string[] };
    skillKey?: string;
    primaryEnv?: string;
    commandDispatch?: string;
  },
): void {
  const comisLines: string[] = [];

  if (fields.os !== undefined) {
    if (typeof fields.os === "string") {
      comisLines.push(`  os: ${fields.os}`);
    } else {
      comisLines.push(`  os:\n${fields.os.map((v) => `    - ${v}`).join("\n")}`);
    }
  }

  if (fields.requires) {
    let reqLines = "  requires:";
    if (fields.requires.bins && fields.requires.bins.length > 0) {
      reqLines += `\n    bins:\n${fields.requires.bins.map((b) => `      - ${b}`).join("\n")}`;
    }
    if (fields.requires.env && fields.requires.env.length > 0) {
      reqLines += `\n    env:\n${fields.requires.env.map((e) => `      - ${e}`).join("\n")}`;
    }
    comisLines.push(reqLines);
  }

  if (fields.skillKey !== undefined) {
    comisLines.push(`  skill-key: "${fields.skillKey}"`);
  }
  if (fields.primaryEnv !== undefined) {
    comisLines.push(`  primary-env: ${fields.primaryEnv}`);
  }
  if (fields.commandDispatch !== undefined) {
    comisLines.push(`  command-dispatch: ${fields.commandDispatch}`);
  }

  const comisYaml = comisLines.length > 0
    ? `comis:\n${comisLines.join("\n")}`
    : "";

  const content = `---
name: ${name}
description: "${description}"
type: prompt
${comisYaml}
---

${body}
`;
  fs.writeFileSync(path.join(basePath, `${name}.md`), content, "utf-8");
}

/** Create a SkillsConfig with promptSkills defaults included. */
function makeConfig(discoveryPaths: string[]) {
  return {
    discoveryPaths,
    builtinTools: { read: true, write: true, edit: true, grep: true, find: true, ls: true, exec: false, process: false, webSearch: false, webFetch: false, browser: false },

    promptSkills: { maxBodyLength: 20000, enableDynamicContext: false, maxAutoInject: 3 },
  };
}

const auditCtx = { agentId: "test-agent", tenantId: "test-tenant", userId: "test-user" };

// ---------------------------------------------------------------------------
// discoverSkills tests
// ---------------------------------------------------------------------------

describe("discoverSkills", () => {
  it("finds skills in a directory", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    createSkill(skillsDir, "hello", makeSkillMd("hello", "Say hello to the world"));
    createSkill(skillsDir, "goodbye", makeSkillMd("goodbye", "Say goodbye"));

    const { skills: result } = discoverSkills([skillsDir]);
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.name).sort()).toEqual(["goodbye", "hello"]);
    expect(result[0].source).toBe("bundled"); // single path = bundled
  });

  it("deduplicates by name (first-loaded-wins)", () => {
    const path1 = path.join(tmpDir, "bundled");
    const path2 = path.join(tmpDir, "local");
    fs.mkdirSync(path1, { recursive: true });
    fs.mkdirSync(path2, { recursive: true });

    createSkill(path1, "calc", makeSkillMd("calc", "Basic calculator v1"));
    createSkill(path2, "calc", makeSkillMd("calc", "Advanced calculator v2"));

    const { skills: result, diagnostics } = discoverSkills([path1, path2]);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("Basic calculator v1");
    expect(result[0].source).toBe("bundled"); // first path wins

    // Collision diagnostic emitted
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].type).toBe("collision");
    expect(diagnostics[0].collision?.winnerPath).toContain("bundled");
    expect(diagnostics[0].collision?.loserPath).toContain("local");
  });

  it("skips missing paths without error", () => {
    const existing = path.join(tmpDir, "exists");
    fs.mkdirSync(existing, { recursive: true });
    createSkill(existing, "test-skill", makeSkillMd("test-skill", "A test skill"));

    const { skills: result } = discoverSkills([path.join(tmpDir, "nonexistent-path"), existing]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("test-skill");
  });

  it("skips malformed SKILL.md files and logs via logger", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Valid
    createSkill(skillsDir, "good", makeSkillMd("good", "A good skill"));

    // Malformed: no frontmatter
    const badDir = path.join(skillsDir, "bad");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "SKILL.md"), "no frontmatter here", "utf-8");

    const mockLogger = { warn: vi.fn() };

    const { skills: result } = discoverSkills([skillsDir], mockLogger);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("good");
    expect(mockLogger.warn).toHaveBeenCalledOnce();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        skillPath: expect.stringContaining("bad"),
        hint: expect.any(String),
        errorKind: "validation",
      }),
      "Skipping malformed skill file",
    );
  });

  it("assigns correct source categories for 3 paths", () => {
    const bundled = path.join(tmpDir, "bundled");
    const workspace = path.join(tmpDir, "workspace");
    const local = path.join(tmpDir, "local");
    [bundled, workspace, local].forEach((d) => fs.mkdirSync(d, { recursive: true }));

    createSkill(bundled, "a", makeSkillMd("a", "Bundled skill"));
    createSkill(workspace, "b", makeSkillMd("b", "Workspace skill"));
    createSkill(local, "c", makeSkillMd("c", "Local skill"));

    const { skills: result } = discoverSkills([bundled, workspace, local]);
    const byName = new Map(result.map((s) => [s.name, s]));

    expect(byName.get("a")!.source).toBe("bundled");
    expect(byName.get("b")!.source).toBe("workspace");
    expect(byName.get("c")!.source).toBe("local");
  });

  it("discovers root .md files in skills directory", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Create a root .md prompt skill
    const promptContent = `---
name: my-prompt
description: "A prompt-based skill"
type: prompt
---

You are a helpful assistant.
`;
    fs.writeFileSync(path.join(skillsDir, "my-prompt.md"), promptContent, "utf-8");

    const { skills: result } = discoverSkills([skillsDir]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("my-prompt");
    expect(result[0].type).toBe("prompt");
    expect(result[0].path).toBe(skillsDir);
  });

  it("discovers both root .md and subdirectory SKILL.md", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Root .md prompt skill
    const promptContent = `---
name: helper
description: "A prompt helper"
type: prompt
userInvocable: true
argumentHint: "[topic]"
---

Help the user with a topic.
`;
    fs.writeFileSync(path.join(skillsDir, "helper.md"), promptContent, "utf-8");

    // Subdirectory code skill
    createSkill(skillsDir, "calculator", makeSkillMd("calculator", "Math calculations"));

    const { skills: result } = discoverSkills([skillsDir]);
    expect(result).toHaveLength(2);
    const byName = new Map(result.map((s) => [s.name, s]));
    expect(byName.has("helper")).toBe(true);
    expect(byName.has("calculator")).toBe(true);
    expect(byName.get("helper")!.type).toBe("prompt");
    expect(byName.get("calculator")!.type).toBe("prompt");
  });

  it("discovers recursive SKILL.md in subdirectories", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Nested subdirectory: skills/category/my-skill/SKILL.md
    const nestedDir = path.join(skillsDir, "category", "my-skill");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(
      path.join(nestedDir, "SKILL.md"),
      makeSkillMd("my-skill", "A nested skill"),
      "utf-8",
    );

    const { skills: result } = discoverSkills([skillsDir]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("my-skill");
    expect(result[0].path).toBe(nestedDir);
  });

  it("SkillMetadata includes type field always as prompt", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    createSkill(skillsDir, "basic", makeSkillMd("basic", "A basic code skill"));

    const { skills: result } = discoverSkills([skillsDir]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("prompt");
    expect(result[0].userInvocable).toBe(true);
    expect(result[0].disableModelInvocation).toBe(false);
    expect(result[0].argumentHint).toBeUndefined();
  });

  it("SkillMetadata includes prompt skill fields", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    const promptContent = `---
name: greeter
description: "Greet the user warmly"
type: prompt
userInvocable: true
disableModelInvocation: true
argumentHint: "[name]"
---

Greet the user by name.
`;
    fs.writeFileSync(path.join(skillsDir, "greeter.md"), promptContent, "utf-8");

    const { skills: result } = discoverSkills([skillsDir]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("prompt");
    expect(result[0].userInvocable).toBe(true);
    expect(result[0].disableModelInvocation).toBe(true);
    expect(result[0].argumentHint).toBe("[name]");
  });

  it("skips dotfiles and node_modules during recursive scan", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Create valid skill
    createSkill(skillsDir, "good-skill", makeSkillMd("good-skill", "A valid skill"));

    // Create hidden directory with SKILL.md (should be skipped)
    const hiddenDir = path.join(skillsDir, ".hidden", "secret-skill");
    fs.mkdirSync(hiddenDir, { recursive: true });
    fs.writeFileSync(
      path.join(hiddenDir, "SKILL.md"),
      makeSkillMd("secret-skill", "Should be skipped"),
      "utf-8",
    );

    // Create node_modules directory with SKILL.md (should be skipped)
    const nmDir = path.join(skillsDir, "node_modules", "pkg-skill");
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(
      path.join(nmDir, "SKILL.md"),
      makeSkillMd("pkg-skill", "Should be skipped"),
      "utf-8",
    );

    const { skills: result } = discoverSkills([skillsDir]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("good-skill");
  });

  // -------------------------------------------------------------------------
  // Ignore file tests
  // -------------------------------------------------------------------------

  it("respects .gitignore files", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Create .gitignore that ignores a skill directory
    fs.writeFileSync(path.join(skillsDir, ".gitignore"), "ignored-skill/\n", "utf-8");

    // Create ignored skill
    createSkill(skillsDir, "ignored-skill", makeSkillMd("ignored-skill", "Should be ignored"));

    // Create allowed skill
    createSkill(skillsDir, "allowed-skill", makeSkillMd("allowed-skill", "Should be found"));

    const { skills: result } = discoverSkills([skillsDir]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("allowed-skill");
  });

  it("respects .ignore and .fdignore files", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Create .ignore that hides a directory
    fs.writeFileSync(path.join(skillsDir, ".ignore"), "hidden/\n", "utf-8");

    // Create hidden skill
    createSkill(skillsDir, "hidden", makeSkillMd("hidden-skill", "Should be hidden"));

    // Create visible skill
    createSkill(skillsDir, "visible", makeSkillMd("visible-skill", "Should be visible"));

    const { skills: result } = discoverSkills([skillsDir]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("visible-skill");
  });

  it("handles negation patterns in .gitignore", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Ignore everything except "allowed/"
    fs.writeFileSync(
      path.join(skillsDir, ".gitignore"),
      "*/\n!allowed/\n",
      "utf-8",
    );

    // Create two skills
    createSkill(skillsDir, "blocked", makeSkillMd("blocked", "Should be blocked"));
    createSkill(skillsDir, "allowed", makeSkillMd("allowed", "Should be allowed"));

    const { skills: result } = discoverSkills([skillsDir]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("allowed");
  });

  // -------------------------------------------------------------------------
  // Collision diagnostics tests
  // -------------------------------------------------------------------------

  it("returns collision diagnostics for duplicate names", () => {
    const path1 = path.join(tmpDir, "first");
    const path2 = path.join(tmpDir, "second");
    fs.mkdirSync(path1, { recursive: true });
    fs.mkdirSync(path2, { recursive: true });

    createSkill(path1, "dupe", makeSkillMd("dupe", "First dupe"));
    createSkill(path2, "dupe", makeSkillMd("dupe", "Second dupe"));

    const { skills, diagnostics } = discoverSkills([path1, path2]);
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe("First dupe"); // first-loaded-wins

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].type).toBe("collision");
    expect(diagnostics[0].collision).toBeDefined();
    expect(diagnostics[0].collision!.resourceType).toBe("skill");
    expect(diagnostics[0].collision!.name).toBe("dupe");
    expect(diagnostics[0].collision!.winnerPath).toContain("first");
    expect(diagnostics[0].collision!.loserPath).toContain("second");
  });

  // -------------------------------------------------------------------------
  // Symlink deduplication tests
  // -------------------------------------------------------------------------

  it("deduplicates symlinks via realpath", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Create a real skill directory
    const realDir = path.join(skillsDir, "real-skill");
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(
      path.join(realDir, "SKILL.md"),
      makeSkillMd("sym-skill", "A symlink test skill"),
      "utf-8",
    );

    // Create a symlink pointing to the same directory
    const linkDir = path.join(skillsDir, "link-skill");
    try {
      fs.symlinkSync(realDir, linkDir, "dir");
    } catch {
      // Skip if symlinks not supported (unlikely on macOS/Linux)
      return;
    }

    const { skills: result, diagnostics } = discoverSkills([skillsDir]);
    // Only one skill returned -- symlink deduplicated silently (no collision diagnostic)
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("sym-skill");
    // No collision diagnostic for symlink dedup (it's a silent skip)
    expect(diagnostics.filter((d) => d.type === "collision")).toHaveLength(0);
  });

  it("handles broken symlinks gracefully", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Create a valid skill
    createSkill(skillsDir, "valid", makeSkillMd("valid", "A valid skill"));

    // Create a broken symlink (points to nonexistent target)
    const brokenLink = path.join(skillsDir, "broken-link");
    try {
      fs.symlinkSync(path.join(tmpDir, "nonexistent-target"), brokenLink);
    } catch {
      // Skip if symlinks not supported
      return;
    }

    const { skills: result } = discoverSkills([skillsDir]);

    // Discovery should complete without error, finding only the valid skill
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("valid");
  });

  // -------------------------------------------------------------------------
  // Extended frontmatter field discovery tests
  // -------------------------------------------------------------------------

  it("discovers new frontmatter fields (os, requires, skill-key, primary-env, command-dispatch)", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkillWithNewFields(
      skillsDir,
      "full-fields",
      "A skill with all new fields",
      "Test body content.",
      {
        os: ["linux", "darwin"],
        requires: { bins: ["ffmpeg"], env: ["OPENAI_KEY"] },
        skillKey: "my-test-skill",
        primaryEnv: "OPENAI_KEY",
        commandDispatch: "tool",
      },
    );

    const { skills: result } = discoverSkills([skillsDir]);
    expect(result).toHaveLength(1);

    const skill = result[0];
    expect(skill.os).toEqual(["linux", "darwin"]);
    expect(skill.requires).toEqual({ bins: ["ffmpeg"], env: ["OPENAI_KEY"] });
    expect(skill.skillKey).toBe("my-test-skill");
    expect(skill.primaryEnv).toBe("OPENAI_KEY");
    expect(skill.commandDispatch).toBe("tool");
  });

  it("coerces os string to array in discovery", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkillWithNewFields(
      skillsDir,
      "os-string",
      "A skill with os as string",
      "Test body.",
      { os: "linux" },
    );

    const { skills: result } = discoverSkills([skillsDir]);
    expect(result).toHaveLength(1);
    expect(result[0].os).toEqual(["linux"]);
  });

  it("normalizes os values to lowercase in discovery", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkillWithNewFields(
      skillsDir,
      "os-case",
      "A skill with mixed case os",
      "Test body.",
      { os: ["Linux", "DARWIN"] },
    );

    const { skills: result } = discoverSkills([skillsDir]);
    expect(result).toHaveLength(1);
    expect(result[0].os).toEqual(["linux", "darwin"]);
  });

  it("coerces skill-key to slug format in discovery", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkillWithNewFields(
      skillsDir,
      "slug-test",
      "A skill with non-slug key",
      "Test body.",
      { skillKey: "My Skill Tool" },
    );

    const { skills: result } = discoverSkills([skillsDir]);
    expect(result).toHaveLength(1);
    expect(result[0].skillKey).toBe("my-skill-tool");
  });

  it("existing SKILL.md without new fields has undefined for new metadata fields", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Use existing-style SKILL.md (name + description only)
    createSkill(skillsDir, "legacy", makeSkillMd("legacy", "A legacy skill"));

    const { skills: result } = discoverSkills([skillsDir]);
    expect(result).toHaveLength(1);

    const skill = result[0];
    expect(skill.os).toBeUndefined();
    expect(skill.requires).toBeUndefined();
    expect(skill.skillKey).toBeUndefined();
    expect(skill.primaryEnv).toBeUndefined();
    expect(skill.commandDispatch).toBeUndefined();
  });

  it("skill-key collision detection (last-loaded-wins with WARN log)", () => {
    const path1 = path.join(tmpDir, "first");
    const path2 = path.join(tmpDir, "second");
    fs.mkdirSync(path1, { recursive: true });
    fs.mkdirSync(path2, { recursive: true });

    // Two skills with different names but same skill-key
    createPromptSkillWithNewFields(
      path1,
      "skill-alpha",
      "First skill",
      "Body alpha.",
      { skillKey: "shared-key" },
    );
    createPromptSkillWithNewFields(
      path2,
      "skill-beta",
      "Second skill",
      "Body beta.",
      { skillKey: "shared-key" },
    );

    const mockLogger = { warn: vi.fn() };

    const { skills: result } = discoverSkills([path1, path2], mockLogger);

    // Both skills are present (different names, no name collision)
    expect(result).toHaveLength(2);
    const names = result.map((s) => s.name).sort();
    expect(names).toEqual(["skill-alpha", "skill-beta"]);

    // WARN log called for skill-key collision
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        skillKey: "shared-key",
        existingPath: expect.stringContaining("first"),
        newPath: expect.stringContaining("second"),
        hint: expect.any(String),
        errorKind: "config",
      }),
      "Skill-key collision detected",
    );
  });
});

// ---------------------------------------------------------------------------
// SkillRegistry tests
// ---------------------------------------------------------------------------

describe("createSkillRegistry", () => {
  // -------------------------------------------------------------------------
  // Diagnostics returned from init()
  // -------------------------------------------------------------------------

  it("returns diagnostics alongside skills from init()", () => {
    const path1 = path.join(tmpDir, "first");
    const path2 = path.join(tmpDir, "second");
    fs.mkdirSync(path1, { recursive: true });
    fs.mkdirSync(path2, { recursive: true });

    // Create duplicate skill names across two paths
    createSkill(path1, "dup-skill", makeSkillMd("dup-skill", "First version"));
    createSkill(path2, "dup-skill", makeSkillMd("dup-skill", "Second version"));

    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(
      {
        discoveryPaths: [path1, path2],
        builtinTools: { read: true, write: true, edit: true, grep: true, find: true, ls: true, exec: false, process: false, webSearch: false, webFetch: false, browser: false },
    
      },
      eventBus,
      auditCtx,
      mockLogger,
    );
    registry.init();

    // Only one skill registered (first-loaded-wins)
    expect(registry.getMetadataCount()).toBe(1);

    // logger.warn was called with collision structured fields
    expect(mockLogger.warn).toHaveBeenCalledOnce();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        collision: expect.objectContaining({
          winnerPath: expect.stringContaining("first"),
          loserPath: expect.stringContaining("second"),
        }),
        hint: expect.any(String),
        errorKind: "config",
      }),
      "Skill name collision",
    );
  });

  // -------------------------------------------------------------------------
  // Prompt skill loading (loadPromptSkill)
  // -------------------------------------------------------------------------

  it("loadPromptSkill succeeds for a valid prompt skill", async () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(
      skillsDir,
      "code-helper",
      "A helpful coding assistant",
      "You are a helpful coding assistant.\n\nAlways explain your reasoning.",
    );

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const result = await registry.loadPromptSkill("code-helper");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.name).toBe("code-helper");
    expect(result.value.description).toBe("A helpful coding assistant");
    expect(result.value.body).toContain("You are a helpful coding assistant.");
    expect(result.value.body).toContain("Always explain your reasoning.");
    expect(result.value.userInvocable).toBe(true);
    expect(result.value.source).toBe("bundled");
    // Body should not contain frontmatter markers
    expect(result.value.body).not.toContain("---");
  });

  it("loadPromptSkill caches result (second call returns same object)", async () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(skillsDir, "cached-skill", "A cached skill", "Cache me please.");

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const result1 = await registry.loadPromptSkill("cached-skill");
    const result2 = await registry.loadPromptSkill("cached-skill");
    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (result1.ok && result2.ok) {
      expect(result1.value).toBe(result2.value); // Reference equality
    }
  });

  it("loadPromptSkill returns err for unknown skill", async () => {
    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([]), eventBus, auditCtx);
    registry.init();

    const result = await registry.loadPromptSkill("nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("not found");
    }
  });

  it("loadPromptSkill extracts allowedTools from manifest", async () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(
      skillsDir,
      "tool-prompt",
      "A prompt with tool restrictions",
      "Use only these tools.",
      { allowedTools: ["exec", "read"] },
    );

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const result = await registry.loadPromptSkill("tool-prompt");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.allowedTools).toEqual(["exec", "read"]);
  });

  it("loadPromptSkill emits audit event", async () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(skillsDir, "audit-prompt", "A skill for audit testing", "Audit this body.");

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    await registry.loadPromptSkill("audit-prompt");

    // Check for audit:event emission
    const auditEvents = eventBus.events.filter((e) => e.name === "audit:event");
    expect(auditEvents.length).toBeGreaterThan(0);

    const auditPayload = auditEvents[0].payload as Record<string, unknown>;
    expect(auditPayload.actionType).toBe("skill.prompt.load");
    expect(auditPayload.outcome).toBe("success");

    const meta = auditPayload.metadata as Record<string, unknown>;
    expect(meta.skillName).toBe("audit-prompt");
    expect(typeof meta.bodyLength).toBe("number");
    expect(typeof meta.htmlCommentsStripped).toBe("number");
    expect(typeof meta.truncated).toBe("boolean");
  });

  // -------------------------------------------------------------------------
  // Prompt skill accessor methods
  // -------------------------------------------------------------------------

  it("getPromptSkillDescriptions returns all discovered skills", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // 2 prompt skills with different disableModelInvocation values
    createPromptSkill(skillsDir, "helper", "A helpful assistant", "Help the user.", {
      disableModelInvocation: false,
    });
    createPromptSkill(skillsDir, "secret", "A secret assistant", "Secret instructions.", {
      disableModelInvocation: true,
    });
    createSkill(skillsDir, "calculator", makeSkillMd("calculator", "Perform math calculations"));

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const descriptions = registry.getPromptSkillDescriptions();
    expect(descriptions).toHaveLength(3);

    const byName = new Map(descriptions.map((d) => [d.name, d]));
    expect(byName.has("helper")).toBe(true);
    expect(byName.has("secret")).toBe(true);
    expect(byName.has("calculator")).toBe(true);

    // Check field mapping
    expect(byName.get("helper")!.description).toBe("A helpful assistant");
    expect(byName.get("helper")!.location).toBeDefined();
    expect(byName.get("helper")!.disableModelInvocation).toBeUndefined(); // false maps to undefined
    expect(byName.get("secret")!.disableModelInvocation).toBe(true);
  });

  it("getPromptSkillDescriptions returns empty array when no skills exist", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Empty directory -- no skills at all
    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    expect(registry.getPromptSkillDescriptions()).toEqual([]);
  });

  it("getUserInvocableSkillNames returns skills where userInvocable is true", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // userInvocable = true (explicit)
    createPromptSkill(skillsDir, "invocable-explicit", "Explicit invocable", "Body.", {
      userInvocable: true,
    });
    // userInvocable = false
    createPromptSkill(skillsDir, "not-invocable", "Not invocable", "Body.", {
      userInvocable: false,
    });
    // userInvocable = true (default)
    createPromptSkill(skillsDir, "invocable-default", "Default invocable", "Body.");
    createSkill(skillsDir, "code-skill", makeSkillMd("code-skill", "A code skill"));

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const names = registry.getUserInvocableSkillNames();
    expect(names).toBeInstanceOf(Set);
    expect(names.size).toBe(3);
    expect(names.has("invocable-explicit")).toBe(true);
    expect(names.has("invocable-default")).toBe(true);
    expect(names.has("code-skill")).toBe(true);
    expect(names.has("not-invocable")).toBe(false);
  });

  it("getUserInvocableSkillNames returns empty set when no skills exist", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Empty directory -- no skills at all
    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const names = registry.getUserInvocableSkillNames();
    expect(names.size).toBe(0);
  });

  it("getRelevantPromptSkills returns matching skills", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(
      skillsDir,
      "code-reviewer",
      "Review code for bugs and style issues",
      "You review code.",
    );
    createPromptSkill(
      skillsDir,
      "test-writer",
      "Write unit tests for code",
      "You write tests.",
    );
    createPromptSkill(
      skillsDir,
      "translator",
      "Translate text between languages",
      "You translate text.",
    );
    createSkill(
      skillsDir,
      "code-formatter",
      makeSkillMd("code-formatter", "Format code according to style rules"),
    );

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const results = registry.getRelevantPromptSkills("review my code for style");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("code-reviewer");
    // All skills are now prompt type -- code-formatter can appear if relevant
    const codeFormatter = results.find((r) => r.name === "code-formatter");
    if (codeFormatter) {
      expect(codeFormatter.type).toBe("prompt");
    }
  });

  it("getRelevantPromptSkills respects maxResults parameter", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Create 5 prompt skills with overlapping descriptions
    for (let i = 1; i <= 5; i++) {
      createPromptSkill(
        skillsDir,
        `data-skill-${i}`,
        `Analyze data and generate reports for data processing pipeline ${i}`,
        `Skill ${i} body content about data analysis.`,
      );
    }

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const results = registry.getRelevantPromptSkills("analyze data and generate reports", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("getRelevantPromptSkills returns empty for unrelated query", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(
      skillsDir,
      "code-helper",
      "Help write TypeScript code",
      "You help with TypeScript.",
    );
    createPromptSkill(
      skillsDir,
      "test-helper",
      "Generate unit tests automatically",
      "You help with tests.",
    );

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const results = registry.getRelevantPromptSkills("cooking recipes dinner meals");
    expect(results).toHaveLength(0);
  });

  it("getRelevantPromptSkills uses config.promptSkills.maxAutoInject as default limit", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Create 5 prompt skills with matching descriptions
    for (let i = 1; i <= 5; i++) {
      createPromptSkill(
        skillsDir,
        `data-processor-${i}`,
        `Process data records and transform data files for batch ${i}`,
        `Body about data processing ${i}.`,
      );
    }

    const eventBus = createMockEventBus();
    // Create config with maxAutoInject = 2
    const configWith2 = {
      discoveryPaths: [skillsDir],
      builtinTools: { read: true, write: true, edit: true, grep: true, find: true, ls: true, exec: false, process: false, webSearch: false, webFetch: false, browser: false },
  
      promptSkills: { maxBodyLength: 20000, enableDynamicContext: false, maxAutoInject: 2 },
    };
    const registry = createSkillRegistry(configWith2, eventBus, auditCtx);
    registry.init();

    // Call without explicit maxResults -- should use maxAutoInject (2)
    const results = registry.getRelevantPromptSkills("process data records and transform");
    expect(results.length).toBeLessThanOrEqual(2);
    expect(results.length).toBeGreaterThan(0); // Should find some matches
  });

  // -------------------------------------------------------------------------
  // Structured logging tests
  // -------------------------------------------------------------------------

  it("logs skill discovery count at INFO", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    createSkill(skillsDir, "skill-a", makeSkillMd("skill-a", "First skill"));
    createSkill(skillsDir, "skill-b", makeSkillMd("skill-b", "Second skill"));

    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx, mockLogger);
    registry.init();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillCount: 2 }),
      "Skills discovered",
    );
  });

  it("works without logger (backward compatible)", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    createSkill(skillsDir, "no-logger", makeSkillMd("no-logger", "No logger skill"));

    const eventBus = createMockEventBus();
    // No logger passed -- should not throw
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();
    expect(registry.getMetadataCount()).toBe(1);
  });

  // -------------------------------------------------------------------------
  // init() cache clearing bug fix
  // -------------------------------------------------------------------------

  it("init() clears promptCache", async () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Create a prompt skill and init registry
    createPromptSkill(skillsDir, "cache-test", "A cache test skill", "Original body content.");

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    // Load the skill (populates promptCache)
    const result1 = await registry.loadPromptSkill("cache-test");
    expect(result1.ok).toBe(true);
    if (!result1.ok) return;
    expect(result1.value.body).toContain("Original body content.");

    // Modify the skill file on disk
    createPromptSkill(skillsDir, "cache-test", "A cache test skill", "Modified body content.");

    // Call init() again -- should clear promptCache
    registry.init();

    // Skill still discovered (it's still on disk)
    expect(registry.getMetadataCount()).toBe(1);

    // Load again -- should read from disk (not stale cache)
    const result2 = await registry.loadPromptSkill("cache-test");
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;
    expect(result2.value.body).toContain("Modified body content.");
    expect(result2.value.body).not.toContain("Original body content.");
  });

  it("init() clears promptCache for deleted skills", async () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Create a prompt skill
    createPromptSkill(skillsDir, "temp-skill", "A temporary skill", "Temporary body.");

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    // Load the skill (populates promptCache)
    const result1 = await registry.loadPromptSkill("temp-skill");
    expect(result1.ok).toBe(true);

    // Delete the skill file from disk
    fs.unlinkSync(path.join(skillsDir, "temp-skill.md"));

    // Call init() again -- should clear cache and not find skill
    registry.init();

    // Skill is no longer discovered
    expect(registry.getMetadataCount()).toBe(0);

    // Attempting to load returns error (not stale cached content)
    const result2 = await registry.loadPromptSkill("temp-skill");
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.error.message).toContain("not found");
    }
  });

  it("init() emits skill:registry_reset event", async () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Create skills
    createPromptSkill(skillsDir, "event-skill-a", "Skill A", "Body A.");
    createPromptSkill(skillsDir, "event-skill-b", "Skill B", "Body B.");

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);

    // First init -- clears from empty state
    registry.init();
    expect(registry.getMetadataCount()).toBe(2);

    // Load one skill to populate promptCache
    await registry.loadPromptSkill("event-skill-a");

    // Clear event log to isolate second init
    eventBus.events.length = 0;

    // Second init -- should report clearing 2 metadata + 1 cache entry
    registry.init();

    const resetEvents = eventBus.events.filter((e) => e.name === "skill:registry_reset");
    expect(resetEvents).toHaveLength(1);

    const payload = resetEvents[0].payload as {
      clearedMetadata: number;
      clearedPromptCache: number;
      timestamp: number;
    };
    expect(payload.clearedMetadata).toBe(2);
    expect(payload.clearedPromptCache).toBe(1);
    expect(typeof payload.timestamp).toBe("number");
  });

  it("init() logs cache clearing at DEBUG", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    createPromptSkill(skillsDir, "debug-skill", "A debug test skill", "Body.");

    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx, mockLogger);

    // First init
    registry.init();

    // Second init -- should log clearing with actual counts
    mockLogger.debug.mockClear();
    registry.init();

    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        clearedMetadata: 1,
        clearedPromptCache: 0,
      }),
      "Registry caches cleared",
    );
  });

  // -------------------------------------------------------------------------
  // Level 1 / Level 2 parity test
  // -------------------------------------------------------------------------

  it("Level 1 and Level 2 return same values for new fields", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Create a skill with all 5 new fields under comis: namespace
    createPromptSkillWithNewFields(
      skillsDir,
      "parity-test",
      "Parity test skill",
      "Test body for parity verification.",
      {
        os: ["linux", "darwin"],
        requires: { bins: ["ffmpeg"], env: ["OPENAI_KEY"] },
        skillKey: "parity-test",
        primaryEnv: "OPENAI_KEY",
        commandDispatch: "tool",
      },
    );

    // Level 1: discovery
    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const descriptions = registry.getPromptSkillDescriptions();
    expect(descriptions).toHaveLength(1);

    // Get Level 1 metadata via discovery
    const { skills } = discoverSkills([skillsDir]);
    expect(skills).toHaveLength(1);
    const metadata = skills[0];

    // Level 2: parse the same file through parseSkillManifest
    const filePath = path.join(skillsDir, "parity-test.md");
    const fileContent = fs.readFileSync(filePath, "utf-8");
    const manifestResult = parseSkillManifest(fileContent);
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;
    const manifest = manifestResult.value;

    // Compare Level 1 metadata values against Level 2 parsed manifest (comis namespace)
    expect(metadata.os).toEqual(manifest.comis?.os);
    expect(metadata.requires?.bins).toEqual(manifest.comis?.requires?.bins);
    expect(metadata.requires?.env).toEqual(manifest.comis?.requires?.env);
    expect(metadata.skillKey).toBe(manifest.comis?.["skill-key"]);
    expect(metadata.primaryEnv).toBe(manifest.comis?.["primary-env"]);
    expect(metadata.commandDispatch).toBe(manifest.comis?.["command-dispatch"]);
  });

  // -------------------------------------------------------------------------
  // comis: namespace discovery tests
  // -------------------------------------------------------------------------

  it("discovers skill with comis: namespace and extracts metadata correctly", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Create a skill using the comis: namespace format
    const content = `---
name: ns-skill
description: "A namespaced skill"
type: prompt
comis:
  os:
    - linux
    - darwin
  requires:
    bins:
      - ffmpeg
    env:
      - OPENAI_KEY
  skill-key: ns-skill
  primary-env: discord
  command-dispatch: slash
---

Namespaced skill body.
`;
    fs.writeFileSync(path.join(skillsDir, "ns-skill.md"), content, "utf-8");

    const { skills } = discoverSkills([skillsDir]);
    expect(skills).toHaveLength(1);
    const meta = skills[0];
    expect(meta.name).toBe("ns-skill");
    expect(meta.os).toEqual(["linux", "darwin"]);
    expect(meta.requires).toEqual({ bins: ["ffmpeg"], env: ["OPENAI_KEY"] });
    expect(meta.skillKey).toBe("ns-skill");
    expect(meta.primaryEnv).toBe("discord");
    expect(meta.commandDispatch).toBe("slash");
  });

  it("skill without comis: namespace has undefined for Comis metadata fields", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // No comis: block -- all Comis-specific fields should be undefined
    createSkill(skillsDir, "no-ns", makeSkillMd("no-ns", "A skill without namespace"));

    const { skills } = discoverSkills([skillsDir]);
    expect(skills).toHaveLength(1);
    const meta = skills[0];
    expect(meta.os).toBeUndefined();
    expect(meta.skillKey).toBeUndefined();
    expect(meta.primaryEnv).toBeUndefined();
    expect(meta.commandDispatch).toBeUndefined();
  });

  it("Level 1 and Level 2 return same values for coerced fields", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Create a skill with fields that require coercion under comis: namespace
    // os: string (not array), skill-key: needs slugification
    createPromptSkillWithNewFields(
      skillsDir,
      "coercion-parity",
      "Coercion parity test",
      "Test body for coercion parity.",
      {
        os: "Linux",         // string, uppercase -- should be coerced to ["linux"]
        skillKey: "My Tool",  // spaces and uppercase -- should be coerced to "my-tool"
      },
    );

    // Level 1: discovery
    const { skills } = discoverSkills([skillsDir]);
    expect(skills).toHaveLength(1);
    const metadata = skills[0];

    // Level 2: parseSkillManifest
    const filePath = path.join(skillsDir, "coercion-parity.md");
    const fileContent = fs.readFileSync(filePath, "utf-8");
    const manifestResult = parseSkillManifest(fileContent);
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;
    const manifest = manifestResult.value;

    // Verify coercion parity: both paths produce same values (from comis namespace)
    expect(metadata.os).toEqual(manifest.comis?.os);
    expect(metadata.os).toEqual(["linux"]);

    expect(metadata.skillKey).toBe(manifest.comis?.["skill-key"]);
    expect(metadata.skillKey).toBe("my-tool");
  });
});

// ---------------------------------------------------------------------------
// startWatching tests
// ---------------------------------------------------------------------------

vi.mock("./skill-watcher.js", () => ({
  createSkillWatcher: vi.fn().mockReturnValue({ close: vi.fn().mockResolvedValue(undefined) }),
}));

describe("startWatching", () => {
  it("delegates to createSkillWatcher with correct options", async () => {
    const { createSkillWatcher: mockCreateWatcher } = await import("./skill-watcher.js");
    vi.mocked(mockCreateWatcher).mockClear();

    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const handle = registry.startWatching(500);

    expect(mockCreateWatcher).toHaveBeenCalledTimes(1);
    expect(mockCreateWatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        discoveryPaths: [skillsDir],
        debounceMs: 500,
        onReload: expect.any(Function),
      }),
    );
    expect(handle).toHaveProperty("close");
  });

  it("onReload callback triggers re-init and emits skills:reloaded", async () => {
    const { createSkillWatcher: mockCreateWatcher } = await import("./skill-watcher.js");
    vi.mocked(mockCreateWatcher).mockClear();

    // Capture the onReload callback
    let capturedOnReload: (() => void) | undefined;
    vi.mocked(mockCreateWatcher).mockImplementation((opts) => {
      capturedOnReload = opts.onReload;
      return { close: vi.fn().mockResolvedValue(undefined) };
    });

    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    createPromptSkill(skillsDir, "watched-skill", "A watched skill", "Body.");

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    registry.startWatching(400);
    expect(capturedOnReload).toBeDefined();

    // Clear events from init
    eventBus.events.length = 0;

    // Invoke the onReload callback (simulates watcher firing)
    capturedOnReload!();

    // Verify skills:reloaded event was emitted
    const reloadedEvent = eventBus.events.find((e) => e.name === "skills:reloaded");
    expect(reloadedEvent).toBeDefined();
    expect(reloadedEvent!.payload).toMatchObject({
      agentId: "test-agent",
      skillCount: expect.any(Number),
      timestamp: expect.any(Number),
    });

    // Verify registry_reset event was also emitted (from doInit)
    const resetEvent = eventBus.events.find((e) => e.name === "skill:registry_reset");
    expect(resetEvent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SkillSnapshot caching tests
// ---------------------------------------------------------------------------

describe("SkillSnapshot caching", () => {
  it("getSnapshot returns cached result on second call", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(skillsDir, "snap-skill", "A snapshot test skill", "Snapshot body.");

    const eventBus = createMockEventBus();
    const config = {
      discoveryPaths: [skillsDir],
      promptSkills: { maxAutoInject: 5 },
    } as any;
    const registry = createSkillRegistry(config, eventBus, { agentId: "test", tenantId: "test", userId: "system" });
    registry.init();

    const snap1 = registry.getSnapshot();
    const snap2 = registry.getSnapshot();

    // Same object reference proves caching
    expect(snap2).toBe(snap1);
    // First init increments version from 0 to 1
    expect(snap1.version).toBe(1);
    // Prompt contains the skill name
    expect(snap1.prompt).toContain("snap-skill");
    expect(snap1.prompt.length).toBeGreaterThan(0);
  });

  it("getSnapshot rebuilds after init()", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(skillsDir, "rebuild-skill", "A rebuild test skill", "Rebuild body.");

    const eventBus = createMockEventBus();
    const config = {
      discoveryPaths: [skillsDir],
      promptSkills: { maxAutoInject: 5 },
    } as any;
    const registry = createSkillRegistry(config, eventBus, { agentId: "test", tenantId: "test", userId: "system" });
    registry.init();

    const snap1 = registry.getSnapshot();
    expect(snap1.version).toBe(1);

    // Simulate reload
    registry.init();

    const snap2 = registry.getSnapshot();
    // Different object reference proves cache invalidation
    expect(snap2).not.toBe(snap1);
    // Version incremented
    expect(snap2.version).toBe(2);
  });

  it("version increments monotonically across multiple reloads", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(skillsDir, "mono-skill", "A monotonic test skill", "Monotonic body.");

    const eventBus = createMockEventBus();
    const config = {
      discoveryPaths: [skillsDir],
      promptSkills: { maxAutoInject: 5 },
    } as any;
    const registry = createSkillRegistry(config, eventBus, { agentId: "test", tenantId: "test", userId: "system" });

    const versions: number[] = [];
    for (let i = 0; i < 5; i++) {
      registry.init();
      versions.push(registry.getSnapshotVersion());
    }

    // Each version strictly greater than previous
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1]);
    }
  });

  it("getSnapshotVersion does not trigger rebuild", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(skillsDir, "version-skill", "A version test skill", "Version body.");

    const eventBus = createMockEventBus();
    const config = {
      discoveryPaths: [skillsDir],
      promptSkills: { maxAutoInject: 5 },
    } as any;
    const registry = createSkillRegistry(config, eventBus, { agentId: "test", tenantId: "test", userId: "system" });
    registry.init();

    // getSnapshotVersion should return 1 without triggering rebuild
    const ver = registry.getSnapshotVersion();
    expect(ver).toBe(1);

    // getSnapshot should return snapshot with same version
    const snap = registry.getSnapshot();
    expect(snap.version).toBe(ver);
  });

  it("getSnapshot before init returns empty snapshot at version 0", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    const eventBus = createMockEventBus();
    const config = {
      discoveryPaths: [skillsDir],
      promptSkills: { maxAutoInject: 5 },
    } as any;
    const registry = createSkillRegistry(config, eventBus, { agentId: "test", tenantId: "test", userId: "system" });

    // Do NOT call init()
    const snap = registry.getSnapshot();
    expect(snap.version).toBe(0);
    expect(snap.prompt).toBe("");
    expect(snap.skills).toEqual([]);
  });

  it("snapshot reflects updated skills after reload", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Start with one skill
    createPromptSkill(skillsDir, "first-skill", "The first skill", "First body.");

    const eventBus = createMockEventBus();
    const config = {
      discoveryPaths: [skillsDir],
      promptSkills: { maxAutoInject: 5 },
    } as any;
    const registry = createSkillRegistry(config, eventBus, { agentId: "test", tenantId: "test", userId: "system" });
    registry.init();

    const snap1 = registry.getSnapshot();
    expect(snap1.skills).toHaveLength(1);
    expect(snap1.version).toBe(1);

    // Add a second skill file
    createPromptSkill(skillsDir, "second-skill", "The second skill", "Second body.");

    // Simulate reload
    registry.init();

    const snap2 = registry.getSnapshot();
    expect(snap2.skills).toHaveLength(2);
    expect(snap2.version).toBe(2);
    expect(snap2.prompt).toContain("first-skill");
    expect(snap2.prompt).toContain("second-skill");
  });
});

// ---------------------------------------------------------------------------
// initFromSdkSkills tests
// ---------------------------------------------------------------------------

describe("initFromSdkSkills", () => {
  it("populates metadata from SDK skills", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Create skill files on disk so enrichment can read them
    createPromptSkill(skillsDir, "alpha", "Alpha skill", "Alpha body.");
    createPromptSkill(skillsDir, "beta", "Beta skill", "Beta body.");

    const eventBus = createMockEventBus();
    const config = {
      discoveryPaths: [skillsDir],
      promptSkills: { maxAutoInject: 5 },
    } as any;
    const registry = createSkillRegistry(config, eventBus, auditCtx);

    registry.initFromSdkSkills([
      { name: "alpha", description: "Alpha skill", filePath: path.join(skillsDir, "alpha.md"), baseDir: skillsDir, source: "bundled", disableModelInvocation: false },
      { name: "beta", description: "Beta skill", filePath: path.join(skillsDir, "beta.md"), baseDir: skillsDir, source: "local", disableModelInvocation: true },
    ]);

    expect(registry.getMetadataCount()).toBe(2);
    // Verify snapshot includes both skills
    const snap = registry.getSnapshot();
    expect(snap.skills).toHaveLength(2);
    expect(snap.skills.map(s => s.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("reads comis: namespace from skill files for enrichment", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Create a skill file with comis: namespace
    const content = `---
name: enriched
description: "Enriched skill"
type: prompt
userInvocable: true
argumentHint: "some hint"
comis:
  os:
    - linux
    - darwin
  requires:
    bins:
      - ffmpeg
    env:
      - OPENAI_KEY
  skill-key: enriched-skill
  primary-env: discord
  command-dispatch: slash
---

Enriched skill body.
`;
    fs.writeFileSync(path.join(skillsDir, "enriched.md"), content, "utf-8");

    const eventBus = createMockEventBus();
    const config = {
      discoveryPaths: [skillsDir],
      promptSkills: { maxAutoInject: 5 },
    } as any;
    const registry = createSkillRegistry(config, eventBus, auditCtx);

    registry.initFromSdkSkills([
      { name: "enriched", description: "Enriched skill", filePath: path.join(skillsDir, "enriched.md"), baseDir: skillsDir, source: "bundled", disableModelInvocation: false },
    ]);

    expect(registry.getMetadataCount()).toBe(1);
    // Verify userInvocable is read (should be in user-invocable set)
    const invocable = registry.getUserInvocableSkillNames();
    expect(invocable.has("enriched")).toBe(true);
  });

  it("filters by allowedSkills/deniedSkills", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(skillsDir, "allow-me", "Allowed skill", "Body.");
    createPromptSkill(skillsDir, "deny-me", "Denied skill", "Body.");
    createPromptSkill(skillsDir, "extra", "Extra skill", "Body.");

    const eventBus = createMockEventBus();
    const config = {
      discoveryPaths: [skillsDir],
      promptSkills: {
        maxAutoInject: 5,
        allowedSkills: ["allow-me", "deny-me"],
        deniedSkills: ["deny-me"],
      },
    } as any;
    const registry = createSkillRegistry(config, eventBus, auditCtx);

    registry.initFromSdkSkills([
      { name: "allow-me", description: "Allowed", filePath: path.join(skillsDir, "allow-me.md"), baseDir: skillsDir, source: "bundled", disableModelInvocation: false },
      { name: "deny-me", description: "Denied", filePath: path.join(skillsDir, "deny-me.md"), baseDir: skillsDir, source: "bundled", disableModelInvocation: false },
      { name: "extra", description: "Extra", filePath: path.join(skillsDir, "extra.md"), baseDir: skillsDir, source: "bundled", disableModelInvocation: false },
    ]);

    // Only "allow-me" should survive: "deny-me" is in deniedSkills, "extra" is not in allowedSkills
    expect(registry.getMetadataCount()).toBe(1);
    const snap = registry.getSnapshot();
    expect(snap.skills[0].name).toBe("allow-me");
  });

  it("clears previous state before populating from SDK skills", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(skillsDir, "filesystem-skill", "From filesystem", "FS body.");
    createPromptSkill(skillsDir, "sdk-skill", "From SDK", "SDK body.");

    const eventBus = createMockEventBus();
    const config = {
      discoveryPaths: [skillsDir],
      promptSkills: { maxAutoInject: 5 },
    } as any;
    const registry = createSkillRegistry(config, eventBus, auditCtx);

    // First: populate via filesystem discovery
    registry.init();
    expect(registry.getMetadataCount()).toBe(2); // both on disk

    // Then: initFromSdkSkills should clear old data and only contain SDK skills
    registry.initFromSdkSkills([
      { name: "sdk-skill", description: "From SDK", filePath: path.join(skillsDir, "sdk-skill.md"), baseDir: skillsDir, source: "bundled", disableModelInvocation: false },
    ]);

    expect(registry.getMetadataCount()).toBe(1);
    const snap = registry.getSnapshot();
    expect(snap.skills[0].name).toBe("sdk-skill");
  });

  it("emits registry_reset event", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(skillsDir, "evt-skill", "Event skill", "Body.");

    const eventBus = createMockEventBus();
    const config = {
      discoveryPaths: [skillsDir],
      promptSkills: { maxAutoInject: 5 },
    } as any;
    const registry = createSkillRegistry(config, eventBus, auditCtx);

    registry.initFromSdkSkills([
      { name: "evt-skill", description: "Event skill", filePath: path.join(skillsDir, "evt-skill.md"), baseDir: skillsDir, source: "bundled", disableModelInvocation: false },
    ]);

    const resetEvents = eventBus.events.filter(e => e.name === "skill:registry_reset");
    expect(resetEvents).toHaveLength(1);
    expect(resetEvents[0].payload).toEqual(expect.objectContaining({
      clearedMetadata: 0,
      clearedPromptCache: 0,
    }));
  });
});

// ---------------------------------------------------------------------------
// getEligibleSkillNames tests
// ---------------------------------------------------------------------------

describe("getEligibleSkillNames", () => {
  it("returns names passing policy and runtime eligibility", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(skillsDir, "eligible-one", "Eligible one", "Body one.");
    createPromptSkill(skillsDir, "eligible-two", "Eligible two", "Body two.");
    createPromptSkill(skillsDir, "denied-skill", "Denied skill", "Body denied.");

    const eventBus = createMockEventBus();
    const config = {
      discoveryPaths: [skillsDir],
      promptSkills: {
        maxAutoInject: 5,
        deniedSkills: ["denied-skill"],
      },
    } as any;
    const registry = createSkillRegistry(config, eventBus, auditCtx);
    registry.init();

    const eligible = registry.getEligibleSkillNames();
    expect(eligible.has("eligible-one")).toBe(true);
    expect(eligible.has("eligible-two")).toBe(true);
    expect(eligible.has("denied-skill")).toBe(false);
    expect(eligible.size).toBe(2);
  });
});
