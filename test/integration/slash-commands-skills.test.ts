// SPDX-License-Identifier: Apache-2.0
/**
 * Prompt skill pipeline integration tests.
 *
 * Composes real createSkillRegistry + loadPromptSkill + expandSkillForInvocation
 * from @comis/skills with matchPromptSkillCommand + parseSlashCommand from
 * @comis/agent. Tests the full skill invocation flow:
 *
 *   user types `/skill:name args`
 *   -> matcher finds canonical name
 *   -> registry loads skill body + allowedTools
 *   -> processor expands to XML with appended arguments
 *
 * All without a daemon -- pure package-level composition with real filesystem
 * SKILL.md files in a temp directory.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createSkillRegistry, expandSkillForInvocation } from "@comis/skills";
import { matchPromptSkillCommand, parseSlashCommand } from "@comis/agent";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SkillRegistry } from "@comis/skills";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tempDir: string;
let skillsDir: string;
let registry: SkillRegistry;

/** Create a mock TypedEventBus sufficient for registry usage. */
function createMockEventBus() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
    listenerCount: vi.fn().mockReturnValue(0),
  } as any;
}

/** Create a SkillsConfig for the registry. */
function makeConfig(discoveryPaths: string[]) {
  return {
    discoveryPaths,
    builtinTools: {
      read: true,
      write: true,
      edit: true,
      grep: true,
      find: true,
      ls: true,
      exec: false,
      webSearch: false,
      webFetch: false,
      browser: false,
    },
    sandboxDefaults: { memoryLimitMb: 64, timeoutMs: 5000, maxResultSizeBytes: 65536 },
    promptSkills: { maxBodyLength: 20000, enableDynamicContext: false, maxAutoInject: 3 },
    toolPolicy: { profile: "full" as const, allow: [], deny: [] },
  };
}

const auditCtx = { agentId: "test-agent", tenantId: "test-tenant", userId: "test-user" };

// ---------------------------------------------------------------------------
// Setup: create temp dir with 4 prompt skill .md files
// ---------------------------------------------------------------------------

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "comis-skill-test-"));
  skillsDir = join(tempDir, "skills");
  mkdirSync(skillsDir, { recursive: true });

  // 1. deploy.md -- Standard skill (userInvocable: true, no allowedTools restriction)
  writeFileSync(
    join(skillsDir, "deploy.md"),
    `---
name: deploy
description: "Deploy code to staging or production"
type: prompt
userInvocable: true
---

Review the deployment target and run the appropriate CI/CD pipeline.
Ensure all tests pass before proceeding.
`,
    "utf-8",
  );

  // 2. restricted-tool.md -- Skill with allowedTools restriction
  writeFileSync(
    join(skillsDir, "restricted-tool.md"),
    `---
name: restricted-tool
description: "Restricted tool access skill"
type: prompt
userInvocable: true
allowedTools:
  - exec
  - read
---

Execute the task using only the allowed tools.
`,
    "utf-8",
  );

  // 3. hidden-skill.md -- Non-user-invocable skill
  writeFileSync(
    join(skillsDir, "hidden-skill.md"),
    `---
name: hidden-skill
description: "Internal system skill"
type: prompt
userInvocable: false
---

Internal processing instructions.
`,
    "utf-8",
  );

  // 4. greeting.md -- Simple skill for argument testing
  writeFileSync(
    join(skillsDir, "greeting.md"),
    `---
name: greeting
description: "Generate a personalized greeting"
type: prompt
userInvocable: true
---

Create a warm greeting for the user.
`,
    "utf-8",
  );

  // Initialize registry
  const eventBus = createMockEventBus();
  registry = createSkillRegistry(makeConfig([skillsDir]), eventBus, auditCtx);
  registry.init();
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Section 1: Skill Discovery & Registry
// ---------------------------------------------------------------------------

describe("Section 1: Skill Discovery & Registry", () => {
  it("SKL-INT-01: createSkillRegistry discovers all 4 SKILL.md files from temp dir", () => {
    expect(registry.getMetadataCount()).toBe(4);
  });

  it("SKL-INT-02: getUserInvocableSkillNames returns 3 user-invocable skills, excludes hidden-skill", () => {
    const names = registry.getUserInvocableSkillNames();
    expect(names.size).toBe(3);
    expect(names.has("deploy")).toBe(true);
    expect(names.has("restricted-tool")).toBe(true);
    expect(names.has("greeting")).toBe(true);
    expect(names.has("hidden-skill")).toBe(false);
  });

  it("SKL-INT-03: getUserInvocableSkillNames result used with matchPromptSkillCommand matches /skill:deploy", () => {
    const skillNames = registry.getUserInvocableSkillNames();
    const match = matchPromptSkillCommand("/skill:deploy build api", skillNames);
    expect(match).not.toBeNull();
    expect(match!.name).toBe("deploy");
    expect(match!.args).toBe("build api");
  });
});

// ---------------------------------------------------------------------------
// Section 2: Full Pipeline (match -> load -> expand)
// ---------------------------------------------------------------------------

describe("Section 2: Full Pipeline (match -> load -> expand)", () => {
  it("SKL-PIPE-01: Full flow produces XML with skill tag, body, and appended user arguments", async () => {
    const skillNames = registry.getUserInvocableSkillNames();
    const match = matchPromptSkillCommand("/skill:deploy build the api", skillNames);
    expect(match).not.toBeNull();
    expect(match!.name).toBe("deploy");
    expect(match!.args).toBe("build the api");

    const loadResult = await registry.loadPromptSkill("deploy");
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const { name, body, location } = loadResult.value;
    const xml = expandSkillForInvocation(name, body, location, skillsDir, match!.args);

    expect(xml).toContain('<skill name="deploy"');
    expect(xml).toContain("Review the deployment target");
    expect(xml).toContain("Ensure all tests pass before proceeding.");
    expect(xml).toContain("</skill>");
    expect(xml).toContain("User arguments: build the api");
  });

  it("SKL-PIPE-02: /skill:greeting with no args produces XML without User arguments section", async () => {
    const skillNames = registry.getUserInvocableSkillNames();
    const match = matchPromptSkillCommand("/skill:greeting", skillNames);
    expect(match).not.toBeNull();
    expect(match!.args).toBe("");

    const loadResult = await registry.loadPromptSkill("greeting");
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const { name, body, location } = loadResult.value;
    // Empty args string => expandSkillForInvocation treats "" as falsy
    const xml = expandSkillForInvocation(name, body, location, skillsDir, match!.args || undefined);

    expect(xml).toContain('<skill name="greeting"');
    expect(xml).toContain("Create a warm greeting for the user.");
    expect(xml).not.toContain("User arguments:");
  });

  it("SKL-PIPE-03: /skill:greeting Hello World appends arguments after </skill> tag", async () => {
    const skillNames = registry.getUserInvocableSkillNames();
    const match = matchPromptSkillCommand("/skill:greeting Hello World", skillNames);
    expect(match).not.toBeNull();
    expect(match!.args).toBe("Hello World");

    const loadResult = await registry.loadPromptSkill("greeting");
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const { name, body, location } = loadResult.value;
    const xml = expandSkillForInvocation(name, body, location, skillsDir, match!.args);

    // Verify args come AFTER the closing </skill> tag (NOT substituted into body)
    const skillCloseIdx = xml.indexOf("</skill>");
    const argsIdx = xml.indexOf("User arguments: Hello World");
    expect(skillCloseIdx).toBeGreaterThan(-1);
    expect(argsIdx).toBeGreaterThan(skillCloseIdx);
  });

  it("SKL-PIPE-04: Expanded XML contains <skill name=... location=...> with body between tags", async () => {
    const loadResult = await registry.loadPromptSkill("deploy");
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const { name, body, location } = loadResult.value;
    const xml = expandSkillForInvocation(name, body, location, skillsDir);

    // Verify structure: <skill name="deploy" location="...">
    expect(xml).toMatch(/<skill name="deploy" location="[^"]+">[\s\S]*<\/skill>/);
    // Body is between the opening and closing tags
    const openIdx = xml.indexOf(">");
    const closeIdx = xml.indexOf("</skill>");
    const betweenTags = xml.slice(openIdx + 1, closeIdx);
    expect(betweenTags).toContain("Review the deployment target");
  });
});

// ---------------------------------------------------------------------------
// Section 3: Arguments Appending (NOT Substitution)
// ---------------------------------------------------------------------------

describe("Section 3: Arguments Appending (NOT Substitution)", () => {
  it("SKL-ARG-01: Body text remains unchanged when args are provided", async () => {
    const loadResult = await registry.loadPromptSkill("deploy");
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const { name, body, location } = loadResult.value;
    const originalBody = body;

    const xmlWithArgs = expandSkillForInvocation(name, body, location, skillsDir, "extra args");
    const xmlWithoutArgs = expandSkillForInvocation(name, body, location, skillsDir);

    // The body portion within the <skill> tags should be identical
    const bodyInWith = xmlWithArgs.slice(0, xmlWithArgs.indexOf("</skill>") + "</skill>".length);
    const bodyInWithout = xmlWithoutArgs.slice(0, xmlWithoutArgs.indexOf("</skill>") + "</skill>".length);
    expect(bodyInWith).toBe(bodyInWithout);

    // Also verify body param was not mutated
    expect(body).toBe(originalBody);
  });

  it("SKL-ARG-02: Empty args string produces no User arguments line", () => {
    const xml = expandSkillForInvocation("test", "Body.", "/loc", "/loc", "");
    expect(xml).not.toContain("User arguments:");
    expect(xml.endsWith("</skill>")).toBe(true);
  });

  it("SKL-ARG-03: Args with XML-special characters are XML-escaped in appended section", () => {
    const xml = expandSkillForInvocation(
      "test",
      "Body.",
      "/loc",
      "/loc",
      'build <api> & "deploy" it',
    );

    expect(xml).toContain("&lt;api&gt;");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&quot;deploy&quot;");
    // Raw special characters should NOT appear in the arguments line
    expect(xml).not.toContain("User arguments: build <api>");
  });
});

// ---------------------------------------------------------------------------
// Section 4: allowedTools Restriction
// ---------------------------------------------------------------------------

describe("Section 4: allowedTools Restriction", () => {
  it("SKL-TOOL-01: loadPromptSkill(restricted-tool) returns allowedTools = [exec, read]", async () => {
    const result = await registry.loadPromptSkill("restricted-tool");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.allowedTools).toEqual(["exec", "read"]);
  });

  it("SKL-TOOL-02: loadPromptSkill(deploy) returns allowedTools = [] (no restriction)", async () => {
    const result = await registry.loadPromptSkill("deploy");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.allowedTools).toEqual([]);
  });

  it("SKL-TOOL-03: allowedTools intersection: only allowed tools pass through", async () => {
    const result = await registry.loadPromptSkill("restricted-tool");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const allowedSet = new Set(result.value.allowedTools);
    const availableTools = ["exec", "read", "web-search"];
    const intersection = availableTools.filter((t) => allowedSet.has(t));

    expect(intersection).toEqual(["exec", "read"]);
    expect(intersection).not.toContain("web-search");
  });

  it("SKL-TOOL-04: Empty allowedTools means no restriction -- all tools pass through", async () => {
    const result = await registry.loadPromptSkill("deploy");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { allowedTools } = result.value;
    const availableTools = ["exec", "read", "web-search"];

    // When allowedTools is empty, no filtering is applied (all pass through)
    const filtered =
      allowedTools.length === 0
        ? availableTools
        : availableTools.filter((t) => allowedTools.includes(t));

    expect(filtered).toEqual(availableTools);
  });
});

// ---------------------------------------------------------------------------
// Section 5: Matching Edge Cases
// ---------------------------------------------------------------------------

describe("Section 5: Matching Edge Cases", () => {
  it("SKL-MATCH-01: Case-insensitive match: /skill:DEPLOY build matches canonical deploy", () => {
    const skillNames = registry.getUserInvocableSkillNames();
    const match = matchPromptSkillCommand("/skill:DEPLOY build", skillNames);
    expect(match).not.toBeNull();
    expect(match!.name).toBe("deploy");
    expect(match!.args).toBe("build");
  });

  it("SKL-MATCH-02: /Skill:deploy build (uppercase S) matches", () => {
    const skillNames = registry.getUserInvocableSkillNames();
    const match = matchPromptSkillCommand("/Skill:deploy build", skillNames);
    expect(match).not.toBeNull();
    expect(match!.name).toBe("deploy");
  });

  it("SKL-MATCH-03: /skill:unknown-name with name not in registry returns null", () => {
    const skillNames = registry.getUserInvocableSkillNames();
    const match = matchPromptSkillCommand("/skill:unknown-name", skillNames);
    expect(match).toBeNull();
  });

  it("SKL-MATCH-04: /skill:hidden-skill returns null (not in getUserInvocableSkillNames)", () => {
    const skillNames = registry.getUserInvocableSkillNames();
    const match = matchPromptSkillCommand("/skill:hidden-skill", skillNames);
    expect(match).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Section 6: Priority Composition
// ---------------------------------------------------------------------------

describe("Section 6: Priority Composition", () => {
  it("SKL-PRI-01: /status is a system command -- parseSlashCommand returns found:true", () => {
    const parsed = parseSlashCommand("/status");
    expect(parsed.found).toBe(true);
    // When a system command is found, matchPromptSkillCommand should not be called
    // (system commands take priority)
  });

  it("SKL-PRI-02: /skill:deploy build api -- parseSlashCommand returns found:false, then matchPromptSkillCommand returns match", () => {
    const parsed = parseSlashCommand("/skill:deploy build api");
    // /skill:deploy is NOT a known system command, so found is false
    expect(parsed.found).toBe(false);

    // Second pass: skill command matcher
    const skillNames = registry.getUserInvocableSkillNames();
    const match = matchPromptSkillCommand("/skill:deploy build api", skillNames);
    expect(match).not.toBeNull();
    expect(match!.name).toBe("deploy");
    expect(match!.args).toBe("build api");
  });

  it("SKL-PRI-03: Regular text message -- both return no-match", () => {
    const text = "regular text message";
    const parsed = parseSlashCommand(text);
    expect(parsed.found).toBe(false);

    const skillNames = registry.getUserInvocableSkillNames();
    const match = matchPromptSkillCommand(text, skillNames);
    expect(match).toBeNull();
  });
});
