// SPDX-License-Identifier: Apache-2.0
/**
 * Progressive tool / skill disclosure integration test.
 *
 * Comis implements progressive disclosure on TWO axes that this test
 * pins end to end:
 *
 *   A. Tool policy (`applyToolPolicy`): given a fleet of registered
 *      AgentTools, only the subset selected by the agent's tool policy
 *      reaches the LLM. The policy supports named profiles, allow/deny
 *      lists, and group expansion. Filtered-out tools come back with a
 *      structured `ToolFilterReason` so operators can see why a tool was
 *      hidden.
 *
 *   B. Prompt-skill registry (`createSkillRegistry`): Level 1 of
 *      progressive disclosure indexes only metadata (name, description,
 *      front-matter). Level 2 (`loadPromptSkill(name)`) reads, sanitises
 *      and caches the body. The level boundary keeps the LLM context
 *      small until the agent explicitly invokes a skill.
 *
 * Asserts:
 *   - `expandGroups` substitutes `group:foo` references using TOOL_GROUPS
 *     and de-duplicates the result.
 *   - `applyToolPolicy` honours `profile=full` (no-op filter), `profile=minimal`
 *     (restricted baseline), and `allow`/`deny` overrides; structured
 *     reasons reflect which gate filtered each tool.
 *   - `createSkillRegistry.init()` discovers Markdown skills WITHOUT
 *     loading their bodies; getMetadataCount() reflects that.
 *   - `loadPromptSkill(name)` returns ok(content) with the body present
 *     and `getPromptSkillDescriptions()` exposes only descriptions, not
 *     bodies, to the prompt builder.
 *   - Eligibility filtering (`getEligibleSkillNames()`) reflects the
 *     promptSkills.allowedSkills/deniedSkills lists.
 *
 * Uses an ephemeral temp dir for skill discovery; no daemon required.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyToolPolicy,
  expandGroups,
  TOOL_PROFILES,
  TOOL_GROUPS,
  createSkillRegistry,
  type SkillRegistry,
} from "@comis/skills";
import { TypedEventBus, SkillsConfigSchema } from "@comis/core";

// ---------------------------------------------------------------------------
// Fake AgentTool factory (the type allows additional fields; we only use name)
// ---------------------------------------------------------------------------

function fakeTool(name: string) {
  return {
    name,
    description: `Tool ${name}`,
    parameters: { type: "object" },
    execute: async () => ({ ok: true }),
  };
}

function fakeTools(names: string[]) {
  // The cast matches the AgentTool<any>[] shape applyToolPolicy expects.
  return names.map(fakeTool) as unknown as Parameters<
    typeof applyToolPolicy
  >[0];
}

// ---------------------------------------------------------------------------
// Suite -- tool policy filter
// ---------------------------------------------------------------------------

describe("Tool policy -- group expansion", () => {
  it("expandGroups returns unknown names unchanged", () => {
    const r = expandGroups(["bash", "read", "write"]);
    expect(r.sort()).toEqual(["bash", "read", "write"]);
  });

  it("expandGroups substitutes a known group reference", () => {
    // TOOL_GROUPS keys already INCLUDE the "group:" prefix, so callers pass
    // them through verbatim (e.g. ["group:coding"]).
    const groups = Object.keys(TOOL_GROUPS);
    expect(groups.length).toBeGreaterThan(0);
    const groupName = groups[0]!;
    const expanded = expandGroups([groupName]);
    for (const member of TOOL_GROUPS[groupName]!) {
      expect(expanded).toContain(member);
    }
  });

  it("expandGroups de-duplicates when a tool appears in two groups", () => {
    const groups = Object.keys(TOOL_GROUPS);
    if (groups.length < 2) return; // not enough groups in this build to test
    const a = groups[0]!;
    const b = groups[1]!;
    const expanded = expandGroups([a, b]);
    const set = new Set(expanded);
    expect(set.size).toBe(expanded.length);
  });
});

describe("Tool policy -- profile + allow + deny filtering", () => {
  it("'full' profile passes all tools through unchanged", () => {
    const tools = fakeTools(["read", "write", "exec", "webSearch"]);
    const r = applyToolPolicy(tools, {
      profile: "full",
      allow: [],
      deny: [],
    });
    expect(r.tools.length).toBe(tools.length);
    expect(r.filtered.length).toBe(0);
  });

  it("a non-full profile restricts the baseline tool set", () => {
    // Pick a known profile that has a non-empty whitelist.
    const profiles = Object.keys(TOOL_PROFILES).filter((p) => {
      const set = TOOL_PROFILES[p];
      return set !== undefined && set.length > 0;
    });
    expect(profiles.length).toBeGreaterThan(0);
    const profileName = profiles[0]!;
    const allowed = TOOL_PROFILES[profileName]!;

    // Build a tool list that mixes allowed + non-allowed names.
    const tools = fakeTools([...allowed, "tool_not_in_profile_xyz"]);
    const r = applyToolPolicy(tools, {
      profile: profileName as "minimal" | "coding" | "messaging" | "supervisor" | "full",
      allow: [],
      deny: [],
    });

    // Outside-profile tool is filtered with a structured reason.
    const filtered = r.filtered.find(
      (f) => f.toolName === "tool_not_in_profile_xyz",
    );
    expect(filtered).toBeDefined();
    expect(filtered?.reason.kind).toBe("not_in_profile");
  });

  it("'allow' adds tools beyond the profile baseline", () => {
    const tools = fakeTools(["read", "exec"]);
    // 'minimal' should not include exec by default.
    const r = applyToolPolicy(tools, {
      profile: "minimal",
      allow: ["exec"],
      deny: [],
    });
    expect(r.tools.map((t) => t.name)).toContain("exec");
  });

  it("'deny' removes a tool the profile would otherwise allow, with a reason", () => {
    const tools = fakeTools(["read", "write", "exec"]);
    const r = applyToolPolicy(tools, {
      profile: "full",
      allow: [],
      deny: ["exec"],
    });
    expect(r.tools.map((t) => t.name)).not.toContain("exec");
    const filtered = r.filtered.find((f) => f.toolName === "exec");
    expect(filtered).toBeDefined();
    expect(filtered?.reason.kind).toBe("explicit_deny");
  });
});

// ---------------------------------------------------------------------------
// Suite -- skill registry progressive disclosure
// ---------------------------------------------------------------------------

describe("Skill registry -- 2-level progressive disclosure", () => {
  let dir: string;
  let bus: TypedEventBus;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "comis-skill-pd-"));

    // Drop two valid SKILL.md files: one as a subdirectory SKILL.md, one
    // as a root .md file. Both should be discovered.
    const skillA = join(dir, "alpha");
    mkdirSync(skillA, { recursive: true });
    writeFileSync(
      join(skillA, "SKILL.md"),
      [
        "---",
        "name: alpha",
        "description: Alpha skill body for testing.",
        "---",
        "",
        "# Alpha",
        "Real body text -- this should NOT load at level 1.",
      ].join("\n"),
    );

    writeFileSync(
      join(dir, "beta.md"),
      [
        "---",
        "name: beta",
        "description: Beta skill -- root .md form.",
        "---",
        "",
        "# Beta",
        "Beta body content.",
      ].join("\n"),
    );

    bus = new TypedEventBus();
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  function makeRegistry(opts?: {
    allowedSkills?: string[];
    deniedSkills?: string[];
  }): SkillRegistry {
    const config = SkillsConfigSchema.parse({
      discoveryPaths: [dir],
      promptSkills: {
        allowedSkills: opts?.allowedSkills ?? [],
        deniedSkills: opts?.deniedSkills ?? [],
      },
    });
    return createSkillRegistry(config, bus, {
      agentId: "default",
      tenantId: "test",
      userId: "user_a",
    });
  }

  it("init() discovers metadata WITHOUT loading bodies", () => {
    const reg = makeRegistry();
    reg.init();
    expect(reg.getMetadataCount()).toBeGreaterThanOrEqual(2);

    // getPromptSkillDescriptions returns lightweight descriptions
    // (name + description), not bodies.
    const descs = reg.getPromptSkillDescriptions();
    const names = new Set(descs.map((d) => d.name));
    expect(names.has("alpha")).toBe(true);
    expect(names.has("beta")).toBe(true);
    for (const d of descs) {
      // Descriptions intentionally omit the body so the LLM tool list
      // stays small at level 1.
      expect("body" in d).toBe(false);
    }
  });

  it("loadPromptSkill(name) reads and caches the body (level 2)", async () => {
    const reg = makeRegistry();
    reg.init();
    const r = await reg.loadPromptSkill("alpha");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe("alpha");
    expect(r.value.body).toContain("Real body text");
    expect(r.value.body).toContain("# Alpha");

    // Calling again hits the cache; the result must still match.
    const again = await reg.loadPromptSkill("alpha");
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.body).toBe(r.value.body);
  });

  it("loadPromptSkill returns err for an unknown skill name", async () => {
    const reg = makeRegistry();
    reg.init();
    const r = await reg.loadPromptSkill("does-not-exist");
    expect(r.ok).toBe(false);
  });

  it("denied skills are excluded from getEligibleSkillNames()", () => {
    const reg = makeRegistry({ deniedSkills: ["beta"] });
    reg.init();
    const eligible = reg.getEligibleSkillNames();
    expect(eligible.has("alpha")).toBe(true);
    expect(eligible.has("beta")).toBe(false);
  });

  it("allowedSkills (when non-empty) acts as an explicit whitelist", () => {
    const reg = makeRegistry({ allowedSkills: ["alpha"] });
    reg.init();
    const eligible = reg.getEligibleSkillNames();
    expect(eligible.has("alpha")).toBe(true);
    expect(eligible.has("beta")).toBe(false);
  });
});

describe("Skill registry -- snapshot version monotonicity", () => {
  let dir: string;
  let bus: TypedEventBus;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "comis-skill-snap-"));
    const subdir = join(dir, "alpha");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(
      join(subdir, "SKILL.md"),
      [
        "---",
        "name: alpha",
        "description: Alpha",
        "---",
        "Body.",
      ].join("\n"),
    );
    bus = new TypedEventBus();
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("getSnapshot().version increments after init", () => {
    const config = SkillsConfigSchema.parse({ discoveryPaths: [dir] });
    const reg = createSkillRegistry(config, bus, {
      agentId: "default",
      tenantId: "test",
      userId: "user_a",
    });

    const v0 = reg.getSnapshotVersion();
    reg.init();
    const v1 = reg.getSnapshotVersion();
    expect(v1).toBeGreaterThan(v0);

    const snap = reg.getSnapshot();
    expect(snap.version).toBe(v1);
  });
});
