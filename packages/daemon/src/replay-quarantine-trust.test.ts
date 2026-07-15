// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { lstatMock, openMock } = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  openMock: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, lstat: lstatMock, open: openMock };
});

import {
  createSystemEnvironmentRolePort,
  createSystemReplayRestoreAttestationPort,
} from "./replay-quarantine.js";

function parentStatus() {
  return {
    isSymbolicLink: () => false,
    isDirectory: () => true,
    uid: 0,
    gid: 0,
    mode: 0o40755,
  };
}

function fileStatus(mode: number, size: number, mtimeMs = 1) {
  return {
    isFile: () => true,
    uid: 0,
    gid: 0,
    nlink: 1,
    mode,
    size,
    dev: 2,
    ino: 3,
    mtimeMs,
    ctimeMs: 4,
  };
}

function openedFile(content: string, mode: number, afterMtimeMs = 1) {
  const before = fileStatus(mode, Buffer.byteLength(content), 1);
  const after = fileStatus(mode, Buffer.byteLength(content), afterMtimeMs);
  return {
    stat: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
    readFile: vi.fn().mockResolvedValue(content),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("root-owned replay trust anchors", () => {
  beforeEach(() => {
    lstatMock.mockReset();
    openMock.mockReset();
    lstatMock.mockResolvedValue(parentStatus());
  });

  it("opens the role marker once without following links and validates its inode", async () => {
    const handle = openedFile("test\n", 0o100644);
    openMock.mockResolvedValue(handle);

    const result = await createSystemEnvironmentRolePort().read();

    expect(result).toEqual({ ok: true, value: "test" });
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock.mock.calls[0]?.[1] & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(handle.stat).toHaveBeenCalledTimes(2);
    expect(handle.readFile).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a trust anchor whose opened inode changes during the read", async () => {
    openMock.mockResolvedValue(openedFile("production\n", 0o100644, 2));

    const result = await createSystemEnvironmentRolePort().read();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("environment_role_untrusted");
  });

  it("accepts only the read-only root seal mode and strict attestation schema", async () => {
    const attestation = JSON.stringify({
      schemaVersion: 1,
      state: "committed",
      dataDirSha256: "a".repeat(64),
      snapshotManifestSha256: "b".repeat(64),
      restoredTreeDigestSha256: "c".repeat(64),
      entryCount: 1,
      bytes: 2,
    });
    openMock.mockResolvedValue(openedFile(attestation, 0o100444));

    const result = await createSystemReplayRestoreAttestationPort().read();

    expect(result.ok).toBe(true);

    openMock.mockResolvedValue(openedFile(attestation, 0o100644));
    const writable = await createSystemReplayRestoreAttestationPort().read();
    expect(writable.ok).toBe(false);
    if (!writable.ok) expect(writable.error.kind).toBe("restore_attestation_untrusted");
  });
});
