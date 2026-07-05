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
import { seedBundledSkills, extractVersion } from "./seed-bundled-skills.js";

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

describe("extractVersion — reads metadata.version from the whole frontmatter block", () => {
  // Ground truth: a spec-pure manifest whose description is long enough that the
  // nested metadata.version sits BEYOND byte 512, mirroring the real
  // long-description bundled skill. A fixed head-window read truncates the
  // version out of range and reports the skill as unversioned — which makes the
  // seeder re-copy it on every boot, overwriting the installed copy.
  const longDescription =
    "Drive a capable coding agent interactively in a terminal session to build, fix, or extend software — " +
    "launch it in a named project folder, hand it the task, answer its interactive prompts through keystrokes, " +
    "watch closely for completion, and verify the result before reporting a concise summary back to the operator. " +
    "Use this whenever the request is to write, build, debug, refactor, or test code or work on a software " +
    "project of any size, even when the underlying tool is not named outright anywhere in the instruction text.";
  const longManifest = `---\nname: coding-agent\ndescription: ${longDescription}\nmetadata:\n  version: "1.1.5"\n---\n\n# Body\n\nContent.\n`;

  it("returns the nested version even when metadata.version is past byte 512 (long description)", () => {
    // Prove the fixture genuinely places the metadata block beyond the old window.
    expect(longManifest.indexOf("metadata:")).toBeGreaterThan(512);
    expect(extractVersion("/x/SKILL.md", () => longManifest)).toBe("1.1.5");
  });

  it("returns the nested metadata.version for a short frontmatter", () => {
    const manifest = `---\nname: tiny\ndescription: A short skill.\nmetadata:\n  version: "2.3.4"\n---\n\n# Body\n`;
    expect(extractVersion("/x/SKILL.md", () => manifest)).toBe("2.3.4");
  });

  it("falls back to a top-level version when there is no metadata block", () => {
    const manifest = `---\nname: tiny\nversion: "9.9.9"\ndescription: A hand-authored skill.\n---\n\n# Body\n`;
    expect(extractVersion("/x/SKILL.md", () => manifest)).toBe("9.9.9");
  });

  it("returns undefined when no version is present anywhere", () => {
    const manifest = `---\nname: tiny\ndescription: A short skill.\n---\n\n# Body\n`;
    expect(extractVersion("/x/SKILL.md", () => manifest)).toBeUndefined();
  });

  it("returns undefined on malformed content and when the read throws (guard holds)", () => {
    expect(extractVersion("/x/SKILL.md", () => "not a manifest at all")).toBeUndefined();
    expect(
      extractVersion("/x/SKILL.md", () => {
        throw new Error("read failed");
      }),
    ).toBeUndefined();
  });
});
