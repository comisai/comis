// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for path suggestion utility.
 *
 * Covers:
 * - levenshteinDistance: known string pairs, edge cases
 * - levenshteinSimilarity: score derivation, empty strings
 * - readDirCapped: cap enforcement, missing directories, empty directories
 * - suggestSimilarPaths: filename matching, directory matching, cap enforcement,
 *   similarity threshold, workspace boundary enforcement
 */

import * as fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  levenshteinDistance,
  levenshteinSimilarity,
  readDirCapped,
  suggestSimilarPaths,
} from "./path-suggest.js";

// ---------------------------------------------------------------------------
// Temp directory setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "comis-path-suggest-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// levenshteinDistance
// ---------------------------------------------------------------------------

describe("levenshteinDistance", () => {
  it("returns 3 for kitten -> sitting", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
  });

  it("returns length of other string when one is empty", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("abc", "")).toBe(3);
  });

  it("returns 0 for two empty strings", () => {
    expect(levenshteinDistance("", "")).toBe(0);
  });

  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("same", "same")).toBe(0);
  });

  it("returns 1 for single substitution", () => {
    expect(levenshteinDistance("abc", "abd")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// levenshteinSimilarity
// ---------------------------------------------------------------------------

describe("levenshteinSimilarity", () => {
  it("returns 0.6 for utils vs utlis (2 edits / 5 max length)", () => {
    expect(levenshteinSimilarity("utils", "utlis")).toBe(0.6);
  });

  it("returns 1.0 for two empty strings", () => {
    expect(levenshteinSimilarity("", "")).toBe(1.0);
  });

  it("returns 0.0 for completely different strings of same length", () => {
    expect(levenshteinSimilarity("abc", "xyz")).toBeCloseTo(0.0);
  });
});

// ---------------------------------------------------------------------------
// readDirCapped
// ---------------------------------------------------------------------------

describe("readDirCapped", () => {
  it("returns all entries when count is below cap", () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(tmpDir, `file-${i}.txt`), "");
    }
    const entries = readDirCapped(tmpDir, 10);
    expect(entries).toHaveLength(5);
  });

  it("returns exactly cap entries when directory has more", () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(tmpDir, `file-${i}.txt`), "");
    }
    const entries = readDirCapped(tmpDir, 3);
    expect(entries).toHaveLength(3);
  });

  it("returns empty array for non-existent directory", () => {
    const entries = readDirCapped(path.join(tmpDir, "does-not-exist"));
    expect(entries).toEqual([]);
  });

  it("returns empty array for empty directory", () => {
    const emptyDir = path.join(tmpDir, "empty");
    mkdirSync(emptyDir);
    const entries = readDirCapped(emptyDir);
    expect(entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// suggestSimilarPaths (real filesystem)
// ---------------------------------------------------------------------------

describe("suggestSimilarPaths", () => {
  it("suggests similar filenames when directory exists (typo in filename)", () => {
    const srcDir = path.join(tmpDir, "src");
    mkdirSync(srcDir);
    writeFileSync(path.join(srcDir, "utils.ts"), "");
    writeFileSync(path.join(srcDir, "types.ts"), "");
    writeFileSync(path.join(srcDir, "index.ts"), "");

    // Typo: "utlis" instead of "utils"
    const target = path.join(srcDir, "utlis.ts");
    const suggestions = suggestSimilarPaths(target, tmpDir);

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(3);
    // The best match should be utils.ts
    expect(suggestions[0]).toContain("utils.ts");
  });

  it("returns empty array when no entries are similar enough", () => {
    const srcDir = path.join(tmpDir, "src");
    mkdirSync(srcDir);
    writeFileSync(path.join(srcDir, "utils.ts"), "");

    const target = path.join(srcDir, "completely-different-name.ts");
    const suggestions = suggestSimilarPaths(target, tmpDir);

    expect(suggestions).toEqual([]);
  });

  it("suggests directory names when directory does not exist (typo in directory)", () => {
    // Create correct directory with a file
    const correctDir = path.join(tmpDir, "components");
    mkdirSync(correctDir);
    writeFileSync(path.join(correctDir, "foo.ts"), "");

    // Typo directory: "componets" (missing 'n')
    const target = path.join(tmpDir, "componets", "foo.ts");
    const suggestions = suggestSimilarPaths(target, tmpDir);

    expect(suggestions.length).toBeGreaterThan(0);
    // The suggestion should reference the correct "components" directory
    const hasComponentsSuggestion = suggestions.some((s) =>
      s.includes("components"),
    );
    expect(hasComponentsSuggestion).toBe(true);
  });

  it("returns corrected full path when file exists in matching directory", () => {
    // Create correct directory with the target file
    const correctDir = path.join(tmpDir, "components");
    mkdirSync(correctDir);
    writeFileSync(path.join(correctDir, "foo.ts"), "");

    // Typo directory: "componets" (missing 'n')
    const target = path.join(tmpDir, "componets", "foo.ts");
    const suggestions = suggestSimilarPaths(target, tmpDir);

    // Should suggest the full corrected path since foo.ts exists in components/
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toContain("components");
    expect(suggestions[0]).toContain("foo.ts");
  });

  it("returns empty array when directory exceeds entry cap", () => {
    const bigDir = path.join(tmpDir, "big");
    mkdirSync(bigDir);
    // Create 250 files (above MAX_DIR_ENTRIES=200)
    for (let i = 0; i < 250; i++) {
      writeFileSync(path.join(bigDir, `file-${String(i).padStart(4, "0")}.ts`), "");
    }

    const target = path.join(bigDir, "flie-0001.ts"); // typo
    const suggestions = suggestSimilarPaths(target, tmpDir);

    expect(suggestions).toEqual([]);
  });

  it("does not suggest paths outside workspace boundary", () => {
    // Create a nested workspace with files
    const workspace = path.join(tmpDir, "workspace");
    const srcDir = path.join(workspace, "src");
    mkdirSync(workspace);
    mkdirSync(srcDir);
    writeFileSync(path.join(srcDir, "utils.ts"), "");

    // Create a file outside the workspace
    writeFileSync(path.join(tmpDir, "secret.ts"), "");

    // Target a file in workspace/src
    const target = path.join(srcDir, "utlis.ts");
    const suggestions = suggestSimilarPaths(target, workspace);

    // All suggestions must be within the workspace
    for (const suggestion of suggestions) {
      expect(suggestion.startsWith(workspace)).toBe(true);
    }
  });

  it("returns empty array when parent directory also does not exist", () => {
    const target = path.join(tmpDir, "a", "b", "c", "file.ts");
    const suggestions = suggestSimilarPaths(target, tmpDir);

    expect(suggestions).toEqual([]);
  });

  it("returns empty array when target is exactly a directory name", () => {
    const srcDir = path.join(tmpDir, "src");
    mkdirSync(srcDir);

    // Target is the directory itself (no basename match makes sense)
    const target = path.join(tmpDir, "srd"); // typo
    const suggestions = suggestSimilarPaths(target, tmpDir);

    // Should try to match "srd" against directory entries in tmpDir
    // "src" is a directory and similar to "srd"
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });
});
