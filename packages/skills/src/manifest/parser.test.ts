// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { parseSkillManifest, parseFrontmatter } from "./parser.js";
import { expandSkillForInvocation } from "../prompt/processor.js";

const VALID_FULL = `---
name: web-search
description: Search the web for information
version: "1.0.0"
license: MIT
permissions:
  fsRead: ["/tmp/cache"]
  fsWrite: ["/tmp/cache/results"]
  net: ["api.search.example.com"]
  env: ["SEARCH_API_KEY"]
inputSchema:
  type: object
  properties:
    query:
      type: string
metadata:
  author: comis-team
  category: search
---

# web-search

A skill that searches the web.
`;

const VALID_MINIMAL = `---
name: hello
description: A simple greeting skill
---

# hello

Greets the user.
`;

describe("parseSkillManifest", () => {
  it("parses valid SKILL.md with all fields", () => {
    const result = parseSkillManifest(VALID_FULL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.name).toBe("web-search");
    expect(result.value.description).toBe("Search the web for information");
    expect(result.value.version).toBe("1.0.0");
    expect(result.value.license).toBe("MIT");
    expect(result.value.permissions.fsRead).toEqual(["/tmp/cache"]);
    expect(result.value.permissions.fsWrite).toEqual(["/tmp/cache/results"]);
    expect(result.value.permissions.net).toEqual(["api.search.example.com"]);
    expect(result.value.permissions.env).toEqual(["SEARCH_API_KEY"]);
    expect(result.value.inputSchema).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
    });
    expect(result.value.metadata).toEqual({
      author: "comis-team",
      category: "search",
    });

    expect(result.value.type).toBe("prompt");
    expect(result.value.userInvocable).toBe(true);
  });

  it("parses minimal SKILL.md and applies defaults", () => {
    const result = parseSkillManifest(VALID_MINIMAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.name).toBe("hello");
    expect(result.value.description).toBe("A simple greeting skill");
    expect(result.value.version).toBeUndefined();
    expect(result.value.license).toBeUndefined();
    expect(result.value.permissions.fsRead).toEqual([]);
    expect(result.value.permissions.fsWrite).toEqual([]);
    expect(result.value.permissions.net).toEqual([]);
    expect(result.value.permissions.env).toEqual([]);
    expect(result.value.inputSchema).toBeUndefined();
    expect(result.value.metadata).toBeUndefined();

    expect(result.value.type).toBe("prompt");
    expect(result.value.userInvocable).toBe(true);
    expect(result.value.disableModelInvocation).toBe(false);
    expect(result.value.allowedTools).toEqual([]);
    expect(result.value.argumentHint).toBeUndefined();
  });

  it("returns error for missing name", () => {
    const content = `---\ndescription: A skill\n---\n`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Manifest validation failed");
    }
  });

  it("returns error for missing description", () => {
    const content = `---\nname: test-skill\n---\n`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Manifest validation failed");
    }
  });

  it("returns error for uppercase name", () => {
    const content = `---\nname: MySkill\ndescription: A skill\n---\n`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Manifest validation failed");
    }
  });

  it("returns error for name with spaces", () => {
    const content = `---\nname: "my skill"\ndescription: A skill\n---\n`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Manifest validation failed");
    }
  });

  it("returns error for consecutive hyphens in name", () => {
    const content = `---\nname: my--skill\ndescription: A skill\n---\n`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Manifest validation failed");
    }
  });

  it("returns error when no frontmatter markers", () => {
    const result = parseSkillManifest("# Just a markdown file\nNo YAML here.");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("No frontmatter found");
    }
  });

  it("returns error for invalid YAML", () => {
    const content = `---\nname: [unclosed\n---\n`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Either YAML parse error or validation error
      expect(result.error.message).toMatch(/YAML parse error|Manifest validation failed/);
    }
  });

  it("returns error for unknown fields (strict mode)", () => {
    const content = `---\nname: test\ndescription: A skill\nunknownField: value\n---\n`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Manifest validation failed");
    }
  });

  it("parses prompt skill with all new fields", () => {
    const content = `---
name: greet
type: prompt
description: Greet the user warmly
userInvocable: true
disableModelInvocation: false
allowedTools:
  - read
  - grep
argumentHint: "[name]"
---

# greet

Greets the user by name.
`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.type).toBe("prompt");
    expect(result.value.userInvocable).toBe(true);
    expect(result.value.disableModelInvocation).toBe(false);
    expect(result.value.allowedTools).toEqual(["read", "grep"]);
    expect(result.value.argumentHint).toBe("[name]");
  });

  it("parses prompt skill with minimal fields and applies defaults", () => {
    const content = `---
name: helper
type: prompt
description: A simple helper skill
---

# helper

Helps the user.
`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.type).toBe("prompt");
    expect(result.value.userInvocable).toBe(true);
    expect(result.value.disableModelInvocation).toBe(false);
    expect(result.value.allowedTools).toEqual([]);
    expect(result.value.argumentHint).toBeUndefined();
  });

  it("returns error for invalid type value", () => {
    const content = `---\nname: bad-type\ndescription: A skill\ntype: invalid\n---\n`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Manifest validation failed");
    }
  });

  it("rejects skill name longer than 64 characters", () => {
    const longName = "a".repeat(65);
    const content = `---\nname: ${longName}\ndescription: A skill\n---\n`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Manifest validation failed");
    }
  });

  it("rejects empty description", () => {
    const content = `---\nname: empty-desc\ndescription: ""\n---\n`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Manifest validation failed");
    }
  });

  // -------------------------------------------------------------------------
  // Extended frontmatter field tests
  // -------------------------------------------------------------------------

  it("parses skill with os field as array under comis: namespace", () => {
    const content = `---
name: platform-skill
description: A platform-specific skill
comis:
  os:
    - linux
    - darwin
---

# platform-skill

Platform-specific instructions.
`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comis?.os).toEqual(["linux", "darwin"]);
  });

  it("coerces os string to array under comis: namespace", () => {
    const content = `---
name: linux-only
description: A Linux-only skill
comis:
  os: linux
---

# linux-only

Linux instructions.
`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comis?.os).toEqual(["linux"]);
  });

  it("normalizes os to lowercase under comis: namespace", () => {
    const content = `---
name: mixed-case-os
description: OS with mixed case
comis:
  os:
    - Linux
    - DARWIN
---

# mixed-case-os

Body.
`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comis?.os).toEqual(["linux", "darwin"]);
  });

  it("parses skill with requires field under comis: namespace", () => {
    const content = `---
name: ffmpeg-skill
description: A skill that needs ffmpeg
comis:
  requires:
    bins:
      - ffmpeg
    env:
      - OPENAI_KEY
---

# ffmpeg-skill

Requires ffmpeg binary.
`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comis?.requires).toEqual({ bins: ["ffmpeg"], env: ["OPENAI_KEY"] });
  });

  it("requires defaults bins and env to empty arrays under comis: namespace", () => {
    const content = `---
name: partial-requires
description: A skill with partial requires
comis:
  requires:
    bins:
      - ffmpeg
---

# partial-requires

Body.
`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comis?.requires).toBeDefined();
    expect(result.value.comis!.requires!.bins).toEqual(["ffmpeg"]);
    expect(result.value.comis!.requires!.env).toEqual([]);
  });

  it("parses skill with skill-key under comis: namespace", () => {
    const content = `---
name: keyed-skill
description: A skill with explicit key
comis:
  skill-key: my-skill
---

# keyed-skill

Body.
`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comis?.["skill-key"]).toBe("my-skill");
  });

  it("coerces skill-key to slug format under comis: namespace", () => {
    const content = `---
name: slug-coerce
description: A skill with coerced key
comis:
  skill-key: "My Skill Tool"
---

# slug-coerce

Body.
`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comis?.["skill-key"]).toBe("my-skill-tool");
  });

  it("parses primary-env and command-dispatch under comis: namespace", () => {
    const content = `---
name: env-skill
description: A skill with env and dispatch
comis:
  primary-env: discord
  command-dispatch: slash
---

# env-skill

Body.
`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comis?.["primary-env"]).toBe("discord");
    expect(result.value.comis?.["command-dispatch"]).toBe("slash");
  });

  it("existing minimal SKILL.md without comis fields still parses", () => {
    const result = parseSkillManifest(VALID_MINIMAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // comis block should be undefined -- no validation errors
    expect(result.value.comis).toBeUndefined();
  });

  it("rejects requires with unknown keys (strict) under comis: namespace", () => {
    const content = `---
name: bad-requires
description: A skill with invalid requires
comis:
  requires:
    bins: []
    services:
      - docker
---

# bad-requires

Body.
`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Manifest validation failed");
    }
  });

  // -------------------------------------------------------------------------
  // comis: namespace tests
  // -------------------------------------------------------------------------

  it("parses skill with comis: namespace block containing all Comis-only fields", () => {
    const content = `---
name: namespaced-skill
description: A skill using the comis namespace
comis:
  os:
    - linux
    - darwin
  requires:
    bins:
      - ffmpeg
    env:
      - OPENAI_KEY
  skill-key: my-namespaced-skill
  primary-env: discord
  command-dispatch: slash
---

# namespaced-skill

Body content.
`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Fields live inside comis: namespace
    expect(result.value.comis?.os).toEqual(["linux", "darwin"]);
    expect(result.value.comis?.requires).toEqual({ bins: ["ffmpeg"], env: ["OPENAI_KEY"] });
    expect(result.value.comis?.["skill-key"]).toBe("my-namespaced-skill");
    expect(result.value.comis?.["primary-env"]).toBe("discord");
    expect(result.value.comis?.["command-dispatch"]).toBe("slash");
  });

  it("rejects top-level Comis fields (legacy format no longer supported)", () => {
    const content = `---
name: legacy-skill
description: A legacy skill with top-level Comis fields
os: linux
skill-key: legacy-key
primary-env: telegram
command-dispatch: tool
---

# legacy-skill

Body.
`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Manifest validation failed");
    }
  });

  it("empty comis block: comis: {} does not cause error", () => {
    const content = `---
name: empty-ns
description: A skill with empty comis block
comis: {}
---

# empty-ns

Body.
`;
    const result = parseSkillManifest(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comis).toEqual({});
  });

  it("expandSkillForInvocation produces <skill name=... location=...> format", () => {
    // Verify the invocation XML matches the SDK's _expandSkillCommand pattern
    const result = expandSkillForInvocation(
      "my-skill",
      "Skill instructions.",
      "/skills/my-skill",
      "/skills/my-skill",
    );
    // Verify SDK-compatible attribute format: <skill name="..." location="...">
    expect(result).toMatch(/^<skill name="[^"]*" location="[^"]*">/);
    expect(result).toContain('</skill>');
  });
});

// ---------------------------------------------------------------------------
// parseFrontmatter tests
// ---------------------------------------------------------------------------

describe("parseFrontmatter", () => {
  it("returns frontmatter and body for valid SKILL.md content", () => {
    const content = `---\nname: test-skill\ndescription: A test skill\n---\n\n# test-skill\n\nThis is the body content.\n`;
    const result = parseFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.frontmatter).toEqual({
      name: "test-skill",
      description: "A test skill",
    });
    expect(result.value.body).toBe("# test-skill\n\nThis is the body content.");
  });

  it("returns empty string body when no content after closing ---", () => {
    const content = `---\nname: minimal\n---\n`;
    const result = parseFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.frontmatter).toEqual({ name: "minimal" });
    expect(result.value.body).toBe("");
  });

  it("handles \\r\\n line endings correctly", () => {
    const content = "---\r\nname: crlf-skill\r\ndescription: Windows style\r\n---\r\n\r\n# Body\r\n";
    const result = parseFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.frontmatter).toEqual({
      name: "crlf-skill",
      description: "Windows style",
    });
    expect(result.value.body).toBe("# Body");
  });

  it("returns error for missing opening --- marker", () => {
    const result = parseFrontmatter("no frontmatter here");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("No frontmatter found");
      expect(result.error.message).toContain("start with '---'");
    }
  });

  it("returns error for missing closing --- marker", () => {
    const result = parseFrontmatter("---\nname: unclosed\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("missing closing");
    }
  });

  it("returns error for empty frontmatter block", () => {
    const result = parseFrontmatter("---\n\n---\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Empty frontmatter");
    }
  });

  it("returns error for invalid YAML", () => {
    const result = parseFrontmatter("---\nname: [unclosed\n---\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("YAML parse error");
    }
  });

  it("returns error for non-object YAML (scalar)", () => {
    const result = parseFrontmatter("---\njust a string\n---\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("YAML frontmatter must be an object");
    }
  });

  it("body is trimmed (no leading/trailing whitespace)", () => {
    const content = "---\nname: trimmed\n---\n\n\n  # Content  \n\n\n";
    const result = parseFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.body).toBe("# Content");
  });
});
