// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for apply-patch parser.
 *
 * Covers:
 * - Parse single Add File operation with content
 * - Parse single Delete File operation
 * - Parse Update File with one hunk (context + removals + additions)
 * - Parse Update File with multiple hunks
 * - Parse Update File with Move directive
 * - Parse multi-file patch (Add + Update + Delete in one patch)
 * - Parse with @@ hunk headers
 * - Handle *** End of File marker (insert at EOF)
 * - Return err() for input without *** Begin Patch
 * - Return err() for malformed directives
 * - Return err() for unclosed patch (no *** End Patch)
 * - Correctly strip line prefixes (space, +, -)
 */

import { describe, expect, it } from "vitest";
import { parsePatch } from "./apply-patch-parser.js";
import type { PatchOperation, PatchHunk } from "./apply-patch-parser.js";

describe("parsePatch", () => {
  it("parses single Add File operation with content", () => {
    const input = [
      "*** Begin Patch",
      "*** Add File: src/new-file.ts",
      "+export function hello() {",
      '+  return "hello";',
      "+}",
      "*** End Patch",
    ].join("\n");

    const result = parsePatch(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    const op = result.value[0]!;
    expect(op.type).toBe("add");
    expect(op.path).toBe("src/new-file.ts");
    expect(op.newContent).toEqual([
      "export function hello() {",
      '  return "hello";',
      "}",
    ]);
  });

  it("parses single Delete File operation", () => {
    const input = [
      "*** Begin Patch",
      "*** Delete File: src/old-file.ts",
      "*** End Patch",
    ].join("\n");

    const result = parsePatch(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    const op = result.value[0]!;
    expect(op.type).toBe("delete");
    expect(op.path).toBe("src/old-file.ts");
  });

  it("parses Update File with one hunk (context + removals + additions)", () => {
    const input = [
      "*** Begin Patch",
      "*** Update File: src/main.ts",
      " import { foo } from './foo';",
      " ",
      "-const x = 1;",
      "+const x = 2;",
      " ",
      " export { foo };",
      "*** End Patch",
    ].join("\n");

    const result = parsePatch(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    const op = result.value[0]!;
    expect(op.type).toBe("update");
    expect(op.path).toBe("src/main.ts");
    expect(op.hunks).toHaveLength(1);

    const hunk = op.hunks![0]!;
    expect(hunk.contextBefore).toEqual(["import { foo } from './foo';", ""]);
    expect(hunk.removals).toEqual(["const x = 1;"]);
    expect(hunk.additions).toEqual(["const x = 2;"]);
    expect(hunk.contextAfter).toEqual(["", "export { foo };"]);
  });

  it("parses Update File with multiple hunks", () => {
    const input = [
      "*** Begin Patch",
      "*** Update File: src/utils.ts",
      " // first section",
      "-const a = 1;",
      "+const a = 10;",
      " // end first",
      "@@ second hunk",
      " // second section",
      "-const b = 2;",
      "+const b = 20;",
      " // end second",
      "*** End Patch",
    ].join("\n");

    const result = parsePatch(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    const op = result.value[0]!;
    expect(op.hunks).toHaveLength(2);

    expect(op.hunks![0]!.removals).toEqual(["const a = 1;"]);
    expect(op.hunks![0]!.additions).toEqual(["const a = 10;"]);
    expect(op.hunks![1]!.removals).toEqual(["const b = 2;"]);
    expect(op.hunks![1]!.additions).toEqual(["const b = 20;"]);
  });

  it("parses Update File with Move directive", () => {
    const input = [
      "*** Begin Patch",
      "*** Update File: src/old-name.ts",
      "*** Move to: src/new-name.ts",
      " const x = 1;",
      "-const y = 2;",
      "+const y = 3;",
      "*** End Patch",
    ].join("\n");

    const result = parsePatch(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    const op = result.value[0]!;
    expect(op.type).toBe("update");
    expect(op.path).toBe("src/old-name.ts");
    expect(op.moveTo).toBe("src/new-name.ts");
    expect(op.hunks).toHaveLength(1);
  });

  it("parses multi-file patch (Add + Update + Delete)", () => {
    const input = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+new content",
      "*** Update File: src/existing.ts",
      " old line",
      "-remove me",
      "+add me",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
    ].join("\n");

    const result = parsePatch(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(3);
    expect(result.value[0]!.type).toBe("add");
    expect(result.value[0]!.path).toBe("src/new.ts");
    expect(result.value[1]!.type).toBe("update");
    expect(result.value[1]!.path).toBe("src/existing.ts");
    expect(result.value[2]!.type).toBe("delete");
    expect(result.value[2]!.path).toBe("src/gone.ts");
  });

  it("parses with @@ hunk headers", () => {
    const input = [
      "*** Begin Patch",
      "*** Update File: src/app.ts",
      "@@ some context header",
      " line before",
      "-old",
      "+new",
      " line after",
      "*** End Patch",
    ].join("\n");

    const result = parsePatch(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    const op = result.value[0]!;
    expect(op.hunks).toHaveLength(1);
    expect(op.hunks![0]!.removals).toEqual(["old"]);
    expect(op.hunks![0]!.additions).toEqual(["new"]);
  });

  it("handles *** End of File marker (insert at EOF)", () => {
    const input = [
      "*** Begin Patch",
      "*** Update File: src/config.ts",
      "*** End of File",
      "+// appended at end",
      "+export const extra = true;",
      "*** End Patch",
    ].join("\n");

    const result = parsePatch(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    const op = result.value[0]!;
    expect(op.hunks).toHaveLength(1);
    // End of File marker creates a hunk with no context, only additions
    const hunk = op.hunks![0]!;
    expect(hunk.contextBefore).toEqual([]);
    expect(hunk.removals).toEqual([]);
    expect(hunk.additions).toEqual([
      "// appended at end",
      "export const extra = true;",
    ]);
    expect(hunk.endOfFile).toBe(true);
  });

  it("returns err() for input without *** Begin Patch", () => {
    const input = "just some random text\nno patch here";

    const result = parsePatch(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Begin Patch");
  });

  it("returns err() for malformed directives", () => {
    const input = [
      "*** Begin Patch",
      "*** InvalidDirective: foo.ts",
      "*** End Patch",
    ].join("\n");

    const result = parsePatch(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeTruthy();
  });

  it("returns err() for unclosed patch (no *** End Patch)", () => {
    const input = [
      "*** Begin Patch",
      "*** Add File: src/file.ts",
      "+content",
    ].join("\n");

    const result = parsePatch(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("End Patch");
  });

  it("correctly strips line prefixes (space, +, -)", () => {
    const input = [
      "*** Begin Patch",
      "*** Update File: src/file.ts",
      " context line with leading space",
      "-removed line content",
      "+added line content",
      "*** End Patch",
    ].join("\n");

    const result = parsePatch(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const hunk = result.value[0]!.hunks![0]!;
    // The leading space/+/- should be stripped
    expect(hunk.contextBefore).toEqual(["context line with leading space"]);
    expect(hunk.removals).toEqual(["removed line content"]);
    expect(hunk.additions).toEqual(["added line content"]);
  });

  it("handles empty Add File (creates empty file)", () => {
    const input = [
      "*** Begin Patch",
      "*** Add File: src/empty.ts",
      "*** End Patch",
    ].join("\n");

    const result = parsePatch(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    const op = result.value[0]!;
    expect(op.type).toBe("add");
    expect(op.newContent).toEqual([]);
  });

  it("handles Update with only additions (no removals)", () => {
    const input = [
      "*** Begin Patch",
      "*** Update File: src/file.ts",
      " existing line",
      "+new line 1",
      "+new line 2",
      " next existing",
      "*** End Patch",
    ].join("\n");

    const result = parsePatch(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const hunk = result.value[0]!.hunks![0]!;
    expect(hunk.removals).toEqual([]);
    expect(hunk.additions).toEqual(["new line 1", "new line 2"]);
  });

  it("handles Update with only removals (no additions)", () => {
    const input = [
      "*** Begin Patch",
      "*** Update File: src/file.ts",
      " existing line",
      "-remove this",
      "-and this",
      " next existing",
      "*** End Patch",
    ].join("\n");

    const result = parsePatch(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const hunk = result.value[0]!.hunks![0]!;
    expect(hunk.removals).toEqual(["remove this", "and this"]);
    expect(hunk.additions).toEqual([]);
  });
});
