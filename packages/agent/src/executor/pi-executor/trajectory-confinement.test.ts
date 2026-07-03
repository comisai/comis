// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import { safePath } from "@comis/core";
import { resolveTrajectoryConfinedBase } from "./trajectory-confinement.js";

describe("resolveTrajectoryConfinedBase", () => {
  it("confines to the configured dataDir, NOT a hardcoded ~/.comis (custom-dataDir trajectory regression)", () => {
    // Live shape: a daemon running with dataDir=~/.comis-livetest.
    // Session files (and their co-located <file>.trajectory.jsonl) live under
    // that root. If the confinement base is the hardcoded ~/.comis instead,
    // every trajectory line-write is rejected at open() and the file is never
    // created — yet the pointer sidecar still advertises it, so obs.explain
    // follows the pointer to a file that does not exist. The base MUST be the
    // operator's resolved data root.
    const dataDir = "/Users/test/.comis-livetest";
    expect(resolveTrajectoryConfinedBase(undefined, dataDir)).toBe(dataDir);
  });

  it("falls back to ~/.comis only when no dataDir is resolved", () => {
    expect(resolveTrajectoryConfinedBase(undefined, undefined)).toBe(
      safePath(os.homedir(), ".comis"),
    );
  });

  it("skips confinement when the operator sets an explicit trajectory dir (they own that path)", () => {
    expect(
      resolveTrajectoryConfinedBase(
        "/var/log/comis/traj",
        "/Users/test/.comis-livetest",
      ),
    ).toBeUndefined();
  });

  it("explicit trajectory dir wins even with no dataDir", () => {
    expect(
      resolveTrajectoryConfinedBase("/var/log/comis/traj", undefined),
    ).toBeUndefined();
  });
});
