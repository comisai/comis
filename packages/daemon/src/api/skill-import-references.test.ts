// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { validateImportedSkillReferences } from "./skill-import-references.js";

describe("imported skill Markdown references", () => {
  it("accepts local files, directory links, anchors, and external URLs", () => {
    const result = validateImportedSkillReferences([
      {
        path: "SKILL.md",
        content: [
          "[guide](references/guide.md#usage)",
          "[directory](references/)",
          "[section](#section)",
          "[source](https://example.com/guide)",
        ].join("\n"),
      },
      { path: "references/guide.md", content: "# Guide" },
    ]);

    expect(result).toEqual({ ok: true, value: undefined });
  });

  it("ignores illustrative Markdown links inside code spans and fences", () => {
    const result = validateImportedSkillReferences([
      {
        path: "SKILL.md",
        content: [
          "`[inline example](not-a-file.md)`",
          "```md",
          "[fenced example](also-not-a-file.md)",
          "```",
        ].join("\n"),
      },
    ]);

    expect(result).toEqual({ ok: true, value: undefined });
  });

  it("rejects encoded and backslash paths that escape the approved directory", () => {
    const encoded = validateImportedSkillReferences([
      { path: "SKILL.md", content: "[shared](%2e%2e/shared.md)" },
    ]);
    const backslash = validateImportedSkillReferences([
      { path: "SKILL.md", content: "[shared](..\\shared.md)" },
    ]);

    expect(encoded.ok).toBe(false);
    expect(backslash.ok).toBe(false);
  });
});
