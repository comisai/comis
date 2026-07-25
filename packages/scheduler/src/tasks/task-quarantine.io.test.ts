// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  lstat: vi.fn(),
  mkdir: vi.fn(),
  chmod: vi.fn(),
  open: vi.fn(),
}));

vi.mock("node:fs/promises", () => fsMocks);

import {
  inspectTaskQuarantine,
  MAX_FOLLOWUP_TASK_QUARANTINE_BYTES,
  quarantineMalformedTerminalTaskGroups,
} from "./task-quarantine.js";

function nodeError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function metadata(size = 0, isFile = true) {
  return { isFile: () => isFile, isSymbolicLink: () => false, mode: 0o600, size };
}

function fileHandle() {
  return {
    stat: vi.fn(async () => metadata()),
    chmod: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    sync: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    readFile: vi.fn(async () => Buffer.alloc(0)),
  };
}

function rawRoot() {
  const policyHash = "a".repeat(64);
  return {
    formatVersion: 1 as const,
    tasks: [{
      id: "task-a",
      agentId: "agent-a",
      status: "cancelled",
      workspacePolicyHash: policyHash,
      terminalAttemptId: null,
    }],
    attempts: [],
    policySnapshots: [{ agentId: "agent-a", combinedHash: policyHash }],
  };
}

function resetHappyAppend() {
  for (const mock of Object.values(fsMocks)) mock.mockReset();
  fsMocks.lstat.mockRejectedValue(nodeError("ENOENT"));
  fsMocks.mkdir.mockResolvedValue(undefined);
  fsMocks.chmod.mockResolvedValue(undefined);
  const file = fileHandle();
  const directory = fileHandle();
  fsMocks.open.mockResolvedValueOnce(file).mockResolvedValueOnce(directory);
  return { file, directory };
}

async function quarantine() {
  return quarantineMalformedTerminalTaskGroups({
    raw: rawRoot(),
    quarantinePath: "/var/lib/comis/tasks-quarantine.jsonl",
    quarantinedAtMs: 1_000,
  });
}

beforeEach(() => {
  resetHappyAppend();
});

describe("task quarantine append failures", () => {
  it("maps quarantine directory creation and hardening failures", async () => {
    fsMocks.mkdir.mockRejectedValueOnce(new Error("mkdir failed"));
    await expect(quarantine()).resolves.toMatchObject({ ok: false, error: { code: "io" } });

    resetHappyAppend();
    fsMocks.chmod.mockRejectedValueOnce(new Error("chmod failed"));
    await expect(quarantine()).resolves.toMatchObject({ ok: false, error: { code: "io" } });
  });

  it("rejects changed invalid and full append authorities", async () => {
    fsMocks.lstat
      .mockRejectedValueOnce(nodeError("ENOENT"))
      .mockResolvedValueOnce(metadata(0, false));
    await expect(quarantine()).resolves.toMatchObject({ ok: false, error: { code: "invalid_state" } });

    resetHappyAppend();
    fsMocks.lstat
      .mockRejectedValueOnce(nodeError("ENOENT"))
      .mockRejectedValueOnce(nodeError("EIO"));
    await expect(quarantine()).resolves.toMatchObject({ ok: false, error: { code: "io" } });

    resetHappyAppend();
    fsMocks.lstat
      .mockRejectedValueOnce(nodeError("ENOENT"))
      .mockResolvedValueOnce(metadata(MAX_FOLLOWUP_TASK_QUARANTINE_BYTES));
    await expect(quarantine()).resolves.toMatchObject({ ok: false, error: { code: "store_full" } });
  });

  it("maps append open stat permission and write failures", async () => {
    fsMocks.open.mockReset().mockRejectedValueOnce(new Error("open failed"));
    await expect(quarantine()).resolves.toMatchObject({ ok: false, error: { code: "io" } });

    for (const stage of ["stat", "chmod", "write"] as const) {
      const { file } = resetHappyAppend();
      if (stage === "stat") file.stat.mockRejectedValueOnce(new Error("stat failed"));
      if (stage === "chmod") file.chmod.mockRejectedValueOnce(new Error("chmod failed"));
      if (stage === "write") file.writeFile.mockRejectedValueOnce(new Error("write failed"));
      await expect(quarantine()).resolves.toMatchObject({ ok: false, error: { code: "io" } });
      expect(file.close).toHaveBeenCalledOnce();
    }
  });

  it("maps append flush close and directory synchronization failures", async () => {
    let handles = resetHappyAppend();
    handles.file.sync.mockRejectedValueOnce(new Error("sync failed"));
    await expect(quarantine()).resolves.toMatchObject({ ok: false, error: { code: "io" } });

    handles = resetHappyAppend();
    handles.file.close.mockRejectedValueOnce(new Error("close failed"));
    await expect(quarantine()).resolves.toMatchObject({ ok: false, error: { code: "io" } });

    handles = resetHappyAppend();
    fsMocks.open.mockReset().mockResolvedValueOnce(handles.file).mockRejectedValueOnce(new Error("directory open failed"));
    await expect(quarantine()).resolves.toMatchObject({ ok: false, error: { code: "io" } });
  });

  it("rejects changed unreadable and oversized authority after opening it safely", async () => {
    let handle = fileHandle();
    handle.stat.mockResolvedValueOnce(metadata(MAX_FOLLOWUP_TASK_QUARANTINE_BYTES + 1));
    fsMocks.lstat.mockResolvedValueOnce(metadata());
    fsMocks.open.mockReset().mockResolvedValueOnce(handle);
    await expect(inspectTaskQuarantine("/var/lib/comis/tasks-quarantine.jsonl"))
      .resolves.toMatchObject({ ok: false, error: { code: "io" } });
    expect(handle.close).toHaveBeenCalledOnce();

    handle = fileHandle();
    handle.readFile.mockRejectedValueOnce(new Error("read failed"));
    fsMocks.lstat.mockResolvedValueOnce(metadata());
    fsMocks.open.mockReset().mockResolvedValueOnce(handle);
    await expect(inspectTaskQuarantine("/var/lib/comis/tasks-quarantine.jsonl"))
      .resolves.toMatchObject({ ok: false, error: { code: "io" } });
    expect(handle.close).toHaveBeenCalledOnce();

    handle = fileHandle();
    handle.readFile.mockResolvedValueOnce(Buffer.alloc(MAX_FOLLOWUP_TASK_QUARANTINE_BYTES + 1));
    fsMocks.lstat.mockResolvedValueOnce(metadata());
    fsMocks.open.mockReset().mockResolvedValueOnce(handle);
    await expect(inspectTaskQuarantine("/var/lib/comis/tasks-quarantine.jsonl"))
      .resolves.toMatchObject({ ok: true, value: { state: "invalid" } });
    expect(handle.close).toHaveBeenCalledOnce();
  });
});
