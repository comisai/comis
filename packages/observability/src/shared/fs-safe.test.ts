// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it, expect } from "vitest";

import {
  appendRegularFile,
  writeRegularFile,
  SymlinkParentRejected,
  FileSizeLimitExceeded,
  PathEscapesConfinementError,
} from "./fs-safe.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("appendRegularFile — happy path", () => {
  it("creates a new file and appends bytes with mode 0o600", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-happy-"));
    const target = path.join(tmpDir, "out.jsonl");

    const result = appendRegularFile({
      path: target,
      content: "line one\n",
    });

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("line one\n");
    const stat = fs.statSync(target);
    // mask out file-type bits and check permission bits == 0o600
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("appends to an existing file on a subsequent call without overwriting", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-append-"));
    const target = path.join(tmpDir, "out.jsonl");

    const r1 = appendRegularFile({ path: target, content: "first\n" });
    expect(r1.ok).toBe(true);
    const r2 = appendRegularFile({ path: target, content: "second\n" });
    expect(r2.ok).toBe(true);

    expect(fs.readFileSync(target, "utf8")).toBe("first\nsecond\n");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("returns the new total file size in bytes on success", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-size-"));
    const target = path.join(tmpDir, "out.jsonl");

    const r1 = appendRegularFile({ path: target, content: "abc" });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.totalBytes).toBe(3);

    const r2 = appendRegularFile({ path: target, content: "defg" });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.totalBytes).toBe(7);
  });
});

describe("appendRegularFile — symlink parent rejection", () => {
  it("returns SymlinkParentRejected when the immediate parent is a symlink", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-symlink-"));
    const realDir = path.join(tmpDir, "real");
    const linkDir = path.join(tmpDir, "evil-link");
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, linkDir);

    const target = path.join(linkDir, "out.jsonl");
    const result = appendRegularFile({ path: target, content: "x" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SymlinkParentRejected);
      expect(result.error.code).toBe("SYMLINK_PARENT_REJECTED");
    }
  });

  it("succeeds when the parent is a real directory (control)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-symlink-control-"));
    const realDir = path.join(tmpDir, "real");
    fs.mkdirSync(realDir);
    const target = path.join(realDir, "out.jsonl");

    const result = appendRegularFile({ path: target, content: "y" });
    expect(result.ok).toBe(true);
  });
});

describe("appendRegularFile — file size limit", () => {
  it("returns FileSizeLimitExceeded when the append would exceed maxFileBytes", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-limit-"));
    const target = path.join(tmpDir, "out.jsonl");

    const r1 = appendRegularFile({
      path: target,
      content: "12345",
      maxFileBytes: 10,
    });
    expect(r1.ok).toBe(true);

    const r2 = appendRegularFile({
      path: target,
      content: "67890ZZZ",
      maxFileBytes: 10,
    });

    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error).toBeInstanceOf(FileSizeLimitExceeded);
      expect(r2.error.code).toBe("FILE_SIZE_LIMIT_EXCEEDED");
      expect(r2.error.attemptedBytes).toBe(13);
      expect(r2.error.maxBytes).toBe(10);
    }
  });

  it("allows an append that lands exactly at maxFileBytes (boundary is strictly greater than)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-boundary-"));
    const target = path.join(tmpDir, "out.jsonl");

    const result = appendRegularFile({
      path: target,
      content: "1234567890",
      maxFileBytes: 10,
    });

    expect(result.ok).toBe(true);
    expect(fs.statSync(target).size).toBe(10);
  });

  it("does NOT enforce a size cap when maxFileBytes is omitted", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-nocap-"));
    const target = path.join(tmpDir, "out.jsonl");
    const result = appendRegularFile({
      path: target,
      content: "long".repeat(1000),
    });
    expect(result.ok).toBe(true);
  });
});

describe("appendRegularFile — defensive chmod 0o600 even when file already exists", () => {
  it("forces mode 0o600 on an existing file that had wider permissions", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-chmod-"));
    const target = path.join(tmpDir, "out.jsonl");
    // Pre-create with mode 0o644 (looser than 0o600).
    fs.writeFileSync(target, "existing\n", { mode: 0o644 });
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);

    const result = appendRegularFile({ path: target, content: "more\n" });
    expect(result.ok).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// Plan 45-gap-01 Task 1: writeRegularFile (symlink-safe write-truncate)
// ---------------------------------------------------------------------------
describe("writeRegularFile — happy path", () => {
  it("creates a new file with mode 0o600 and the given content", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-write-happy-"));
    const target = path.join(tmpDir, "out.tmp");

    const result = writeRegularFile({ path: target, content: "data" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.totalBytes).toBe(4);
    expect(fs.readFileSync(target, "utf8")).toBe("data");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("truncates on rewrite (does NOT append)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-write-truncate-"));
    const target = path.join(tmpDir, "out.tmp");

    const r1 = writeRegularFile({ path: target, content: "first" });
    expect(r1.ok).toBe(true);
    const r2 = writeRegularFile({ path: target, content: "second" });
    expect(r2.ok).toBe(true);

    expect(fs.readFileSync(target, "utf8")).toBe("second");
    if (r2.ok) expect(r2.value.totalBytes).toBe(6);
  });

  it("with default unlinkExisting=true, a pre-staged symlink at the target is replaced; the symlink target is NOT followed", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-write-symlink-"));
    const target = path.join(tmpDir, "out.tmp");
    const sentinel = path.join(tmpDir, "sentinel");

    // Pre-stage attacker symlink: <target> -> <sentinel>.
    fs.writeFileSync(sentinel, ""); // create empty sentinel
    fs.symlinkSync(sentinel, target);

    const result = writeRegularFile({ path: target, content: "safe" });
    expect(result.ok).toBe(true);

    // The sentinel file MUST remain untouched (proving we did NOT follow the symlink).
    expect(fs.readFileSync(sentinel, "utf8")).toBe("");

    // The target is now a regular file (lstat shows non-symlink) with our content.
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("safe");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("with unlinkExisting=false and an existing regular file, truncates and rewrites with mode 0o600", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-write-existing-"));
    const target = path.join(tmpDir, "out.tmp");
    fs.writeFileSync(target, "original", { mode: 0o644 });

    const result = writeRegularFile({ path: target, content: "new", unlinkExisting: false });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("new");
    // Defensive chmod forces 0o600 even when prior file was 0o644.
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("with unlinkExisting=true and no existing file, succeeds (ENOENT on unlink is ignored)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-write-noent-"));
    const target = path.join(tmpDir, "out.tmp");
    // target does not exist
    const result = writeRegularFile({ path: target, content: "x" });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("x");
  });
});

describe("writeRegularFile — symlink parent rejection", () => {
  it("returns SymlinkParentRejected when the immediate parent is a symlink", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-write-symparent-"));
    const realDir = path.join(tmpDir, "real");
    const linkDir = path.join(tmpDir, "evil-link");
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, linkDir);

    const target = path.join(linkDir, "out.tmp");
    const result = writeRegularFile({ path: target, content: "x" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SymlinkParentRejected);
    }
  });
});

// ---------------------------------------------------------------------------
// Plan 45.1-03 Task 3: H1 confinedBaseDir ancestor-escape rejection.
//
// The existing `SymlinkParentRejected` rule only catches a symlinked
// IMMEDIATE parent of the target. An attacker controlling a grandparent
// (or any higher ancestor) can pre-stage a symlink there; the kernel
// follows the ancestor symlink during normal path-walk and O_NOFOLLOW
// only inspects the final component. The opt-in `confinedBaseDir` option
// closes the ancestor gap: when supplied, after the parent-lstat check
// passes, the helper runs realpathSync(target) (or the parent when the
// target doesn't yet exist) and asserts the resolved path stays inside
// realpathSync(confinedBaseDir).
//
// Per RESEARCH.md §3 H1 row.
// ---------------------------------------------------------------------------
describe("appendRegularFile — confined-base-dir ancestor escape rejection (TRAJ-FIX-01)", () => {
  it("rejects when an ancestor (not the immediate parent) is a symlink escaping the base", () => {
    // Build: base/  base/evil -> escape-target/
    // target = base/evil/writes.txt  resolves to escape-target/writes.txt
    // The immediate parent of writes.txt (base/evil) is a symlink, but
    // we're testing the confinement check (the existing symlink-parent
    // rejection would also fire here — see the next test for the
    // grandparent-only attack that the existing check MISSES).
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-confine-anc-"));
    const baseDir = path.join(tmpDir, "base");
    const escapeTarget = path.join(tmpDir, "escape-target");
    fs.mkdirSync(baseDir, { recursive: true });
    fs.mkdirSync(escapeTarget, { recursive: true });

    const evilParent = path.join(baseDir, "evil");
    fs.symlinkSync(escapeTarget, evilParent);
    const target = path.join(evilParent, "writes.txt");

    const result = appendRegularFile({
      path: target,
      content: "x",
      confinedBaseDir: baseDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Either rejection is acceptable: the symlinked-parent check fires
      // first today, and the confinement check fires for the deeper
      // ancestor variant below. Both are correctness wins.
      expect(
        result.error instanceof PathEscapesConfinementError ||
          result.error instanceof SymlinkParentRejected,
      ).toBe(true);
    }
  });

  it("rejects via realpath when the GRANDPARENT is the symlink (the immediate parent is real)", () => {
    // Critical case: the existing SymlinkParentRejected check only
    // lstats the IMMEDIATE parent. Build a chain where the immediate
    // parent is a real directory but a grandparent escapes.
    //   escape-target/ + escape-target/inner/  (real dirs)
    //   base/evil-grandparent -> escape-target/  (symlink)
    //   target = base/evil-grandparent/inner/writes.txt
    //     immediate parent  = base/evil-grandparent/inner  (NOT a symlink)
    //     grandparent       = base/evil-grandparent        (IS a symlink)
    //     resolves to       = escape-target/inner/writes.txt (OUTSIDE base)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-confine-gp-"));
    const escapeTarget = path.join(tmpDir, "escape-target");
    fs.mkdirSync(escapeTarget, { recursive: true });
    const realInner = path.join(escapeTarget, "inner");
    fs.mkdirSync(realInner, { recursive: true });

    const baseDir = path.join(tmpDir, "g-base");
    fs.mkdirSync(baseDir, { recursive: true });
    const evilGrandparent = path.join(baseDir, "evil-grandparent");
    fs.symlinkSync(escapeTarget, evilGrandparent);

    const target = path.join(evilGrandparent, "inner", "writes.txt");
    // Sanity: the immediate parent IS a real directory (via realpath),
    // so the existing SymlinkParentRejected check would NOT fire here.
    expect(fs.lstatSync(path.dirname(target)).isSymbolicLink()).toBe(false);

    const result = appendRegularFile({
      path: target,
      content: "x",
      confinedBaseDir: baseDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(PathEscapesConfinementError);
    }
  });

  it("accepts when the resolved path stays inside the base (positive case)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-confine-ok-"));
    const baseDir = path.join(tmpDir, "ok-base");
    fs.mkdirSync(path.join(baseDir, "sub"), { recursive: true });
    const target = path.join(baseDir, "sub", "writes.txt");

    const result = appendRegularFile({
      path: target,
      content: "x\n",
      confinedBaseDir: baseDir,
    });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("x\n");
  });

  it("accepts when no confinedBaseDir is supplied (back-compat for non-observability callers)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-confine-nocap-"));
    const target = path.join(tmpDir, "free.txt");
    // No confinedBaseDir — option is opt-in. Existing callers must
    // continue to work without it.
    const result = appendRegularFile({ path: target, content: "x\n" });
    expect(result.ok).toBe(true);
  });

  it("accepts when the target equals the base dir itself (boundary)", () => {
    // Edge case: a file directly at the base dir. The check uses
    // `targetResolved === baseResolved || targetResolved.startsWith(baseResolved + path.sep)`,
    // so a same-prefix file like `<base>-evil/x` must NOT match.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-confine-boundary-"));
    const baseDir = path.join(tmpDir, "base");
    fs.mkdirSync(baseDir, { recursive: true });
    const target = path.join(baseDir, "writes.txt");

    const result = appendRegularFile({
      path: target,
      content: "x",
      confinedBaseDir: baseDir,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a sibling-prefix path that would naively startsWith match (boundary safety)", () => {
    // Build: tmpDir/base + tmpDir/base-evil  (sibling, NOT inside base).
    // Naive `startsWith(base)` would accept tmpDir/base-evil/x because
    // "/tmp/.../base-evil/x".startsWith("/tmp/.../base") is true. The
    // correct check requires `base + path.sep` boundary.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-confine-sibling-"));
    const baseDir = path.join(tmpDir, "base");
    fs.mkdirSync(baseDir, { recursive: true });
    const siblingDir = path.join(tmpDir, "base-evil");
    fs.mkdirSync(siblingDir, { recursive: true });
    const target = path.join(siblingDir, "writes.txt");

    const result = appendRegularFile({
      path: target,
      content: "x",
      confinedBaseDir: baseDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(PathEscapesConfinementError);
    }
  });
});

describe("writeRegularFile — confined-base-dir ancestor escape rejection (TRAJ-FIX-01)", () => {
  it("rejects via realpath when the GRANDPARENT is the symlink (the immediate parent is real)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-write-confine-gp-"));
    const escapeTarget = path.join(tmpDir, "escape-target");
    fs.mkdirSync(escapeTarget, { recursive: true });
    const realInner = path.join(escapeTarget, "inner");
    fs.mkdirSync(realInner, { recursive: true });

    const baseDir = path.join(tmpDir, "g-base");
    fs.mkdirSync(baseDir, { recursive: true });
    const evilGrandparent = path.join(baseDir, "evil-grandparent");
    fs.symlinkSync(escapeTarget, evilGrandparent);

    const target = path.join(evilGrandparent, "inner", "writes.txt");
    expect(fs.lstatSync(path.dirname(target)).isSymbolicLink()).toBe(false);

    const result = writeRegularFile({
      path: target,
      content: "x",
      confinedBaseDir: baseDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(PathEscapesConfinementError);
    }
  });

  it("accepts when the resolved path stays inside the base (positive case)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-write-confine-ok-"));
    const baseDir = path.join(tmpDir, "ok-base");
    fs.mkdirSync(path.join(baseDir, "sub"), { recursive: true });
    const target = path.join(baseDir, "sub", "writes.txt");

    const result = writeRegularFile({
      path: target,
      content: "data",
      confinedBaseDir: baseDir,
    });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("data");
  });

  it("accepts when no confinedBaseDir is supplied (back-compat)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-write-confine-nocap-"));
    const target = path.join(tmpDir, "free.tmp");
    const result = writeRegularFile({ path: target, content: "y" });
    expect(result.ok).toBe(true);
  });

  it("rejects a sibling-prefix path that would naively startsWith match (boundary safety)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-write-confine-sibling-"));
    const baseDir = path.join(tmpDir, "base");
    fs.mkdirSync(baseDir, { recursive: true });
    const siblingDir = path.join(tmpDir, "base-evil");
    fs.mkdirSync(siblingDir, { recursive: true });
    const target = path.join(siblingDir, "writes.tmp");

    const result = writeRegularFile({
      path: target,
      content: "x",
      confinedBaseDir: baseDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(PathEscapesConfinementError);
    }
  });
});
