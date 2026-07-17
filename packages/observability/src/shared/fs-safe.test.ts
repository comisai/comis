// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// `chmodSyncThrowsEperm` is a hoisted toggle: when true, the mocked
// `fs.chmodSync` throws an EPERM error. This is the only portable way
// to exercise the chmod-EPERM-non-fatal branch in `ensureContainedDir`
// under ESM (vi.spyOn cannot redefine non-configurable namespace
// properties on `node:fs`). Default false → real chmod runs everywhere
// else in this file (existing tests rely on real chmod behavior).
const { chmodSyncThrowsEperm, fchmodSyncMode, fsyncSyncCalls, writeSyncBehavior } = vi.hoisted(
  () => ({
    chmodSyncThrowsEperm: { value: false },
    // "real" → run real fchmod; "permission-model" → throw the --permission
    // refusal (must be swallowed, file already opened 0o600); "eio" → throw a
    // genuine I/O error (must propagate). Drives the fchmod-disabled guard.
    fchmodSyncMode: { value: "real" as "real" | "permission-model" | "eio" },
    fsyncSyncCalls: { value: 0 },
    writeSyncBehavior: {
      maxBytesPerCall: undefined as number | undefined,
      returnZero: false,
      callCount: 0,
      offsets: [] as number[],
    },
  }),
);

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    chmodSync: (...args: Parameters<typeof real.chmodSync>) => {
      if (chmodSyncThrowsEperm.value) {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }
      return real.chmodSync(...args);
    },
    fchmodSync: (...args: Parameters<typeof real.fchmodSync>) => {
      if (fchmodSyncMode.value === "permission-model") {
        throw new Error(
          "fchmod API is disabled when Permission Model is enabled.",
        );
      }
      if (fchmodSyncMode.value === "eio") {
        throw Object.assign(new Error("EIO: i/o error, fchmod"), {
          code: "EIO",
        });
      }
      return real.fchmodSync(...args);
    },
    fsyncSync: (...args: Parameters<typeof real.fsyncSync>) => {
      fsyncSyncCalls.value += 1;
      return real.fsyncSync(...args);
    },
    writeSync: (
      fd: number,
      buffer: Buffer,
      offset?: number,
      length?: number,
      position?: number | null,
    ): number => {
      if (writeSyncBehavior.maxBytesPerCall === undefined) {
        return real.writeSync(fd, buffer, offset, length, position);
      }
      writeSyncBehavior.callCount += 1;
      const effectiveOffset = offset ?? 0;
      writeSyncBehavior.offsets.push(effectiveOffset);
      if (writeSyncBehavior.returnZero) return 0;

      const effectiveLength = length ?? buffer.length - effectiveOffset;
      return real.writeSync(
        fd,
        buffer,
        effectiveOffset,
        Math.min(effectiveLength, writeSyncBehavior.maxBytesPerCall),
        position,
      );
    },
  };
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  appendRegularFile,
  readRegularFile,
  writeRegularFile,
  ensureContainedDir,
  SymlinkParentRejected,
  FileSizeLimitExceeded,
  PathEscapesConfinementError,
} from "./fs-safe.js";

let tmpDir: string;

afterEach(() => {
  writeSyncBehavior.maxBytesPerCall = undefined;
  writeSyncBehavior.returnZero = false;
  writeSyncBehavior.callCount = 0;
  writeSyncBehavior.offsets.length = 0;
  fsyncSyncCalls.value = 0;
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("fchmod disabled by Node Permission Model (regression: 2026-06-02)", () => {
  // The production daemon runs under `node --permission`, which disables
  // fchmod outright. The defensive `fchmodSync(fd, 0o600)` in both writers
  // must tolerate that refusal (the file was already opened 0o600) instead
  // of failing the write — an unguarded throw here broke MCP OAuth discovery
  // and session-metadata persistence on a live VPS.
  afterEach(() => {
    fchmodSyncMode.value = "real";
  });

  it("writeRegularFile persists content when fchmod is refused by the permission model", () => {
    fchmodSyncMode.value = "permission-model";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-permmodel-w-"));
    const target = path.join(tmpDir, "out.txt");

    const result = writeRegularFile({ path: target, content: "hello world" });

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("hello world");
  });

  it("appendRegularFile persists content when fchmod is refused by the permission model", () => {
    fchmodSyncMode.value = "permission-model";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-permmodel-a-"));
    const target = path.join(tmpDir, "out.jsonl");

    const result = appendRegularFile({ path: target, content: "line one\n" });

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("line one\n");
  });

  it("still returns err on a genuine fchmod I/O error (EIO), not silently swallowed", () => {
    fchmodSyncMode.value = "eio";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-eio-"));
    const target = path.join(tmpDir, "out.txt");

    const result = writeRegularFile({ path: target, content: "x" });

    expect(result.ok).toBe(false);
  });
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

  it("retries partial writes until every requested byte is persisted", () => {
    writeSyncBehavior.maxBytesPerCall = 2;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-partial-write-"));
    const target = path.join(tmpDir, "out.jsonl");

    const result = appendRegularFile({
      path: target,
      content: "complete\n",
    });

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("complete\n");
    expect(writeSyncBehavior.callCount).toBeGreaterThan(1);
    expect(writeSyncBehavior.offsets).toEqual([0, 2, 4, 6, 8]);
  });

  it("returns an error when a write makes no forward progress", () => {
    writeSyncBehavior.maxBytesPerCall = 2;
    writeSyncBehavior.returnZero = true;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-zero-write-"));
    const target = path.join(tmpDir, "out.jsonl");

    const result = appendRegularFile({ path: target, content: "pending\n" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("made no forward progress");
    }
    expect(writeSyncBehavior.callCount).toBe(1);
    expect(fs.readFileSync(target, "utf8")).toBe("");
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
// readRegularFile (symlink-safe bounded read)
// ---------------------------------------------------------------------------
describe("readRegularFile — bounded symlink-safe reads", () => {
  it("uses O_NONBLOCK so a swapped non-regular target cannot stall the daemon", () => {
    const source = fs.readFileSync(new URL("./fs-safe.ts", import.meta.url), "utf8");
    const readFlagsStart = source.indexOf("function resolveReadOpenFlags");
    const readFlagsEnd = source.indexOf("return flags;", readFlagsStart);
    expect(readFlagsStart).toBeGreaterThan(-1);
    expect(source.slice(readFlagsStart, readFlagsEnd)).toContain("O_NONBLOCK");
  });

  it("reads one existing regular file and reports its exact byte length", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-read-happy-"));
    const target = path.join(tmpDir, "trajectory.jsonl");
    fs.writeFileSync(target, "first\nsecond\n", { mode: 0o600 });

    const result = readRegularFile({
      path: target,
      maxFileBytes: 1024,
      confinedBaseDir: tmpDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.content.toString("utf8")).toBe("first\nsecond\n");
    expect(result.value.totalBytes).toBe(13);
  });

  it("rejects a final-component symlink without reading its target", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-read-symlink-"));
    const outside = path.join(tmpDir, "outside.jsonl");
    const target = path.join(tmpDir, "trajectory.jsonl");
    fs.writeFileSync(outside, "sensitive\n", { mode: 0o600 });
    fs.symlinkSync(outside, target);

    const result = readRegularFile({
      path: target,
      maxFileBytes: 1024,
      confinedBaseDir: tmpDir,
    });

    expect(result.ok).toBe(false);
    expect(fs.readFileSync(outside, "utf8")).toBe("sensitive\n");
  });

  it("rejects an escaping ancestor symlink when confinedBaseDir is set", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-read-confine-"));
    const baseDir = path.join(tmpDir, "base");
    const outsideDir = path.join(tmpDir, "outside");
    const outsideInner = path.join(outsideDir, "inner");
    fs.mkdirSync(baseDir, { recursive: true });
    fs.mkdirSync(outsideInner, { recursive: true });
    fs.writeFileSync(path.join(outsideInner, "trajectory.jsonl"), "outside\n");
    fs.symlinkSync(outsideDir, path.join(baseDir, "escape"));

    const result = readRegularFile({
      path: path.join(baseDir, "escape", "inner", "trajectory.jsonl"),
      maxFileBytes: 1024,
      confinedBaseDir: baseDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(PathEscapesConfinementError);
    }
  });

  it("rejects an oversized file before returning any content", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-read-limit-"));
    const target = path.join(tmpDir, "trajectory.jsonl");
    fs.writeFileSync(target, "x".repeat(65), { mode: 0o600 });

    const result = readRegularFile({
      path: target,
      maxFileBytes: 64,
      confinedBaseDir: tmpDir,
    });

    expect(result.ok).toBe(false);
  });

  it("rejects a directory after opening it without returning content", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-read-directory-"));
    const target = path.join(tmpDir, "not-a-file");
    fs.mkdirSync(target);

    const result = readRegularFile({
      path: target,
      maxFileBytes: 1024,
      confinedBaseDir: tmpDir,
    });

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// writeRegularFile (symlink-safe write-truncate)
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

  it("flushes truncate-written bytes before success when requested", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-write-fsync-"));
    const target = path.join(tmpDir, "out.tmp");

    const result = writeRegularFile({
      path: target,
      content: "durable",
      fsyncBeforeSuccess: true,
    });

    expect(result.ok).toBe(true);
    expect(fsyncSyncCalls.value).toBe(1);
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

  it("retries partial writes at advancing buffer offsets until complete", () => {
    writeSyncBehavior.maxBytesPerCall = 2;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-write-partial-"));
    const target = path.join(tmpDir, "out.tmp");

    const result = writeRegularFile({ path: target, content: "truncate" });

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("truncate");
    expect(writeSyncBehavior.offsets).toEqual([0, 2, 4, 6]);
  });

  it("returns an error when a truncate write makes no forward progress", () => {
    writeSyncBehavior.maxBytesPerCall = 2;
    writeSyncBehavior.returnZero = true;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-write-zero-"));
    const target = path.join(tmpDir, "out.tmp");

    const result = writeRegularFile({ path: target, content: "pending" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("made no forward progress");
    }
    expect(writeSyncBehavior.callCount).toBe(1);
    expect(fs.readFileSync(target, "utf8")).toBe("");
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
// confinedBaseDir ancestor-escape rejection.
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
// ---------------------------------------------------------------------------
describe("appendRegularFile — confined-base-dir ancestor escape rejection", () => {
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

describe("writeRegularFile — confined-base-dir ancestor escape rejection", () => {
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

// ---------------------------------------------------------------------------
// ensureContainedDir — shared substrate primitive
//
// The helper unifies the open-coded `mkdir + lstat-gated chmod` pattern
// duplicated in `queued-file-writer.ts:ensureParentDir` and
// `config-audit/append.ts:ensureConfigAuditParentDir`. It provides:
//
//   1. Fresh-create branch — `mkdirSync(dir, {recursive:true, mode})` and
//      the dir exists at the specified mode.
//   2. EEXIST-default-umask branch — pre-existing dir at 0o755 (e.g.,
//      pino-roll-created) gets chmod'd to the specified mode.
//   3. EEXIST-symlink-rejected branch — refuses to chmod a symlinked
//      dir (confused-deputy invariant); returns SymlinkParentRejected.
//   4. chmod-EPERM-non-fatal branch — chmod failure (not-owned-by-user,
//      etc.) is logged-by-caller, not surfaced as Result.err (best-effort
//      contract).
//   5. Confinement-base passes — when `confinedBaseDir` is supplied,
//      `realpathSync(dir)` must stay inside `realpathSync(confinedBaseDir)`.
//   6. Confinement-base rejects ancestor symlink — ancestor symlink that
//      escapes the base rejects with PathEscapesConfinementError.
// ---------------------------------------------------------------------------
describe("ensureContainedDir", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-fs-safe-ensure-"));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("fresh_create_at_specified_mode_succeeds_with_created_true", () => {
    const target = path.join(baseDir, "fresh");
    const result = ensureContainedDir({ dir: target, mode: 0o700 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.created).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
  });

  it("eexist_default_umask_dir_gets_chmod_to_specified_mode", () => {
    const target = path.join(baseDir, "preexisting");
    // Pre-create with looser mode (mimics pino-roll / pi-mono creating
    // a parent dir before our writer touches it).
    fs.mkdirSync(target, { recursive: true, mode: 0o755 });
    // Force-clear umask drift so the pre-state is deterministic.
    fs.chmodSync(target, 0o755);
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);

    const result = ensureContainedDir({ dir: target, mode: 0o700 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.created).toBe(false);
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
  });

  it("eexist_symlink_parent_rejected_with_typed_error_and_target_mode_untouched", () => {
    const sibling = path.join(baseDir, "sibling");
    fs.mkdirSync(sibling, { recursive: true, mode: 0o700 });
    fs.chmodSync(sibling, 0o755);
    const siblingModeBefore = fs.statSync(sibling).mode & 0o777;

    const linkPath = path.join(baseDir, "link");
    fs.symlinkSync(sibling, linkPath, "dir");

    const result = ensureContainedDir({ dir: linkPath, mode: 0o700 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBeInstanceOf(SymlinkParentRejected);
    expect((result.error as SymlinkParentRejected).code).toBe(
      "SYMLINK_PARENT_REJECTED",
    );
    // Confused-deputy invariant: the symlink target's mode is untouched.
    expect(fs.statSync(sibling).mode & 0o777).toBe(siblingModeBefore);
  });

  it("chmod_eperm_non_fatal_returns_ok_created_false", () => {
    const target = path.join(baseDir, "preexisting-eperm");
    fs.mkdirSync(target, { recursive: true, mode: 0o755 });
    fs.chmodSync(target, 0o755);

    // Toggle the hoisted mock so the next fs.chmodSync call throws EPERM.
    chmodSyncThrowsEperm.value = true;
    try {
      const result = ensureContainedDir({ dir: target, mode: 0o700 });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.value.created).toBe(false);
      // Mode bits stay at the pre-state because chmod threw — proves
      // we actually exercised the EPERM branch and didn't fall through.
      expect(fs.statSync(target).mode & 0o777).toBe(0o755);
    } finally {
      chmodSyncThrowsEperm.value = false;
    }
  });

  it("confinement_base_passes_when_realpath_inside_base", () => {
    const target = path.join(baseDir, "sub");
    const result = ensureContainedDir({
      dir: target,
      mode: 0o700,
      confinedBaseDir: baseDir,
    });
    expect(result.ok).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
  });

  it("confinement_base_rejects_when_ancestor_symlink_escapes_base", () => {
    // Create a sibling dir outside `baseDir`, then a symlink inside
    // `baseDir` pointing to it. mkdir through the symlink will succeed
    // and the kernel will create `<other>/sub`, but the realpath check
    // MUST reject it because `<other>` is outside `confinedBaseDir`.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "comis-fs-safe-other-"));
    try {
      const escape = path.join(baseDir, "escape");
      fs.symlinkSync(other, escape, "dir");
      const target = path.join(escape, "sub");

      const result = ensureContainedDir({
        dir: target,
        mode: 0o700,
        confinedBaseDir: baseDir,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toBeInstanceOf(PathEscapesConfinementError);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
