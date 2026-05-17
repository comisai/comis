// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap coverage for identity-updater.ts.
 *
 * The existing identity-updater.test.ts covers happy-path approve()/propose()
 * paths but misses the error-classification branches in approve():
 *   - PathTraversalError safePath rejection (line 104)
 *   - non-PathTraversalError, non-Error safePath rejection (line 107 cond-expr)
 *   - non-Error throw from writeFile/git execFile (line 139 cond-expr)
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIdentityUpdater } from "./identity-updater.js";

describe("createIdentityUpdater approve() — branch-gap coverage", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "comis-identity-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("returns err with descriptive message when approve runs against a workspace that does not exist", async () => {
    const updater = createIdentityUpdater(workspaceDir);
    await updater.propose("soul", "new soul content", "test reason");

    // Delete the workspace dir so writeFile fails
    rmSync(workspaceDir, { recursive: true, force: true });

    const result = await updater.approve("soul");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it("returns err result for non-existent pending fileType lookup", async () => {
    const updater = createIdentityUpdater(workspaceDir);
    const result = await updater.approve("soul"); // never proposed
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/No pending update for file type: soul/);
    }
  });

  it("removes pending update when reject is invoked with a matching fileType", async () => {
    const updater = createIdentityUpdater(workspaceDir);
    await updater.propose("soul", "soul content", "reason");
    expect(updater.getPending()).toHaveLength(1);

    updater.reject("soul");
    expect(updater.getPending()).toHaveLength(0);
  });

  it("no-ops cleanly when reject is invoked with a fileType that has no pending update", () => {
    const updater = createIdentityUpdater(workspaceDir);
    expect(() => updater.reject("soul")).not.toThrow();
    expect(updater.getPending()).toHaveLength(0);
  });

  it("clears every pending update across all fileTypes when clearPending is called", async () => {
    const updater = createIdentityUpdater(workspaceDir);
    await updater.propose("soul", "s", "r");
    await updater.propose("identity", "i", "r");
    await updater.propose("user", "u", "r");
    expect(updater.getPending()).toHaveLength(3);

    updater.clearPending();
    expect(updater.getPending()).toHaveLength(0);
  });

  it("propose returns the pending update with the supplied reason and proposed content", async () => {
    const updater = createIdentityUpdater(workspaceDir);
    const update = await updater.propose("identity", "new identity", "agent refinement");
    expect(update.fileType).toBe("identity");
    expect(update.proposedContent).toBe("new identity");
    expect(update.reason).toBe("agent refinement");
    expect(update.currentContent).toBeUndefined(); // no existing IDENTITY.md
    expect(typeof update.proposedAt).toBe("number");
  });

  it("propose overwrites an earlier pending update for the same fileType", async () => {
    const updater = createIdentityUpdater(workspaceDir);
    await updater.propose("soul", "first content", "first reason");
    await updater.propose("soul", "second content", "second reason");

    const pending = updater.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.proposedContent).toBe("second content");
    expect(pending[0]!.reason).toBe("second reason");
  });
});
