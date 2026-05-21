// SPDX-License-Identifier: Apache-2.0
/**
 * `readFileSnapshot` behavior tests.
 *
 * Five cases:
 *   - returns_full_snapshot_for_existing_file
 *   - returns_null_for_missing_file
 *   - returns_null_for_directory_not_a_file
 *   - hash_is_deterministic_for_identical_content
 *   - dev_and_ino_are_stringified_other_stat_fields_are_numbers
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFileSnapshot } from "./file-snapshot.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "comis-file-snapshot-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("readFileSnapshot -- existing files", () => {
  it("returns_full_snapshot_for_existing_file with hash + stat fields populated", () => {
    const filePath = join(tmpDir, "config.yaml");
    const body = "logging:\n  level: info\n";
    writeFileSync(filePath, body, { mode: 0o600 });

    const snap = readFileSnapshot(filePath);
    expect(snap).not.toBeNull();
    expect(snap!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(snap!.bytes).toBe(Buffer.byteLength(body, "utf-8"));
    expect(typeof snap!.mtimeMs).toBe("number");
    expect(typeof snap!.ctimeMs).toBe("number");
    expect(typeof snap!.dev).toBe("string");
    expect(typeof snap!.ino).toBe("string");
    expect(typeof snap!.mode).toBe("number");
    expect(typeof snap!.nlink).toBe("number");
    expect(typeof snap!.uid).toBe("number");
    expect(typeof snap!.gid).toBe("number");
  });
});

describe("readFileSnapshot -- missing / non-file paths", () => {
  it("returns_null_for_missing_file (does not throw on ENOENT)", () => {
    const missing = join(tmpDir, "does-not-exist.yaml");
    expect(readFileSnapshot(missing)).toBeNull();
  });

  it("returns_null_for_directory_not_a_file (defensive — caller should branch exists:false)", () => {
    const subdir = join(tmpDir, "a-directory");
    mkdirSync(subdir);
    expect(readFileSnapshot(subdir)).toBeNull();
  });
});

describe("readFileSnapshot -- determinism", () => {
  it("hash_is_deterministic_for_identical_content across two file paths", () => {
    const body = "the same content\n";
    const a = join(tmpDir, "a.yaml");
    const b = join(tmpDir, "b.yaml");
    writeFileSync(a, body, { mode: 0o600 });
    writeFileSync(b, body, { mode: 0o600 });

    const snapA = readFileSnapshot(a);
    const snapB = readFileSnapshot(b);
    expect(snapA).not.toBeNull();
    expect(snapB).not.toBeNull();
    expect(snapA!.hash).toBe(snapB!.hash);
    expect(snapA!.bytes).toBe(snapB!.bytes);
  });
});

describe("readFileSnapshot -- field types", () => {
  it("dev_and_ino_are_stringified_other_stat_fields_are_numbers (design §9.2 contract)", () => {
    const filePath = join(tmpDir, "f.yaml");
    writeFileSync(filePath, "x", { mode: 0o600 });

    const snap = readFileSnapshot(filePath);
    expect(snap).not.toBeNull();
    // dev / ino: string (safe-integer overflow protection)
    expect(typeof snap!.dev).toBe("string");
    expect(typeof snap!.ino).toBe("string");
    // Other POSIX numeric fields: number
    expect(Number.isInteger(snap!.mode)).toBe(true);
    expect(Number.isInteger(snap!.nlink)).toBe(true);
    expect(Number.isInteger(snap!.uid)).toBe(true);
    expect(Number.isInteger(snap!.gid)).toBe(true);
    // mtimeMs / ctimeMs: number (epoch milliseconds)
    expect(typeof snap!.mtimeMs).toBe("number");
    expect(typeof snap!.ctimeMs).toBe("number");
  });
});
