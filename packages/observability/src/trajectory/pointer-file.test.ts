// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for `writeTrajectoryPointerFileBestEffort`.
 *
 * Covers:
 *   - writes_pointer_with_correct_shape
 *   - pointer_file_has_mode_0600
 *   - symlink_parent_dir_is_silent_noop
 *   - second_call_truncates
 *   - unwritable_parent_silent_noop
 *
 * @module
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeTrajectoryPointerFileBestEffort } from "./pointer-file.js";
import { resolveTrajectoryPointerFilePath } from "./paths.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "comis-trj-ptr-"));
});

afterEach(() => {
  // Best-effort cleanup. chmod back so rmSync can recurse.
  try {
    chmodSync(tmpRoot, 0o700);
  } catch {
    /* ignore */
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("writeTrajectoryPointerFileBestEffort", () => {
  it("writes_pointer_with_correct_shape: traceSchema, schemaVersion, sessionId, runtimeFile", () => {
    const sessionFile = join(tmpRoot, "session.jsonl");
    const runtimeFile = join(tmpRoot, "session.jsonl.trajectory.jsonl");

    writeTrajectoryPointerFileBestEffort({
      sessionFile,
      sessionId: "sid-pointer-1",
      runtimeFile,
    });

    const pointerPath = sessionFile + ".trajectory-path.json";
    expect(existsSync(pointerPath)).toBe(true);
    const raw = readFileSync(pointerPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.traceSchema).toBe("comis-trajectory-pointer");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.sessionId).toBe("sid-pointer-1");
    expect(parsed.runtimeFile).toBe(runtimeFile);
  });

  it("pointer_file_has_mode_0600 on POSIX", () => {
    const sessionFile = join(tmpRoot, "session.jsonl");
    writeTrajectoryPointerFileBestEffort({
      sessionFile,
      sessionId: "sid-mode",
      runtimeFile: "/abs/path/to/trajectory.jsonl",
    });

    const st = statSync(sessionFile + ".trajectory-path.json");
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("symlink_parent_dir_is_silent_noop and writes no file", () => {
    // Make a symlinked directory and aim the pointer-write at it.
    const realParent = join(tmpRoot, "real-parent");
    mkdirSync(realParent, { recursive: true });
    const linkParent = join(tmpRoot, "symlink-parent");
    symlinkSync(realParent, linkParent);

    const sessionFile = join(linkParent, "session.jsonl");

    // Must not throw. Pointer file at <sessionFile>.trajectory-path.json
    // must NOT be created (because the parent dir is a symlink).
    expect(() =>
      writeTrajectoryPointerFileBestEffort({
        sessionFile,
        sessionId: "sid-symlink",
        runtimeFile: "/abs/runtime.jsonl",
      }),
    ).not.toThrow();

    const pointerPath = sessionFile + ".trajectory-path.json";
    expect(existsSync(pointerPath)).toBe(false);
  });

  it("second_call_truncates: O_TRUNC semantics — second runtimeFile wins", () => {
    const sessionFile = join(tmpRoot, "session.jsonl");
    writeTrajectoryPointerFileBestEffort({
      sessionFile,
      sessionId: "sid-first",
      runtimeFile: "/abs/first.jsonl",
    });
    writeTrajectoryPointerFileBestEffort({
      sessionFile,
      sessionId: "sid-second",
      runtimeFile: "/abs/second.jsonl",
    });

    const raw = readFileSync(sessionFile + ".trajectory-path.json", "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.sessionId).toBe("sid-second");
    expect(parsed.runtimeFile).toBe("/abs/second.jsonl");
  });

  it("unwritable_parent_silent_noop: chmod 0o500 parent, helper does not throw", () => {
    const lockedDir = join(tmpRoot, "locked");
    mkdirSync(lockedDir, { recursive: true });
    chmodSync(lockedDir, 0o500); // read+exec only — open(O_CREAT|O_WRONLY) fails EACCES

    const sessionFile = join(lockedDir, "session.jsonl");
    expect(() =>
      writeTrajectoryPointerFileBestEffort({
        sessionFile,
        sessionId: "sid-locked",
        runtimeFile: "/abs/runtime.jsonl",
      }),
    ).not.toThrow();

    // Restore for cleanup.
    chmodSync(lockedDir, 0o700);
  });

  it("missing_parent_dir_is_silent_noop and writes no file", () => {
    // Aim at a parent that doesn't exist — the lstat fails, we no-op.
    const ghostDir = join(tmpRoot, "does-not-exist");
    const sessionFile = join(ghostDir, "session.jsonl");

    expect(() =>
      writeTrajectoryPointerFileBestEffort({
        sessionFile,
        sessionId: "sid-ghost",
        runtimeFile: "/abs/runtime.jsonl",
      }),
    ).not.toThrow();

    expect(existsSync(sessionFile + ".trajectory-path.json")).toBe(false);
  });

  it("writer_reader_symmetry: pointer path written matches resolveTrajectoryPointerFilePath result", () => {
    // Write a pointer file, then verify the path the writer used matches
    // what resolveTrajectoryPointerFilePath returns for the same sessionFile.
    // This closes the writer/reader symmetry contract.
    const sessionFile = join(tmpRoot, "session.jsonl");
    const runtimeFile = join(tmpRoot, "elsewhere", "runtime.jsonl");

    writeTrajectoryPointerFileBestEffort({
      sessionFile,
      sessionId: "sid-symmetry",
      runtimeFile,
    });

    const resolvedPointerPath = resolveTrajectoryPointerFilePath(sessionFile);
    // The writer must have used the same path — file must exist there.
    expect(existsSync(resolvedPointerPath)).toBe(true);
    // The resolved path must equal <sessionFile>.trajectory-path.json.
    expect(resolvedPointerPath).toBe(sessionFile + ".trajectory-path.json");
  });
});

describe("resolveTrajectoryPointerFilePath", () => {
  it("suffix_is_trajectory_path_json: returns <sessionFile>.trajectory-path.json", () => {
    // Pins the suffix so a future renamer cannot break the reader without
    // this test catching it first.
    expect(resolveTrajectoryPointerFilePath("/tmp/sess.jsonl"))
      .toBe("/tmp/sess.jsonl.trajectory-path.json");
  });
});
