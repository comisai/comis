// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { discoverSkills } from "./discovery.js";

// ---------------------------------------------------------------------------
// Test helper: temp directory with valid SKILL.md files
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-discovery-"));
  tmpDirs.push(dir);
  return dir;
}

function writeSkillFile(dir: string, filename: string, frontmatter: Record<string, unknown>): void {
  const yamlLines = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        const nested = Object.entries(v as Record<string, unknown>)
          .map(([nk, nv]) => {
            if (Array.isArray(nv)) {
              return `  ${nk}:\n${(nv as unknown[]).map((item) => `    - ${JSON.stringify(item)}`).join("\n")}`;
            }
            return `  ${nk}: ${JSON.stringify(nv)}`;
          })
          .join("\n");
        return `${k}:\n${nested}`;
      }
      if (Array.isArray(v)) {
        return `${k}:\n${v.map((item) => `  - ${JSON.stringify(item)}`).join("\n")}`;
      }
      return `${k}: ${JSON.stringify(v)}`;
    })
    .join("\n");
  const content = `---\n${yamlLines}\n---\n# Skill Content\n\nThis is test content.\n`;
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

beforeEach(() => {
  tmpDirs = [];
});

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  }
});

// ---------------------------------------------------------------------------
// discoverSkills
// ---------------------------------------------------------------------------

describe("discoverSkills", () => {
  it("returns empty skills and diagnostics for empty directory", () => {
    const dir = createTempDir();
    const result = discoverSkills([dir]);
    expect(result.skills).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("discovers root .md file with valid frontmatter", () => {
    const dir = createTempDir();
    writeSkillFile(dir, "my-skill.md", {
      name: "my-skill",
      description: "A test skill",
    });

    const result = discoverSkills([dir]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("my-skill");
    expect(result.skills[0].description).toBe("A test skill");
    expect(result.skills[0].type).toBe("prompt");
    expect(result.skills[0].source).toBe("bundled");
  });

  it("discovers SKILL.md in subdirectory", () => {
    const dir = createTempDir();
    const subdir = path.join(dir, "sub-skill");
    fs.mkdirSync(subdir);
    writeSkillFile(subdir, "SKILL.md", {
      name: "sub-skill",
      description: "A subdirectory skill",
    });

    const result = discoverSkills([dir]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("sub-skill");
    expect(result.skills[0].path).toBe(subdir);
  });

  it("skips root .md without valid frontmatter (missing name)", () => {
    const dir = createTempDir();
    writeSkillFile(dir, "invalid.md", {
      description: "No name field",
    });

    const result = discoverSkills([dir]);
    expect(result.skills).toHaveLength(0);
  });

  it("skips root .md without frontmatter block", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "no-frontmatter.md"), "# Just markdown\n\nNo YAML here.\n", "utf-8");

    const result = discoverSkills([dir]);
    expect(result.skills).toHaveLength(0);
  });

  it("handles name collision: first wins, diagnostic emitted", () => {
    const dir1 = createTempDir();
    const dir2 = createTempDir();
    writeSkillFile(dir1, "collision.md", {
      name: "dup-skill",
      description: "First version",
    });
    writeSkillFile(dir2, "collision.md", {
      name: "dup-skill",
      description: "Second version",
    });

    const result = discoverSkills([dir1, dir2]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].description).toBe("First version");
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
    const collision = result.diagnostics.find((d) => d.type === "collision");
    expect(collision).toBeDefined();
    expect(collision!.collision?.name).toBe("dup-skill");
  });

  it("resolves source correctly for single path (bundled)", () => {
    const dir = createTempDir();
    writeSkillFile(dir, "skill.md", {
      name: "single-source",
      description: "Test",
    });

    const result = discoverSkills([dir]);
    expect(result.skills[0].source).toBe("bundled");
  });

  it("resolves source for two paths: index 0=bundled, index 1=local", () => {
    const dir1 = createTempDir();
    const dir2 = createTempDir();
    writeSkillFile(dir1, "first.md", {
      name: "first-skill",
      description: "Bundled",
    });
    writeSkillFile(dir2, "second.md", {
      name: "second-skill",
      description: "Local",
    });

    const result = discoverSkills([dir1, dir2]);
    const first = result.skills.find((s) => s.name === "first-skill");
    const second = result.skills.find((s) => s.name === "second-skill");
    expect(first!.source).toBe("bundled");
    expect(second!.source).toBe("local");
  });

  it("resolves source for three paths: bundled, workspace, local", () => {
    const dir1 = createTempDir();
    const dir2 = createTempDir();
    const dir3 = createTempDir();
    writeSkillFile(dir1, "a.md", { name: "a", description: "A" });
    writeSkillFile(dir2, "b.md", { name: "b", description: "B" });
    writeSkillFile(dir3, "c.md", { name: "c", description: "C" });

    const result = discoverSkills([dir1, dir2, dir3]);
    const a = result.skills.find((s) => s.name === "a");
    const b = result.skills.find((s) => s.name === "b");
    const c = result.skills.find((s) => s.name === "c");
    expect(a!.source).toBe("bundled");
    expect(b!.source).toBe("workspace");
    expect(c!.source).toBe("local");
  });

  it("skips hidden directories", () => {
    const dir = createTempDir();
    const hidden = path.join(dir, ".hidden");
    fs.mkdirSync(hidden);
    writeSkillFile(hidden, "SKILL.md", {
      name: "hidden-skill",
      description: "Should be skipped",
    });

    const result = discoverSkills([dir]);
    expect(result.skills).toHaveLength(0);
  });

  it("skips node_modules", () => {
    const dir = createTempDir();
    const nm = path.join(dir, "node_modules");
    fs.mkdirSync(nm);
    writeSkillFile(nm, "SKILL.md", {
      name: "nm-skill",
      description: "Should be skipped",
    });

    const result = discoverSkills([dir]);
    expect(result.skills).toHaveLength(0);
  });

  it("respects .gitignore patterns", () => {
    const dir = createTempDir();
    writeSkillFile(dir, "keep.md", {
      name: "keep-skill",
      description: "Should be kept",
    });
    writeSkillFile(dir, "ignored.md", {
      name: "ignored-skill",
      description: "Should be ignored",
    });
    fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.md\n", "utf-8");

    const result = discoverSkills([dir]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("keep-skill");
  });

  it("silently skips missing directory", () => {
    const result = discoverSkills(["/tmp/comis-nonexistent-dir-" + Date.now()]);
    expect(result.skills).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("extracts comis namespace fields", () => {
    const dir = createTempDir();
    // Write manually with proper YAML for nested comis namespace
    const content = `---
name: "ns-skill"
description: "Namespace test"
comis:
  os:
    - "linux"
  skill-key: "my-key"
  primary-env: "MY_VAR"
---
# Content
`;
    fs.writeFileSync(path.join(dir, "ns.md"), content, "utf-8");

    const result = discoverSkills([dir]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].os).toEqual(["linux"]);
    expect(result.skills[0].skillKey).toBe("my-key");
    expect(result.skills[0].primaryEnv).toBe("MY_VAR");
  });

  it("userInvocable defaults to true", () => {
    const dir = createTempDir();
    writeSkillFile(dir, "default-ui.md", {
      name: "default-ui",
      description: "Test",
    });

    const result = discoverSkills([dir]);
    expect(result.skills[0].userInvocable).toBe(true);
  });

  it("disableModelInvocation defaults to false", () => {
    const dir = createTempDir();
    writeSkillFile(dir, "default-dmi.md", {
      name: "default-dmi",
      description: "Test",
    });

    const result = discoverSkills([dir]);
    expect(result.skills[0].disableModelInvocation).toBe(false);
  });

  it("respects userInvocable=false from frontmatter", () => {
    const dir = createTempDir();
    writeSkillFile(dir, "no-invoke.md", {
      name: "no-invoke",
      description: "Test",
      userInvocable: false,
    });

    const result = discoverSkills([dir]);
    expect(result.skills[0].userInvocable).toBe(false);
  });

  it("symlink deduplication: same file via different symlink discovered once", () => {
    const dir = createTempDir();
    writeSkillFile(dir, "original.md", {
      name: "sym-skill",
      description: "Original",
    });

    // Create a subdirectory with a symlink to the original file as SKILL.md
    const subdir = path.join(dir, "linked");
    fs.mkdirSync(subdir);
    try {
      fs.symlinkSync(path.join(dir, "original.md"), path.join(subdir, "SKILL.md"));
    } catch {
      // Some platforms may not support symlinks; skip test silently
      return;
    }

    const result = discoverSkills([dir]);
    // Should only discover once despite appearing as root .md and subdir SKILL.md
    const matching = result.skills.filter((s) => s.name === "sym-skill");
    expect(matching).toHaveLength(1);
  });

  it("sets filePath to the absolute path of the manifest file", () => {
    const dir = createTempDir();
    writeSkillFile(dir, "pathtest.md", {
      name: "pathtest",
      description: "Test",
    });

    const result = discoverSkills([dir]);
    expect(result.skills[0].filePath).toBe(path.join(dir, "pathtest.md"));
  });

  it("emits logger warnings for malformed skill files", () => {
    const dir = createTempDir();
    writeSkillFile(dir, "bad.md", { description: "No name" });

    const warns: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const logger = {
      warn(obj: Record<string, unknown>, msg: string) {
        warns.push({ obj, msg });
      },
    };

    discoverSkills([dir], logger);
    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toBe("Skipping malformed skill file");
  });
});
