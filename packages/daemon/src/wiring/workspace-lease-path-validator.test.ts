// SPDX-License-Identifier: Apache-2.0
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateWorkspaceLeasePath } from "./workspace-lease-path-validator.js";

describe("workspace lease path validation", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function makeLayout() {
    const root = mkdtempSync(join(tmpdir(), "workspace-lease-path-"));
    temporaryDirectories.push(root);
    const allowedRoot = join(root, "allowed");
    const workspace = join(allowedRoot, "task-a");
    const dataDir = join(root, "comis-data");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(dataDir);
    return { root, allowedRoot, workspace, dataDir };
  }

  it("accepts one canonical directory strictly below an allowed root", () => {
    const layout = makeLayout();

    const result = validateWorkspaceLeasePath({
      requestedPath: layout.workspace,
      allowedWorkspaceRoots: [layout.allowedRoot],
      dataDir: layout.dataDir,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        canonicalPath: layout.workspace,
        filesystemIdentity: {
          device: expect.any(Number),
          inode: expect.any(Number),
        },
      },
    });
  });

  it("rejects outside, broad, and Comis data-directory authority", () => {
    const layout = makeLayout();
    const outside = join(layout.root, "outside");
    mkdirSync(outside);

    expect(validateWorkspaceLeasePath({
      requestedPath: outside,
      allowedWorkspaceRoots: [layout.allowedRoot],
      dataDir: layout.dataDir,
    }).ok).toBe(false);
    expect(validateWorkspaceLeasePath({
      requestedPath: layout.workspace,
      allowedWorkspaceRoots: ["/"],
      dataDir: layout.dataDir,
    }).ok).toBe(false);
    expect(validateWorkspaceLeasePath({
      requestedPath: layout.dataDir,
      allowedWorkspaceRoots: [layout.root],
      dataDir: layout.dataDir,
    }).ok).toBe(false);
  });

  it("rejects symlinked finals and non-directory targets", () => {
    const layout = makeLayout();
    const linked = join(layout.allowedRoot, "linked-task");
    const file = join(layout.allowedRoot, "task.txt");
    symlinkSync(layout.workspace, linked);
    writeFileSync(file, "not a workspace");

    expect(validateWorkspaceLeasePath({
      requestedPath: linked,
      allowedWorkspaceRoots: [layout.allowedRoot],
      dataDir: layout.dataDir,
    }).ok).toBe(false);
    expect(validateWorkspaceLeasePath({
      requestedPath: file,
      allowedWorkspaceRoots: [layout.allowedRoot],
      dataDir: layout.dataDir,
    }).ok).toBe(false);
  });
});
