// SPDX-License-Identifier: Apache-2.0
/**
 * Build-time DRIFT GUARD (v2.26 PROFILE-03 / design §11 D2): every terminal platform profile's
 * `platformVersion` MUST equal the `version` in its paired bundled SKILL.md.
 *
 * A perception/render change (the profile) and a guidance change (the skill) usually pair — the
 * FINDING-3 ghost-strip and the sole-driver skill guidance were one incident. The profile and the
 * skill ship by DIFFERENT mechanisms (the skill is boot-seeded by version; the profile is compiled
 * into the daemon build), so the shared `platformVersion` is enforced at BUILD time (here) — never
 * a runtime gate (it would be fragile and add failure modes, D2).
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

/** Extract the `version:` from a SKILL.md YAML frontmatter block. */
function parseSkillVersion(md: string): string | undefined {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (fm === null) return undefined;
  return fm[1].match(/^version:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
}

/** Every `platforms/<id>/profile.ts` (auto-discovered) → its directory id + source. */
function discoverProfiles(): Array<{ dir: string; source: string }> {
  return readdirSync(PLATFORMS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ dir: e.name, file: join(PLATFORMS_DIR, e.name, "profile.ts") }))
    .filter((e) => existsSync(e.file))
    .map((e) => ({ dir: e.dir, source: readFileSync(e.file, "utf8") }));
}

describe("terminal platform-profile ↔ SKILL.md version parity (PROFILE-03 build-time drift guard)", () => {
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
        `platform "${dir}": profile.platformVersion (${profileVersion}) must equal SKILL.md version (${skillVersion}) — bump them together (D2)`,
      ).toBe(skillVersion);
    });
  }
});

describe("the version parsers are non-vacuous (the drift guard genuinely fires)", () => {
  it("parses a quoted frontmatter version and detects a deliberate mismatch", () => {
    const md = '---\nname: x\ntype: prompt\nversion: "1.1.3"\n---\n# body\n';
    expect(parseSkillVersion(md)).toBe("1.1.3");
    const profileTs = 'export const p = { id: "x", platformVersion: "1.1.4" };';
    // A mismatched pair MUST be unequal — proving the parity assertion above is not vacuous.
    expect(parseProfileVersion(profileTs)).not.toBe(parseSkillVersion(md));
  });
});
