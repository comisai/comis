// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateExecutionAttachmentPath } from "./execution-attachment-path-validator.js";

interface Layout {
  readonly root: string;
  readonly runtimeRoot: string;
  readonly dataDir: string;
  readonly socketPath: string;
  readonly server: Server;
}

const layouts: Layout[] = [];

async function makeLayout(): Promise<Layout> {
  const root = mkdtempSync(join(tmpdir(), "execution-attachment-path-"));
  const runtimeRoot = join(root, "service-runtime");
  const dataDir = join(root, "comis-data");
  mkdirSync(runtimeRoot, { mode: 0o700 });
  mkdirSync(dataDir, { mode: 0o700 });
  const socketPath = join(runtimeRoot, "worker.sock");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const layout = { root, runtimeRoot, dataDir, socketPath, server };
  layouts.push(layout);
  return layout;
}

afterEach(async () => {
  for (const layout of layouts.splice(0)) {
    await new Promise<void>((resolve) => layout.server.close(() => resolve()));
    rmSync(layout.root, { recursive: true, force: true });
  }
});

describe("execution attachment source path validation", () => {
  it("proves a canonical Unix socket beneath the exact allowed runtime root", async () => {
    const layout = await makeLayout();
    const result = validateExecutionAttachmentPath({
      requestedPath: layout.socketPath,
      allowedRuntimeRoots: [layout.runtimeRoot],
      dataDir: layout.dataDir,
      controlSocketPaths: [],
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        canonicalPath: layout.socketPath,
        filesystemType: "socket",
        filesystemIdentity: { device: expect.any(Number), inode: expect.any(Number) },
      },
    });
  });

  it("rejects symlinks regular files and sources outside the allowed root", async () => {
    const layout = await makeLayout();
    const symlinkPath = join(layout.runtimeRoot, "linked.sock");
    symlinkSync(layout.socketPath, symlinkPath);
    const regularPath = join(layout.runtimeRoot, "regular.sock");
    writeFileSync(regularPath, "not a socket");
    for (const requestedPath of [symlinkPath, regularPath, join(layout.dataDir, "daemon.sock")]) {
      expect(validateExecutionAttachmentPath({
        requestedPath,
        allowedRuntimeRoots: [layout.runtimeRoot],
        dataDir: layout.dataDir,
        controlSocketPaths: [],
      }).ok, requestedPath).toBe(false);
    }
  });

  it("rejects broad roots data roots and the capability-service control socket", async () => {
    const layout = await makeLayout();
    expect(validateExecutionAttachmentPath({
      requestedPath: layout.socketPath,
      allowedRuntimeRoots: ["/"],
      dataDir: layout.dataDir,
      controlSocketPaths: [],
    }).ok).toBe(false);
    expect(validateExecutionAttachmentPath({
      requestedPath: layout.socketPath,
      allowedRuntimeRoots: [layout.root],
      dataDir: layout.runtimeRoot,
      controlSocketPaths: [],
    }).ok).toBe(false);
    expect(validateExecutionAttachmentPath({
      requestedPath: layout.socketPath,
      allowedRuntimeRoots: [layout.runtimeRoot],
      dataDir: layout.dataDir,
      controlSocketPaths: [layout.socketPath],
    }).ok).toBe(false);
  });
});
