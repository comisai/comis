// SPDX-License-Identifier: Apache-2.0
import { err, fromPromise, ok, type Result } from "@comis/shared";

import type { ProductionBinarySshBridge } from "./production-binary-ssh.js";
import type {
  ProductionRemoteExecutor,
  ProductionRemoteInvocation,
} from "./production-bootstrap.js";
import type { ProductionReplayProfile } from "./production-profile.js";
import {
  commitProductionRestore,
  prepareProductionRestore,
  type ProductionRestoreError,
} from "./production-restore.js";
import {
  buildProductionSnapshotPlan,
  parseProductionSnapshotManifest,
  type ProductionSnapshotMetadataKind,
  type ProductionSnapshotMetadataStatus,
  type ProductionSnapshotCaptureMode,
  type ProductionSnapshotManifest,
  type ProductionSnapshotPlan,
} from "./production-snapshot.js";

export interface ProductionStateCloneRequest {
  readonly runId: string;
  readonly profile: ProductionReplayProfile;
  readonly captureMode: ProductionSnapshotCaptureMode;
  readonly agentIds: readonly string[];
}

export interface ProductionStateCloneDeps {
  readonly executor: ProductionRemoteExecutor;
  readonly bridge: ProductionBinarySshBridge;
}

export interface ProductionStateCloneReport {
  readonly state: "committed";
  readonly runId: string;
  readonly captureMode: ProductionSnapshotCaptureMode;
  readonly manifestSha256: string;
  readonly bytesTransferred: number;
  readonly entries: number;
  readonly exclusions: number;
  readonly dataTreeIdentitySha256: string;
  readonly sourceEnvironmentEvidenceIdentitySha256: string;
  readonly environmentConfiguration: "source_plus_replay_overlay";
  /** Canonical payload bytes count each regular file once and exclude directory and hardlink sizes. */
  readonly dataFileContentBytes: number;
  readonly metadataIdentity: {
    readonly fidelity: "exact" | "gapped";
    readonly acl: ProductionSnapshotMetadataStatus;
    readonly xattr: ProductionSnapshotMetadataStatus;
    readonly capability: ProductionSnapshotMetadataStatus;
    readonly gapKinds: readonly ProductionSnapshotMetadataKind[];
  };
}

export type ProductionStateCloneError =
  | {
      readonly kind: "invalid_request";
      readonly message: string;
    }
  | {
      readonly kind: "remote_failure";
      readonly stage: string;
      readonly message: string;
    }
  | {
      readonly kind: "manifest_failure";
      readonly message: string;
    }
  | {
      readonly kind: "cleanup_failure";
      readonly message: string;
    }
  | {
      readonly kind: "restore_failure";
      readonly stage: string;
      readonly message: string;
    };

const READ_MANIFEST_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
run_id="$2"
if [ "$(id -u)" -ne 0 ]; then exit 70; fi
case "$run_id" in [A-Za-z0-9]*) ;; *) exit 68 ;; esac
case "$run_id" in *[!A-Za-z0-9_-]*) exit 68 ;; esac
if [ "$(printf '%s' "$run_id" | wc -c | tr -d ' ')" -gt 64 ]; then exit 68; fi
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then exit 71; fi
stage_root=/run/comis-self-driving
stage_dir="$stage_root/$run_id"
manifest="$stage_dir/manifest.json"
if [ -L "$stage_root" ] || [ -L "$stage_dir" ] || [ -L "$manifest" ]; then exit 72; fi
if [ "$(stat -c '%u:%a' "$stage_root" 2>/dev/null || true)" != 0:700 ] || \
   [ "$(stat -c '%u:%a' "$stage_dir" 2>/dev/null || true)" != 0:700 ] || \
   [ "$(stat -c '%u:%a' "$manifest" 2>/dev/null || true)" != 0:600 ]; then exit 73; fi
if [ ! -f "$manifest" ]; then exit 74; fi
exec /usr/bin/cat -- "$manifest"
`;

function sourceInvocation(
  request: ProductionStateCloneRequest,
  label: string,
  command: { readonly args: readonly string[]; readonly stdin: string },
): ProductionRemoteInvocation {
  return {
    label,
    host: request.profile.source.ssh,
    ...(request.profile.source.sshPort !== undefined
      ? { port: request.profile.source.sshPort }
      : {}),
    args: command.args,
    stdin: command.stdin,
  };
}

function manifestInvocation(
  request: ProductionStateCloneRequest,
): ProductionRemoteInvocation {
  return {
    label: "read-snapshot-manifest-source",
    host: request.profile.source.ssh,
    ...(request.profile.source.sshPort !== undefined
      ? { port: request.profile.source.sshPort }
      : {}),
    args: [
      "sudo",
      "bash",
      "-s",
      "--",
      request.profile.source.expectedMachineIdSha256,
      request.runId,
    ],
    stdin: READ_MANIFEST_SCRIPT,
    stdoutLimitBytes: 64 * 1024 * 1024,
  };
}

async function runRemote(
  executor: ProductionRemoteExecutor,
  command: ProductionRemoteInvocation,
  expectedOutput: "empty" | "manifest",
): Promise<Result<string, ProductionStateCloneError>> {
  const attempted = await fromPromise(Promise.resolve().then(() => executor.run(command)));
  if (!attempted.ok || !attempted.value.ok || attempted.value.value.exitCode !== 0) {
    return err({
      kind: "remote_failure",
      stage: command.label,
      message: `Production state clone failed during ${command.label}`,
    });
  }
  const stdout = attempted.value.value.stdout;
  if ((expectedOutput === "empty" && stdout !== "") || (expectedOutput === "manifest" && stdout === "")) {
    return err({
      kind: "remote_failure",
      stage: command.label,
      message: `Production state clone failed during ${command.label}`,
    });
  }
  return ok(stdout);
}

async function cleanupSnapshot(
  request: ProductionStateCloneRequest,
  plan: ProductionSnapshotPlan,
  executor: ProductionRemoteExecutor,
): Promise<Result<void, ProductionStateCloneError>> {
  const cleanup = await runRemote(
    executor,
    sourceInvocation(request, "cleanup-snapshot-source", plan.cleanup),
    "empty",
  );
  if (!cleanup.ok) {
    return err({
      kind: "cleanup_failure",
      message: "Production snapshot source cleanup failed",
    });
  }
  return ok(undefined);
}

function restoreError(error: ProductionRestoreError): ProductionStateCloneError {
  const stage = "stage" in error ? error.stage : error.kind;
  return {
    kind: "restore_failure",
    stage,
    message: "Production state restore transaction failed",
  };
}

function snapshotDataFileContentBytes(manifest: ProductionSnapshotManifest): number | null {
  let bytes = 0;
  for (const entry of manifest.entries) {
    if (entry.type !== "file" || !entry.path.startsWith("data/")) continue;
    bytes += entry.size;
    if (!Number.isSafeInteger(bytes)) return null;
  }
  return bytes;
}

const METADATA_KINDS = ["acl", "xattr", "capability"] as const;

export async function cloneProductionState(
  request: ProductionStateCloneRequest,
  deps: ProductionStateCloneDeps,
): Promise<Result<ProductionStateCloneReport, ProductionStateCloneError>> {
  const snapshot = buildProductionSnapshotPlan({
    runId: request.runId,
    expectedMachineIdSha256: request.profile.source.expectedMachineIdSha256,
    service: request.profile.source.service,
    dataDir: request.profile.source.dataDir,
    captureMode: request.captureMode,
  });
  if (!snapshot.ok) {
    return err({ kind: "invalid_request", message: "Production snapshot request is invalid" });
  }

  const captured = await runRemote(
    deps.executor,
    sourceInvocation(request, "capture-snapshot-source", snapshot.value.prepare),
    "empty",
  );
  if (!captured.ok) {
    const cleanup = await cleanupSnapshot(request, snapshot.value, deps.executor);
    return cleanup.ok ? captured : cleanup;
  }

  const manifestOutput = await runRemote(
    deps.executor,
    manifestInvocation(request),
    "manifest",
  );
  if (!manifestOutput.ok) {
    const cleanup = await cleanupSnapshot(request, snapshot.value, deps.executor);
    return cleanup.ok ? manifestOutput : cleanup;
  }
  const manifest = parseProductionSnapshotManifest(manifestOutput.value);
  if (!manifest.ok) {
    const cleanup = await cleanupSnapshot(request, snapshot.value, deps.executor);
    if (!cleanup.ok) return cleanup;
    return err({ kind: "manifest_failure", message: "Production snapshot manifest is invalid" });
  }
  const dataFileContentBytes = snapshotDataFileContentBytes(manifest.value);
  if (dataFileContentBytes === null) {
    const cleanup = await cleanupSnapshot(request, snapshot.value, deps.executor);
    if (!cleanup.ok) return cleanup;
    return err({ kind: "manifest_failure", message: "Production snapshot manifest is invalid" });
  }

  const pending = await prepareProductionRestore(
    {
      runId: request.runId,
      profile: request.profile,
      snapshot: snapshot.value,
      manifestJson: manifestOutput.value,
      agentIds: request.agentIds,
    },
    deps,
  );
  if (!pending.ok) return err(restoreError(pending.error));

  const committed = await commitProductionRestore(
    pending.value,
    {
      decision: "commit",
      runId: pending.value.runId,
      targetMachineIdSha256: pending.value.targetMachineIdSha256,
      manifestSha256: pending.value.manifestSha256,
      bytesTransferred: pending.value.bytesTransferred,
    },
    deps.executor,
  );
  if (!committed.ok) return err(restoreError(committed.error));

  return ok({
    state: "committed",
    runId: committed.value.runId,
    captureMode: request.captureMode,
    manifestSha256: pending.value.manifestSha256,
    bytesTransferred: pending.value.bytesTransferred,
    entries: manifest.value.entries.length,
    exclusions: manifest.value.exclusions.length,
    dataTreeIdentitySha256: committed.value.restoredDataTreeIdentitySha256,
    sourceEnvironmentEvidenceIdentitySha256:
      committed.value.sourceEnvironmentEvidenceIdentitySha256,
    environmentConfiguration: "source_plus_replay_overlay",
    dataFileContentBytes,
    metadataIdentity: {
      fidelity: manifest.value.metadataIdentity.gaps.length === 0 ? "exact" : "gapped",
      acl: manifest.value.metadataIdentity.acl,
      xattr: manifest.value.metadataIdentity.xattr,
      capability: manifest.value.metadataIdentity.capability,
      gapKinds: METADATA_KINDS.filter((kind) =>
        manifest.value.metadataIdentity.gaps.some((gap) => gap.kind === kind),
      ),
    },
  });
}
