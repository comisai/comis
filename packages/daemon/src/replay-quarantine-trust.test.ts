// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
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
  createSystemReplayMachineIdentityPort,
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
      runId: "restore-a1",
      targetMachineIdSha256: "f".repeat(64),
      baselineImmutable: true,
      dataDirSha256: "a".repeat(64),
      snapshotManifestSha256: "b".repeat(64),
      restoredDataTreeDigestSha256: "c".repeat(64),
      sourceEnvironmentEvidenceIdentitySha256: "d".repeat(64),
      effectiveEnvironmentContentSha256: "e".repeat(64),
      replayOverlayContentSha256: "0".repeat(64),
      dataEntryCount: 1,
      dataBytes: 2,
    });
    openMock.mockResolvedValue(openedFile(attestation, 0o100444));

    const result = await createSystemReplayRestoreAttestationPort().read();

    expect(result.ok).toBe(true);

    openMock.mockResolvedValue(openedFile(attestation, 0o100644));
    const writable = await createSystemReplayRestoreAttestationPort().read();
    expect(writable.ok).toBe(false);
    if (!writable.ok) expect(writable.error.kind).toBe("restore_attestation_untrusted");
  });

  it("hashes the exact trusted machine-id bytes used by the restore controller", async () => {
    const machineId = "0123456789abcdef0123456789abcdef\n";
    const handle = openedFile(machineId, 0o100444);
    openMock.mockResolvedValue(handle);

    const result = await createSystemReplayMachineIdentityPort().readSha256();

    expect(result).toEqual({
      ok: true,
      value: createHash("sha256").update(machineId).digest("hex"),
    });
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock.mock.calls[0]?.[0]).toBe("/etc/machine-id");
    expect(openMock.mock.calls[0]?.[1] & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(handle.stat).toHaveBeenCalledTimes(2);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("rejects writable or malformed machine identity trust anchors", async () => {
    const machineId = "0123456789abcdef0123456789abcdef\n";
    openMock.mockResolvedValue(openedFile(machineId, 0o100644));

    const writable = await createSystemReplayMachineIdentityPort().readSha256();

    expect(writable.ok).toBe(false);
    if (!writable.ok) expect(writable.error.kind).toBe("machine_identity_untrusted");

    openMock.mockResolvedValue(openedFile("uninitialized\n", 0o100444));
    const malformed = await createSystemReplayMachineIdentityPort().readSha256();

    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.kind).toBe("invalid_machine_identity");
  });
});
