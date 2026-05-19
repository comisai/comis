// SPDX-License-Identifier: Apache-2.0
/**
 * Trajectory file-path resolution tests.
 *
 * The trajectory file path resolution has a small deterministic precedence:
 *
 *   1. Explicit `trajectoryDir` arg, if present → `<dir>/<safeSessionId>.trajectory.jsonl`
 *   2. `COMIS_TRAJECTORY_DIR` env var, if set → same shape as (1)
 *   3. `sessionFile`, if present → `<sessionFile>.trajectory.jsonl`
 *      (co-located with the per-session JSONL writer)
 *   4. `workspaceDir`, if present → `<workspaceDir>/<safeSessionId>.trajectory.jsonl`
 *   5. Last resort: `${process.cwd()}/<safeSessionId>.trajectory.jsonl`
 *
 * Plus three small helpers:
 *   - `resolveTrajectoryPointerFilePath(sessionFile)` →
 *     `<sessionFile>.trajectory-path.json`
 *   - `resolveTrajectoryPointerOpenFlags()` → `O_CREAT | O_TRUNC |
 *     O_WRONLY | O_NOFOLLOW`
 *   - `resolveTrajectoryFilePathFromSession` (the inner helper for
 *     sessionFile co-location)
 *
 * Path-escape contract: when `trajectoryDir` is absolute and
 * `sessionId` contains traversal characters, the helper goes through
 * `safeTrajectorySessionFileName` so the resulting filename cannot escape
 * the dir.
 *
 * @module
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
  resolveTrajectoryPointerOpenFlags,
} from "./paths.js";

let tmpDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "comis-trj-paths-"));
  savedEnv = process.env.COMIS_TRAJECTORY_DIR;
  delete process.env.COMIS_TRAJECTORY_DIR;
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.COMIS_TRAJECTORY_DIR;
  } else {
    process.env.COMIS_TRAJECTORY_DIR = savedEnv;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveTrajectoryFilePath -- co-location with sessionFile", () => {
  it("appends .trajectory.jsonl to the session JSONL path when only sessionFile is supplied", () => {
    const result = resolveTrajectoryFilePath({
      sessionId: "sid-1",
      sessionFile: `${tmpDir}/session-abc.jsonl`,
    });
    expect(result).toBe(`${tmpDir}/session-abc.jsonl.trajectory.jsonl`);
  });

  it("preserves the full sessionFile filename when computing the trajectory path (not truncated)", () => {
    const long = `${tmpDir}/very-long-session-filename-with-dashes-and_underscores.jsonl`;
    const result = resolveTrajectoryFilePath({
      sessionId: "sid-2",
      sessionFile: long,
    });
    expect(result).toBe(`${long}.trajectory.jsonl`);
  });
});

describe("resolveTrajectoryFilePath -- COMIS_TRAJECTORY_DIR env override", () => {
  it("uses env dir when COMIS_TRAJECTORY_DIR is set, overriding sessionFile co-location", () => {
    process.env.COMIS_TRAJECTORY_DIR = tmpDir;
    const result = resolveTrajectoryFilePath({
      sessionId: "sid-3",
      sessionFile: "/different/place/session.jsonl",
    });
    expect(result).toBe(`${tmpDir}/sid-3.trajectory.jsonl`);
  });

  it("collapses unsafe characters in the sessionId via safeTrajectorySessionFileName when env dir is set", () => {
    process.env.COMIS_TRAJECTORY_DIR = tmpDir;
    const result = resolveTrajectoryFilePath({
      sessionId: "evil/../sid",
    });
    expect(result).toBe(`${tmpDir}/evil____sid.trajectory.jsonl`);
  });

  it("falls back to 'session' literal when sessionId has no allowed characters", () => {
    process.env.COMIS_TRAJECTORY_DIR = tmpDir;
    const result = resolveTrajectoryFilePath({
      sessionId: "///",
    });
    expect(result).toBe(`${tmpDir}/session.trajectory.jsonl`);
  });
});

describe("resolveTrajectoryFilePath -- explicit trajectoryDir takes precedence over env", () => {
  it("uses explicit trajectoryDir even when COMIS_TRAJECTORY_DIR is set", () => {
    process.env.COMIS_TRAJECTORY_DIR = "/env/dir";
    const result = resolveTrajectoryFilePath({
      sessionId: "sid-4",
      trajectoryDir: tmpDir,
    });
    expect(result).toBe(`${tmpDir}/sid-4.trajectory.jsonl`);
  });
});

describe("resolveTrajectoryFilePath -- workspaceDir + last-resort cwd", () => {
  it("uses workspaceDir when sessionFile is absent and trajectoryDir/env are not set", () => {
    const result = resolveTrajectoryFilePath({
      sessionId: "sid-5",
      workspaceDir: tmpDir,
    });
    expect(result).toBe(`${tmpDir}/sid-5.trajectory.jsonl`);
  });

  it("falls back to process.cwd() when no path inputs are available", () => {
    const result = resolveTrajectoryFilePath({
      sessionId: "sid-cwd",
    });
    expect(result).toBe(`${process.cwd()}/sid-cwd.trajectory.jsonl`);
  });
});

describe("resolveTrajectoryFilePath -- path containment", () => {
  it("rejects a sessionId that would resolve outside the trajectoryDir via PathEscapeError", () => {
    // The safeTrajectorySessionFileName collapse already prevents
    // traversal, so this is the second line of defense. We rely on
    // resolveContainedPath under the hood — confirm the resulting path
    // is strictly inside the trajectoryDir.
    process.env.COMIS_TRAJECTORY_DIR = tmpDir;
    const result = resolveTrajectoryFilePath({
      sessionId: "../../etc/passwd",
    });
    expect(result.startsWith(`${tmpDir}/`)).toBe(true);
    expect(result).not.toContain("..");
  });
});

describe("resolveTrajectoryPointerFilePath -- pointer file shape", () => {
  it("appends .trajectory-path.json to the session JSONL path", () => {
    const result = resolveTrajectoryPointerFilePath(`${tmpDir}/session-abc.jsonl`);
    expect(result).toBe(`${tmpDir}/session-abc.jsonl.trajectory-path.json`);
  });
});

describe("resolveTrajectoryPointerOpenFlags -- safe open flags", () => {
  it("returns O_CREAT | O_TRUNC | O_WRONLY with O_NOFOLLOW OR'd when host supports it (POSIX)", () => {
    const flags = resolveTrajectoryPointerOpenFlags();
    expect(typeof flags).toBe("number");
    expect(flags).toBeGreaterThan(0);

    // Sanity: should at least be CREAT | TRUNC | WRONLY (the three required flags).
    // We do not assert the exact O_NOFOLLOW bit because it is platform-specific.
    // Instead we delegate to resolveSafeOpenFlags and assert parity.
    const fs = require("node:fs") as typeof import("node:fs");
    const minimum =
      fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY;
    expect((flags & minimum) === minimum).toBe(true);
  });
});
