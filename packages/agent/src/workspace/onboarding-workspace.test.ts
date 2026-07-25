// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspace, readWorkspaceState } from "@comis/core";
import { detectOnboardingState } from "./onboarding-detector.js";

describe("workspace onboarding lifecycle", () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = path.join(os.tmpdir(), `comis-onboarding-test-${randomUUID()}`);
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("activates onboarding for a newly created workspace", async () => {
    const dir = makeTempDir();
    await ensureWorkspace({ dir, initGit: false });

    expect(await detectOnboardingState(dir)).toBe(true);
    expect((await readWorkspaceState(dir)).onboardingMessageCount).toBe(1);
  });

  it("reactivates onboarding when a completed workspace directory is deleted and recreated", async () => {
    const dir = makeTempDir();
    await ensureWorkspace({ dir, initGit: false });
    await fs.writeFile(path.join(dir, "BOOTSTRAP.md"), "", "utf-8");
    await fs.rm(dir, { recursive: true, force: true });

    await ensureWorkspace({ dir, initGit: false });

    expect(await detectOnboardingState(dir)).toBe(true);
    const state = await readWorkspaceState(dir);
    expect(state.onboardingMessageCount).toBe(1);
    expect(state.onboardingCompletedAt).toBeUndefined();
  });
});
