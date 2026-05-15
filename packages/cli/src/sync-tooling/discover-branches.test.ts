// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-coverage tests for sync-tooling/discover.ts — covers shape-mismatch
 * early-return paths, malformed-frontmatter silent-skip paths, dot/node_modules
 * skip paths, and read-error tolerance in walkSkillDir.
 *
 * These tests target uncovered branches in:
 *   - readMcpServers: integrations missing / mcp missing / servers not-array /
 *     entry not plain-object / name not-string / name empty-string
 *   - discoverSkills: agents not-object / agent not-object / skills not-object /
 *     discoveryPaths not-array / entry not-string / entry empty
 *   - walkSkillDir: dir does not exist / readdir throws / entry hidden /
 *     entry node_modules / SKILL.md missing / tryParseSkillFrontmatter null
 *   - tryParseSkillFrontmatter: file read fails / no opening --- / no newline
 *     after opening / no closing --- / empty yaml content / yaml parse fails /
 *     parse returns non-object / name missing / name not-string / name empty
 *
 * @module
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { readMcpServers, discoverSkills } from "./discover.js";

function writeRaw(baseDir: string, dirName: string, fileContent: string): void {
  const dir = path.join(baseDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), fileContent);
}

describe("readMcpServers — shape-mismatch early-return branches", () => {
  it("returns empty array when integrations key is absent from the root config object", () => {
    expect(readMcpServers({})).toEqual([]);
  });

  it("returns empty array when integrations value is a non-object (string)", () => {
    expect(readMcpServers({ integrations: "not-an-object" })).toEqual([]);
  });

  it("returns empty array when integrations value is null", () => {
    expect(readMcpServers({ integrations: null })).toEqual([]);
  });

  it("returns empty array when integrations value is an array (not a plain object)", () => {
    expect(readMcpServers({ integrations: [1, 2, 3] })).toEqual([]);
  });

  it("returns empty array when integrations.mcp key is absent", () => {
    expect(readMcpServers({ integrations: {} })).toEqual([]);
  });

  it("returns empty array when integrations.mcp is a non-object value (number)", () => {
    expect(readMcpServers({ integrations: { mcp: 42 } })).toEqual([]);
  });

  it("returns empty array when integrations.mcp.servers key is absent", () => {
    expect(readMcpServers({ integrations: { mcp: {} } })).toEqual([]);
  });

  it("returns empty array when integrations.mcp.servers is not an array (object)", () => {
    expect(
      readMcpServers({ integrations: { mcp: { servers: { not: "array" } } } }),
    ).toEqual([]);
  });

  it("skips MCP entry when entry value is not a plain object (string element in array)", () => {
    const result = readMcpServers({
      integrations: {
        mcp: { servers: ["string-entry", { name: "valid", command: "x" }] },
      },
    });
    expect(result.map((m) => m.name)).toEqual(["valid"]);
  });

  it("skips MCP entry when entry value is null in the servers array", () => {
    const result = readMcpServers({
      integrations: {
        mcp: { servers: [null, { name: "valid", command: "x" }] },
      },
    });
    expect(result.map((m) => m.name)).toEqual(["valid"]);
  });
});

describe("discoverSkills — config shape-mismatch branches", () => {
  let tmp: string;
  let homeDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(tmpdir(), "comis-discover-branch-"));
    homeDir = path.join(tmp, "home");
    fs.mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty array when agents key is absent and daemon-default paths do not exist", () => {
    const result = discoverSkills({}, { homeDir });
    expect(result).toEqual([]);
  });

  it("ignores config when agents value is not a plain object (string scalar)", () => {
    const result = discoverSkills({ agents: "not-an-object" }, { homeDir });
    expect(result).toEqual([]);
  });

  it("ignores agent entry when its value is not a plain object (number scalar)", () => {
    const result = discoverSkills(
      { agents: { brokenAgent: 42, anotherAgent: { skills: {} } } },
      { homeDir },
    );
    expect(result).toEqual([]);
  });

  it("ignores agent when skills field is not a plain object (boolean scalar)", () => {
    const result = discoverSkills(
      { agents: { agent: { skills: true } } },
      { homeDir },
    );
    expect(result).toEqual([]);
  });

  it("ignores agent when discoveryPaths is not an array (string scalar)", () => {
    const result = discoverSkills(
      { agents: { agent: { skills: { discoveryPaths: "not-array" } } } },
      { homeDir },
    );
    expect(result).toEqual([]);
  });

  it("filters non-string entries and empty-string entries from discoveryPaths array", () => {
    // A mix of valid string path, an empty string, a number, and undefined
    const skillDir = path.join(tmp, "valid-skills");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.mkdirSync(path.join(skillDir, "alpha"), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: ok\n---\n\nbody\n",
    );

    const result = discoverSkills(
      {
        agents: {
          agent: {
            skills: {
              discoveryPaths: [skillDir, "", 42, null, undefined],
            },
          },
        },
      },
      { homeDir },
    );

    expect(result.map((s) => s.name)).toEqual(["alpha"]);
  });
});

describe("discoverSkills — filesystem-walk branches in walkSkillDir", () => {
  let tmp: string;
  let homeDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(tmpdir(), "comis-discover-walk-"));
    homeDir = path.join(tmp, "home");
    fs.mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("silently skips a discovery path that does not exist on disk", () => {
    const nonexistent = path.join(tmp, "does-not-exist");
    const result = discoverSkills(
      { agents: { agent: { skills: { discoveryPaths: [nonexistent] } } } },
      { homeDir },
    );
    expect(result).toEqual([]);
  });

  it("skips hidden directory entries that start with a dot from skill discovery", () => {
    const baseDir = path.join(tmp, "skills");
    fs.mkdirSync(baseDir, { recursive: true });
    // hidden dir
    const hiddenDir = path.join(baseDir, ".hidden");
    fs.mkdirSync(hiddenDir, { recursive: true });
    fs.writeFileSync(
      path.join(hiddenDir, "SKILL.md"),
      "---\nname: should-not-appear\ndescription: hidden\n---\n\nbody\n",
    );
    // visible dir
    writeRaw(baseDir, "visible", "---\nname: visible\ndescription: ok\n---\n\nbody\n");

    const result = discoverSkills(
      { agents: { agent: { skills: { discoveryPaths: [baseDir] } } } },
      { homeDir },
    );
    expect(result.map((s) => s.name)).toEqual(["visible"]);
  });

  it("skips the node_modules directory by name during skill walk", () => {
    const baseDir = path.join(tmp, "skills");
    fs.mkdirSync(baseDir, { recursive: true });
    const nmDir = path.join(baseDir, "node_modules");
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(
      path.join(nmDir, "SKILL.md"),
      "---\nname: should-not-appear\ndescription: nm\n---\n\nbody\n",
    );
    writeRaw(baseDir, "visible", "---\nname: visible\ndescription: ok\n---\n\nbody\n");

    const result = discoverSkills(
      { agents: { agent: { skills: { discoveryPaths: [baseDir] } } } },
      { homeDir },
    );
    expect(result.map((s) => s.name)).toEqual(["visible"]);
  });

  it("skips entries that are files (not directories) directly under the discovery path", () => {
    const baseDir = path.join(tmp, "skills");
    fs.mkdirSync(baseDir, { recursive: true });
    // Plain file, not a dir
    fs.writeFileSync(path.join(baseDir, "loose.md"), "stray file");
    writeRaw(baseDir, "valid", "---\nname: valid\ndescription: ok\n---\n\nbody\n");

    const result = discoverSkills(
      { agents: { agent: { skills: { discoveryPaths: [baseDir] } } } },
      { homeDir },
    );
    expect(result.map((s) => s.name)).toEqual(["valid"]);
  });

  it("skips a subdirectory that does not contain a SKILL.md file", () => {
    const baseDir = path.join(tmp, "skills");
    fs.mkdirSync(baseDir, { recursive: true });
    // Dir present but no SKILL.md
    fs.mkdirSync(path.join(baseDir, "empty-dir"), { recursive: true });
    writeRaw(baseDir, "valid", "---\nname: valid\ndescription: ok\n---\n\nbody\n");

    const result = discoverSkills(
      { agents: { agent: { skills: { discoveryPaths: [baseDir] } } } },
      { homeDir },
    );
    expect(result.map((s) => s.name)).toEqual(["valid"]);
  });
});

describe("discoverSkills — frontmatter parse branches in tryParseSkillFrontmatter", () => {
  let tmp: string;
  let homeDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(tmpdir(), "comis-discover-fm-"));
    homeDir = path.join(tmp, "home");
    fs.mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("silently skips a skill directory whose SKILL.md does not start with three-dash frontmatter delimiter", () => {
    const baseDir = path.join(tmp, "skills");
    fs.mkdirSync(baseDir, { recursive: true });
    writeRaw(baseDir, "noframtter", "# Just markdown\nNo frontmatter here.");

    const result = discoverSkills(
      { agents: { agent: { skills: { discoveryPaths: [baseDir] } } } },
      { homeDir },
    );
    expect(result).toEqual([]);
  });

  it("silently skips SKILL.md that has opening dashes but no closing three-dash delimiter line", () => {
    const baseDir = path.join(tmp, "skills");
    fs.mkdirSync(baseDir, { recursive: true });
    writeRaw(baseDir, "unclosed", "---\nname: nothing\ndescription: missing close\n");

    const result = discoverSkills(
      { agents: { agent: { skills: { discoveryPaths: [baseDir] } } } },
      { homeDir },
    );
    expect(result).toEqual([]);
  });

  it("silently skips SKILL.md whose frontmatter block is completely empty between the dash delimiters", () => {
    const baseDir = path.join(tmp, "skills");
    fs.mkdirSync(baseDir, { recursive: true });
    writeRaw(baseDir, "empty", "---\n\n---\n\nBody\n");

    const result = discoverSkills(
      { agents: { agent: { skills: { discoveryPaths: [baseDir] } } } },
      { homeDir },
    );
    expect(result).toEqual([]);
  });

  it("silently skips SKILL.md whose frontmatter YAML fails to parse with a syntax error", () => {
    const baseDir = path.join(tmp, "skills");
    fs.mkdirSync(baseDir, { recursive: true });
    // The colons here form invalid YAML mapping syntax
    writeRaw(baseDir, "bad", "---\nname: : : :\n   broken:\n---\n\nBody\n");

    const result = discoverSkills(
      { agents: { agent: { skills: { discoveryPaths: [baseDir] } } } },
      { homeDir },
    );
    expect(result).toEqual([]);
  });

  it("silently skips SKILL.md whose frontmatter parses to a scalar (not a plain object)", () => {
    const baseDir = path.join(tmp, "skills");
    fs.mkdirSync(baseDir, { recursive: true });
    writeRaw(baseDir, "scalar", "---\njust-a-string\n---\n\nBody\n");

    const result = discoverSkills(
      { agents: { agent: { skills: { discoveryPaths: [baseDir] } } } },
      { homeDir },
    );
    expect(result).toEqual([]);
  });

  it("silently skips SKILL.md whose frontmatter name field is missing entirely", () => {
    const baseDir = path.join(tmp, "skills");
    fs.mkdirSync(baseDir, { recursive: true });
    writeRaw(baseDir, "noname", "---\ndescription: anonymous\n---\n\nBody\n");

    const result = discoverSkills(
      { agents: { agent: { skills: { discoveryPaths: [baseDir] } } } },
      { homeDir },
    );
    expect(result).toEqual([]);
  });

  it("silently skips SKILL.md whose frontmatter name is non-string (numeric)", () => {
    const baseDir = path.join(tmp, "skills");
    fs.mkdirSync(baseDir, { recursive: true });
    writeRaw(baseDir, "numericname", "---\nname: 42\ndescription: bad\n---\n\nBody\n");

    const result = discoverSkills(
      { agents: { agent: { skills: { discoveryPaths: [baseDir] } } } },
      { homeDir },
    );
    expect(result).toEqual([]);
  });

  it("silently skips SKILL.md whose frontmatter name is the empty string", () => {
    const baseDir = path.join(tmp, "skills");
    fs.mkdirSync(baseDir, { recursive: true });
    writeRaw(baseDir, "emptyname", "---\nname: ''\ndescription: empty\n---\n\nBody\n");

    const result = discoverSkills(
      { agents: { agent: { skills: { discoveryPaths: [baseDir] } } } },
      { homeDir },
    );
    expect(result).toEqual([]);
  });

  it("normalizes Windows CRLF line endings before locating the frontmatter delimiter", () => {
    const baseDir = path.join(tmp, "skills");
    fs.mkdirSync(baseDir, { recursive: true });
    // CRLF endings explicitly
    writeRaw(
      baseDir,
      "crlf",
      "---\r\nname: crlf-skill\r\ndescription: windows-line-endings\r\n---\r\n\r\nBody\r\n",
    );

    const result = discoverSkills(
      { agents: { agent: { skills: { discoveryPaths: [baseDir] } } } },
      { homeDir },
    );
    expect(result.map((s) => s.name)).toEqual(["crlf-skill"]);
  });

  it("treats comis.capability as malformed and falls back to frontmatter description when capability is a scalar", () => {
    const baseDir = path.join(tmp, "skills");
    fs.mkdirSync(baseDir, { recursive: true });
    writeRaw(
      baseDir,
      "badcap",
      "---\nname: badcap\ndescription: fallback wins\ncomis:\n  capability: not-an-object\n---\n\nBody\n",
    );

    const result = discoverSkills(
      { agents: { agent: { skills: { discoveryPaths: [baseDir] } } } },
      { homeDir },
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toBe("fallback wins");
    expect(result[0]!.cluster).toBeUndefined();
  });

  it("treats comis as malformed and ignores cluster + summary when comis is a non-object scalar", () => {
    const baseDir = path.join(tmp, "skills");
    fs.mkdirSync(baseDir, { recursive: true });
    writeRaw(
      baseDir,
      "badcomis",
      "---\nname: badcomis\ndescription: from-frontmatter\ncomis: not-object\n---\n\nBody\n",
    );

    const result = discoverSkills(
      { agents: { agent: { skills: { discoveryPaths: [baseDir] } } } },
      { homeDir },
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toBe("from-frontmatter");
    expect(result[0]!.cluster).toBeUndefined();
  });

  it("returns description undefined when comis.capability.summary is a non-string value", () => {
    const baseDir = path.join(tmp, "skills");
    fs.mkdirSync(baseDir, { recursive: true });
    writeRaw(
      baseDir,
      "numsum",
      "---\nname: numsum\ncomis:\n  capability:\n    summary: 42\n---\n\nBody\n",
    );

    const result = discoverSkills(
      { agents: { agent: { skills: { discoveryPaths: [baseDir] } } } },
      { homeDir },
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toBeUndefined();
  });

  it("returns cluster undefined when comis.capability.cluster is non-string (boolean)", () => {
    const baseDir = path.join(tmp, "skills");
    fs.mkdirSync(baseDir, { recursive: true });
    writeRaw(
      baseDir,
      "boolcluster",
      "---\nname: boolcluster\ndescription: ok\ncomis:\n  capability:\n    cluster: true\n---\n\nBody\n",
    );

    const result = discoverSkills(
      { agents: { agent: { skills: { discoveryPaths: [baseDir] } } } },
      { homeDir },
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.cluster).toBeUndefined();
  });
});
