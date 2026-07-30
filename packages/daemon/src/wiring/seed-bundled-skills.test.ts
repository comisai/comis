// SPDX-License-Identifier: Apache-2.0
/**
 * Generalize the bundled-skill seeder from a single hardcoded
 * `skill-creator` to an AUTO-SCAN of every `bundled-skills/<name>/` dir — so adding a
 * bundled skill (claude-code, codex, …) is ZERO engine code (drop the dir, it seeds).
 * Pure decision logic with injected fs seams (no real disk).
 *
 * @module
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import {
  defaultSeedBundledSkillsDeps,
  seedBundledSkills,
} from "./seed-bundled-skills.js";

function listFiles(root: string, relativeDirectory = ""): string[] {
  const directory = resolve(root, relativeDirectory);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) return listFiles(root, relativePath);
    return entry.isFile() ? [relativePath] : [];
  });
}

describe("seedBundledSkills — auto-scan + version-aware seeding of ALL bundled skills", () => {
  it("packages every repository-shipped prompt skill for boot seeding", () => {
    const repositoryRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../..",
    );
    const repositorySkills = resolve(repositoryRoot, "skills");
    const bundledSkills = resolve(
      repositoryRoot,
      "packages/daemon/bundled-skills",
    );
    const shippedSkillNames = readdirSync(repositorySkills, {
      withFileTypes: true,
    })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(resolve(repositorySkills, entry.name, "SKILL.md")),
      )
      .map((entry) => entry.name)
      .sort();
    const violations: string[] = [];

    expect(shippedSkillNames.length).toBeGreaterThan(0);

    for (const skillName of shippedSkillNames) {
      const sourceRoot = resolve(repositorySkills, skillName);
      const packagedRoot = resolve(bundledSkills, skillName);
      const packagedManifest = resolve(packagedRoot, "SKILL.md");

      if (!existsSync(packagedManifest)) {
        violations.push(`${skillName}: missing bundled SKILL.md`);
        continue;
      }

      const sourceFiles = listFiles(sourceRoot);
      const packagedFiles = listFiles(packagedRoot);
      if (JSON.stringify(packagedFiles) !== JSON.stringify(sourceFiles)) {
        violations.push(`${skillName}: bundled file tree differs`);
        continue;
      }

      for (const relativePath of sourceFiles) {
        if (
          !readFileSync(resolve(sourceRoot, relativePath)).equals(
            readFileSync(resolve(packagedRoot, relativePath)),
          )
        ) {
          violations.push(`${skillName}: ${relativePath} differs`);
        }
      }

      const manifest = readFileSync(
        resolve(sourceRoot, "SKILL.md"),
        "utf8",
      );
      if (!/^version:\s*\S+/mu.test(manifest)) {
        violations.push(`${skillName}: missing version frontmatter`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("directs skill discovery through the native catalog and registry import path", () => {
    const repositoryRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../..",
    );
    const manifest = readFileSync(
      resolve(repositoryRoot, "skills/find-skills/SKILL.md"),
      "utf8",
    );

    expect(manifest).toMatch(/must run `npx skills find <query>` first/iu);
    expect(manifest).toMatch(/skills_manage/iu);
    expect(manifest).toMatch(/action:\s*["'`]import["'`]/iu);
    expect(manifest).toMatch(/scope:\s*["'`]local["'`]/iu);
    expect(manifest).not.toMatch(/copies it to ~\/\.comis\/skills/iu);
  });

  it("downloads a generated chart into an ESM workspace without host renderers", () => {
    const repositoryRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../..",
    );
    const generator = resolve(
      repositoryRoot,
      "packages/daemon/bundled-skills/chart-visualization/scripts/generate.cjs",
    );
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), "comis-chart-skill-"));
    const workspace = resolve(fixtureRoot, "workspace");
    const fetchStub = resolve(fixtureRoot, "fetch-stub.cjs");
    mkdirSync(workspace);
    writeFileSync(
      resolve(workspace, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    writeFileSync(
      fetchStub,
      [
        "globalThis.fetch = async (url) => {",
        '  if (String(url) === "https://mdn.alipayobjects.com/chart.png") {',
        "    return new Response(Uint8Array.from([137, 80, 78, 71]), {",
        '      status: 200, headers: { "content-type": "image/png" },',
        "    });",
        "  }",
        "  return Response.json({",
        '    success: true, resultObj: "https://mdn.alipayobjects.com/chart.png",',
        "  });",
        "};",
      ].join("\n"),
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          generator,
          JSON.stringify({
            tool: "generate_bar_chart",
            args: {
              data: [{ category: "runs", value: 2 }],
              title: "Weekly runs",
            },
          }),
          "--output",
          "output/chart.png",
        ],
        {
          cwd: workspace,
          encoding: "utf8",
          env: { NODE_OPTIONS: `--require=${fetchStub}` },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(resolve(workspace, "output/chart.png"))).toEqual(
        Buffer.from([137, 80, 78, 71]),
      );
      expect(result.stdout.trim()).toBe(
        resolve(realpathSync(workspace), "output/chart.png"),
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("removes retired files when reseeding a changed bundled skill", () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), "comis-skill-reseed-"));
    const bundledRoot = resolve(fixtureRoot, "bundled");
    const skillsTarget = resolve(fixtureRoot, "installed");
    const bundledSkill = resolve(bundledRoot, "example-skill");
    const installedSkill = resolve(skillsTarget, "example-skill");
    mkdirSync(resolve(bundledSkill, "scripts"), { recursive: true });
    mkdirSync(resolve(installedSkill, "scripts"), { recursive: true });
    writeFileSync(
      resolve(bundledSkill, "SKILL.md"),
      "---\nname: example-skill\nversion: 2.0.0\n---\n",
    );
    writeFileSync(
      resolve(bundledSkill, "scripts/generate.cjs"),
      "module.exports = {};\n",
    );
    writeFileSync(
      resolve(installedSkill, "SKILL.md"),
      "---\nname: example-skill\nversion: 1.0.0\n---\n",
    );
    writeFileSync(
      resolve(installedSkill, "scripts/generate.js"),
      "module.exports = {};\n",
    );

    try {
      const result = seedBundledSkills(
        defaultSeedBundledSkillsDeps(bundledRoot, skillsTarget),
      );

      expect(result.seeded).toEqual(["example-skill"]);
      expect(existsSync(resolve(installedSkill, "scripts/generate.cjs"))).toBe(
        true,
      );
      expect(existsSync(resolve(installedSkill, "scripts/generate.js"))).toBe(
        false,
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

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
