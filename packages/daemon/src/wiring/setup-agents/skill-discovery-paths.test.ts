// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { resolveSkillDiscoveryPaths } from "./skill-discovery-paths.js";

const DATA = "/home/comis/.comis";
const WS_SKILLS = "/home/comis/.comis/workspace/skills";
const BUNDLED = "/home/comis/.comis/skills";

describe("resolveSkillDiscoveryPaths", () => {
  it("resolves relative paths against dataDir and prepends the agent workspace skills dir", () => {
    const out = resolveSkillDiscoveryPaths(["./skills"], DATA, WS_SKILLS);
    expect(out[0]).toBe(WS_SKILLS); // prepended, first-loaded-wins
    expect(out).toContain(BUNDLED); // ./skills → <dataDir>/skills
  });

  // Skill-surfacing robustness: a CUSTOM discoveryPaths
  // that omits the default "./skills" must STILL discover the daemon's bundled skills — they are
  // seeded into <dataDir>/skills (the install target), so that dir is force-included regardless of the
  // operator's config. Without this, a leftover `discoveryPaths:[<custom-dir>]` can hide claude-code entirely.
  it("ALWAYS includes the bundled-skill install target <dataDir>/skills, even for a custom discoveryPaths", () => {
    const out = resolveSkillDiscoveryPaths(["/srv/team-skills"], DATA, WS_SKILLS);
    expect(out).toContain(BUNDLED); // the daemon's bundled skills stay discoverable
    expect(out).toContain("/srv/team-skills"); // the operator's custom path is kept
    expect(out[0]).toBe(WS_SKILLS); // workspace still prepended
  });

  it("does not duplicate <dataDir>/skills when the default ./skills already resolves to it", () => {
    const out = resolveSkillDiscoveryPaths(["./skills"], DATA, WS_SKILLS);
    expect(out.filter((p) => p === BUNDLED)).toHaveLength(1);
  });

  it("does not duplicate the workspace skills dir when it is already an explicit absolute entry", () => {
    const out = resolveSkillDiscoveryPaths([WS_SKILLS, "/srv/team-skills"], DATA, WS_SKILLS);
    expect(out.filter((p) => p === WS_SKILLS)).toHaveLength(1);
  });
});
