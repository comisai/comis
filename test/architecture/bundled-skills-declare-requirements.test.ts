// SPDX-License-Identifier: Apache-2.0
/**
 * Every bundled skill must DECLARE its runtime requirements.
 *
 * `packages/daemon/bundled-skills/<name>/` is seeded into `<dataDir>/skills` on
 * every boot, so those skills are present on a stock install with no operator
 * action. The registry emits an aggregated WARN naming every eligible skill
 * whose `comis.requires` block is absent — the runtime has nothing to
 * pre-flight, so a missing prerequisite would surface mid-task. That warning is
 * actionable for a skill the operator installed and pure noise for one WE ship:
 * the operator cannot fix a vendored SKILL.md, and it is overwritten on
 * upgrade. A bundled skill that needs nothing therefore declares empty `bins`
 * and `env` arrays (the "verified needs nothing" state), which is exactly the
 * distinction `EligibilityResult.requirementsDeclared` encodes.
 *
 * Source-level (fs read, no build): the SKILL.md files ship as package data,
 * and the dir is auto-scanned so a newly added bundled skill is covered with
 * zero edits here.
 *
 * @module
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";

const BUNDLED_SKILLS_DIR = resolve(
  import.meta.dirname,
  "../../packages/daemon/bundled-skills",
);

/** Every `bundled-skills/<name>/SKILL.md` (auto-discovered) → name + source. */
function discoverBundledSkills(): Array<{ name: string; source: string }> {
  return readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, file: join(BUNDLED_SKILLS_DIR, e.name, "SKILL.md") }))
    .filter((e) => existsSync(e.file))
    .map((e) => ({ name: e.name, source: readFileSync(e.file, "utf8") }));
}

/** The parsed YAML frontmatter block of a SKILL.md, or undefined when absent. */
function parseFrontmatter(md: string): Record<string, unknown> | undefined {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (fm === null) return undefined;
  const parsed: unknown = parseYaml(fm[1]);
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : undefined;
}

describe("bundled skills declare their runtime requirements", () => {
  const skills = discoverBundledSkills();

  it("discovers the bundled skill set", () => {
    expect(skills.length).toBeGreaterThan(0);
  });

  it("declares a comis.requires block on every bundled SKILL.md", () => {
    const undeclared = skills
      .filter(({ source }) => {
        const frontmatter = parseFrontmatter(source);
        const comis = frontmatter?.["comis"];
        if (typeof comis !== "object" || comis === null) return true;
        const requires = (comis as Record<string, unknown>)["requires"];
        return typeof requires !== "object" || requires === null;
      })
      .map(({ name }) => name)
      .sort();

    expect(
      undeclared,
      `bundled-skills/<name>/SKILL.md must declare a \`comis.requires\` block (empty ` +
        `bins/env arrays for a skill that needs nothing); undeclared: ${undeclared.join(", ")}`,
    ).toEqual([]);
  });
});
