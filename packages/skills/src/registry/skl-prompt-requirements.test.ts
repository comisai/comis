// SPDX-License-Identifier: Apache-2.0
/**
 * Requirement-verification tests for prompt skill requirements:
 *   - Prompt skill discovery finds SKILL.md files with type: prompt frontmatter
 *   - Prompt skill /skill:name invocation injects body into system prompt
 *   - Prompt skill $ARGUMENTS substitution works correctly with user-provided args
 *   - Prompt skill with allowedTools restricts tool set during invocation
 *   - Skill eligibility filtering via allowedSkills/deniedSkills config
 *
 * Uses temp directory pattern from skill-registry.test.ts. Reuses createPromptSkill
 * helper for writing .md files with type: prompt frontmatter.
 */

import type { TypedEventBus } from "@comis/core";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expandSkillForInvocation } from "../prompt/processor.js";
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
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "comis-skl-prompt-test-"));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});
/** Create a root .md prompt skill file in a directory. */
function createPromptSkill(
  basePath: string,
  name: string,
  description: string,
  body: string,
  opts?: {
    userInvocable?: boolean;
    disableModelInvocation?: boolean;
    argumentHint?: string;
    allowedTools?: string[];
  },
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

/** Create a SKILL.md file in a named subdirectory. */
function createCodeSkill(basePath: string, dirName: string, name: string, description: string): string {
  const skillDir = path.join(basePath, dirName);
  fs.mkdirSync(skillDir, { recursive: true });
  const skillMd = `---
name: ${name}
description: "${description}"
---

# ${name}

${description}
`;
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMd, "utf-8");
  return skillDir;
}

/** Create a SkillsConfig with promptSkills defaults included and optional eligibility fields. */
function makeConfig(
  discoveryPaths: string[],
  opts?: { allowedSkills?: string[]; deniedSkills?: string[] },
) {
  return {
    discoveryPaths,
    builtinTools: { read: true, write: true, edit: true, grep: true, find: true, ls: true, exec: false, process: false, webSearch: false, webFetch: false, browser: false },

    promptSkills: {
      maxBodyLength: 20000,
      enableDynamicContext: false,
      maxAutoInject: 3,
      allowedSkills: opts?.allowedSkills ?? [],
      deniedSkills: opts?.deniedSkills ?? [],
    },
  };
}

const auditCtx = { agentId: "test-agent", tenantId: "test-tenant", userId: "test-user" };

// ---------------------------------------------------------------------------
// Prompt skill discovery finds SKILL.md files with type: prompt
// ---------------------------------------------------------------------------

describe("Prompt skill discovery finds SKILL.md files with type: prompt frontmatter", () => {
  it("discovers root .md prompt skill files", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(skillsDir, "my-prompt", "A prompt-based skill", "You are a helpful assistant.");

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const relevant = registry.getRelevantPromptSkills("prompt");
    expect(relevant.length).toBeGreaterThanOrEqual(1);
    expect(relevant[0].name).toBe("my-prompt");
    expect(relevant[0].type).toBe("prompt");
  });

  it("discovers SKILL.md in subdirectory with type: prompt", () => {
    const skillsDir = path.join(tmpDir, "skills");
    const subDir = path.join(skillsDir, "subdir");
    fs.mkdirSync(subDir, { recursive: true });

    const skillMd = `---
name: sub-prompt
description: "A subdirectory prompt skill"
type: prompt
---

Subdirectory prompt body.
`;
    fs.writeFileSync(path.join(subDir, "SKILL.md"), skillMd, "utf-8");

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    expect(registry.getMetadataCount()).toBeGreaterThanOrEqual(1);

    const result = registry.getRelevantPromptSkills("subdirectory prompt");
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.find((s) => s.name === "sub-prompt")).toBeDefined();
  });

  it("treats subdirectory SKILL.md without explicit type as prompt skill", async () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createCodeSkill(skillsDir, "my-code-skill", "my-code-skill", "A code skill");

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const result = await registry.loadPromptSkill("my-code-skill");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("my-code-skill");
      expect(result.value.body).toContain("A code skill");
    }
  });
});

// ---------------------------------------------------------------------------
// Prompt skill /skill:name invocation injects body into system prompt
// ---------------------------------------------------------------------------

describe("Prompt skill /skill:name invocation injects body into system prompt", () => {
  it("loadPromptSkill returns sanitized body content", async () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(skillsDir, "body-test", "Body content test", "Use this tool for {{task}}.");

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const result = await registry.loadPromptSkill("body-test");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.body).toContain("Use this tool for {{task}}.");
  });

  it("expandSkillForInvocation produces correct XML with name, location, and body", () => {
    const result = expandSkillForInvocation(
      "my-skill",
      "Do the task.",
      "/path/to/skill",
      "/workspace",
    );

    expect(result).toContain('<skill name="my-skill"');
    expect(result).toContain("Do the task.");
    expect(result).toContain("</skill>");
    expect(result).toContain('location="/path/to/skill"');
  });

  it("full flow: loadPromptSkill -> expandSkillForInvocation produces injectable XML", async () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(skillsDir, "flow-skill", "Full flow test skill", "Step 1: Do something.\nStep 2: Do another thing.");

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const loadResult = await registry.loadPromptSkill("flow-skill");
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const { name, body, location } = loadResult.value;

    const xml = expandSkillForInvocation(name, body, location, skillsDir);

    expect(xml).toContain(`<skill name="flow-skill"`);
    expect(xml).toContain("Step 1: Do something.");
    expect(xml).toContain("Step 2: Do another thing.");
    expect(xml).toContain(`location="`);
    expect(xml).toContain("</skill>");
  });
});

// ---------------------------------------------------------------------------
// Prompt skill $ARGUMENTS substitution works correctly
// ---------------------------------------------------------------------------

describe("Prompt skill $ARGUMENTS substitution works correctly with user-provided args", () => {
  it("expandSkillForInvocation appends user arguments after </skill> tag", () => {
    const result = expandSkillForInvocation(
      "test-skill",
      "Body content.",
      "/loc",
      "/loc",
      "build a REST API",
    );

    // Verify the skill block ends with </skill>, followed by args
    expect(result).toContain("</skill>");
    expect(result).toContain("User arguments: build a REST API");

    // Verify args come after the closing tag
    const skillCloseIndex = result.indexOf("</skill>");
    const argsIndex = result.indexOf("User arguments: build a REST API");
    expect(argsIndex).toBeGreaterThan(skillCloseIndex);
  });

  it("arguments are XML-escaped", () => {
    const result = expandSkillForInvocation(
      "test-skill",
      "Body content.",
      "/loc",
      "/loc",
      '<script>alert("xss")</script>',
    );

    expect(result).toContain("&lt;script&gt;");
    expect(result).toContain("&quot;xss&quot;");
    expect(result).toContain("&lt;/script&gt;");
    // Raw script tags should NOT be present in arguments
    expect(result).not.toContain("User arguments: <script>");
  });

  it("no arguments appended when args is undefined or empty", () => {
    const resultUndefined = expandSkillForInvocation(
      "test-skill",
      "Body content.",
      "/loc",
      "/loc",
      undefined,
    );
    expect(resultUndefined).not.toContain("User arguments:");
    expect(resultUndefined.endsWith("</skill>")).toBe(true);

    const resultEmpty = expandSkillForInvocation(
      "test-skill",
      "Body content.",
      "/loc",
      "/loc",
      "",
    );
    expect(resultEmpty).not.toContain("User arguments:");
    expect(resultEmpty.endsWith("</skill>")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Prompt skill with allowedTools restricts tool set during invocation
// ---------------------------------------------------------------------------

describe("Prompt skill with allowedTools restricts tool set during invocation", () => {
  it("loadPromptSkill returns allowedTools from manifest", async () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(skillsDir, "restricted-tools", "Skill with tool restrictions", "Use only specific tools.", {
      allowedTools: ["exec", "read"],
    });

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const result = await registry.loadPromptSkill("restricted-tools");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.allowedTools).toEqual(["exec", "read"]);
  });

  it("allowedTools is empty array when not specified", async () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(skillsDir, "no-restriction", "Skill without tool restrictions", "Use any tool.");

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const result = await registry.loadPromptSkill("no-restriction");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.allowedTools).toEqual([]);
  });

  it("allowedTools data is available for consumer to filter tools", async () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(skillsDir, "filter-demo", "Skill for filter demo", "Only use exec.", {
      allowedTools: ["exec"],
    });

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const result = await registry.loadPromptSkill("filter-demo");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { allowedTools } = result.value;

    // Simulate consumer filtering a tool list based on allowedTools
    const mockToolList = [
      { name: "exec", execute: async () => ({}) },
      { name: "read", execute: async () => ({}) },
      { name: "web-search", execute: async () => ({}) },
    ];

    const filtered = mockToolList.filter((t) => allowedTools.includes(t.name));
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("exec");
  });
});

// ---------------------------------------------------------------------------
// Skill eligibility filtering via allowedSkills/deniedSkills
// ---------------------------------------------------------------------------

describe("Skill eligibility filtering via allowedSkills/deniedSkills", () => {
  /** Helper to create 3 skills (skill-a, skill-b, skill-c) in a temp directory. */
  function setupThreeSkills(): string {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    createPromptSkill(skillsDir, "skill-a", "Skill A for testing eligibility", "Body A.");
    createPromptSkill(skillsDir, "skill-b", "Skill B for testing eligibility", "Body B.");
    createPromptSkill(skillsDir, "skill-c", "Skill C for testing eligibility", "Body C.");
    return skillsDir;
  }

  it("default behavior (empty lists): all discovered skills appear in getPromptSkillDescriptions", () => {
    const skillsDir = setupThreeSkills();
    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const descriptions = registry.getPromptSkillDescriptions();
    expect(descriptions).toHaveLength(3);
    const names = descriptions.map((d) => d.name).sort();
    expect(names).toEqual(["skill-a", "skill-b", "skill-c"]);
  });

  it("allowedSkills filter: only named skills appear in getPromptSkillDescriptions", () => {
    const skillsDir = setupThreeSkills();
    const eventBus = createMockEventBus();
    const config = makeConfig([skillsDir], { allowedSkills: ["skill-a", "skill-b"] });
    const registry = createSkillRegistry(config, eventBus, auditCtx);
    registry.init();

    const descriptions = registry.getPromptSkillDescriptions();
    expect(descriptions).toHaveLength(2);
    const names = descriptions.map((d) => d.name).sort();
    expect(names).toEqual(["skill-a", "skill-b"]);
  });

  it("deniedSkills filter: named skill excluded from getPromptSkillDescriptions", () => {
    const skillsDir = setupThreeSkills();
    const eventBus = createMockEventBus();
    const config = makeConfig([skillsDir], { deniedSkills: ["skill-c"] });
    const registry = createSkillRegistry(config, eventBus, auditCtx);
    registry.init();

    const descriptions = registry.getPromptSkillDescriptions();
    expect(descriptions).toHaveLength(2);
    const names = descriptions.map((d) => d.name).sort();
    expect(names).toEqual(["skill-a", "skill-b"]);
  });

  it("combined filter: deny takes precedence within allowed set", () => {
    const skillsDir = setupThreeSkills();
    const eventBus = createMockEventBus();
    const config = makeConfig([skillsDir], {
      allowedSkills: ["skill-a", "skill-b"],
      deniedSkills: ["skill-b"],
    });
    const registry = createSkillRegistry(config, eventBus, auditCtx);
    registry.init();

    const descriptions = registry.getPromptSkillDescriptions();
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0].name).toBe("skill-a");
  });

  it("getUserInvocableSkillNames respects deniedSkills", () => {
    const skillsDir = setupThreeSkills();
    const eventBus = createMockEventBus();
    const config = makeConfig([skillsDir], { deniedSkills: ["skill-b"] });
    const registry = createSkillRegistry(config, eventBus, auditCtx);
    registry.init();

    const names = registry.getUserInvocableSkillNames();
    expect(names.size).toBe(2);
    expect(names.has("skill-a")).toBe(true);
    expect(names.has("skill-c")).toBe(true);
    expect(names.has("skill-b")).toBe(false);
  });

  it("getRelevantPromptSkills respects allowedSkills filter", () => {
    const skillsDir = setupThreeSkills();
    const eventBus = createMockEventBus();
    const config = makeConfig([skillsDir], { allowedSkills: ["skill-a"] });
    const registry = createSkillRegistry(config, eventBus, auditCtx);
    registry.init();

    const results = registry.getRelevantPromptSkills("testing eligibility");
    // Only skill-a should appear since only it is allowed
    expect(results.length).toBeLessThanOrEqual(1);
    if (results.length > 0) {
      expect(results[0].name).toBe("skill-a");
    }
  });

  it("legacy config without allowedSkills/deniedSkills preserves default behavior", () => {
    const skillsDir = setupThreeSkills();
    const eventBus = createMockEventBus();
    // Simulate legacy config that omits the eligibility fields entirely
    const legacyConfig = {
      discoveryPaths: [skillsDir],
      builtinTools: { read: true, write: true, edit: true, grep: true, find: true, ls: true, exec: false, process: false, webSearch: false, webFetch: false, browser: false },

      promptSkills: { maxBodyLength: 20000, enableDynamicContext: false, maxAutoInject: 3 },
    };
    const registry = createSkillRegistry(legacyConfig as any, eventBus, auditCtx);
    registry.init();

    // All skills should appear (null-safe defaults in isSkillEligible)
    const descriptions = registry.getPromptSkillDescriptions();
    expect(descriptions).toHaveLength(3);

    const names = registry.getUserInvocableSkillNames();
    expect(names.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Template substitution in skill body (end-to-end integration)
// ---------------------------------------------------------------------------

describe("loadPromptSkill + expandSkillForInvocation template substitution", () => {
  it("substitutes {placeholder} args into body instead of appending", async () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(
      skillsDir,
      "review-code",
      "Review code in a file",
      "Review the code in {filename} and check for bugs.",
      { argumentHint: "[filename]" },
    );

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const loadResult = await registry.loadPromptSkill("review-code");
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const { name, body, location } = loadResult.value;

    // Expand with args -- template substitution should activate
    const xml = expandSkillForInvocation(name, body, location, skillsDir, "main.ts");

    expect(xml).toContain("Review the code in main.ts and check for bugs.");
    expect(xml).not.toContain("User arguments:");
    expect(xml).not.toContain("{filename}");
  });

  it("appends args when no templates in body (backward compat)", async () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(
      skillsDir,
      "deploy-app",
      "Deploy to a target environment",
      "Deploy the application to the specified target.",
      { argumentHint: "[target]" },
    );

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const loadResult = await registry.loadPromptSkill("deploy-app");
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const { name, body, location } = loadResult.value;

    // Body has no {placeholder} patterns -- should fall back to appending
    const xml = expandSkillForInvocation(name, body, location, skillsDir, "production");

    expect(xml).toContain("Deploy the application to the specified target.");
    expect(xml).toContain("User arguments: production");
  });

  it("skill without argumentHint still works with expandSkillForInvocation", async () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    createPromptSkill(
      skillsDir,
      "simple-skill",
      "A simple skill without argument hint",
      "Just do the basic thing.",
    );

    const eventBus = createMockEventBus();
    const registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
    registry.init();

    const loadResult = await registry.loadPromptSkill("simple-skill");
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const { name, body, location } = loadResult.value;

    // No args provided -- standard format
    const xml = expandSkillForInvocation(name, body, location, skillsDir);

    expect(xml).toContain("Just do the basic thing.");
    expect(xml).not.toContain("User arguments:");
    expect(xml).toContain("</skill>");
  });
});
