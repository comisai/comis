// SPDX-License-Identifier: Apache-2.0
/**
 * Build-time DRIFT GUARD: every terminal platform profile's
 * `platformVersion` MUST equal the `version` in its paired bundled SKILL.md.
 *
 * A perception/render change (the profile) and a guidance change (the skill) usually pair — a
 * ghost-strip and the sole-driver skill guidance were one such incident. The profile and the
 * skill ship by DIFFERENT mechanisms (the skill is boot-seeded by version; the profile is compiled
 * into the daemon build), so the shared `platformVersion` is enforced at BUILD time (here) — never
 * a runtime gate (it would be fragile and add failure modes).
 *
 * Source-level (not an import): the profiles are package-internal (not on the @comis/skills barrel)
 * and the SKILL.md files live in @comis/daemon, so this reads BOTH as text — no build, deterministic,
 * and it auto-discovers `platforms/<id>/profile.ts` so a new platform is covered with zero edits here.
 *
 * @module
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const PLATFORMS_DIR = resolve(
  here,
  "../../packages/skills/src/tools/builtin/terminal-driver/platforms",
);
const BUNDLED_SKILLS_DIR = resolve(here, "../../packages/daemon/bundled-skills");

/** Extract `platformVersion: "X"` from a profile.ts source (the literal the build compiles in). */
function parseProfileVersion(ts: string): string | undefined {
  return ts.match(/platformVersion:\s*["']([^"']+)["']/)?.[1];
}

/** Extract `id: "X"` from a profile.ts source. */
function parseProfileId(ts: string): string | undefined {
  return ts.match(/\bid:\s*["']([^"']+)["']/)?.[1];
}

/**
 * Extract the manifest version from a SKILL.md YAML frontmatter block:
 * `metadata.version` (its authored home), falling back to a top-level
 * `version`. Parses the WHOLE frontmatter block with the YAML parser — the
 * SAME field the boot seeder reads — so a version nested under `metadata:`
 * (indented, and possibly following a long `description`) is found. Returns
 * undefined on no frontmatter block, no version, or a block that is not valid YAML.
 */
function parseSkillVersion(md: string): string | undefined {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm === null) return undefined;
  try {
    const parsed = parseYaml(fm[1]) as Record<string, unknown> | null | undefined;
    if (parsed === null || typeof parsed !== "object") return undefined;
    const meta = parsed["metadata"];
    const nested =
      meta !== null && typeof meta === "object"
        ? (meta as Record<string, unknown>)["version"]
        : undefined;
    const raw = nested ?? parsed["version"];
    if (raw === undefined || raw === null) return undefined;
    const value = String(raw).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Every `platforms/<id>/profile.ts` (auto-discovered) → its directory id + source. */
function discoverProfiles(): Array<{ dir: string; source: string }> {
  return readdirSync(PLATFORMS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ dir: e.name, file: join(PLATFORMS_DIR, e.name, "profile.ts") }))
    .filter((e) => existsSync(e.file))
    .map((e) => ({ dir: e.dir, source: readFileSync(e.file, "utf8") }));
}

describe("terminal platform-profile ↔ SKILL.md version parity (build-time drift guard)", () => {
  const profiles = discoverProfiles();

  it("discovers at least the claude-code and codex profiles", () => {
    const dirs = profiles.map((p) => p.dir).sort();
    expect(dirs).toContain("claude-code");
    expect(dirs).toContain("codex");
  });

  for (const { dir, source } of profiles) {
    it(`profile "${dir}" platformVersion equals its bundled SKILL.md version`, () => {
      const profileVersion = parseProfileVersion(source);
      expect(profileVersion, `platforms/${dir}/profile.ts must declare a platformVersion`).toBeDefined();

      // The profile.ts id must match its directory (and so its skill dir).
      expect(parseProfileId(source)).toBe(dir);

      const skillPath = join(BUNDLED_SKILLS_DIR, dir, "SKILL.md");
      expect(existsSync(skillPath), `bundled skill for "${dir}" must exist at ${skillPath}`).toBe(true);
      const skillVersion = parseSkillVersion(readFileSync(skillPath, "utf8"));
      expect(skillVersion, `bundled-skills/${dir}/SKILL.md must declare a frontmatter version`).toBeDefined();

      expect(
        profileVersion,
        `platform "${dir}": profile.platformVersion (${profileVersion}) must equal SKILL.md version (${skillVersion}) — bump them together`,
      ).toBe(skillVersion);
    });
  }
});

describe("the version parsers are non-vacuous (the drift guard genuinely fires)", () => {
  it("reads metadata.version from frontmatter and detects a deliberate mismatch", () => {
    const md = '---\nname: x\ndescription: d\nmetadata:\n  version: "1.1.3"\n---\n# body\n';
    expect(parseSkillVersion(md)).toBe("1.1.3");
    const profileTs = 'export const p = { id: "x", platformVersion: "1.1.4" };';
    // A mismatched pair MUST be unequal — proving the parity assertion above is not vacuous.
    expect(parseProfileVersion(profileTs)).not.toBe(parseSkillVersion(md));
  });
});
