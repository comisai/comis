// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-coverage tests for skill-handlers.
 *
 * Covers all 6 handlers (skills.list, skills.upload, skills.import,
 * skills.delete, skills.create, skills.update) at the rejection-branch
 * level. Uses temp directories for file-system operations and mocked
 * SkillRegistry instances for re-discovery assertions.
 *
 * Network-dependent paths (skills.import via GitHub Contents API) are
 * exercised via global fetch mocks; the production source's parsing +
 * error branches are covered without touching real GitHub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSkillHandlers, type SkillHandlerDeps } from "./skill-handlers.js";
import type { AppContainer } from "@comis/core";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(descriptions: Array<{ name: string; location: string; description?: string }> = []) {
  const init = vi.fn();
  // Schema requires `description` so fill it when omitted
  const full = descriptions.map((d) => ({ description: "test description", ...d }));
  return {
    init,
    loadPromptSkill: vi.fn(),
    getPromptSkillDescriptions: vi.fn(() => full),
    getUserInvocableSkillNames: vi.fn(() => new Set<string>()),
    findRelevantSkills: vi.fn(() => []),
    findRelevantSkillsForInvocation: vi.fn(() => []),
  } as unknown as import("@comis/skills").SkillRegistry & { init: ReturnType<typeof vi.fn> };
}

function makeContainer(): AppContainer {
  return {
    config: { dataDir: "/nonexistent-data-dir" },
    eventBus: createMockEventBus(),
  } as unknown as AppContainer;
}

function makeDeps(overrides: Partial<SkillHandlerDeps> = {}): SkillHandlerDeps {
  return {
    getAgentBrowserService: vi.fn(),
    approvalGate: undefined,
    mcpClientManager: {} as never,
    skillRegistries: undefined,
    notificationService: undefined,
    execGit: vi.fn(),
    agents: {},
    defaultAgentId: "default-agent",
    defaultWorkspaceDir: "/tmp/ws",
    workspaceDirs: new Map(),
    logger: createMockLogger(),
    tenantId: "test-tenant",
    memoryApi: {} as never,
    memoryAdapter: {} as never,
    container: makeContainer(),
    eventBus: createMockEventBus(),
    ...overrides,
  };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(join(tmpdir(), `skill-handlers-test-${randomUUID().slice(0, 8)}-`));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// skills.list
// ---------------------------------------------------------------------------

describe("skills.list handler", () => {
  it("returns empty skills array when no registries are configured at all", async () => {
    const handlers = createSkillHandlers(makeDeps({ skillRegistries: undefined }));
    const result = await handlers["skills.list"]!({});
    expect(result).toEqual({ skills: [] });
  });

  it("returns empty skills array when registries map is present but empty", async () => {
    const handlers = createSkillHandlers(
      makeDeps({ skillRegistries: new Map() }),
    );
    const result = await handlers["skills.list"]!({});
    expect(result).toEqual({ skills: [] });
  });

  it("returns descriptions from the matching agent registry when agentId param is provided", async () => {
    const registry = makeRegistry([{ name: "alpha", location: "/skills/alpha" }]);
    const handlers = createSkillHandlers(
      makeDeps({ skillRegistries: new Map([["agent-x", registry]]) }),
    );
    const result = await handlers["skills.list"]!({ agentId: "agent-x" });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({ name: "alpha", location: "/skills/alpha" });
  });

  it("returns empty skills array when agentId is provided but registry is not present", async () => {
    const handlers = createSkillHandlers(
      makeDeps({
        skillRegistries: new Map([["agent-a", makeRegistry([{ name: "a", location: "/p" }])]]),
      }),
    );
    const result = await handlers["skills.list"]!({ agentId: "agent-unknown" });
    expect(result).toEqual({ skills: [] });
  });

  it("falls back to the _agentId internal-field when agentId is absent from params", async () => {
    const registry = makeRegistry([{ name: "beta", location: "/p/beta" }]);
    const handlers = createSkillHandlers(
      makeDeps({ skillRegistries: new Map([["agent-z", registry]]) }),
    );
    const result = await handlers["skills.list"]!({ _agentId: "agent-z" });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({ name: "beta", location: "/p/beta" });
  });

  it("uses the default agent registry when neither agentId nor _agentId are present", async () => {
    const defaultReg = makeRegistry([{ name: "default", location: "/d" }]);
    const otherReg = makeRegistry([{ name: "other", location: "/o" }]);
    const handlers = createSkillHandlers(
      makeDeps({
        defaultAgentId: "default-agent",
        skillRegistries: new Map([
          ["other-agent", otherReg],
          ["default-agent", defaultReg],
        ]),
      }),
    );
    const result = await handlers["skills.list"]!({});
    expect(result.skills[0]!.name).toBe("default");
  });

  it("falls back to first registry value when defaultAgentId is empty and no agentId is provided", async () => {
    const firstReg = makeRegistry([{ name: "first", location: "/f" }]);
    const handlers = createSkillHandlers(
      makeDeps({
        defaultAgentId: "",
        skillRegistries: new Map([["any-agent", firstReg]]),
      }),
    );
    const result = await handlers["skills.list"]!({});
    expect(result.skills[0]!.name).toBe("first");
  });
});

// ---------------------------------------------------------------------------
// skills.upload
// ---------------------------------------------------------------------------

describe("skills.upload handler", () => {
  it("rejects when calling agentId is absent from both rawParams and internals", async () => {
    const handlers = createSkillHandlers(makeDeps());
    await expect(
      handlers["skills.upload"]!({
        name: "my-skill",
        files: [{ path: "SKILL.md", content: "---\nname: my-skill\n---" }],
      }),
    ).rejects.toThrow(/Agent ID is required/i);
  });

  it("rejects upload when skill name fails the lowercase-alphanumeric-hyphens validation pattern", async () => {
    const handlers = createSkillHandlers(makeDeps());
    await expect(
      handlers["skills.upload"]!({
        name: "Invalid_Name",
        files: [{ path: "SKILL.md", content: "x" }],
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/Invalid skill name/i);
  });

  it("rejects upload when skill name contains consecutive double-hyphens forbidden by validator", async () => {
    const handlers = createSkillHandlers(makeDeps());
    await expect(
      handlers["skills.upload"]!({
        name: "bad--name",
        files: [{ path: "SKILL.md", content: "x" }],
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/Invalid skill name/i);
  });

  it("rejects upload when the files array is empty per handler precondition", async () => {
    const handlers = createSkillHandlers(makeDeps());
    await expect(
      handlers["skills.upload"]!({
        name: "ok-name",
        files: [],
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/No files provided/i);
  });

  it("rejects upload when none of the supplied files is named SKILL.md at the folder root", async () => {
    const handlers = createSkillHandlers(makeDeps());
    await expect(
      handlers["skills.upload"]!({
        name: "ok-name",
        files: [{ path: "README.md", content: "hi" }],
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/must contain a SKILL.md/i);
  });

  it("rejects shared-scope upload when calling agent is not the default agent per scope guard", async () => {
    const handlers = createSkillHandlers(
      makeDeps({ defaultAgentId: "owner-agent" }),
    );
    await expect(
      handlers["skills.upload"]!({
        name: "shared-skill",
        scope: "shared",
        files: [{ path: "SKILL.md", content: "x" }],
        _agentId: "intruder-agent",
      }),
    ).rejects.toThrow(/Only the default agent.*can manage shared skills/i);
  });

  it("rejects local-scope upload when no workspace directory is registered for the calling agent", async () => {
    const handlers = createSkillHandlers(makeDeps({ workspaceDirs: new Map() }));
    await expect(
      handlers["skills.upload"]!({
        name: "local-skill",
        scope: "local",
        files: [{ path: "SKILL.md", content: "x" }],
        _agentId: "agent-no-ws",
      }),
    ).rejects.toThrow(/No workspace directory found/i);
  });

  it("rejects upload when target skill directory already exists on disk per no-overwrite guard", async () => {
    const wsDir = join(tmpRoot, "ws");
    fs.mkdirSync(join(wsDir, "skills", "existing-skill"), { recursive: true });
    const handlers = createSkillHandlers(
      makeDeps({ workspaceDirs: new Map([["agent-a", wsDir]]) }),
    );
    await expect(
      handlers["skills.upload"]!({
        name: "existing-skill",
        scope: "local",
        files: [{ path: "SKILL.md", content: "x" }],
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it("creates the skill directory and writes all files in local scope with valid agentId and SKILL.md", async () => {
    const wsDir = join(tmpRoot, "ws");
    fs.mkdirSync(wsDir, { recursive: true });
    const reg = makeRegistry([]);
    const handlers = createSkillHandlers(
      makeDeps({
        workspaceDirs: new Map([["agent-a", wsDir]]),
        skillRegistries: new Map([["agent-a", reg]]),
      }),
    );
    const result = await handlers["skills.upload"]!({
      name: "new-skill",
      scope: "local",
      files: [
        { path: "SKILL.md", content: "---\nname: new-skill\n---\nBody" },
        { path: "ref/extra.md", content: "extra content" },
      ],
      _agentId: "agent-a",
    });
    expect(result).toMatchObject({ ok: true });
    expect(fs.existsSync(join(wsDir, "skills", "new-skill", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(join(wsDir, "skills", "new-skill", "ref", "extra.md"))).toBe(true);
    expect(reg.init).toHaveBeenCalled();
  });

  it("rejects upload when any file entry has a non-string path or content per zod contract", async () => {
    const wsDir = join(tmpRoot, "ws");
    fs.mkdirSync(wsDir, { recursive: true });
    const handlers = createSkillHandlers(
      makeDeps({ workspaceDirs: new Map([["agent-a", wsDir]]) }),
    );
    // Non-string path/content is rejected by Zod before write loop runs
    await expect(
      handlers["skills.upload"]!({
        name: "mixed-skill",
        scope: "local",
        files: [
          { path: "SKILL.md", content: "ok" },
          { path: 123 as unknown as string, content: "x" },
        ],
        _agentId: "agent-a",
      }),
    ).rejects.toThrow();
  });

  it("re-initializes every registry in shared scope upload, not just the default agent's", async () => {
    const dataDir = join(tmpRoot, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const container = makeContainer();
    (container as { config: { dataDir: string } }).config = { dataDir };
    const reg1 = makeRegistry([]);
    const reg2 = makeRegistry([]);
    const handlers = createSkillHandlers(
      makeDeps({
        container,
        defaultAgentId: "default-agent",
        skillRegistries: new Map([["default-agent", reg1], ["agent-b", reg2]]),
      }),
    );
    await handlers["skills.upload"]!({
      name: "shared-skill",
      scope: "shared",
      files: [{ path: "SKILL.md", content: "x" }],
      _agentId: "default-agent",
    });
    expect(reg1.init).toHaveBeenCalled();
    expect(reg2.init).toHaveBeenCalled();
  });

  it("skills_upload_writes_skill_file_at_0o600_and_dir_at_0o700_via_fs_safe_substrate", async () => {
    // Route through @comis/observability/shared/fs-safe.ts
    // so the §1.4 confidentiality invariant (dir 0o700, file 0o600) is enforced on
    // every skill artifact written by skills.upload — including nested-parent dirs.
    const wsDir = join(tmpRoot, "ws");
    fs.mkdirSync(wsDir, { recursive: true });
    const reg = makeRegistry([]);
    const handlers = createSkillHandlers(
      makeDeps({
        workspaceDirs: new Map([["agent-a", wsDir]]),
        skillRegistries: new Map([["agent-a", reg]]),
      }),
    );
    await handlers["skills.upload"]!({
      name: "mode-skill",
      scope: "local",
      files: [
        { path: "SKILL.md", content: "---\nname: mode-skill\n---\nBody" },
        { path: "nested/extra.md", content: "nested content" },
      ],
      _agentId: "agent-a",
    });
    const skillDir = join(wsDir, "skills", "mode-skill");
    const skillFile = join(skillDir, "SKILL.md");
    const nestedDir = join(skillDir, "nested");
    const nestedFile = join(nestedDir, "extra.md");
    expect(fs.statSync(skillDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(nestedDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(skillFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(nestedFile).mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// skills.import (network-mocked)
// ---------------------------------------------------------------------------

describe("skills.import handler", () => {
  it("rejects import when calling agentId is absent from both rawParams and internals", async () => {
    const handlers = createSkillHandlers(makeDeps());
    await expect(
      handlers["skills.import"]!({
        url: "https://github.com/owner/repo/tree/main/skills/foo",
      }),
    ).rejects.toThrow(/Agent ID is required/i);
  });

  it("rejects shared-scope import early when calling agent is not the default agent (before fetch)", async () => {
    const handlers = createSkillHandlers(makeDeps({ defaultAgentId: "owner" }));
    await expect(
      handlers["skills.import"]!({
        url: "https://github.com/owner/repo/tree/main/skills/foo",
        scope: "shared",
        _agentId: "other-agent",
      }),
    ).rejects.toThrow(/Only the default agent.*can manage shared skills/i);
  });

  it("rejects import when the url string is empty after trimming whitespace", async () => {
    const handlers = createSkillHandlers(makeDeps());
    await expect(
      handlers["skills.import"]!({ url: "   ", _agentId: "agent-a" }),
    ).rejects.toThrow(/URL is required/i);
  });

  it("rejects import when the url does not match the github.com/{owner}/{repo}/tree/{branch}/{path} pattern", async () => {
    const handlers = createSkillHandlers(makeDeps());
    await expect(
      handlers["skills.import"]!({
        url: "https://example.com/some/other/path",
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/Invalid GitHub URL/i);
  });

  it("rejects import when the derived skill name from URL path fails name validation pattern", async () => {
    const handlers = createSkillHandlers(makeDeps());
    await expect(
      handlers["skills.import"]!({
        url: "https://github.com/o/r/tree/main/path/UPPER_NAME",
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/Invalid skill name derived from URL/i);
  });

  it("rejects import when github contents API returns non-OK response status code", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not found", { status: 404, statusText: "Not Found" }),
    );
    const handlers = createSkillHandlers(makeDeps());
    await expect(
      handlers["skills.import"]!({
        url: "https://github.com/owner/repo/tree/main/skills/my-skill",
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/GitHub API error/i);
    fetchSpy.mockRestore();
  });

  it("rejects import when github contents API returns empty list of files", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const handlers = createSkillHandlers(makeDeps());
    await expect(
      handlers["skills.import"]!({
        url: "https://github.com/owner/repo/tree/main/skills/my-skill",
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/No files found/i);
  });

  it("rejects import when fetched github folder is missing a SKILL.md file at any depth", async () => {
    const wsDir = join(tmpRoot, "ws");
    fs.mkdirSync(wsDir, { recursive: true });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.startsWith("https://api.github.com/")) {
        return new Response(
          JSON.stringify([{ name: "README.md", type: "file", download_url: "https://download/README.md", path: "skills/my-skill/README.md" }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("README body", { status: 200 });
    });
    const handlers = createSkillHandlers(
      makeDeps({ workspaceDirs: new Map([["agent-a", wsDir]]) }),
    );
    await expect(
      handlers["skills.import"]!({
        url: "https://github.com/owner/repo/tree/main/skills/my-skill",
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/must contain a SKILL.md/i);
  });

  it("rejects local-scope import when calling agent has no workspace directory registered", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify([{ name: "SKILL.md", type: "file", download_url: "https://download/SKILL.md", path: "skills/my-skill/SKILL.md" }]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const handlers = createSkillHandlers(makeDeps({ workspaceDirs: new Map() }));
    await expect(
      handlers["skills.import"]!({
        url: "https://github.com/owner/repo/tree/main/skills/my-skill",
        scope: "local",
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/No workspace directory/i);
  });

  it("rejects import when destination directory already exists per no-overwrite guard", async () => {
    const wsDir = join(tmpRoot, "ws");
    fs.mkdirSync(join(wsDir, "skills", "my-skill"), { recursive: true });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.startsWith("https://api.github.com/")) {
        return new Response(
          JSON.stringify([{ name: "SKILL.md", type: "file", download_url: "https://download/SKILL.md", path: "skills/my-skill/SKILL.md" }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("body", { status: 200 });
    });
    const handlers = createSkillHandlers(
      makeDeps({ workspaceDirs: new Map([["agent-a", wsDir]]) }),
    );
    await expect(
      handlers["skills.import"]!({
        url: "https://github.com/owner/repo/tree/main/skills/my-skill",
        scope: "local",
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it("imports skill successfully when github folder contains SKILL.md and dest is empty", async () => {
    const wsDir = join(tmpRoot, "ws");
    fs.mkdirSync(wsDir, { recursive: true });
    const reg = makeRegistry([]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = typeof url === "string" ? url : url.toString();
      // Top-level dir listing
      if (u.includes("contents/skills/my-skill?")) {
        return new Response(
          JSON.stringify([
            { name: "SKILL.md", type: "file", download_url: "https://dl/SKILL.md", path: "skills/my-skill/SKILL.md" },
            { name: "sub", type: "dir", download_url: null, path: "skills/my-skill/sub" },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // Nested dir listing (terminates: returns one file, no more dirs)
      if (u.includes("contents/skills/my-skill/sub?")) {
        return new Response(
          JSON.stringify([{ name: "deep.md", type: "file", download_url: "https://dl/deep.md", path: "skills/my-skill/sub/deep.md" }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // download_url responses (raw file content)
      return new Response("body content", { status: 200 });
    });
    const handlers = createSkillHandlers(
      makeDeps({
        workspaceDirs: new Map([["agent-a", wsDir]]),
        skillRegistries: new Map([["agent-a", reg]]),
      }),
    );
    const result = await handlers["skills.import"]!({
      url: "https://github.com/owner/repo/tree/main/skills/my-skill",
      scope: "local",
      _agentId: "agent-a",
    });
    expect(result).toMatchObject({ ok: true, name: "my-skill" });
    expect(fs.existsSync(join(wsDir, "skills", "my-skill", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(join(wsDir, "skills", "my-skill", "sub", "deep.md"))).toBe(true);
    expect(reg.init).toHaveBeenCalled();
  });

  it("skills_import_writes_skill_file_at_0o600_and_dir_at_0o700_via_fs_safe_substrate", async () => {
    // Imported skill artifacts honor §1.4 modes
    // (dir 0o700, file 0o600) — including nested-parent dirs created
    // by the in-loop ensureContainedDir for sub-folders.
    const wsDir = join(tmpRoot, "ws");
    fs.mkdirSync(wsDir, { recursive: true });
    const reg = makeRegistry([]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("contents/skills/mode-skill?")) {
        return new Response(
          JSON.stringify([
            { name: "SKILL.md", type: "file", download_url: "https://dl/SKILL.md", path: "skills/mode-skill/SKILL.md" },
            { name: "sub", type: "dir", download_url: null, path: "skills/mode-skill/sub" },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.includes("contents/skills/mode-skill/sub?")) {
        return new Response(
          JSON.stringify([{ name: "deep.md", type: "file", download_url: "https://dl/deep.md", path: "skills/mode-skill/sub/deep.md" }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("body content", { status: 200 });
    });
    const handlers = createSkillHandlers(
      makeDeps({
        workspaceDirs: new Map([["agent-a", wsDir]]),
        skillRegistries: new Map([["agent-a", reg]]),
      }),
    );
    await handlers["skills.import"]!({
      url: "https://github.com/owner/repo/tree/main/skills/mode-skill",
      scope: "local",
      _agentId: "agent-a",
    });
    const skillDir = join(wsDir, "skills", "mode-skill");
    const skillFile = join(skillDir, "SKILL.md");
    const nestedDir = join(skillDir, "sub");
    const nestedFile = join(nestedDir, "deep.md");
    expect(fs.statSync(skillDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(nestedDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(skillFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(nestedFile).mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// skills.delete
// ---------------------------------------------------------------------------

describe("skills.delete handler", () => {
  it("rejects delete when calling agentId is absent from both rawParams and internals", async () => {
    const handlers = createSkillHandlers(makeDeps());
    await expect(
      handlers["skills.delete"]!({ name: "my-skill" }),
    ).rejects.toThrow(/Agent ID is required/i);
  });

  it("rejects delete when skill name fails validation pattern (uppercase letters forbidden)", async () => {
    const handlers = createSkillHandlers(makeDeps());
    await expect(
      handlers["skills.delete"]!({ name: "BadName", _agentId: "agent-a" }),
    ).rejects.toThrow(/Invalid skill name/i);
  });

  it("rejects shared-scope delete when calling agent is not the default agent per scope guard", async () => {
    const handlers = createSkillHandlers(makeDeps({ defaultAgentId: "owner" }));
    await expect(
      handlers["skills.delete"]!({
        name: "my-skill",
        scope: "shared",
        _agentId: "intruder",
      }),
    ).rejects.toThrow(/Only the default agent/i);
  });

  it("rejects delete when calling agent has no registry registered", async () => {
    const handlers = createSkillHandlers(makeDeps({ skillRegistries: new Map() }));
    await expect(
      handlers["skills.delete"]!({ name: "my-skill", _agentId: "agent-a" }),
    ).rejects.toThrow(/Skill registry not found/i);
  });

  it("rejects delete when skill name is not present in the agent registry's descriptions", async () => {
    const reg = makeRegistry([{ name: "other-skill", location: "/some/location" }]);
    const handlers = createSkillHandlers(
      makeDeps({ skillRegistries: new Map([["agent-a", reg]]) }),
    );
    await expect(
      handlers["skills.delete"]!({ name: "missing-skill", _agentId: "agent-a" }),
    ).rejects.toThrow(/Skill not found/i);
  });

  it("rejects local-scope delete when target skill is not located under the agent's workspace skills dir", async () => {
    const wsDir = join(tmpRoot, "ws");
    fs.mkdirSync(wsDir, { recursive: true });
    const dataDir = join(tmpRoot, "data");
    fs.mkdirSync(join(dataDir, "skills", "shared-skill"), { recursive: true });
    const container = makeContainer();
    (container as { config: { dataDir: string } }).config = { dataDir };
    const reg = makeRegistry([
      { name: "shared-skill", location: join(dataDir, "skills", "shared-skill") },
    ]);
    const handlers = createSkillHandlers(
      makeDeps({
        container,
        workspaceDirs: new Map([["agent-a", wsDir]]),
        skillRegistries: new Map([["agent-a", reg]]),
      }),
    );
    await expect(
      handlers["skills.delete"]!({
        name: "shared-skill",
        scope: "local",
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/not in this agent's workspace skills directory/i);
  });

  it("rejects shared-scope delete when target skill is not in the shared skills directory", async () => {
    const dataDir = join(tmpRoot, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const wsDir = join(tmpRoot, "ws");
    fs.mkdirSync(join(wsDir, "skills", "local-skill"), { recursive: true });
    const container = makeContainer();
    (container as { config: { dataDir: string } }).config = { dataDir };
    const reg = makeRegistry([
      { name: "local-skill", location: join(wsDir, "skills", "local-skill") },
    ]);
    const handlers = createSkillHandlers(
      makeDeps({
        container,
        defaultAgentId: "agent-a",
        workspaceDirs: new Map([["agent-a", wsDir]]),
        skillRegistries: new Map([["agent-a", reg]]),
      }),
    );
    await expect(
      handlers["skills.delete"]!({
        name: "local-skill",
        scope: "shared",
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/not in the shared skills directory/i);
  });

  it("removes the skill directory and triggers a per-agent registry re-init on successful local delete", async () => {
    const wsDir = join(tmpRoot, "ws");
    const skillPath = join(wsDir, "skills", "delete-me");
    fs.mkdirSync(skillPath, { recursive: true });
    fs.writeFileSync(join(skillPath, "SKILL.md"), "x", "utf-8");
    const reg = makeRegistry([{ name: "delete-me", location: skillPath }]);
    const container = makeContainer();
    (container as { config: { dataDir: string } }).config = { dataDir: join(tmpRoot, "data") };
    const handlers = createSkillHandlers(
      makeDeps({
        container,
        workspaceDirs: new Map([["agent-a", wsDir]]),
        skillRegistries: new Map([["agent-a", reg]]),
      }),
    );
    const result = await handlers["skills.delete"]!({
      name: "delete-me",
      scope: "local",
      _agentId: "agent-a",
    });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(skillPath)).toBe(false);
    expect(reg.init).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// skills.create
// ---------------------------------------------------------------------------

describe("skills.create handler", () => {
  it("rejects create when calling agentId is absent from both rawParams and internals", async () => {
    const handlers = createSkillHandlers(makeDeps());
    await expect(
      handlers["skills.create"]!({
        name: "my-skill",
        content: "---\nname: my-skill\n---",
      }),
    ).rejects.toThrow(/Agent ID is required/i);
  });

  it("rejects create when skill name fails validation pattern and emits skill:failed event", async () => {
    const eventBus = createMockEventBus();
    const handlers = createSkillHandlers(makeDeps({ eventBus }));
    await expect(
      handlers["skills.create"]!({
        name: "Invalid!",
        content: "---\nname: x\n---",
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/Invalid skill name/i);
    expect(eventBus.emit).toHaveBeenCalledWith("skill:failed", expect.objectContaining({ phase: "create" }));
  });

  it("rejects create when content is the empty string per zod min-length contract validation", async () => {
    const handlers = createSkillHandlers(makeDeps());
    await expect(
      handlers["skills.create"]!({
        name: "ok-name",
        content: "",
        _agentId: "agent-a",
      }),
    ).rejects.toThrow();
  });

  it("rejects shared-scope create when calling agent is not the default agent per scope guard", async () => {
    const handlers = createSkillHandlers(makeDeps({ defaultAgentId: "owner" }));
    await expect(
      handlers["skills.create"]!({
        name: "my-skill",
        scope: "shared",
        content: "---\nname: my-skill\n---",
        _agentId: "intruder",
      }),
    ).rejects.toThrow(/Only the default agent/i);
  });

  it("rejects local-scope create when calling agent has no workspace directory registered", async () => {
    const handlers = createSkillHandlers(makeDeps({ workspaceDirs: new Map() }));
    await expect(
      handlers["skills.create"]!({
        name: "my-skill",
        scope: "local",
        content: "---\nname: my-skill\n---",
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/No workspace directory/i);
  });

  it("rejects create when target directory already exists per no-overwrite guard", async () => {
    const wsDir = join(tmpRoot, "ws");
    fs.mkdirSync(join(wsDir, "skills", "existing"), { recursive: true });
    const handlers = createSkillHandlers(
      makeDeps({ workspaceDirs: new Map([["agent-a", wsDir]]) }),
    );
    await expect(
      handlers["skills.create"]!({
        name: "existing",
        scope: "local",
        content: "---\nname: existing\n---",
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it("writes SKILL.md and triggers registry re-init on successful create in local scope", async () => {
    const wsDir = join(tmpRoot, "ws");
    fs.mkdirSync(wsDir, { recursive: true });
    const reg = makeRegistry([]);
    const eventBus = createMockEventBus();
    const handlers = createSkillHandlers(
      makeDeps({
        workspaceDirs: new Map([["agent-a", wsDir]]),
        skillRegistries: new Map([["agent-a", reg]]),
        eventBus,
      }),
    );
    const result = await handlers["skills.create"]!({
      name: "new-skill",
      scope: "local",
      content: "---\nname: new-skill\ndescription: test skill\n---\nBody",
      _agentId: "agent-a",
    });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(join(wsDir, "skills", "new-skill", "SKILL.md"))).toBe(true);
    expect(reg.init).toHaveBeenCalled();
  });

  it("skills_create_writes_skill_file_at_0o600_and_dir_at_0o700_via_fs_safe_substrate", async () => {
    // skills.create routes its mkdir + SKILL.md
    // writeFile through the fs-safe substrate so the new skill artifact
    // honors the §1.4 confidentiality invariant (dir 0o700, file 0o600).
    const wsDir = join(tmpRoot, "ws");
    fs.mkdirSync(wsDir, { recursive: true });
    const reg = makeRegistry([]);
    const handlers = createSkillHandlers(
      makeDeps({
        workspaceDirs: new Map([["agent-a", wsDir]]),
        skillRegistries: new Map([["agent-a", reg]]),
      }),
    );
    await handlers["skills.create"]!({
      name: "mode-skill",
      scope: "local",
      content: "---\nname: mode-skill\ndescription: test skill\n---\nBody",
      _agentId: "agent-a",
    });
    const skillDir = join(wsDir, "skills", "mode-skill");
    const skillFile = join(skillDir, "SKILL.md");
    expect(fs.statSync(skillDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(skillFile).mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// skills.update
// ---------------------------------------------------------------------------

describe("skills.update handler", () => {
  it("rejects update when calling agentId is absent from both rawParams and internals", async () => {
    const handlers = createSkillHandlers(makeDeps());
    await expect(
      handlers["skills.update"]!({
        name: "my-skill",
        content: "---\nname: my-skill\n---",
      }),
    ).rejects.toThrow(/Agent ID is required/i);
  });

  it("rejects update when skill name fails validation pattern with uppercase letters", async () => {
    const handlers = createSkillHandlers(makeDeps());
    await expect(
      handlers["skills.update"]!({
        name: "BadName",
        content: "x",
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/Invalid skill name/i);
  });

  it("rejects update when content is the empty string per zod min-length contract validation", async () => {
    const handlers = createSkillHandlers(makeDeps());
    await expect(
      handlers["skills.update"]!({
        name: "ok-name",
        content: "",
        _agentId: "agent-a",
      }),
    ).rejects.toThrow();
  });

  it("rejects update when calling agent has no registry registered for it", async () => {
    const handlers = createSkillHandlers(makeDeps({ skillRegistries: new Map() }));
    await expect(
      handlers["skills.update"]!({
        name: "my-skill",
        content: "---\nname: my-skill\n---",
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/Skill registry not found/i);
  });

  it("rejects update when skill name is not present in the agent's registry descriptions", async () => {
    const reg = makeRegistry([{ name: "other", location: "/other" }]);
    const handlers = createSkillHandlers(
      makeDeps({ skillRegistries: new Map([["agent-a", reg]]) }),
    );
    await expect(
      handlers["skills.update"]!({
        name: "missing",
        content: "x",
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/Skill not found/i);
  });

  it("rejects shared-scope update when calling agent is not the default agent per scope guard", async () => {
    const reg = makeRegistry([{ name: "shared-skill", location: "/skills/shared-skill" }]);
    const handlers = createSkillHandlers(
      makeDeps({
        defaultAgentId: "owner",
        skillRegistries: new Map([["intruder", reg]]),
      }),
    );
    await expect(
      handlers["skills.update"]!({
        name: "shared-skill",
        scope: "shared",
        content: "x",
        _agentId: "intruder",
      }),
    ).rejects.toThrow(/Only the default agent/i);
  });

  it("rejects update when SKILL.md is missing at the registered skill location on disk", async () => {
    const skillDir = join(tmpRoot, "ghost-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    // Note: SKILL.md intentionally not written
    const reg = makeRegistry([{ name: "ghost-skill", location: skillDir }]);
    const handlers = createSkillHandlers(
      makeDeps({ skillRegistries: new Map([["agent-a", reg]]) }),
    );
    await expect(
      handlers["skills.update"]!({
        name: "ghost-skill",
        content: "new content",
        _agentId: "agent-a",
      }),
    ).rejects.toThrow(/SKILL\.md not found/i);
  });

  it("overwrites SKILL.md and triggers registry re-init on successful update in local scope", async () => {
    const wsDir = join(tmpRoot, "ws");
    const skillDir = join(wsDir, "skills", "update-me");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(join(skillDir, "SKILL.md"), "OLD CONTENT", "utf-8");
    const reg = makeRegistry([{ name: "update-me", location: skillDir }]);
    const eventBus = createMockEventBus();
    const handlers = createSkillHandlers(
      makeDeps({
        workspaceDirs: new Map([["agent-a", wsDir]]),
        skillRegistries: new Map([["agent-a", reg]]),
        eventBus,
      }),
    );
    const result = await handlers["skills.update"]!({
      name: "update-me",
      content: "---\nname: update-me\n---\nNEW BODY",
      _agentId: "agent-a",
    });
    expect(result.ok).toBe(true);
    const content = fs.readFileSync(join(skillDir, "SKILL.md"), "utf-8");
    expect(content).toContain("NEW BODY");
    expect(reg.init).toHaveBeenCalled();
  });

  it("skills_update_writes_skill_file_at_0o600_via_fs_safe_substrate", async () => {
    // skills.update routes its SKILL.md
    // overwrite through writeRegularFile so the resulting file mode is
    // `0o600` — and writeRegularFile's unlink-before-open + defensive
    // fchmod path defensively corrects legacy artifacts written at a
    // wider mode by older code.
    const wsDir = join(tmpRoot, "ws");
    const skillDir = join(wsDir, "skills", "mode-update");
    fs.mkdirSync(skillDir, { recursive: true });
    // Pre-seed a legacy SKILL.md at the wider 0o644 mode (the older default).
    fs.writeFileSync(join(skillDir, "SKILL.md"), "LEGACY", "utf-8");
    fs.chmodSync(join(skillDir, "SKILL.md"), 0o644);
    const reg = makeRegistry([{ name: "mode-update", location: skillDir }]);
    const handlers = createSkillHandlers(
      makeDeps({
        workspaceDirs: new Map([["agent-a", wsDir]]),
        skillRegistries: new Map([["agent-a", reg]]),
      }),
    );
    await handlers["skills.update"]!({
      name: "mode-update",
      content: "---\nname: mode-update\n---\nNEW BODY",
      _agentId: "agent-a",
    });
    const skillFile = join(skillDir, "SKILL.md");
    // The legacy 0o644 file is replaced; the new file is 0o600.
    expect(fs.statSync(skillFile).mode & 0o777).toBe(0o600);
  });
});
