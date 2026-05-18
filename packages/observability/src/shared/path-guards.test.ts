// SPDX-License-Identifier: Apache-2.0
import { constants as fsConstants } from "node:fs";
import { describe, it, expect } from "vitest";

import {
  resolveContainedPath,
  resolveContainedPathOrThrow,
  safeTrajectorySessionFileName,
  resolveSafeOpenFlags,
  PathEscapeError,
} from "./path-guards.js";

describe("resolveContainedPath — non-throwing variant returns Result-shape", () => {
  it("returns ok=true with the joined path when the segments stay inside base", () => {
    const result = resolveContainedPath("/a/b", "c");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("/a/b/c");
  });

  it("returns ok=true for multi-segment within-base resolution", () => {
    const result = resolveContainedPath("/a/b", "c", "d.txt");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("/a/b/c/d.txt");
  });

  it("returns ok=false when a segment escapes the base via ..", () => {
    const result = resolveContainedPath("/a/b", "../c");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(PathEscapeError);
      expect(result.error.code).toBe("PATH_ESCAPE");
    }
  });

  it("returns ok=false when a segment escapes via deep ..", () => {
    const result = resolveContainedPath("/a/b", "c", "..", "..", "..", "etc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PATH_ESCAPE");
    }
  });
});

describe("resolveContainedPathOrThrow — throwing variant for boundary callers", () => {
  it("returns the joined path when the segments stay inside base", () => {
    expect(resolveContainedPathOrThrow("/a/b", "c")).toBe("/a/b/c");
  });

  it("throws PathEscapeError with code=PATH_ESCAPE when a segment escapes", () => {
    expect.assertions(2);
    try {
      resolveContainedPathOrThrow("/a/b", "../c");
    } catch (e) {
      expect(e).toBeInstanceOf(PathEscapeError);
      expect((e as PathEscapeError).code).toBe("PATH_ESCAPE");
    }
  });
});

describe("safeTrajectorySessionFileName — alphanumeric-only filename normalization", () => {
  it("replaces every character outside [a-zA-Z0-9_-] with an underscore (1-to-1, not coalesced)", () => {
    // `evil/../sid` has 4 disallowed chars (`/`, `.`, `.`, `/`) → 4 underscores.
    expect(safeTrajectorySessionFileName("evil/../sid")).toBe("evil____sid");
  });

  it("preserves a clean alphanumeric session id", () => {
    expect(safeTrajectorySessionFileName("session-abc_123")).toBe(
      "session-abc_123",
    );
  });

  it("slices the result to at most 120 chars", () => {
    const long = "a".repeat(200);
    const out = safeTrajectorySessionFileName(long);
    expect(out.length).toBe(120);
    expect(out).toBe("a".repeat(120));
  });

  it("falls back to the literal 'session' when the input has zero allowed chars", () => {
    expect(safeTrajectorySessionFileName("///***")).toBe("session");
  });

  it("falls back to 'session' for an empty string input", () => {
    expect(safeTrajectorySessionFileName("")).toBe("session");
  });

  it("falls back to 'session' for a whitespace-only input", () => {
    expect(safeTrajectorySessionFileName("   ")).toBe("session");
  });
});

describe("resolveSafeOpenFlags — symlink-safe write flags", () => {
  it("returns a flag set including O_CREAT | O_TRUNC | O_WRONLY on POSIX-like platforms", () => {
    const flags = resolveSafeOpenFlags();
    expect(flags & fsConstants.O_CREAT).toBe(fsConstants.O_CREAT);
    expect(flags & fsConstants.O_TRUNC).toBe(fsConstants.O_TRUNC);
    expect(flags & fsConstants.O_WRONLY).toBe(fsConstants.O_WRONLY);
  });

  it("ORs in O_NOFOLLOW when defined on the platform (POSIX)", () => {
    const flags = resolveSafeOpenFlags();
    // On POSIX (linux, darwin), O_NOFOLLOW is defined and must be present.
    const NOFOLLOW = (fsConstants as Record<string, number | undefined>)[
      "O_NOFOLLOW"
    ];
    if (typeof NOFOLLOW === "number") {
      expect(flags & NOFOLLOW).toBe(NOFOLLOW);
    } else {
      // Non-POSIX (Windows) — O_NOFOLLOW not defined; flag must omit it but
      // the base flags must still be present.
      expect(flags & fsConstants.O_CREAT).toBe(fsConstants.O_CREAT);
    }
  });
});

describe("PathEscapeError shape", () => {
  it("has name 'PathEscapeError'", () => {
    const err = new PathEscapeError("/base", "/elsewhere/file");
    expect(err.name).toBe("PathEscapeError");
  });

  it("has code 'PATH_ESCAPE'", () => {
    const err = new PathEscapeError("/base", "/elsewhere/file");
    expect(err.code).toBe("PATH_ESCAPE");
  });

  it("exposes base and attempted properties for operator-readable hints", () => {
    const err = new PathEscapeError("/a/b", "/elsewhere");
    expect(err.base).toBe("/a/b");
    expect(err.attempted).toBe("/elsewhere");
  });
});
