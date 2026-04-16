/**
 * Tests for runtime eligibility evaluation and registry integration.
 *
 * Covers runtime eligibility requirements:
 * - OS platform filtering
 * - Binary availability filtering
 * - Environment variable filtering
 * - Binary cache populated at init, not per-request
 * - Eligibility integrates with existing allow/deny filtering
 * - DEBUG log with skill name and reason for exclusion
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateSkillEligibility,
  createRuntimeEligibilityContext,
  type RuntimeEligibilityContext,
  type EligibilityResult,
} from "./eligibility.js";
import { createSkillRegistry } from "./skill-registry.js";
import type { TypedEventBus } from "@comis/core";
import { createSecretManager, SkillsConfigSchema } from "@comis/core";
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
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "comis-eligibility-test-"));
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

/** Create a root .md prompt skill file with extended frontmatter fields under comis: namespace. */
function createPromptSkillWithNewFields(
  basePath: string,
  name: string,
  description: string,
  body: string,
  fields: {
    os?: string | string[];
    requires?: { bins?: string[]; env?: string[] };
    userInvocable?: boolean;
  },
): void {
  let comisYaml = "";
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

  if (comisLines.length > 0) {
    comisYaml = `comis:\n${comisLines.join("\n")}`;
  }

  const content = `---
name: ${name}
description: "${description}"
type: prompt
userInvocable: ${fields.userInvocable ?? true}
${comisYaml}
---

${body}
`;
  fs.writeFileSync(path.join(basePath, `${name}.md`), content, "utf-8");
}

/** Create a mock RuntimeEligibilityContext with controllable behavior. */
function createMockEligibilityContext(opts: {
  platform?: string;
  availableBins?: Set<string>;
  availableEnvVars?: Set<string>;
}): RuntimeEligibilityContext {
  const bins = opts.availableBins ?? new Set<string>();
  const envVars = opts.availableEnvVars ?? new Set<string>();
  return {
    platform: opts.platform ?? process.platform,
    hasBin: (name: string) => bins.has(name),
    hasEnv: (key: string) => envVars.has(key),
    populateBinaryCache: vi.fn(),
  };
}

/** Create a SkillsConfig using SkillsConfigSchema.parse for type safety. */
function makeConfig(overrides: Record<string, unknown> = {}) {
  return SkillsConfigSchema.parse({
    discoveryPaths: [tmpDir],
    ...overrides,
  });
}

const auditCtx = { agentId: "test-agent", tenantId: "test-tenant", userId: "test-user" };

// ---------------------------------------------------------------------------
// evaluateSkillEligibility (pure function tests)
// ---------------------------------------------------------------------------

describe("evaluateSkillEligibility", () => {
  it("returns eligible when skill has no constraints", () => {
    const ctx = createMockEligibilityContext({});
    const result = evaluateSkillEligibility({}, ctx);
    expect(result).toEqual({ eligible: true });
  });

  it("returns eligible when os matches current platform", () => {
    const ctx = createMockEligibilityContext({ platform: "linux" });
    const result = evaluateSkillEligibility({ os: ["linux"] }, ctx);
    expect(result).toEqual({ eligible: true });
  });

  it("returns ineligible with os mismatch reason when platform not in os array", () => {
    const ctx = createMockEligibilityContext({ platform: "linux" });
    const result = evaluateSkillEligibility({ os: ["darwin"] }, ctx);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('os mismatch: platform "linux" not in [darwin]');
  });

  it("returns eligible when os array is empty (no restriction)", () => {
    const ctx = createMockEligibilityContext({ platform: "linux" });
    const result = evaluateSkillEligibility({ os: [] }, ctx);
    expect(result).toEqual({ eligible: true });
  });

  it("returns eligible when all required binaries are available", () => {
    const ctx = createMockEligibilityContext({ availableBins: new Set(["ffmpeg", "curl"]) });
    const result = evaluateSkillEligibility({ requires: { bins: ["ffmpeg", "curl"], env: [] } }, ctx);
    expect(result).toEqual({ eligible: true });
  });

  it("returns ineligible with missing binary reason", () => {
    const ctx = createMockEligibilityContext({ availableBins: new Set() });
    const result = evaluateSkillEligibility({ requires: { bins: ["ffmpeg"], env: [] } }, ctx);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("missing binary: ffmpeg");
  });

  it("returns ineligible listing all missing binaries", () => {
    const ctx = createMockEligibilityContext({ availableBins: new Set() });
    const result = evaluateSkillEligibility({ requires: { bins: ["ffmpeg", "sox"], env: [] } }, ctx);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("missing binary: ffmpeg, sox");
  });

  it("returns eligible when all required env vars are set", () => {
    const ctx = createMockEligibilityContext({ availableEnvVars: new Set(["OPENAI_KEY"]) });
    const result = evaluateSkillEligibility({ requires: { bins: [], env: ["OPENAI_KEY"] } }, ctx);
    expect(result).toEqual({ eligible: true });
  });

  it("returns ineligible with missing env var reason", () => {
    const ctx = createMockEligibilityContext({ availableEnvVars: new Set() });
    const result = evaluateSkillEligibility({ requires: { bins: [], env: ["OPENAI_KEY"] } }, ctx);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("missing env var: OPENAI_KEY");
  });

  it("returns ineligible listing all missing env vars", () => {
    const ctx = createMockEligibilityContext({ availableEnvVars: new Set() });
    const result = evaluateSkillEligibility({ requires: { bins: [], env: ["OPENAI_KEY", "ANTHROPIC_KEY"] } }, ctx);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("missing env var: OPENAI_KEY, ANTHROPIC_KEY");
  });

  it("checks os before binaries before env vars (fail fast)", () => {
    // All three would fail, but os is checked first
    const ctx = createMockEligibilityContext({
      platform: "linux",
      availableBins: new Set(),
      availableEnvVars: new Set(),
    });
    const result = evaluateSkillEligibility(
      { os: ["darwin"], requires: { bins: ["ffmpeg"], env: ["OPENAI_KEY"] } },
      ctx,
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("os mismatch");
    // Should NOT contain binary or env var messages
    expect(result.reason).not.toContain("binary");
    expect(result.reason).not.toContain("env var");
  });

  it("returns eligible when all constraints satisfied together", () => {
    const ctx = createMockEligibilityContext({
      platform: "linux",
      availableBins: new Set(["ffmpeg", "curl"]),
      availableEnvVars: new Set(["OPENAI_KEY", "ANTHROPIC_KEY"]),
    });
    const result = evaluateSkillEligibility(
      { os: ["linux", "darwin"], requires: { bins: ["ffmpeg", "curl"], env: ["OPENAI_KEY", "ANTHROPIC_KEY"] } },
      ctx,
    );
    expect(result).toEqual({ eligible: true });
  });
});

// ---------------------------------------------------------------------------
// createRuntimeEligibilityContext (factory tests)
// ---------------------------------------------------------------------------

describe("createRuntimeEligibilityContext", () => {
  it("reads PATH from SecretManager and detects existing binary", async () => {
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binaryPath = path.join(binDir, "test-binary");
    fs.writeFileSync(binaryPath, "#!/bin/sh\necho hello", "utf-8");
    fs.chmodSync(binaryPath, 0o755);

    const sm = createSecretManager({ PATH: binDir });
    const ctx = createRuntimeEligibilityContext(sm);
    ctx.populateBinaryCache(["test-binary"]);

    expect(ctx.hasBin("test-binary")).toBe(true);
  });

  it("returns false for binary not on PATH", () => {
    const sm = createSecretManager({ PATH: tmpDir });
    const ctx = createRuntimeEligibilityContext(sm);
    ctx.populateBinaryCache(["nonexistent"]);

    expect(ctx.hasBin("nonexistent")).toBe(false);
  });

  it("checks env vars via SecretManager.has()", () => {
    const sm = createSecretManager({ OPENAI_KEY: "sk-test" });
    const ctx = createRuntimeEligibilityContext(sm);

    expect(ctx.hasEnv("OPENAI_KEY")).toBe(true);
    expect(ctx.hasEnv("MISSING_KEY")).toBe(false);
  });

  it("uses process.platform for platform property", () => {
    const sm = createSecretManager({});
    const ctx = createRuntimeEligibilityContext(sm);

    expect(ctx.platform).toBe(process.platform);
  });

  it("caches binary results after populateBinaryCache", () => {
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binaryPath = path.join(binDir, "cached-bin");
    fs.writeFileSync(binaryPath, "#!/bin/sh\necho hello", "utf-8");
    fs.chmodSync(binaryPath, 0o755);

    const sm = createSecretManager({ PATH: binDir });
    const ctx = createRuntimeEligibilityContext(sm);

    // Populate cache
    ctx.populateBinaryCache(["cached-bin"]);
    expect(ctx.hasBin("cached-bin")).toBe(true);

    // Remove the binary file to prove cache is used
    fs.unlinkSync(binaryPath);

    // Should still return true from cache
    expect(ctx.hasBin("cached-bin")).toBe(true);

    // Re-populate clears cache and re-checks filesystem
    ctx.populateBinaryCache(["cached-bin"]);
    expect(ctx.hasBin("cached-bin")).toBe(false);
  });

  it("handles empty PATH gracefully", () => {
    const sm = createSecretManager({});
    const ctx = createRuntimeEligibilityContext(sm);
    ctx.populateBinaryCache(["anything"]);

    expect(ctx.hasBin("anything")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Registry integration (end-to-end with real registry)
// ---------------------------------------------------------------------------

describe("registry integration", () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("excludes skill by os mismatch from getPromptSkillDescriptions", () => {
    // One skill restricted to an impossible platform, one universal
    const oppositeOs = process.platform === "linux" ? "win32" : "linux";
    createPromptSkillWithNewFields(tmpDir, "os-restricted", "Restricted skill", "Restricted body", {
      os: [oppositeOs],
    });
    createPromptSkill(tmpDir, "universal", "Universal skill", "Universal body");

    const ctx = createMockEligibilityContext({ platform: process.platform });
    const config = makeConfig();
    const registry = createSkillRegistry(config, createMockEventBus(), auditCtx, mockLogger, ctx);
    registry.init();

    const descriptions = registry.getPromptSkillDescriptions();
    const names = descriptions.map((d) => d.name);

    expect(names).toContain("universal");
    expect(names).not.toContain("os-restricted");

    // DEBUG log with skill name and reason
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        skillName: "os-restricted",
        reason: expect.stringContaining("os mismatch"),
      }),
      "Skill excluded by runtime eligibility",
    );
  });

  it("excludes skill by missing binary from getUserInvocableSkillNames", () => {
    createPromptSkillWithNewFields(tmpDir, "ffmpeg-skill", "Needs ffmpeg", "FFmpeg body", {
      requires: { bins: ["ffmpeg"] },
      userInvocable: true,
    });
    createPromptSkill(tmpDir, "no-deps", "No deps skill", "No deps body", { userInvocable: true });

    // Context with NO available binaries
    const ctx = createMockEligibilityContext({ availableBins: new Set() });
    const config = makeConfig();
    const registry = createSkillRegistry(config, createMockEventBus(), auditCtx, mockLogger, ctx);
    registry.init();

    const invocable = registry.getUserInvocableSkillNames();

    expect(invocable.has("no-deps")).toBe(true);
    expect(invocable.has("ffmpeg-skill")).toBe(false);
  });

  it("excludes skill by missing env var from getRelevantPromptSkills", () => {
    createPromptSkillWithNewFields(tmpDir, "openai-skill", "OpenAI integration helper", "OpenAI body", {
      requires: { env: ["OPENAI_KEY"] },
    });
    createPromptSkill(tmpDir, "basic-helper", "Basic integration helper", "Basic body");

    // Context with no available env vars
    const ctx = createMockEligibilityContext({ availableEnvVars: new Set() });
    const config = makeConfig();
    const registry = createSkillRegistry(config, createMockEventBus(), auditCtx, mockLogger, ctx);
    registry.init();

    const relevant = registry.getRelevantPromptSkills("integration helper");
    const names = relevant.map((s) => s.name);

    expect(names).toContain("basic-helper");
    expect(names).not.toContain("openai-skill");
  });

  it("includes skill when all prerequisites are met", () => {
    createPromptSkillWithNewFields(tmpDir, "full-reqs", "Full requirements skill", "Full body", {
      os: [process.platform],
      requires: { bins: ["ffmpeg"], env: ["OPENAI_KEY"] },
    });

    const ctx = createMockEligibilityContext({
      platform: process.platform,
      availableBins: new Set(["ffmpeg"]),
      availableEnvVars: new Set(["OPENAI_KEY"]),
    });
    const config = makeConfig();
    const registry = createSkillRegistry(config, createMockEventBus(), auditCtx, mockLogger, ctx);
    registry.init();

    const descriptions = registry.getPromptSkillDescriptions();
    expect(descriptions.map((d) => d.name)).toContain("full-reqs");
  });

  it("populates binary cache during init()", () => {
    createPromptSkillWithNewFields(tmpDir, "bin-skill", "Needs binaries", "Body with deps", {
      requires: { bins: ["ffmpeg", "sox"] },
    });

    const ctx = createMockEligibilityContext({});
    const config = makeConfig();
    const registry = createSkillRegistry(config, createMockEventBus(), auditCtx, mockLogger, ctx);
    registry.init();

    // populateBinaryCache should have been called with the set of required binaries
    expect(ctx.populateBinaryCache).toHaveBeenCalledTimes(1);
    const calledWith = (ctx.populateBinaryCache as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(calledWith.sort()).toEqual(["ffmpeg", "sox"]);
  });

  it("does not filter when eligibility context is not provided (backward compat)", () => {
    const oppositeOs = process.platform === "linux" ? "win32" : "linux";
    createPromptSkillWithNewFields(tmpDir, "os-restricted", "Restricted skill", "Restricted body", {
      os: [oppositeOs],
    });

    // No eligibility context passed
    const config = makeConfig();
    const registry = createSkillRegistry(config, createMockEventBus(), auditCtx, mockLogger);
    registry.init();

    const descriptions = registry.getPromptSkillDescriptions();
    // Without context, os-restricted skill is included (no filtering)
    expect(descriptions.map((d) => d.name)).toContain("os-restricted");
  });

  it("respects runtimeEligibility.enabled = false (disables filtering)", () => {
    const oppositeOs = process.platform === "linux" ? "win32" : "linux";
    createPromptSkillWithNewFields(tmpDir, "os-restricted", "Restricted skill", "Restricted body", {
      os: [oppositeOs],
    });

    const ctx = createMockEligibilityContext({ platform: process.platform });
    const config = makeConfig({ runtimeEligibility: { enabled: false } });
    const registry = createSkillRegistry(config, createMockEventBus(), auditCtx, mockLogger, ctx);
    registry.init();

    const descriptions = registry.getPromptSkillDescriptions();
    // With enabled: false, os-restricted skill is included
    expect(descriptions.map((d) => d.name)).toContain("os-restricted");
  });
});
