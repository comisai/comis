// SPDX-License-Identifier: Apache-2.0
/** Pure parser and resolver contract for /.well-known/skills/index.json. */
import { describe, expect, it } from "vitest";
import { parseWellKnownIndex, resolveWellKnownSkill } from "./wellknown-index.js";

describe("parseWellKnownIndex", () => {
  it("accepts the bounded conventional index projection", () => {
    const result = parseWellKnownIndex({
      skills: [
        {
          name: "summarize",
          description: "Summarize a document",
          files: ["SKILL.md", "references/examples.md"],
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects unknown top-level and skill-entry fields", () => {
    expect(parseWellKnownIndex({ skills: [], extra: true }).ok).toBe(false);
    expect(parseWellKnownIndex({ skills: [{ name: "x", url: "https://example.com" }] }).ok).toBe(false);
  });
});

describe("resolveWellKnownSkill", () => {
  it("resolves a skill name to a deterministic deduplicated file list", () => {
    const parsed = parseWellKnownIndex({
      skills: [
        {
          name: "summarize",
          files: ["references/examples.md", "SKILL.md", "references/examples.md"],
        },
      ],
    });
    if (!parsed.ok) throw new Error("fixture must parse");

    expect(resolveWellKnownSkill(parsed.value, "summarize")).toEqual({
      ok: true,
      value: {
        name: "summarize",
        files: ["SKILL.md", "references/examples.md"],
      },
    });
  });

  it("adds SKILL.md when an entry omits files or lists only support files", () => {
    const parsed = parseWellKnownIndex({
      skills: [
        { name: "implicit" },
        { name: "support-only", files: ["references/guide.md"] },
      ],
    });
    if (!parsed.ok) throw new Error("fixture must parse");

    expect(resolveWellKnownSkill(parsed.value, "implicit")).toMatchObject({
      ok: true,
      value: { files: ["SKILL.md"] },
    });
    expect(resolveWellKnownSkill(parsed.value, "support-only")).toMatchObject({
      ok: true,
      value: { files: ["SKILL.md", "references/guide.md"] },
    });
  });

  it.each([
    "../../etc/passwd",
    "/etc/passwd",
    "C:/windows/system.ini",
    "references\\..\\escape.md",
    "references/../../escape.md",
  ])("refuses the whole skill when one file path is unsafe: %s", (unsafePath) => {
    const parsed = parseWellKnownIndex({
      skills: [{ name: "unsafe", files: ["SKILL.md", unsafePath] }],
    });
    if (!parsed.ok) throw new Error("fixture must parse");

    const resolved = resolveWellKnownSkill(parsed.value, "unsafe");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.kind).toBe("unsafe_path");
  });

  it("returns skill_not_found without selecting a similarly named entry", () => {
    const parsed = parseWellKnownIndex({ skills: [{ name: "summary" }] });
    if (!parsed.ok) throw new Error("fixture must parse");

    const resolved = resolveWellKnownSkill(parsed.value, "summarize");
    expect(resolved).toMatchObject({ ok: false, error: { kind: "skill_not_found" } });
  });
});

