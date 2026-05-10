// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for buildBackupFilename + writeBackup.
 *
 * Covers:
 *   - Exact filename for fixed Date + fixed rng (regex sanity)
 *   - Default-args filename matches the backup-name regex
 *   - writeBackup happy path — backup file under ~/.comis/, ok({ backupPath })
 *   - Backup contents are byte-equal to source
 *   - Backup file mode is 0o600
 *   - Source-read failure surfaces as SOURCE_READ_FAILED
 *   - Backup-write failure surfaces as BACKUP_WRITE_FAILED (source untouched)
 *   - Backup is written under safePath(homeDir, ".comis", filename)
 *
 * Same ESM mocking pattern as atomic-write.test.ts: replace node:fs with
 * a wrapper that defaults to the real impl and override per-test.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    statSync: actual.statSync,
    mkdtempSync: actual.mkdtempSync,
    mkdirSync: actual.mkdirSync,
    existsSync: actual.existsSync,
    rmSync: actual.rmSync,
  };
});

const fs = await import("node:fs");
const os = await import("node:os");
const { join } = await import("node:path");
const { buildBackupFilename, writeBackup } = await import("./backup.js");

const D10_REGEX =
  /^config\.pre-sync-tooling-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}-[0-9a-f]{6}\.yaml$/;

describe("buildBackupFilename", () => {
  it("returns the exact filename for a fixed Date + fixed rng", () => {
    const filename = buildBackupFilename(
      new Date("2026-05-10T12:34:56.789Z"),
      () => "a3f2c1",
    );
    expect(filename).toBe(
      "config.pre-sync-tooling-2026-05-10T12-34-56.789-a3f2c1.yaml",
    );
  });

  it("returns a filename matching the regex with default args", () => {
    const filename = buildBackupFilename();
    expect(filename).toMatch(D10_REGEX);
  });
});

describe("writeBackup", () => {
  let homeDir: string;
  let configDir: string;
  let configPath: string;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
    vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync);

    // Create a sandboxed home dir with ~/.comis/ already present so that
    // safePath can resolve under it.
    // eslint-disable-next-line no-restricted-syntax -- test code: path.join inside test, not src
    homeDir = fs.mkdtempSync(join(os.tmpdir(), "sync-tooling-backup-home-"));
    // eslint-disable-next-line no-restricted-syntax -- test code: path.join inside test, not src
    configDir = join(homeDir, ".comis");
    fs.mkdirSync(configDir, { mode: 0o700 });
    // eslint-disable-next-line no-restricted-syntax -- test code: path.join inside test, not src
    configPath = join(configDir, "config.yaml");
    fs.writeFileSync(configPath, "gateway:\n  port: 4766\n", { mode: 0o600 });
  });

  afterEach(() => {
    try {
      fs.rmSync(homeDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.clearAllMocks();
  });

  it("writes the backup under homeDir/.comis/ and returns ok({ backupPath })", () => {
    const result = writeBackup(configPath, homeDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.backupPath.startsWith(configDir + "/")).toBe(true);
      expect(fs.existsSync(result.value.backupPath)).toBe(true);
    }
  });

  it("writes a backup that is byte-equal to the source file", () => {
    const source = fs.readFileSync(configPath);

    const result = writeBackup(configPath, homeDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const backup = fs.readFileSync(result.value.backupPath);
      expect(Buffer.compare(source, backup)).toBe(0);
    }
  });

  it("creates the backup with mode 0o600", () => {
    const result = writeBackup(configPath, homeDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const mode = fs.statSync(result.value.backupPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("returns err({ code: 'SOURCE_READ_FAILED' }) when configPath does not exist", () => {
    // eslint-disable-next-line no-restricted-syntax -- test code: path.join inside test, not src
    const missing = join(configDir, "does-not-exist.yaml");

    const result = writeBackup(missing, homeDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SOURCE_READ_FAILED");
      if (result.error.code === "SOURCE_READ_FAILED") {
        expect(result.error.path).toBe(missing);
        expect(result.error.cause.toLowerCase()).toContain("enoent");
      }
    }
  });

  it("returns err({ code: 'BACKUP_WRITE_FAILED' }) on ENOSPC; source unchanged", () => {
    const sourceMtimeBefore = fs.statSync(configPath).mtimeMs;
    const sourceBytesBefore = fs.readFileSync(configPath);

    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      const e = new Error("ENOSPC: no space left on device") as Error & {
        code?: string;
      };
      e.code = "ENOSPC";
      throw e;
    });

    const result = writeBackup(configPath, homeDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("BACKUP_WRITE_FAILED");
      if (result.error.code === "BACKUP_WRITE_FAILED") {
        expect(result.error.cause.toLowerCase()).toContain("enospc");
      }
    }

    // Source must be byte-equal AND have an unchanged mtime.
    const sourceBytesAfter = fs.readFileSync(configPath);
    expect(Buffer.compare(sourceBytesBefore, sourceBytesAfter)).toBe(0);
    expect(fs.statSync(configPath).mtimeMs).toBe(sourceMtimeBefore);
  });

  it("writes the backup under homeDir/.comis/ (safePath-resolved)", () => {
    const result = writeBackup(configPath, homeDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The backup path must start with homeDir/.comis/ (which is configDir).
      expect(result.value.backupPath.startsWith(configDir + "/")).toBe(true);
      // And the filename portion must match the backup-name regex.
      const filename = result.value.backupPath.slice(configDir.length + 1);
      expect(filename).toMatch(D10_REGEX);
    }
  });

  it("buildBackupFilename with custom prefix uses tooling-fill literal", () => {
    const filename = buildBackupFilename(
      new Date("2026-05-10T12:34:56.789Z"),
      () => "a3f2c1",
      "tooling-fill",
    );
    expect(filename).toBe(
      "config.pre-tooling-fill-2026-05-10T12-34-56.789-a3f2c1.yaml",
    );
  });

  // Regression-fence: the literal "config.pre-tooling-fill-" prefix below
  // must appear in the basename — anchors the tooling-fill backup-naming
  // contract. Both the regex and the literal startsWith check guard against
  // accidental drift back to "config.pre-sync-tooling-".
  it("writeBackup with prefix='tooling-fill' writes the renamed file", () => {
    const result = writeBackup(configPath, homeDir, "tooling-fill");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const basename = result.value.backupPath.slice(configDir.length + 1);
      expect(basename.startsWith("config.pre-tooling-fill-")).toBe(true);
      expect(basename).toMatch(/^config\.pre-tooling-fill-.*\.yaml$/);
      expect(fs.existsSync(result.value.backupPath)).toBe(true);
      const mode = fs.statSync(result.value.backupPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});
