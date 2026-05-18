// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it, expect } from "vitest";

import {
  appendRegularFile,
  SymlinkParentRejected,
  FileSizeLimitExceeded,
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
