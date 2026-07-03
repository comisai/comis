// SPDX-License-Identifier: Apache-2.0
/**
 * Generalize the bundled-skill seeder from a single hardcoded
 * `skill-creator` to an AUTO-SCAN of every `bundled-skills/<name>/` dir — so adding a
 * bundled skill (claude-code, codex, …) is ZERO engine code (drop the dir, it seeds).
 * Pure decision logic with injected fs seams (no real disk).
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { seedBundledSkills } from "./seed-bundled-skills.js";

describe("seedBundledSkills — auto-scan + version-aware seeding of ALL bundled skills", () => {
  it("seeds missing skills, RE-seeds version-changed skills, and SKIPS up-to-date ones", () => {
    const bundled: Record<string, string> = { "skill-creator": "1.1.1", "claude-code": "1.0.0", codex: "1.0.0" };
    const installed: Record<string, string | undefined> = {
      "skill-creator": "1.1.1", // same version → skip
      codex: "0.9.0", // version differs → re-seed
      // claude-code: not installed → seed
    };
    const seededCalls: string[] = [];
    const logger = { info: vi.fn() };
    const r = seedBundledSkills({
      bundledRoot: "/b",
      skillsTarget: "/t",
      listSkillNames: () => Object.keys(bundled),
      bundledVersion: (_root, name) => bundled[name],
      installedVersion: (_t, name) => installed[name],
      seed: (name) => seededCalls.push(name),
      logger,
    });
    expect(r.seeded.sort()).toEqual(["claude-code", "codex"]);
    expect(r.skipped).toEqual(["skill-creator"]);
    expect(seededCalls.sort()).toEqual(["claude-code", "codex"]);
  });

  it("seeds a skill when it is not installed at all (installedVersion undefined)", () => {
    const seeded: string[] = [];
    const r = seedBundledSkills({
      bundledRoot: "/b",
      skillsTarget: "/t",
      listSkillNames: () => ["claude-code"],
      bundledVersion: () => "1.0.0",
      installedVersion: () => undefined, // not installed
      seed: (n) => seeded.push(n),
    });
    expect(r.seeded).toEqual(["claude-code"]);
    expect(seeded).toEqual(["claude-code"]);
  });

  it("does NOT re-seed when the bundled version equals the installed version (idempotent boot)", () => {
    const seeded: string[] = [];
    const r = seedBundledSkills({
      bundledRoot: "/b",
      skillsTarget: "/t",
      listSkillNames: () => ["skill-creator", "claude-code", "codex"],
      bundledVersion: (_r, n) => ({ "skill-creator": "1.1.1", "claude-code": "1.0.0", codex: "1.0.0" })[n],
      installedVersion: (_t, n) => ({ "skill-creator": "1.1.1", "claude-code": "1.0.0", codex: "1.0.0" })[n],
      seed: (n) => seeded.push(n),
    });
    expect(seeded).toEqual([]);
    expect(r.seeded).toEqual([]);
    expect(r.skipped.sort()).toEqual(["claude-code", "codex", "skill-creator"]);
  });

  it("never throws when there are no bundled skills (empty scan)", () => {
    const r = seedBundledSkills({
      bundledRoot: "/b",
      skillsTarget: "/t",
      listSkillNames: () => [],
      bundledVersion: () => undefined,
      installedVersion: () => undefined,
      seed: () => {
        throw new Error("must not seed");
      },
    });
    expect(r.seeded).toEqual([]);
    expect(r.skipped).toEqual([]);
  });
});
