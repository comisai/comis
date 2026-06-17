// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the learned-skill surface helper (SURFACE-01/03 + D1).
 *
 * The cache keystone: learned `<skill>` blocks append AFTER platform blocks in
 * ONE `<available_skills>` wrapper, so the per-session prompt-skills freeze
 * captures a byte-stable platform prefix (a newly-promoted skill is picked up
 * on the NEXT session, never mid-session). Materialization derives the
 * `<workspace>/.learned-skills/<name>/SKILL.md` tree WHOLESALE from `list()`
 * filtered to `active ∧ !mutating` (derive-on-refresh — a demoted skill's file
 * is gone after a refresh). Every dynamic path segment goes through `safePath`.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ok, err, type Result } from "@comis/shared";
import { safePath, type LearnedSkill, type LearnedSkillStorePort, type LearningScope } from "@comis/core";
import type { PromptSkillDescription } from "@comis/skills";
import {
  mergeLearnedSkillsXml,
  materializeLearnedSkills,
  renderLearnedSkillsXml,
  refreshLearnedSkillSurface,
} from "./learned-skill-surface.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A platform PromptSkillDescription with an absolute location (as the registry produces). */
function platform(name: string): PromptSkillDescription {
  return {
    name,
    description: `desc-${name}`,
    location: `/abs/skills/${name}`,
  };
}

/** A LearnedSkill row mirror; defaults are an active, read-only procedure. */
function learned(over: Partial<LearnedSkill> = {}): LearnedSkill {
  return {
    id: `id-${over.name ?? "alpha"}`,
    name: over.name ?? "alpha",
    description: over.description ?? "an alpha procedure",
    body: over.body ?? "# Alpha\n\nStep 1. Do the thing.\n",
    trustLevel: "learned",
    state: over.state ?? "active",
    proofCount: over.proofCount ?? 3,
    confidence: over.confidence ?? 0.9,
    mutating: over.mutating ?? false,
    sourceTrajIds: over.sourceTrajIds ?? [],
    createdAt: over.createdAt ?? 1_700_000_000_000,
  };
}

/** A no-op pino-compatible logger. */
const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as import("@comis/infra").ComisLogger;

const scope: LearningScope = { tenantId: "t1", agentId: "a1" };

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(safePath(tmpdir(), "learned-surface-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// mergeLearnedSkillsXml — the append-after-platform cache keystone
// ---------------------------------------------------------------------------

describe("mergeLearnedSkillsXml — append after platform", () => {
  it("renders ONE <available_skills> wrapper with platform first, then learned LAST", () => {
    const xml = mergeLearnedSkillsXml(
      [platform("P1"), platform("P2")],
      [learned({ name: "L1", description: "learned one" })],
      workDir,
    );

    // Order: P1 < P2 < L1 (learned appended last).
    const iP1 = xml.indexOf("<name>P1</name>");
    const iP2 = xml.indexOf("<name>P2</name>");
    const iL1 = xml.indexOf("<name>L1</name>");
    expect(iP1).toBeGreaterThan(-1);
    expect(iP2).toBeGreaterThan(iP1);
    expect(iL1).toBeGreaterThan(iP2);
  });

  it("emits EXACTLY ONE <available_skills> open + close tag (never two wrappers)", () => {
    const xml = mergeLearnedSkillsXml(
      [platform("P1")],
      [learned({ name: "L1" }), learned({ name: "L2", id: "id-L2" })],
      workDir,
    );
    const opens = xml.match(/<available_skills>/g) ?? [];
    const closes = xml.match(/<\/available_skills>/g) ?? [];
    expect(opens).toHaveLength(1);
    expect(closes).toHaveLength(1);
  });

  it("keeps the platform byte-prefix UNCHANGED when a learned skill is appended (cache-stability)", () => {
    const platformOnly = mergeLearnedSkillsXml([platform("P1"), platform("P2")], [], workDir);
    const withLearned = mergeLearnedSkillsXml(
      [platform("P1"), platform("P2")],
      [learned({ name: "L1" })],
      workDir,
    );

    // The prefix through the LAST platform </skill> must be byte-identical.
    const cut = platformOnly.indexOf("</skill>") > -1
      ? platformOnly.lastIndexOf("</skill>") + "</skill>".length
      : platformOnly.length;
    expect(withLearned.startsWith(platformOnly.slice(0, cut))).toBe(true);
  });

  it("renders <source>learned</source> on the learned block (the model-visible trust distinction)", () => {
    const xml = mergeLearnedSkillsXml([platform("P1")], [learned({ name: "L1" })], workDir);
    // Platform default source is bundled; learned explicitly carries learned.
    expect(xml).toContain("<source>learned</source>");
    // The learned <location> points at the workspace-relative materialized SKILL.md.
    expect(xml).toContain("<location>.learned-skills/L1/SKILL.md</location>");
  });

  it("filters to active ∧ !mutating — mutating/stale/candidate/archived NEVER surface", () => {
    const xml = mergeLearnedSkillsXml(
      [platform("P1")],
      [
        learned({ name: "Mut", id: "id-mut", mutating: true }),
        learned({ name: "Stale", id: "id-stale", state: "stale" }),
        learned({ name: "Cand", id: "id-cand", state: "candidate" }),
        learned({ name: "Arch", id: "id-arch", state: "archived" }),
        learned({ name: "Good", id: "id-good" }),
      ],
      workDir,
    );
    expect(xml).toContain("<name>Good</name>");
    expect(xml).not.toContain("<name>Mut</name>");
    expect(xml).not.toContain("<name>Stale</name>");
    expect(xml).not.toContain("<name>Cand</name>");
    expect(xml).not.toContain("<name>Arch</name>");
  });
});

// ---------------------------------------------------------------------------
// materializeLearnedSkills — derive-on-refresh, never a stale file
// ---------------------------------------------------------------------------

describe("materializeLearnedSkills — derive wholesale", () => {
  it("writes <workspace>/.learned-skills/<name>/SKILL.md containing the body", () => {
    materializeLearnedSkills(workDir, [learned({ name: "alpha", body: "# Alpha body" })]);
    const file = safePath(workDir, ".learned-skills", "alpha", "SKILL.md");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("# Alpha body");
  });

  it("removes a demoted skill's SKILL.md on the next refresh (a second call with [])", () => {
    materializeLearnedSkills(workDir, [learned({ name: "alpha" })]);
    const file = safePath(workDir, ".learned-skills", "alpha", "SKILL.md");
    expect(existsSync(file)).toBe(true);

    // Refresh with the skill gone (demoted/archived) → its file must NOT survive.
    materializeLearnedSkills(workDir, []);
    expect(existsSync(file)).toBe(false);
  });

  it("does NOT materialize mutating or non-active skills (the surface filter holds for files too)", () => {
    materializeLearnedSkills(workDir, [
      learned({ name: "mut", mutating: true }),
      learned({ name: "stale", state: "stale" }),
      learned({ name: "ok" }),
    ]);
    expect(existsSync(safePath(workDir, ".learned-skills", "ok", "SKILL.md"))).toBe(true);
    expect(existsSync(safePath(workDir, ".learned-skills", "mut", "SKILL.md"))).toBe(false);
    expect(existsSync(safePath(workDir, ".learned-skills", "stale", "SKILL.md"))).toBe(false);
  });

  it("rejects a path-traversal name via safePath (never escapes the workspace)", () => {
    // A malicious skill name must be rejected by safePath, never written above
    // the workspace as `<tmp>/escape/SKILL.md`.
    expect(() => materializeLearnedSkills(workDir, [learned({ name: "../escape" })])).toThrow();
    const escaped = safePath(tmpdir(), "escape", "SKILL.md");
    expect(existsSync(escaped)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderLearnedSkillsXml — the SYNC seam reader (default-off byte identity)
// ---------------------------------------------------------------------------

/** A minimal SkillRegistry stub exposing getSnapshot() (the only method the seam reads). */
function makeRegistry(descriptions: PromptSkillDescription[]) {
  const prompt =
    descriptions.length === 0
      ? ""
      : `<available_skills>\n${descriptions
          .map(
            (d) =>
              `  <skill>\n    <name>${d.name}</name>\n    <description>${d.description}</description>\n    <location>${d.location}</location>\n    <source>bundled</source>\n  </skill>`,
          )
          .join("\n")}\n</available_skills>`;
  return {
    getSnapshot: () => ({ prompt, skills: descriptions, version: 1 }),
  } as unknown as import("@comis/skills").SkillRegistry;
}

describe("renderLearnedSkillsXml — sync seam reader", () => {
  it("returns getSnapshot().prompt UNCHANGED when there are no surfaced learned skills (byte-identical)", () => {
    const reg = makeRegistry([platform("P1"), platform("P2")]);
    const out = renderLearnedSkillsXml({ skillRegistry: reg, learnedSkills: [], workspaceDir: workDir });
    expect(out).toBe(reg.getSnapshot().prompt);
  });

  it("returns getSnapshot().prompt UNCHANGED when every learned skill is filtered out (mutating/stale)", () => {
    const reg = makeRegistry([platform("P1")]);
    const out = renderLearnedSkillsXml({
      skillRegistry: reg,
      learnedSkills: [learned({ name: "mut", mutating: true }), learned({ name: "stale", state: "stale" })],
      workspaceDir: workDir,
    });
    expect(out).toBe(reg.getSnapshot().prompt);
  });

  it("appends a surfaced learned skill after the platform descriptions in one wrapper", () => {
    const reg = makeRegistry([platform("P1")]);
    const out = renderLearnedSkillsXml({
      skillRegistry: reg,
      learnedSkills: [learned({ name: "L1" })],
      workspaceDir: workDir,
    });
    expect((out.match(/<available_skills>/g) ?? []).length).toBe(1);
    expect(out.indexOf("<name>P1</name>")).toBeLessThan(out.indexOf("<name>L1</name>"));
    expect(out).toContain("<source>learned</source>");
  });
});

// ---------------------------------------------------------------------------
// refreshLearnedSkillSurface — the ASYNC half (list → materialize → cache)
// ---------------------------------------------------------------------------

/** A minimal LearnedSkillStorePort stub whose list() returns a fixed Result. */
function makeStore(listResult: Result<LearnedSkill[], Error>): LearnedSkillStorePort {
  return {
    admit: async () => ok({ id: "x", admitted: true }),
    get: async () => ok(undefined),
    list: async () => listResult,
    promote: async () => ok(undefined),
    demote: async () => ok(undefined),
    evict: async () => ok(undefined),
  } as unknown as LearnedSkillStorePort;
}

describe("refreshLearnedSkillSurface — async list + materialize + cache", () => {
  it("returns [] and materializes nothing when no store is threaded (default-off)", async () => {
    const surfaced = await refreshLearnedSkillSurface({
      learnedSkillStore: undefined,
      scope,
      workspaceDir: workDir,
      logger: noopLogger,
    });
    expect(surfaced).toEqual([]);
    expect(existsSync(safePath(workDir, ".learned-skills"))).toBe(false);
  });

  it("materializes active∧!mutating skills and returns them when list() is ok", async () => {
    const store = makeStore(ok([learned({ name: "alpha" }), learned({ name: "mut", id: "id-mut", mutating: true })]));
    const surfaced = await refreshLearnedSkillSurface({
      learnedSkillStore: store,
      scope,
      workspaceDir: workDir,
      logger: noopLogger,
    });
    // alpha materialized + cached; mut filtered.
    expect(existsSync(safePath(workDir, ".learned-skills", "alpha", "SKILL.md"))).toBe(true);
    expect(existsSync(safePath(workDir, ".learned-skills", "mut", "SKILL.md"))).toBe(false);
    expect(surfaced.some((s) => s.name === "alpha")).toBe(true);
  });

  it("fails closed: list() err → returns [] and writes no learned files (no throw)", async () => {
    const store = makeStore(err(new Error("unresolved scope")));
    const surfaced = await refreshLearnedSkillSurface({
      learnedSkillStore: store,
      scope,
      workspaceDir: workDir,
      logger: noopLogger,
    });
    expect(surfaced).toEqual([]);
    expect(existsSync(safePath(workDir, ".learned-skills", "alpha", "SKILL.md"))).toBe(false);
  });

  it("derive-on-refresh: a skill present then absent across two refreshes leaves no stale file", async () => {
    const present = makeStore(ok([learned({ name: "alpha" })]));
    await refreshLearnedSkillSurface({ learnedSkillStore: present, scope, workspaceDir: workDir, logger: noopLogger });
    const file = safePath(workDir, ".learned-skills", "alpha", "SKILL.md");
    expect(existsSync(file)).toBe(true);

    const absent = makeStore(ok([]));
    await refreshLearnedSkillSurface({ learnedSkillStore: absent, scope, workspaceDir: workDir, logger: noopLogger });
    expect(existsSync(file)).toBe(false);
  });
});
