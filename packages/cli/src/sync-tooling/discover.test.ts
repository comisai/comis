// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for sync-tooling/discover.ts — MCP and skill discovery helpers.
 *
 * Covers:
 * - readMcpServers (pure config read)
 * - discoverSkills (filesystem walk + frontmatter parse + dedupe)
 * - description priority (comis.capability.summary > frontmatter.description > undefined)
 * - First-loaded-wins dedupe by skill name
 * - Per-agent discoveryPaths union
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  readMcpServers,
  discoverSkills,
} from "./discover.js";

/** Helper: write a SKILL.md fixture under a directory. */
function writeSkill(
  baseDir: string,
  skillDirName: string,
  frontmatter: string,
  body = "# Body\n\nNonempty body line.",
): void {
  const dir = path.join(baseDir, skillDirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\n${frontmatter}\n---\n\n${body}\n`,
  );
}

describe("readMcpServers", () => {
  it("returns [] for empty config", () => {
    expect(readMcpServers({})).toEqual([]);
  });

  it("returns one entry per MCP server", () => {
    const result = readMcpServers({
      integrations: {
        mcp: {
          servers: [{ name: "yfinance", command: "npx", args: [] }],
        },
      },
    });
    expect(result).toEqual([{ name: "yfinance", description: undefined }]);
  });

  it("ignores entries without a string `name` field", () => {
    const result = readMcpServers({
      integrations: {
        mcp: {
          servers: [
            { name: "valid", command: "x" },
            { command: "no-name" },
            { name: 123 },
            { name: "" },
            { name: "another", command: "y" },
          ],
        },
      },
    });
    expect(result.map((m) => m.name)).toEqual(["valid", "another"]);
  });
});

describe("discoverSkills", () => {
  let tmp: string;
  let homeDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(tmpdir(), "comis-discover-test-"));
    homeDir = path.join(tmp, "home");
    fs.mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("walks discoveryPaths from agent config + the two daemon defaults; skips paths that do not exist", () => {
    // Write one skill under a custom discovery path
    const customDir = path.join(tmp, "custom-skills");
    writeSkill(
      customDir,
      "alpha",
      "name: alpha\ndescription: Alpha skill",
    );

    // Write one skill under the daemon default ~/.comis/skills
    const defaultDir = path.join(homeDir, ".comis", "skills");
    writeSkill(
      defaultDir,
      "beta",
      "name: beta\ndescription: Beta skill",
    );

    // Note: ~/.comis/workspace/skills is intentionally absent — should be skipped silently
    const result = discoverSkills(
      {
        agents: {
          default: { skills: { discoveryPaths: [customDir] } },
        },
      },
      { homeDir },
    );

    const names = result.map((s) => s.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  it("comis.capability.summary takes priority over frontmatter.description", () => {
    const skillDir = path.join(homeDir, ".comis", "skills");
    writeSkill(
      skillDir,
      "stub",
      [
        "name: stub-skill",
        "description: Frontmatter description",
        "comis:",
        "  capability:",
        "    summary: Capability summary wins",
      ].join("\n"),
    );

    const result = discoverSkills({}, { homeDir });
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toBe("Capability summary wins");
  });

  it("falls back to frontmatter.description when comis.capability.summary is absent", () => {
    const skillDir = path.join(homeDir, ".comis", "skills");
    writeSkill(
      skillDir,
      "fb",
      "name: fb\ndescription: Just a frontmatter description",
    );

    const result = discoverSkills({}, { homeDir });
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toBe("Just a frontmatter description");
  });

  it("returns description=undefined when both summary and frontmatter description are missing", () => {
    // Note: SkillManifestSchema requires `description` — but discover reads
    // pre-validation, so a malformed manifest still surfaces with description=undefined.
    const skillDir = path.join(homeDir, ".comis", "skills");
    writeSkill(
      skillDir,
      "noname",
      "name: nameonly",
    );

    const result = discoverSkills({}, { homeDir });
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toBeUndefined();
  });

  it("dedupes by skill name (first-loaded-wins)", () => {
    const dirA = path.join(tmp, "a");
    const dirB = path.join(tmp, "b");
    writeSkill(dirA, "shared", "name: shared\ndescription: From A");
    writeSkill(dirB, "shared", "name: shared\ndescription: From B");

    // Order: dirA first, then dirB. A should win.
    const result = discoverSkills(
      {
        agents: {
          default: { skills: { discoveryPaths: [dirA, dirB] } },
        },
      },
      { homeDir },
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("shared");
    expect(result[0]!.description).toBe("From A");
  });

  it("returns DiscoveredSkill.cluster from comis.capability.cluster when present, undefined otherwise", () => {
    const skillDir = path.join(homeDir, ".comis", "skills");
    writeSkill(
      skillDir,
      "withcluster",
      [
        "name: withcluster",
        "description: has cluster",
        "comis:",
        "  capability:",
        "    cluster: custom-cluster",
      ].join("\n"),
    );
    writeSkill(
      skillDir,
      "nocluster",
      "name: nocluster\ndescription: no cluster",
    );

    const result = discoverSkills({}, { homeDir });
    const byName = new Map(result.map((s) => [s.name, s]));
    expect(byName.get("withcluster")!.cluster).toBe("custom-cluster");
    expect(byName.get("nocluster")!.cluster).toBeUndefined();
  });

  it("unions paths from multiple agents and dedupes the union", () => {
    const dirAlpha = path.join(tmp, "alpha-skills");
    const dirBeta = path.join(tmp, "beta-skills");
    writeSkill(dirAlpha, "only-alpha", "name: only-alpha\ndescription: Alpha");
    writeSkill(dirAlpha, "shared", "name: shared\ndescription: From alpha");
    writeSkill(dirBeta, "only-beta", "name: only-beta\ndescription: Beta");
    writeSkill(dirBeta, "shared", "name: shared\ndescription: From beta");

    const result = discoverSkills(
      {
        agents: {
          alpha: { skills: { discoveryPaths: [dirAlpha] } },
          beta: { skills: { discoveryPaths: [dirBeta] } },
        },
      },
      { homeDir },
    );

    const names = result.map((s) => s.name).sort();
    expect(names).toEqual(["only-alpha", "only-beta", "shared"]);
    // Object iteration order in JS preserves insertion: alpha is iterated first,
    // so the alpha "shared" wins.
    const shared = result.find((s) => s.name === "shared");
    expect(shared!.description).toBe("From alpha");
  });
});
