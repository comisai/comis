// SPDX-License-Identifier: Apache-2.0
/**
 * Boundary suite for the text-only import filter. Import is prompt-only, so
 * the filter must keep UTF-8 text and drop every execution-vector shape — a
 * `scripts/` path, an exec-bit entry, a known executable/binary extension, and
 * a non-UTF-8 file — each with a reason naming the exact trigger.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { applyTextFilter, type TextFilterEntry } from "./text-filter.js";

function entry(relPath: string, content: string | Buffer, execBit = false): TextFilterEntry {
  return {
    relPath,
    execBit,
    bytes: typeof content === "string" ? Buffer.from(content, "utf-8") : content,
  };
}

describe("applyTextFilter — text-only drop rules", () => {
  it("drops an entry under a scripts directory with a reason naming the trigger", () => {
    const result = applyTextFilter([entry("scripts/helper.py", "print(1)")]);
    expect(result.kept).toHaveLength(0);
    expect(result.drops).toHaveLength(1);
    expect(result.drops[0]!.relPath).toBe("scripts/helper.py");
    expect(result.drops[0]!.reason.toLowerCase()).toContain("scripts");
  });

  it("drops an entry that arrived with a Unix exec bit set", () => {
    const result = applyTextFilter([entry("runme", "#!/bin/sh\necho hi", true)]);
    expect(result.kept).toHaveLength(0);
    expect(result.drops[0]!.reason.toLowerCase()).toContain("exec bit");
  });

  it("drops a Python file by its executable file extension", () => {
    const result = applyTextFilter([entry("tool.py", "print(1)")]);
    expect(result.kept).toHaveLength(0);
    expect(result.drops[0]!.reason).toContain(".py");
  });

  it("drops a shell script by its executable file extension", () => {
    const result = applyTextFilter([entry("install.sh", "rm -rf /")]);
    expect(result.kept).toHaveLength(0);
    expect(result.drops[0]!.reason).toContain(".sh");
  });

  it("drops a WebAssembly binary by its file extension", () => {
    const result = applyTextFilter([entry("mod.wasm", Buffer.from([0x00, 0x61, 0x73, 0x6d]))]);
    expect(result.kept).toHaveLength(0);
    expect(result.drops[0]!.reason).toContain(".wasm");
  });

  it("drops a file whose bytes are not valid UTF-8 text", () => {
    // A lone 0xFF byte is never valid UTF-8; the extension (.md) and the absent
    // exec bit would otherwise keep it — the decode is the last-line trigger.
    const result = applyTextFilter([entry("data.md", Buffer.from([0xff, 0xfe, 0xff]))]);
    expect(result.kept).toHaveLength(0);
    expect(result.drops[0]!.reason.toLowerCase()).toContain("utf-8");
  });

  it("keeps a Markdown manifest file decoded as UTF-8 text", () => {
    const result = applyTextFilter([entry("SKILL.md", "# Heading\nBody text.")]);
    expect(result.drops).toHaveLength(0);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.relPath).toBe("SKILL.md");
    expect(result.kept[0]!.content).toBe("# Heading\nBody text.");
  });

  it("keeps a plain-text reference file and reports no drop for it", () => {
    const result = applyTextFilter([entry("references/notes.txt", "reference material")]);
    expect(result.drops).toHaveLength(0);
    expect(result.kept[0]!.relPath).toBe("references/notes.txt");
  });

  it("partitions a mixed set into kept text and reasoned drops", () => {
    const result = applyTextFilter([
      entry("SKILL.md", "# ok"),
      entry("references/guide.md", "guide"),
      entry("scripts/run.py", "print(1)"),
      entry("bin/tool", "x", true),
      entry("lib.so", Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
    ]);
    const keptPaths = result.kept.map((k) => k.relPath).sort();
    expect(keptPaths).toEqual(["SKILL.md", "references/guide.md"]);
    const droppedPaths = result.drops.map((d) => d.relPath).sort();
    expect(droppedPaths).toEqual(["bin/tool", "lib.so", "scripts/run.py"]);
    // Every drop names its trigger.
    for (const drop of result.drops) {
      expect(drop.reason.length).toBeGreaterThan(0);
    }
  });
});
