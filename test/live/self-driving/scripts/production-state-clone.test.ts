// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

import { err, ok } from "@comis/shared";
import { describe, expect, it } from "vitest";

import { parseProductionProfile } from "./production-profile.js";
import {
  cloneProductionState,
  type ProductionStateCloneDeps,
} from "./production-state-clone.js";
import {
  deriveProductionSnapshotDataTreeIdentity,
  deriveProductionSnapshotEnvironmentEvidenceIdentity,
  type ProductionSnapshotManifest,
} from "./production-snapshot.js";

const SOURCE_MACHINE = "a".repeat(64);
const TARGET_MACHINE = "b".repeat(64);
const PROFILE_TEXT = `
SOURCE_HOST=source-box
TARGET_HOST=test-box
SOURCE_SSH_PORT=2222
TARGET_SSH_PORT=2202
SOURCE_ROLE=production
TARGET_ROLE=test
SOURCE_COMIS_USER=comis
TARGET_COMIS_USER=comis
SOURCE_DATA=/home/comis/.comis
TARGET_DATA=/home/comis/.comis
SOURCE_SERVICE=comis
TARGET_SERVICE=comis
SOURCE_MACHINE_ID_SHA256=${SOURCE_MACHINE}
TARGET_MACHINE_ID_SHA256=${TARGET_MACHINE}
`;

function profile() {
  const parsed = parseProductionProfile(PROFILE_TEXT);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("fixture profile invalid");
  return parsed.value;
}

function manifest(runId = "state-a1"): string {
  const metadata = { uid: 1001, gid: 1001, mtimeNs: "1752560000123456789" } as const;
  const value: ProductionSnapshotManifest = {
    schemaVersion: 1,
    runId,
    sourceMachineIdSha256: SOURCE_MACHINE,
    service: "comis",
    captureMode: "offline",
    captureStartedAtMs: 1_752_560_000_000,
    captureCompletedAtMs: 1_752_560_000_100,
    freezeDurationMs: 0,
    metadataIdentity: {
      acl: "unavailable",
      xattr: "unavailable",
      capability: "unavailable",
      gaps: [
        { kind: "acl", reason: "source_tool_unavailable" },
        { kind: "xattr", reason: "source_tool_unavailable" },
        { kind: "capability", reason: "source_tool_unavailable" },
      ],
    },
    dataTreeIdentitySha256: "0".repeat(64),
    sourceEnvironmentEvidenceIdentitySha256: "0".repeat(64),
    entries: [
      { path: "data", type: "directory", mode: "0700", size: 0, ...metadata },
      {
        path: "data/memory.db",
        type: "file",
        mode: "0600",
        size: 4096,
        sha256: "c".repeat(64),
        ...metadata,
      },
      { path: "system", type: "directory", mode: "0700", size: 0, uid: 0, gid: 0, mtimeNs: metadata.mtimeNs },
      { path: "system/etc", type: "directory", mode: "0755", size: 0, uid: 0, gid: 0, mtimeNs: metadata.mtimeNs },
      { path: "system/etc/comis", type: "directory", mode: "0755", size: 0, uid: 0, gid: 0, mtimeNs: metadata.mtimeNs },
      {
        path: "system/etc/comis/env",
        type: "file",
        mode: "0640",
        size: 200,
        sha256: "d".repeat(64),
        uid: 0,
        gid: 1001,
        mtimeNs: metadata.mtimeNs,
      },
    ],
    exclusions: [
      {
        path: "data/memory.db-shm",
        type: "file",
        mode: "0600",
        size: 32768,
        reason: "sqlite_shm",
      },
    ],
  };
  return JSON.stringify({
    ...value,
    dataTreeIdentitySha256: deriveProductionSnapshotDataTreeIdentity(value),
    sourceEnvironmentEvidenceIdentitySha256:
      deriveProductionSnapshotEnvironmentEvidenceIdentity(value),
  });
}

function makeDeps(labels: string[], manifestJson = manifest()): ProductionStateCloneDeps {
  return {
    executor: {
      run: async (invocation) => {
        labels.push(invocation.label);
        if (invocation.label === "read-snapshot-manifest-source") {
          return ok({ stdout: manifestJson, exitCode: 0 });
        }
        return ok({ stdout: "", exitCode: 0 });
      },
    },
    bridge: {
      transfer: async (request) => {
        expect(request.label).toBe("snapshot-archive");
        expect(request.source).toMatchObject({ host: "source-box", port: 2222 });
        expect(request.target).toMatchObject({ host: "test-box", port: 2202 });
        return ok({ bytesTransferred: 500_000 });
      },
    },
  };
}

describe("production state clone transaction", () => {
  it("captures the inactive source and commits a verified direct restore", async () => {
    const labels: string[] = [];

    const result = await cloneProductionState(
      {
        runId: "state-a1",
        profile: profile(),
        captureMode: "offline",
        agentIds: ["default"],
      },
      makeDeps(labels),
    );

    expect(result).toEqual({
      ok: true,
      value: {
        state: "committed",
        runId: "state-a1",
        captureMode: "offline",
        manifestSha256: createHash("sha256").update(manifest()).digest("hex"),
        bytesTransferred: 500_000,
        entries: 6,
        exclusions: 1,
        dataTreeIdentitySha256: deriveProductionSnapshotDataTreeIdentity(
          JSON.parse(manifest()) as ProductionSnapshotManifest,
        ),
        sourceEnvironmentEvidenceIdentitySha256:
          deriveProductionSnapshotEnvironmentEvidenceIdentity(
            JSON.parse(manifest()) as ProductionSnapshotManifest,
          ),
        environmentConfiguration: "source_plus_replay_overlay",
        dataFileContentBytes: 4096,
        metadataIdentity: {
          fidelity: "gapped",
          acl: "unavailable",
          xattr: "unavailable",
          capability: "unavailable",
          gapKinds: ["acl", "xattr", "capability"],
        },
      },
    });
    expect(labels).toEqual([
      "capture-snapshot-source",
      "read-snapshot-manifest-source",
      "prepare-snapshot-restore-target",
      "prepare-snapshot-stream-source",
      "verify-and-promote-snapshot-target",
      "cleanup-snapshot-source",
      "commit-snapshot-target",
    ]);
  });

  it("uses source and target SSH ports for every host-specific stage", async () => {
    const invocations: Array<{
      label: string;
      host: string;
      port?: number;
      stdoutLimitBytes?: number;
    }> = [];
    const deps = makeDeps([]);

    const result = await cloneProductionState(
      {
        runId: "state-a1",
        profile: profile(),
        captureMode: "offline",
        agentIds: [],
      },
      {
        ...deps,
        executor: {
          run: async (invocation) => {
            invocations.push({
              label: invocation.label,
              host: invocation.host,
              ...(invocation.port !== undefined ? { port: invocation.port } : {}),
              ...(invocation.stdoutLimitBytes !== undefined
                ? { stdoutLimitBytes: invocation.stdoutLimitBytes }
                : {}),
            });
            return invocation.label === "read-snapshot-manifest-source"
              ? ok({ stdout: manifest(), exitCode: 0 })
              : ok({ stdout: "", exitCode: 0 });
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(invocations.filter(({ host }) => host === "source-box").every(({ port }) => port === 2222)).toBe(true);
    expect(invocations.filter(({ host }) => host === "test-box").every(({ port }) => port === 2202)).toBe(true);
    expect(
      invocations.find(({ label }) => label === "read-snapshot-manifest-source")
        ?.stdoutLimitBytes,
    ).toBe(64 * 1024 * 1024);
  });

  it("cleans source staging when manifest retrieval fails without contacting target", async () => {
    const labels: string[] = [];
    const deps = makeDeps(labels);

    const result = await cloneProductionState(
      {
        runId: "state-a1",
        profile: profile(),
        captureMode: "offline",
        agentIds: [],
      },
      {
        ...deps,
        executor: {
          run: async (invocation) => {
            labels.push(invocation.label);
            if (invocation.label === "read-snapshot-manifest-source") {
              return err({ kind: "remote", message: "secret stderr must not escape" });
            }
            return ok({ stdout: "", exitCode: 0 });
          },
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "remote_failure",
        stage: "read-snapshot-manifest-source",
        message: "Production state clone failed during read-snapshot-manifest-source",
      },
    });
    expect(labels).toEqual([
      "capture-snapshot-source",
      "read-snapshot-manifest-source",
      "cleanup-snapshot-source",
    ]);
    expect(labels.some((label) => label.includes("target"))).toBe(false);
  });

  it("rejects malformed manifest content and removes the source stage", async () => {
    const labels: string[] = [];

    const result = await cloneProductionState(
      {
        runId: "state-a1",
        profile: profile(),
        captureMode: "offline",
        agentIds: [],
      },
      makeDeps(labels, '{"secretBody":"never accepted"}'),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("manifest_failure");
    expect(labels).toEqual([
      "capture-snapshot-source",
      "read-snapshot-manifest-source",
      "cleanup-snapshot-source",
    ]);
  });
});
