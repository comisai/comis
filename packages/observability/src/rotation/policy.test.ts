// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for applyRotationPolicy.
 *
 * All tests use an isolated tmpdir per test case so parallel Vitest workers
 * never share file state.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyRotationPolicy, type RotationPolicy } from "./policy.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-rotation-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const defaultPolicy: RotationPolicy = {
  maxSizeBytes: 50 * 1024 * 1024,
  maxFiles: 5,
  maxAgeDays: 30,
  compressAged: true,
};

function writeFile(dir: string, name: string, sizeBytes: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(sizeBytes, 0x58)); // 'X' bytes
  return p;
}

function setMtime(filePath: string, daysAgo: number): void {
  const nowMs = Date.now();
  const mtimeMs = nowMs - daysAgo * 86_400_000;
  const mtimeSec = mtimeMs / 1000;
  fs.utimesSync(filePath, mtimeSec, mtimeSec);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyRotationPolicy", () => {
  it("compresses an aged .N file — daemon.1.log becomes daemon.1.log.gz", async () => {
    const basePath = path.join(tmpDir, "daemon.log");
    const rotatedPath = path.join(tmpDir, "daemon.1.log");

    // Write 60 MB of data to the rotated file.
    const content = Buffer.alloc(60 * 1024 * 1024, 0x58);
    fs.writeFileSync(rotatedPath, content);

    await applyRotationPolicy(
      { basePath, rotatedFiles: [rotatedPath], policy: defaultPolicy },
    );

    const gzPath = rotatedPath + ".gz";
    expect(fs.existsSync(gzPath), "gzip file should exist").toBe(true);
    expect(fs.existsSync(rotatedPath), "original .log should be removed").toBe(false);

    // Verify gzip is valid and round-trips to the original length.
    const gz = fs.readFileSync(gzPath);
    const decompressed = zlib.gunzipSync(gz);
    expect(decompressed.length).toBe(content.length);
  });

  it("removes files older than maxAgeDays via age-prune", async () => {
    const basePath = path.join(tmpDir, "daemon.log");
    const oldGz = path.join(tmpDir, "daemon.2.log.gz");

    fs.writeFileSync(oldGz, Buffer.alloc(100, 0x58));
    setMtime(oldGz, 31); // 31 days old — beyond maxAgeDays=30

    await applyRotationPolicy(
      { basePath, rotatedFiles: [oldGz], policy: defaultPolicy },
    );

    expect(fs.existsSync(oldGz), "file older than maxAgeDays should be unlinked").toBe(false);
  });

  it("keeps files within maxAgeDays", async () => {
    const basePath = path.join(tmpDir, "daemon.log");
    const recentGz = path.join(tmpDir, "daemon.2.log.gz");

    fs.writeFileSync(recentGz, Buffer.alloc(100, 0x58));
    setMtime(recentGz, 29); // 29 days old — within maxAgeDays=30

    await applyRotationPolicy(
      { basePath, rotatedFiles: [recentGz], policy: defaultPolicy },
    );

    expect(fs.existsSync(recentGz), "file within maxAgeDays should be kept").toBe(true);
  });

  it("unlinks files beyond maxFiles count (oldest-first by mtime)", async () => {
    const basePath = path.join(tmpDir, "daemon.log");
    const policy: RotationPolicy = { ...defaultPolicy, maxFiles: 5, compressAged: false };

    // Create 7 rotated files with different mtimes.
    const files: string[] = [];
    for (let i = 1; i <= 7; i++) {
      const p = path.join(tmpDir, `daemon.${i}.log.gz`);
      fs.writeFileSync(p, Buffer.alloc(100, 0x58));
      setMtime(p, 7 - i + 1); // file 1 is oldest (7 days), file 7 is newest (1 day)
      files.push(p);
    }

    await applyRotationPolicy({ basePath, rotatedFiles: files, policy });

    // With maxFiles=5, the 2 oldest files (daemon.1.log.gz, daemon.2.log.gz) should be unlinked.
    expect(fs.existsSync(files[0]!), "oldest file 1 should be unlinked").toBe(false);
    expect(fs.existsSync(files[1]!), "oldest file 2 should be unlinked").toBe(false);
    // The 5 newest should remain.
    for (let i = 2; i <= 6; i++) {
      expect(fs.existsSync(files[i]!), `file ${i + 1} should remain`).toBe(true);
    }
  });

  it("never touches the active base file", async () => {
    const basePath = path.join(tmpDir, "daemon.log");
    const policy: RotationPolicy = { ...defaultPolicy, compressAged: true };

    // Write the active base file with some content.
    const originalContent = "active log content";
    fs.writeFileSync(basePath, originalContent);

    // No rotated siblings — nothing else to process.
    await applyRotationPolicy({ basePath, rotatedFiles: [], policy });

    // The base file must be untouched.
    expect(fs.existsSync(basePath), "base file should still exist").toBe(true);
    expect(fs.readFileSync(basePath, "utf8")).toBe(originalContent);
    expect(fs.existsSync(basePath + ".gz"), "base file must NOT be gzipped").toBe(false);
  });

  it("skips gzip but still age-prunes when compressAged=false", async () => {
    const policy: RotationPolicy = { ...defaultPolicy, compressAged: false };
    const basePath = path.join(tmpDir, "daemon.log");
    const rotatedPath = path.join(tmpDir, "daemon.1.log");

    fs.writeFileSync(rotatedPath, Buffer.alloc(1024, 0x58));

    await applyRotationPolicy({ basePath, rotatedFiles: [rotatedPath], policy });

    // File should NOT be gzipped.
    expect(fs.existsSync(rotatedPath + ".gz"), "should NOT create .gz when compressAged=false").toBe(false);
    // File should remain (not old enough to age-prune).
    expect(fs.existsSync(rotatedPath), "uncompressed file should remain when compressAged=false").toBe(true);
  });

  it("skips symlinks without crashing (lstat gate)", async () => {
    const basePath = path.join(tmpDir, "daemon.log");
    const symlinkPath = path.join(tmpDir, "daemon.1.log");

    // Create a symlink pointing to a non-existent target.
    try {
      fs.symlinkSync("/etc/passwd", symlinkPath);
    } catch {
      // If symlink creation fails (e.g., permissions), skip the test body.
      return;
    }

    // Should not throw; symlink should be skipped.
    await expect(
      applyRotationPolicy({ basePath, rotatedFiles: [symlinkPath], policy: defaultPolicy }),
    ).resolves.not.toThrow();

    // The symlink should still exist (not unlinked).
    expect(fs.existsSync(symlinkPath)).toBe(true);
  });
});
