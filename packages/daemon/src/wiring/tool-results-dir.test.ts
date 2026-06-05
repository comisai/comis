// SPDX-License-Identifier: Apache-2.0
/**
 * RED → GREEN for the tool-result spill-dir derivation (FIX 1).
 *
 * The session-key resolver returns the session JSONL FILE path; the spill dir
 * must be derived from the session DIRECTORY (the file's parent), NOT by
 * appending `tool-results` onto the `.jsonl` file path. The pre-patch code
 * produced `…/web-user.jsonl/tool-results`, whose parent is a regular file, so
 * `mkdirSync` threw `ENOTDIR: not a directory` and EVERY oversized tool-result
 * spill (ctx_expand + the shared exec spill path) broke.
 *
 * These tests prove (a) the produced path's parent is NOT a `.jsonl` file and
 * (b) `mkdirSync` actually succeeds against a real session JSONL file on disk —
 * the ENOTDIR reproduction.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { toolResultsDirFromSessionPath } from "./tool-results-dir.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeSessionTree(): { jsonlPath: string; sessionDir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "comis-tool-results-"));
  tempDirs.push(root);
  // …/sessions/<tenant>/<channel>/web-user.jsonl
  const sessionDir = join(root, "sessions", "tenant_a", "channel_a");
  mkdirSync(sessionDir, { recursive: true });
  const jsonlPath = join(sessionDir, "web-user.jsonl");
  writeFileSync(jsonlPath, "", "utf-8"); // a real session JSONL FILE
  return { jsonlPath, sessionDir, root };
}

describe("toolResultsDirFromSessionPath — derives the spill dir from the session directory, not the .jsonl file", () => {
  it("returns a path whose parent is a directory, never a `.jsonl` file path segment", () => {
    const { jsonlPath, sessionDir } = makeSessionTree();
    const spillDir = toolResultsDirFromSessionPath(jsonlPath);

    // The spill dir must NOT live UNDER the .jsonl file path.
    expect(spillDir).not.toContain(".jsonl/");
    expect(spillDir.endsWith("tool-results")).toBe(true);
    // Its parent must be the session DIRECTORY (a real dir), not the file.
    expect(dirname(spillDir)).toBe(sessionDir);
    expect(statSync(dirname(spillDir)).isDirectory()).toBe(true);
  });

  it("produces a spill dir that mkdirSync can create (the ENOTDIR reproduction)", () => {
    const { jsonlPath } = makeSessionTree();
    const spillDir = toolResultsDirFromSessionPath(jsonlPath);

    // Pre-patch: spillDir === `…/web-user.jsonl/tool-results` → ENOTDIR here.
    expect(() => mkdirSync(spillDir, { recursive: true })).not.toThrow();
    expect(existsSync(spillDir)).toBe(true);
    expect(statSync(spillDir).isDirectory()).toBe(true);
  });
});
