import { describe, it, expect } from "vitest";
import { matchPromptSkillCommand, detectSkillCollisions } from "./prompt-skill-command.js";

// ---------------------------------------------------------------------------
// matchPromptSkillCommand
// ---------------------------------------------------------------------------

describe("matchPromptSkillCommand", () => {
  const skills = new Set(["deploy", "code-review", "summarize"]);

  // -----------------------------------------------------------------------
  // Successful matches
  // -----------------------------------------------------------------------

  it("matches /skill:name with no args", () => {
    const result = matchPromptSkillCommand("/skill:deploy", skills);
    expect(result).toEqual({ name: "deploy", args: "" });
  });

  it("matches /skill:name with args", () => {
    const result = matchPromptSkillCommand("/skill:deploy production --force", skills);
    expect(result).toEqual({ name: "deploy", args: "production --force" });
  });

  it("matches hyphenated skill names", () => {
    const result = matchPromptSkillCommand("/skill:code-review src/main.ts", skills);
    expect(result).toEqual({ name: "code-review", args: "src/main.ts" });
  });

  it("matches case-insensitively and returns canonical name", () => {
    const result = matchPromptSkillCommand("/skill:Deploy", skills);
    expect(result).toEqual({ name: "deploy", args: "" });
  });

  it("matches case-insensitive prefix /Skill:name", () => {
    const result = matchPromptSkillCommand("/Skill:deploy", skills);
    expect(result).toEqual({ name: "deploy", args: "" });
  });

  it("matches multiline args with s flag", () => {
    const result = matchPromptSkillCommand("/skill:deploy line1\nline2", skills);
    expect(result).toEqual({ name: "deploy", args: "line1\nline2" });
  });

  // -----------------------------------------------------------------------
  // Non-matches (returns null)
  // -----------------------------------------------------------------------

  it("returns null for unknown skill names", () => {
    const result = matchPromptSkillCommand("/skill:unknown", skills);
    expect(result).toBeNull();
  });

  it("returns null for system commands -- not intercepted", () => {
    const result = matchPromptSkillCommand("/status", skills);
    expect(result).toBeNull();
  });

  it("returns null for /skill without colon (no match)", () => {
    const result = matchPromptSkillCommand("/skill deploy", skills);
    expect(result).toBeNull();
  });

  it("returns null for /skill: with empty name", () => {
    const result = matchPromptSkillCommand("/skill:", skills);
    expect(result).toBeNull();
  });

  it("returns null for /skill:-bad (leading hyphen invalid)", () => {
    const result = matchPromptSkillCommand("/skill:-bad", skills);
    expect(result).toBeNull();
  });

  it("returns null for plain text (no slash)", () => {
    const result = matchPromptSkillCommand("Hello world", skills);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectSkillCollisions
// ---------------------------------------------------------------------------

describe("detectSkillCollisions", () => {
  it("detects collision with current system command names", () => {
    const skills = new Set(["status", "deploy"]);
    const warnings = detectSkillCollisions(skills);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.skillName).toBe("status");
    expect(warnings[0]!.collidesWithCommand).toBe("status");
  });

  it("returns empty array when no collisions", () => {
    const skills = new Set(["deploy", "summarize"]);
    const warnings = detectSkillCollisions(skills);
    expect(warnings).toHaveLength(0);
  });

  it("detects collision with anticipated future commands", () => {
    const skills = new Set(["help"]);
    const warnings = detectSkillCollisions(skills);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.skillName).toBe("help");
  });

  it("detects collision with namespace prefix 'skill'", () => {
    const skills = new Set(["skill"]);
    const warnings = detectSkillCollisions(skills);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.skillName).toBe("skill");
  });
});
