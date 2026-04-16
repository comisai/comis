import { describe, it, expect } from "vitest";
import {
  escapeXml,
  formatAvailableSkillsXml,
  expandSkillForInvocation,
  parseSkillArgs,
  substituteSkillArgs,
  SYSTEM_PROMPT_INSTRUCTION,
  type PromptSkillDescription,
} from "./processor.js";

// ---------------------------------------------------------------------------
// escapeXml
// ---------------------------------------------------------------------------

describe("escapeXml", () => {
  it("returns unchanged string when no entities present", () => {
    expect(escapeXml("hello")).toBe("hello");
  });

  it("escapes ampersand", () => {
    expect(escapeXml("a & b")).toBe("a &amp; b");
  });

  it("escapes angle brackets", () => {
    expect(escapeXml("<tag>")).toBe("&lt;tag&gt;");
  });

  it("escapes double quotes", () => {
    expect(escapeXml('"quotes"')).toBe("&quot;quotes&quot;");
  });

  it("escapes single quotes (apostrophes)", () => {
    expect(escapeXml("it's")).toBe("it&apos;s");
  });

  it("escapes all 5 entities in a single string", () => {
    expect(escapeXml("a & <b> \"c\" d'e")).toBe(
      "a &amp; &lt;b&gt; &quot;c&quot; d&apos;e",
    );
  });

  it("prevents double-escaping (& in existing entities gets escaped)", () => {
    // Input: "&lt;" -- the & should become &amp;, resulting in "&amp;lt;"
    expect(escapeXml("&lt;")).toBe("&amp;lt;");
  });

  it("handles empty string", () => {
    expect(escapeXml("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// formatAvailableSkillsXml
// ---------------------------------------------------------------------------

describe("formatAvailableSkillsXml", () => {
  it("returns empty string for empty array", () => {
    expect(formatAvailableSkillsXml([])).toBe("");
  });

  it("generates valid XML for a single skill", () => {
    const skills: PromptSkillDescription[] = [
      { name: "test", description: "A test", location: "/skills/test" },
    ];
    const result = formatAvailableSkillsXml(skills);
    expect(result).toBe(
      `<available_skills>\n` +
        `  <skill>\n` +
        `    <name>test</name>\n` +
        `    <description>A test</description>\n` +
        `    <location>/skills/test</location>\n` +
        `  </skill>\n` +
        `</available_skills>`,
    );
  });

  it("generates valid XML for two skills", () => {
    const skills: PromptSkillDescription[] = [
      { name: "alpha", description: "First skill", location: "/skills/alpha" },
      { name: "beta", description: "Second skill", location: "/skills/beta" },
    ];
    const result = formatAvailableSkillsXml(skills);
    expect(result).toContain("<available_skills>");
    expect(result).toContain("</available_skills>");
    expect(result).toContain("<name>alpha</name>");
    expect(result).toContain("<name>beta</name>");
    expect(result).toContain("<description>First skill</description>");
    expect(result).toContain("<description>Second skill</description>");
  });

  it("filters out skills with disableModelInvocation: true", () => {
    const skills: PromptSkillDescription[] = [
      { name: "visible", description: "Can see me", location: "/skills/visible" },
      {
        name: "hidden",
        description: "Cannot see me",
        location: "/skills/hidden",
        disableModelInvocation: true,
      },
    ];
    const result = formatAvailableSkillsXml(skills);
    expect(result).toContain("<name>visible</name>");
    expect(result).not.toContain("<name>hidden</name>");
  });

  it("returns empty string when all skills are disabled", () => {
    const skills: PromptSkillDescription[] = [
      {
        name: "hidden-a",
        description: "Nope",
        location: "/a",
        disableModelInvocation: true,
      },
      {
        name: "hidden-b",
        description: "Nope",
        location: "/b",
        disableModelInvocation: true,
      },
    ];
    expect(formatAvailableSkillsXml(skills)).toBe("");
  });

  it("XML-escapes special characters in name, description, and location", () => {
    const skills: PromptSkillDescription[] = [
      {
        name: "a&b",
        description: 'uses <xml> & "quotes"',
        location: "/path/it's here",
      },
    ];
    const result = formatAvailableSkillsXml(skills);
    expect(result).toContain("<name>a&amp;b</name>");
    expect(result).toContain(
      "<description>uses &lt;xml&gt; &amp; &quot;quotes&quot;</description>",
    );
    expect(result).toContain("<location>/path/it&apos;s here</location>");
  });

  it("includes skills where disableModelInvocation is false or undefined", () => {
    const skills: PromptSkillDescription[] = [
      { name: "no-flag", description: "No flag set", location: "/a" },
      {
        name: "explicit-false",
        description: "Explicitly false",
        location: "/b",
        disableModelInvocation: false,
      },
    ];
    const result = formatAvailableSkillsXml(skills);
    expect(result).toContain("<name>no-flag</name>");
    expect(result).toContain("<name>explicit-false</name>");
  });
});

// ---------------------------------------------------------------------------
// expandSkillForInvocation
// ---------------------------------------------------------------------------

describe("expandSkillForInvocation", () => {
  it("generates skill block without args", () => {
    const result = expandSkillForInvocation(
      "my-skill",
      "Do the thing.\nStep 1: foo",
      "/skills/my-skill",
      "/skills/my-skill",
    );
    expect(result).toBe(
      `<skill name="my-skill" location="/skills/my-skill">\n` +
        `References are relative to /skills/my-skill.\n` +
        `Do the thing.\nStep 1: foo\n` +
        `</skill>`,
    );
  });

  it("appends user arguments after </skill> block", () => {
    const result = expandSkillForInvocation(
      "deploy",
      "Deploy instructions.",
      "/skills/deploy",
      "/skills/deploy",
      "production --force",
    );
    expect(result).toContain("</skill>\n\nUser arguments: production --force");
  });

  it("omits arguments section when args is empty string", () => {
    const result = expandSkillForInvocation(
      "test",
      "Body.",
      "/loc",
      "/loc",
      "",
    );
    expect(result).not.toContain("User arguments:");
    expect(result.endsWith("</skill>")).toBe(true);
  });

  it("omits arguments section when args is undefined", () => {
    const result = expandSkillForInvocation(
      "test",
      "Body.",
      "/loc",
      "/loc",
      undefined,
    );
    expect(result).not.toContain("User arguments:");
    expect(result.endsWith("</skill>")).toBe(true);
  });

  it("XML-escapes name and location attributes", () => {
    const result = expandSkillForInvocation(
      'a"b',
      "Body.",
      '/path/"loc"',
      "/base",
    );
    expect(result).toContain('name="a&quot;b"');
    expect(result).toContain('location="/path/&quot;loc&quot;"');
  });

  it("XML-escapes baseDir in preamble", () => {
    const result = expandSkillForInvocation(
      "test",
      "Body.",
      "/loc",
      "/base/<dir>",
    );
    expect(result).toContain("References are relative to /base/&lt;dir&gt;.");
  });

  it("XML-escapes user arguments", () => {
    const result = expandSkillForInvocation(
      "test",
      "Body.",
      "/loc",
      "/loc",
      '<script>alert("xss")</script>',
    );
    expect(result).toContain(
      "User arguments: &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
    );
  });

  it("does NOT escape the body content (preserves Markdown)", () => {
    const body = "Use <details> and <summary> for collapsible sections.";
    const result = expandSkillForInvocation("md", body, "/loc", "/loc");
    expect(result).toContain(body);
    // Verify the raw HTML tags are preserved, not escaped
    expect(result).toContain("<details>");
    expect(result).toContain("<summary>");
  });

  it("substitutes {placeholder} args into body instead of appending", () => {
    const result = expandSkillForInvocation(
      "review",
      "Review the code in {filename}.",
      "/skills/review",
      "/skills/review",
      "main.ts",
    );
    expect(result).toContain("Review the code in main.ts.");
    expect(result).not.toContain("User arguments:");
    expect(result).not.toContain("{filename}");
  });

  it("falls back to appending when no templates in body", () => {
    const result = expandSkillForInvocation(
      "deploy",
      "Deploy the application.",
      "/skills/deploy",
      "/skills/deploy",
      "production",
    );
    expect(result).toContain("User arguments: production");
    expect(result).toContain("Deploy the application.");
  });
});

// ---------------------------------------------------------------------------
// parseSkillArgs
// ---------------------------------------------------------------------------

describe("parseSkillArgs", () => {
  it("splits simple space-separated args", () => {
    expect(parseSkillArgs("a b c")).toEqual(["a", "b", "c"]);
  });

  it("respects double-quoted strings", () => {
    expect(parseSkillArgs('file "my doc.txt" output')).toEqual([
      "file",
      "my doc.txt",
      "output",
    ]);
  });

  it("respects single-quoted strings", () => {
    expect(parseSkillArgs("file 'my doc.txt'")).toEqual([
      "file",
      "my doc.txt",
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(parseSkillArgs("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseSkillArgs("   ")).toEqual([]);
  });

  it("handles multiple spaces between args", () => {
    expect(parseSkillArgs("a   b")).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// substituteSkillArgs
// ---------------------------------------------------------------------------

describe("substituteSkillArgs", () => {
  it("substitutes single {placeholder}", () => {
    const result = substituteSkillArgs("Review {filename}", ["main.ts"]);
    expect(result.substituted).toBe("Review main.ts");
    expect(result.hasTemplates).toBe(true);
  });

  it("substitutes multiple placeholders positionally", () => {
    const result = substituteSkillArgs("Deploy {app} to {env}", [
      "myapp",
      "prod",
    ]);
    expect(result.substituted).toBe("Deploy myapp to prod");
    expect(result.hasTemplates).toBe(true);
  });

  it("leaves unmatched placeholders as-is when args exhausted", () => {
    const result = substituteSkillArgs("Deploy {app} to {env}", ["myapp"]);
    expect(result.substituted).toBe("Deploy myapp to {env}");
    expect(result.hasTemplates).toBe(true);
  });

  it("returns hasTemplates: false when no patterns in body", () => {
    const result = substituteSkillArgs("No templates here", ["x"]);
    expect(result.substituted).toBe("No templates here");
    expect(result.hasTemplates).toBe(false);
  });

  it("handles $1 positional syntax", () => {
    const result = substituteSkillArgs("File: $1", ["test.ts"]);
    expect(result.substituted).toBe("File: test.ts");
    expect(result.hasTemplates).toBe(true);
  });

  it("handles $@ for all arguments", () => {
    const result = substituteSkillArgs("Args: $@", ["a", "b", "c"]);
    expect(result.substituted).toBe("Args: a b c");
    expect(result.hasTemplates).toBe(true);
  });

  it("handles $ARGUMENTS for all arguments", () => {
    const result = substituteSkillArgs("All: $ARGUMENTS", ["x", "y"]);
    expect(result.substituted).toBe("All: x y");
    expect(result.hasTemplates).toBe(true);
  });

  it("handles ${@:N} slice syntax", () => {
    const result = substituteSkillArgs("Rest: ${@:2}", ["a", "b", "c"]);
    expect(result.substituted).toBe("Rest: b c");
    expect(result.hasTemplates).toBe(true);
  });

  it("handles empty args gracefully with named placeholders", () => {
    const result = substituteSkillArgs("Deploy {app}", []);
    expect(result.substituted).toBe("Deploy {app}");
    expect(result.hasTemplates).toBe(true);
  });

  it("handles empty args gracefully with positional syntax", () => {
    const result = substituteSkillArgs("File: $1", []);
    expect(result.substituted).toBe("File: $1");
    expect(result.hasTemplates).toBe(true);
  });

  it("handles repeated placeholder names", () => {
    const result = substituteSkillArgs(
      "Copy {file} to backup_{file}",
      ["data.json"],
    );
    expect(result.substituted).toBe("Copy data.json to backup_data.json");
    expect(result.hasTemplates).toBe(true);
  });

  it("appends extra args when more args than named placeholders", () => {
    const result = substituteSkillArgs("Deploy {app}", [
      "myapp",
      "extra1",
      "extra2",
    ]);
    expect(result.substituted).toContain("Deploy myapp");
    expect(result.substituted).toContain("Additional arguments: extra1 extra2");
    expect(result.hasTemplates).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SDK format compliance verification
// ---------------------------------------------------------------------------

describe("SDK format compliance", () => {
  it("available_skills XML uses SDK-compatible child element format", () => {
    // Verifies the format matches SDK's formatSkillsForPrompt:
    // <available_skills> wrapper with <skill> entries containing <name>, <description> child elements
    const skills: PromptSkillDescription[] = [
      { name: "test-skill", description: "A test skill", location: "/skills/test-skill" },
    ];
    const result = formatAvailableSkillsXml(skills);

    // Must use child elements (not attributes) for listing
    expect(result).toContain("<available_skills>");
    expect(result).toContain("</available_skills>");
    expect(result).toContain("<skill>");
    expect(result).toContain("<name>test-skill</name>");
    expect(result).toContain("<description>A test skill</description>");
    expect(result).toContain("<location>/skills/test-skill</location>");
    expect(result).toContain("</skill>");

    // Verify child element nesting order: <skill> -> <name>, <description>, <location>
    const skillBlockMatch = result.match(/<skill>\n\s+<name>.*<\/name>\n\s+<description>.*<\/description>\n\s+<location>.*<\/location>\n\s+<\/skill>/);
    expect(skillBlockMatch).not.toBeNull();
  });

  it("expandSkillForInvocation uses SDK-compatible attribute format", () => {
    // Verifies the format matches SDK's _expandSkillCommand:
    // <skill name="..." location="..."> with attributes (not child elements)
    const result = expandSkillForInvocation(
      "deploy",
      "Deploy the application.",
      "/skills/deploy",
      "/skills/deploy",
    );

    // Must use attribute format for invocation
    expect(result).toMatch(/^<skill name="deploy" location="\/skills\/deploy">/);
    expect(result).toContain("</skill>");
    // Must NOT use child element format for invocation
    expect(result).not.toContain("<name>deploy</name>");
  });
});

// ---------------------------------------------------------------------------
// SYSTEM_PROMPT_INSTRUCTION
// ---------------------------------------------------------------------------

describe("SYSTEM_PROMPT_INSTRUCTION", () => {
  it("matches expected SYSTEM_PROMPT_INSTRUCTION text", () => {
    expect(SYSTEM_PROMPT_INSTRUCTION).toBe(
      "Use the read tool to load a skill's file when the task matches its description. " +
        "When a skill file references a relative path, resolve it against the skill directory.",
    );
  });
});
