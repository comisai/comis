// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileLockPort, LockError } from "@comis/core";
import { ok, type Result } from "@comis/shared";

const fsMocks = vi.hoisted(() => ({
  lstat: vi.fn(),
  open: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
  chmod: vi.fn(),
}));

vi.mock("node:fs/promises", () => fsMocks);

import { createTaskAuthorityMaintenance } from "./task-authority-maintenance.js";

function nodeError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function metadata(size = 0, overrides: Record<string, unknown> = {}) {
  return { isFile: () => true, size, dev: 1, ino: 1, ...overrides };
}

function readableHandle(bytes = Buffer.alloc(0)) {
  let read = false;
  return {
    stat: vi.fn(async () => metadata(bytes.byteLength)),
    read: vi.fn(async (buffer: Buffer) => {
      if (read) return { bytesRead: 0, buffer };
      read = true;
      bytes.copy(buffer);
      return { bytesRead: bytes.byteLength, buffer };
    }),
    close: vi.fn(async () => undefined),
    sync: vi.fn(async () => undefined),
  };
}

function authority() {
  const fileLock: FileLockPort = {
    acquire: async () => ok(async () => undefined),
    release: async () => ok(undefined),
    withLock: async <T>(_path: string, operation: () => Promise<T>): Promise<Result<T, LockError>> => ok(await operation()),
    isLocked: async () => false,
    cleanupStaleLocks: async () => 0,
  };
  return createTaskAuthorityMaintenance({
    directory: "/var/lib/comis/scheduler",
    storePath: "/var/lib/comis/scheduler/tasks.json",
    intentPath: "/var/lib/comis/scheduler/tasks-reset-intent.json",
    storeLockPath: "/var/lib/comis/scheduler/tasks.lock",
    fileLock,
    clock: { now: () => 1_000, nowDate: () => new Date(1_000) },
    idFactory: () => "operation-a",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fsMocks.readFile.mockResolvedValue(Buffer.alloc(0));
  fsMocks.rename.mockResolvedValue(undefined);
  fsMocks.unlink.mockResolvedValue(undefined);
  fsMocks.chmod.mockResolvedValue(undefined);
});

describe("task authority filesystem failures", () => {
  it("maps lstat and open failures during raw authority inspection", async () => {
    fsMocks.lstat.mockRejectedValueOnce(nodeError("EIO"));
    await expect(authority().inspect()).resolves.toMatchObject({ ok: false, error: { code: "io" } });

    fsMocks.lstat.mockResolvedValueOnce(metadata());
    fsMocks.open.mockRejectedValueOnce(nodeError("EACCES"));
    await expect(authority().inspect()).resolves.toMatchObject({ ok: false, error: { code: "io" } });
  });

  it("rejects changed metadata and failed reads while hashing authority", async () => {
    const changed = readableHandle();
    changed.stat.mockRejectedValueOnce(new Error("stat failed"));
    fsMocks.lstat.mockResolvedValueOnce(metadata());
    fsMocks.open.mockResolvedValueOnce(changed);
    await expect(authority().inspect()).resolves.toMatchObject({ ok: false, error: { code: "invalid_path" } });
    expect(changed.close).toHaveBeenCalledOnce();

    const unreadable = readableHandle();
    unreadable.read.mockRejectedValueOnce(new Error("read failed"));
    fsMocks.lstat.mockResolvedValueOnce(metadata());
    fsMocks.open.mockResolvedValueOnce(unreadable);
    await expect(authority().inspect()).resolves.toMatchObject({ ok: false, error: { code: "io" } });
    expect(unreadable.close).toHaveBeenCalledOnce();
  });

  it("maps bounded reset-intent metadata and read failures", async () => {
    const intent = Buffer.from(JSON.stringify({ formatVersion: 1 }), "utf8");
    for (const boundedFailure of ["metadata", "shape", "read"] as const) {
      const handle = readableHandle(intent);
      fsMocks.lstat.mockRejectedValueOnce(nodeError("ENOENT"));
      fsMocks.lstat.mockResolvedValueOnce(metadata(intent.byteLength));
      fsMocks.open.mockResolvedValueOnce(handle);
      if (boundedFailure === "metadata") fsMocks.lstat.mockRejectedValueOnce(nodeError("EIO"));
      if (boundedFailure === "shape") fsMocks.lstat.mockResolvedValueOnce(metadata(intent.byteLength, { isFile: () => false }));
      if (boundedFailure === "read") {
        fsMocks.lstat.mockResolvedValueOnce(metadata(intent.byteLength));
        fsMocks.readFile.mockRejectedValueOnce(nodeError("EIO"));
      }

      await expect(authority().inspect()).resolves.toMatchObject({ ok: false, error: { code: expect.any(String) } });
    }
  });

  it("reports close failure after otherwise complete authority hashing", async () => {
    const handle = readableHandle(Buffer.from("authority", "utf8"));
    handle.close.mockRejectedValueOnce(new Error("close failed"));
    fsMocks.lstat.mockResolvedValueOnce(metadata(9));
    fsMocks.open.mockResolvedValueOnce(handle);

    await expect(authority().inspect()).resolves.toMatchObject({ ok: false, error: { code: "io" } });
  });
});
