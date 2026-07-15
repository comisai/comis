// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

import type {
  BinarySshEndpoint,
  ProductionBinarySshBridge,
} from "./production-binary-ssh.js";
import {
  TARGET_REPLAY_QUARANTINE_SHA256,
  type ProductionRemoteExecutor,
  type ProductionRemoteInvocation,
  type ProductionRemoteResult,
} from "./production-bootstrap.js";
import type { ProductionReplayProfile } from "./production-profile.js";
import { buildReplayQuarantineOverlay } from "./production-quarantine.js";
import {
  buildProductionSnapshotPlan,
  deriveProductionSnapshotDataTreeIdentity,
  deriveProductionSnapshotEnvironmentEvidenceIdentity,
  parseProductionSnapshotManifest,
  type ProductionSnapshotManifest,
  type ProductionSnapshotPlan,
} from "./production-snapshot.js";

export interface ProductionRestoreRequest {
  readonly runId: string;
  readonly profile: ProductionReplayProfile;
  readonly snapshot: ProductionSnapshotPlan;
  /** Content-free manifest bytes obtained from the source snapshot stage. */
  readonly manifestJson: string;
  readonly agentIds: readonly string[];
}

export interface ProductionRestoreStreamPlan {
  readonly source: BinarySshEndpoint;
  readonly target: BinarySshEndpoint;
  readonly maximumBytes: number;
}

export interface ProductionRestorePlan {
  readonly manifest: ProductionSnapshotManifest;
  readonly manifestSha256: string;
  readonly restoreAttestationExpectation: ProductionReplayRestoreAttestationExpectation;
  readonly minimumTargetFreeBytes: number;
  readonly minimumTargetFreeInodes: number;
  readonly minimumEtcFreeBytes: number;
  readonly minimumEtcFreeInodes: number;
  readonly sourceStreamPrepare: ProductionRemoteInvocation;
  readonly targetPrepare: ProductionRemoteInvocation;
  readonly stream: ProductionRestoreStreamPlan;
  readonly targetVerifyAndPromote: ProductionRemoteInvocation;
  readonly targetReadAttestation: ProductionRemoteInvocation;
  readonly targetStatus: ProductionRemoteInvocation;
  readonly targetRollback: ProductionRemoteInvocation;
  readonly targetCommit: ProductionRemoteInvocation;
  readonly targetFinalize: ProductionRemoteInvocation;
  readonly sourceCleanup: ProductionRemoteInvocation;
}

export interface ProductionReplayRestoreAttestationExpectation {
  readonly schemaVersion: 1;
  readonly state: "committed";
  readonly runId: string;
  readonly targetMachineIdSha256: string;
  readonly baselineImmutable: true;
  readonly dataDirSha256: string;
  readonly snapshotManifestSha256: string;
  readonly restoredDataTreeDigestSha256: string;
  readonly sourceEnvironmentEvidenceIdentitySha256: string;
  readonly replayOverlayContentSha256: string;
  readonly dataEntryCount: number;
  readonly dataBytes: number;
}

/** Strict content-free seal emitted from the promoted target filesystem. */
export interface ProductionReplayRestoreAttestation
  extends ProductionReplayRestoreAttestationExpectation {
  readonly effectiveEnvironmentContentSha256: string;
}

export interface ProductionReplayRestoreAttestationError {
  readonly kind: "malformed_restore_attestation";
  readonly message: string;
}

export type ProductionRestoreDurableState =
  | "absent"
  | "prepared"
  | "received"
  | "promoting"
  | "promoted"
  | "authorized"
  | "rolling_back"
  | "finalizing"
  | "finalized"
  | "rolled_back";

export interface ProductionRestoreStatus {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly targetMachineIdSha256: string;
  readonly state: ProductionRestoreDurableState;
  readonly bytesTransferred: number | null;
  readonly restoreAttestation: ProductionReplayRestoreAttestation | null;
  readonly restoreAttestationSha256: string | null;
}

export interface ProductionRestoreRecoveryRequest {
  readonly runId: string;
  readonly profile: ProductionReplayProfile;
}

const RESTORE_ATTESTATION_KEYS = [
  "schemaVersion",
  "state",
  "runId",
  "targetMachineIdSha256",
  "baselineImmutable",
  "dataDirSha256",
  "snapshotManifestSha256",
  "restoredDataTreeDigestSha256",
  "sourceEnvironmentEvidenceIdentitySha256",
  "effectiveEnvironmentContentSha256",
  "replayOverlayContentSha256",
  "dataEntryCount",
  "dataBytes",
] as const;

/** Parses the root-only target seal without accepting content-bearing extensions. */
export function parseProductionReplayRestoreAttestation(
  raw: string,
): Result<ProductionReplayRestoreAttestation, ProductionReplayRestoreAttestationError> {
  if (Buffer.byteLength(raw, "utf8") > 4096) {
    return err({
      kind: "malformed_restore_attestation",
      message: "Production restore attestation exceeds the size limit",
    });
  }
  const parsed = tryCatch<unknown>(() => JSON.parse(raw));
  const value = parsed.ok ? parsed.value : undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err({
      kind: "malformed_restore_attestation",
      message: "Production restore attestation is not a strict object",
    });
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [...RESTORE_ATTESTATION_KEYS].sort();
  const digests = [
    record["targetMachineIdSha256"],
    record["dataDirSha256"],
    record["snapshotManifestSha256"],
    record["restoredDataTreeDigestSha256"],
    record["sourceEnvironmentEvidenceIdentitySha256"],
    record["effectiveEnvironmentContentSha256"],
    record["replayOverlayContentSha256"],
  ];
  if (
    keys.join("\0") !== expectedKeys.join("\0") ||
    record["schemaVersion"] !== 1 ||
    record["state"] !== "committed" ||
    typeof record["runId"] !== "string" ||
    !SAFE_RUN_ID_RE.test(record["runId"]) ||
    record["baselineImmutable"] !== true ||
    digests.some((digest) => typeof digest !== "string" || !SHA256_RE.test(digest)) ||
    !Number.isSafeInteger(record["dataEntryCount"]) ||
    (record["dataEntryCount"] as number) <= 0 ||
    !Number.isSafeInteger(record["dataBytes"]) ||
    (record["dataBytes"] as number) < 0
  ) {
    return err({
      kind: "malformed_restore_attestation",
      message: "Production restore attestation fields are invalid",
    });
  }
  return ok(record as unknown as ProductionReplayRestoreAttestation);
}

const RESTORE_DURABLE_STATES = new Set<ProductionRestoreDurableState>([
  "absent",
  "prepared",
  "received",
  "promoting",
  "promoted",
  "authorized",
  "rolling_back",
  "finalizing",
  "finalized",
  "rolled_back",
]);

export function parseProductionRestoreStatus(
  raw: string,
): Result<ProductionRestoreStatus, ProductionRestoreError> {
  if (Buffer.byteLength(raw, "utf8") > 8192) {
    return err({
      kind: "invalid_restore_status",
      stage: "inspect-snapshot-target",
      message: "Restore status exceeds the size limit",
    });
  }
  const parsed = tryCatch<unknown>(() => JSON.parse(raw));
  const value = parsed.ok ? parsed.value : undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err({
      kind: "invalid_restore_status",
      stage: "inspect-snapshot-target",
      message: "Restore status is not a strict object",
    });
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "bytesTransferred",
    "restoreAttestationBase64",
    "restoreAttestationSha256",
    "runId",
    "schemaVersion",
    "state",
    "targetMachineIdSha256",
  ].sort();
  const state = record["state"];
  const bytesTransferred = record["bytesTransferred"];
  const encodedAttestation = record["restoreAttestationBase64"];
  const attestationSha256 = record["restoreAttestationSha256"];
  if (
    Object.keys(record).sort().join("\0") !== expectedKeys.join("\0") ||
    record["schemaVersion"] !== 1 ||
    typeof record["runId"] !== "string" ||
    !SAFE_RUN_ID_RE.test(record["runId"]) ||
    typeof record["targetMachineIdSha256"] !== "string" ||
    !SHA256_RE.test(record["targetMachineIdSha256"]) ||
    typeof state !== "string" ||
    !RESTORE_DURABLE_STATES.has(state as ProductionRestoreDurableState) ||
    (bytesTransferred !== null &&
      (!Number.isSafeInteger(bytesTransferred) || (bytesTransferred as number) <= 0)) ||
    (encodedAttestation !== null && typeof encodedAttestation !== "string") ||
    (attestationSha256 !== null &&
      (typeof attestationSha256 !== "string" || !SHA256_RE.test(attestationSha256))) ||
    (encodedAttestation === null) !== (attestationSha256 === null)
  ) {
    return err({
      kind: "invalid_restore_status",
      stage: "inspect-snapshot-target",
      message: "Restore status fields are invalid",
    });
  }
  const durableState = state as ProductionRestoreDurableState;
  const hasBytes = typeof bytesTransferred === "number";
  const hasAttestation = typeof encodedAttestation === "string";
  const phaseEvidenceIsValid =
    ((durableState === "absent" || durableState === "prepared" || durableState === "rolled_back") &&
      !hasBytes &&
      !hasAttestation) ||
    (durableState === "received" && hasBytes && !hasAttestation) ||
    (durableState === "promoting" && hasBytes) ||
    durableState === "rolling_back" ||
    ((durableState === "promoted" ||
      durableState === "authorized" ||
      durableState === "finalizing" ||
      durableState === "finalized") &&
      hasBytes &&
      hasAttestation);
  if (!phaseEvidenceIsValid) {
    return err({
      kind: "invalid_restore_status",
      stage: "inspect-snapshot-target",
      message: "Restore status phase evidence is inconsistent",
    });
  }
  let restoreAttestation: ProductionReplayRestoreAttestation | null = null;
  if (typeof encodedAttestation === "string" && typeof attestationSha256 === "string") {
    const attestationRaw = Buffer.from(encodedAttestation, "base64").toString("utf8");
    if (
      Buffer.from(attestationRaw, "utf8").toString("base64") !== encodedAttestation ||
      createHash("sha256").update(attestationRaw, "utf8").digest("hex") !==
        attestationSha256
    ) {
      return err({
        kind: "invalid_restore_status",
        stage: "inspect-snapshot-target",
        message: "Restore status attestation digest is invalid",
      });
    }
    const attestation = parseProductionReplayRestoreAttestation(attestationRaw);
    if (
      !attestation.ok ||
      attestation.value.runId !== record["runId"] ||
      attestation.value.targetMachineIdSha256 !== record["targetMachineIdSha256"]
    ) {
      return err({
        kind: "invalid_restore_status",
        stage: "inspect-snapshot-target",
        message: "Restore status attestation identity is invalid",
      });
    }
    restoreAttestation = attestation.value;
  }
  return ok({
    schemaVersion: 1,
    runId: record["runId"] as string,
    targetMachineIdSha256: record["targetMachineIdSha256"] as string,
    state: durableState,
    bytesTransferred: (bytesTransferred as number | null),
    restoreAttestation,
    restoreAttestationSha256: attestationSha256 as string | null,
  });
}

export interface PendingProductionRestore {
  readonly state: "awaiting-attestation";
  readonly runId: string;
  readonly targetMachineIdSha256: string;
  readonly manifestSha256: string;
  readonly bytesTransferred: number;
  readonly restoredDataTreeIdentitySha256: string;
  readonly sourceEnvironmentEvidenceIdentitySha256: string;
  readonly restoreAttestation: ProductionReplayRestoreAttestation;
  readonly restoreAttestationSha256: string;
  readonly targetCommit: ProductionRemoteInvocation;
  readonly targetFinalize: ProductionRemoteInvocation;
  readonly targetStatus: ProductionRemoteInvocation;
  readonly targetRollback: ProductionRemoteInvocation;
}

export interface ProductionRestoreCommitAttestation {
  readonly decision: "commit";
  readonly runId: string;
  readonly targetMachineIdSha256: string;
  readonly manifestSha256: string;
  readonly bytesTransferred: number;
  readonly restoreAttestationSha256: string;
}

export interface CommittedProductionRestore {
  readonly runId: string;
  readonly state: "committed";
  readonly restoredDataTreeIdentitySha256: string;
  readonly sourceEnvironmentEvidenceIdentitySha256: string;
}

export interface ProductionRestoreDeps {
  readonly executor: ProductionRemoteExecutor;
  readonly bridge: ProductionBinarySshBridge;
}

export type ProductionRestoreError =
  | {
      readonly kind: "invalid_request";
      readonly field: string;
      readonly message: string;
    }
  | {
      readonly kind: "remote_failure";
      readonly stage: string;
      readonly message: string;
    }
  | {
      readonly kind: "transfer_failure";
      readonly stage: "snapshot-archive";
      readonly message: string;
    }
  | {
      readonly kind: "source_cleanup_failure";
      readonly stage: "cleanup-snapshot-source";
      readonly message: string;
    }
  | {
      readonly kind: "rollback_failure";
      readonly stage: "rollback-snapshot-target";
      readonly message: string;
    }
  | {
      readonly kind: "attestation_required";
      readonly message: string;
    }
  | {
      readonly kind: "attestation_failure";
      readonly stage: "read-promoted-snapshot-attestation";
      readonly message: string;
    }
  | {
      readonly kind: "finalization_failure";
      readonly stage: "finalize-snapshot-target";
      readonly message: string;
    }
  | {
      readonly kind: "commit_state_unknown";
      readonly stage: "commit-snapshot-target";
      readonly message: string;
    }
  | {
      readonly kind: "invalid_restore_status";
      readonly stage: "inspect-snapshot-target";
      readonly message: string;
    };

const SAFE_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SAFE_REMOTE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.@-]*$/u;
const SAFE_REMOTE_PATH_CHARS_RE = /^\/[A-Za-z0-9._/-]+$/u;
const SAFE_SSH_COMPONENT_RE = /^[A-Za-z0-9._-]+$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const ARCHIVE_ENTRY_OVERHEAD_BYTES = 64 * 1024;
const ARCHIVE_FIXED_OVERHEAD_BYTES = 64 * 1024 * 1024;
const RESTORE_WORKSPACE_OVERHEAD_BYTES = 64 * 1024 * 1024;
const MAXIMUM_RESTORE_BYTES = 8 * 1024 * 1024 * 1024 * 1024;
const MAXIMUM_RESTORE_HEADROOM_BYTES =
  MAXIMUM_RESTORE_BYTES * 6 + RESTORE_WORKSPACE_OVERHEAD_BYTES;
const RESTORE_INODE_OVERHEAD = 128;
const ETC_RESTORE_OVERHEAD_BYTES = 64 * 1024 * 1024;
const ETC_RESTORE_INODE_OVERHEAD = 32;
const DATA_DIR_DIGEST_DOMAIN = "comis-replay-data-dir-v1\0";
const FIXED_RESTORE_CONTROL_ROOTS = [
  "/etc/comis",
  "/var/lib/comis-self-driving",
  "/run/comis-self-driving",
  "/.comis-self-driving",
] as const;

function invalidRequest(
  field: string,
  message: string,
): Result<never, ProductionRestoreError> {
  return err({ kind: "invalid_request", field, message });
}

function isSafeRemotePath(value: string): boolean {
  if (!SAFE_REMOTE_PATH_CHARS_RE.test(value)) return false;
  return !value
    .slice(1)
    .split("/")
    .some((segment) => segment === "" || segment === "." || segment === "..");
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function isSafeSshTarget(value: string): boolean {
  const parts = value.split("@");
  if (parts.length > 2) return false;
  const host = parts.at(-1);
  const user = parts.length === 2 ? parts[0] : undefined;
  return (
    host !== undefined &&
    /^[A-Za-z0-9]/u.test(host) &&
    SAFE_SSH_COMPONENT_RE.test(host) &&
    (user === undefined || SAFE_SSH_COMPONENT_RE.test(user))
  );
}

function sshHostIdentity(value: string): string {
  return (value.split("@").at(-1) ?? "").toLowerCase();
}

function invocation(
  label: string,
  host: ProductionReplayProfile["source"] | ProductionReplayProfile["target"],
  args: readonly string[],
  stdin: string,
): ProductionRemoteInvocation {
  return {
    label,
    host: host.ssh,
    ...(host.sshPort !== undefined ? { port: host.sshPort } : {}),
    args,
    stdin,
  };
}

function endpoint(
  host: ProductionReplayProfile["source"] | ProductionReplayProfile["target"],
  args: readonly string[],
): BinarySshEndpoint {
  return {
    host: host.ssh,
    ...(host.sshPort !== undefined ? { port: host.sshPort } : {}),
    args,
  };
}

function calculateMaximumArchiveBytes(
  manifest: ProductionSnapshotManifest,
  manifestBytes: number,
): Result<number, ProductionRestoreError> {
  let fileBytes = manifestBytes;
  for (const entry of manifest.entries) {
    if (entry.type !== "file") continue;
    fileBytes += entry.size;
    if (!Number.isSafeInteger(fileBytes)) {
      return invalidRequest("manifestJson", "Snapshot byte total exceeds the safe integer range");
    }
  }
  const recordCount = manifest.entries.length + manifest.exclusions.length + 1;
  const maximumBytes =
    fileBytes +
    recordCount * ARCHIVE_ENTRY_OVERHEAD_BYTES +
    ARCHIVE_FIXED_OVERHEAD_BYTES;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= fileBytes ||
    maximumBytes > MAXIMUM_RESTORE_BYTES
  ) {
    return invalidRequest("manifestJson", "Snapshot archive bound is unsafe");
  }
  return ok(maximumBytes);
}

function calculateMinimumTargetFreeBytes(
  manifest: ProductionSnapshotManifest,
  maximumArchiveBytes: number,
  manifestBytes: number,
): Result<number, ProductionRestoreError> {
  let extractedFileBytes = 0;
  for (const entry of manifest.entries) {
    if (entry.type !== "file") continue;
    extractedFileBytes += entry.size;
    if (!Number.isSafeInteger(extractedFileBytes)) {
      return invalidRequest("manifestJson", "Snapshot extraction total exceeds the safe integer range");
    }
  }
  const environmentEntry = manifest.entries.find(
    (entry) => entry.path === "system/etc/comis/env" && entry.type === "file",
  );
  if (environmentEntry === undefined || environmentEntry.type !== "file") {
    return invalidRequest("manifestJson", "Snapshot environment entry is missing");
  }
  const minimumFreeBytes =
    maximumArchiveBytes +
    extractedFileBytes * 2 +
    environmentEntry.size +
    manifestBytes * 2 +
    RESTORE_WORKSPACE_OVERHEAD_BYTES;
  if (
    !Number.isSafeInteger(minimumFreeBytes) ||
    minimumFreeBytes <= maximumArchiveBytes ||
    minimumFreeBytes > MAXIMUM_RESTORE_HEADROOM_BYTES
  ) {
    return invalidRequest("manifestJson", "Snapshot restore headroom bound is unsafe");
  }
  return ok(minimumFreeBytes);
}

function calculateMinimumTargetFreeInodes(
  manifest: ProductionSnapshotManifest,
): Result<number, ProductionRestoreError> {
  const minimum = manifest.entries.length + RESTORE_INODE_OVERHEAD;
  if (!Number.isSafeInteger(minimum) || minimum <= manifest.entries.length) {
    return invalidRequest("manifestJson", "Snapshot restore inode bound is unsafe");
  }
  return ok(minimum);
}

function calculateMinimumEtcFreeBytes(
  manifest: ProductionSnapshotManifest,
): Result<number, ProductionRestoreError> {
  const environmentEntry = manifest.entries.find(
    (entry) => entry.path === "system/etc/comis/env" && entry.type === "file",
  );
  if (environmentEntry === undefined || environmentEntry.type !== "file") {
    return invalidRequest("manifestJson", "Snapshot environment entry is missing");
  }
  const minimum = environmentEntry.size + ETC_RESTORE_OVERHEAD_BYTES;
  if (!Number.isSafeInteger(minimum) || minimum <= environmentEntry.size) {
    return invalidRequest("manifestJson", "Snapshot /etc restore bound is unsafe");
  }
  return ok(minimum);
}

function buildRestoreAttestationExpectation(
  runId: string,
  targetMachineIdSha256: string,
  dataDir: string,
  manifest: ProductionSnapshotManifest,
  manifestSha256: string,
  overlayYaml: string,
): ProductionReplayRestoreAttestationExpectation {
  return {
    schemaVersion: 1,
    state: "committed",
    runId,
    targetMachineIdSha256,
    baselineImmutable: true,
    dataDirSha256: createHash("sha256")
      .update(DATA_DIR_DIGEST_DOMAIN)
      .update(dataDir)
      .digest("hex"),
    snapshotManifestSha256: manifestSha256,
    restoredDataTreeDigestSha256: deriveProductionSnapshotDataTreeIdentity(manifest),
    sourceEnvironmentEvidenceIdentitySha256:
      deriveProductionSnapshotEnvironmentEvidenceIdentity(manifest),
    replayOverlayContentSha256: createHash("sha256").update(overlayYaml).digest("hex"),
    dataEntryCount: manifest.entries.filter(
      (entry) => entry.path === "data" || entry.path.startsWith("data/"),
    ).length,
    dataBytes: manifest.entries.reduce(
      (total, entry) =>
        total +
        (entry.type === "file" && entry.path.startsWith("data/") ? entry.size : 0),
      0,
    ),
  };
}

const TARGET_MOUNT_OVERLAP_GUARD = String.raw`paths_overlap() {
  case "$1/" in "$2/"*) return 0 ;; esac
  case "$2/" in "$1/"*) return 0 ;; esac
  return 1
}
for protected_root in /etc/comis "$coordination_root" "$runtime_root" "$state_root"; do
  if paths_overlap "$data_dir" "$protected_root"; then exit 77; fi
done
mount_overlap_status=0
python3 - "$data_dir" /etc/comis "$coordination_root" "$runtime_root" "$state_root" \
  <<'PYTHON_MOUNT_OVERLAP' || mount_overlap_status=$?
import posixpath
import re
import sys
from typing import NamedTuple

class Mount(NamedTuple):
    mount_id: int
    device: str
    root: str
    target: str

def decode_mount_path(value: str) -> str:
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), value)

def normalize(path: str) -> str:
    normalized = posixpath.normpath(path)
    if not normalized.startswith("/"):
        raise ValueError("mount path is not absolute")
    return normalized

def beneath(path: str, root: str) -> bool:
    return root == "/" or path == root or path.startswith(root + "/")

def coordinate(path: str, mount: Mount) -> str:
    relative = posixpath.relpath(path, mount.target)
    if relative == ".":
        return mount.root
    result = normalize(posixpath.join(mount.root, relative))
    if result == ".." or result.startswith("../"):
        raise ValueError("mount coordinate escaped its filesystem root")
    return result

try:
    mounts: list[Mount] = []
    with open("/proc/self/mountinfo", "r", encoding="utf8") as mountinfo:
        for raw_line in mountinfo:
            left, separator, _right = raw_line.rstrip("\n").partition(" - ")
            fields = left.split()
            if separator == "" or len(fields) < 6:
                raise ValueError("malformed mountinfo record")
            mounts.append(Mount(
                mount_id=int(fields[0]),
                device=fields[2],
                root=normalize(decode_mount_path(fields[3])),
                target=normalize(decode_mount_path(fields[4])),
            ))
    if not mounts:
        raise ValueError("mountinfo is empty")

    def mount_regions(path: str) -> list[tuple[str, str]]:
        normalized_path = normalize(path)
        containing = [mount for mount in mounts if beneath(normalized_path, mount.target)]
        if not containing:
            raise ValueError("path has no containing mount")
        selected = max(containing, key=lambda mount: (len(mount.target), mount.mount_id))
        regions = [(selected.device, coordinate(normalized_path, selected))]
        regions.extend(
            (mount.device, mount.root)
            for mount in mounts
            if mount.target != normalized_path and beneath(mount.target, normalized_path)
        )
        return regions

    data_regions = mount_regions(sys.argv[1])
    for protected_path in sys.argv[2:]:
        for data_device, data_root in data_regions:
            for protected_device, protected_root in mount_regions(protected_path):
                if data_device == protected_device and (
                    beneath(data_root, protected_root) or beneath(protected_root, data_root)
                ):
                    raise SystemExit(10)
except SystemExit:
    raise
except Exception:
    raise SystemExit(11)
PYTHON_MOUNT_OVERLAP
case "$mount_overlap_status" in
  0) ;;
  10) exit 77 ;;
  *) exit 79 ;;
esac
`;

const TARGET_GUARD = String.raw`if [ "$(id -u)" -ne 0 ] || [ "$(uname -s)" != Linux ]; then exit 70; fi
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then exit 71; fi
role_marker=/etc/comis/environment-role
if [ -L "$role_marker" ] || [ "$(cat "$role_marker" 2>/dev/null || true)" != test ] || \
   [ "$(stat -c '%u:%g:%a:%s' "$role_marker" 2>/dev/null || true)" != 0:0:644:5 ]; then
  exit 72
fi
case "$service" in *.service) unit="$service" ;; *) unit="$service.service" ;; esac
load_state="$(systemctl show "$unit" --property=LoadState --value 2>/dev/null || true)"
active_state="$(systemctl is-active "$unit" 2>/dev/null || true)"
enabled_state="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
if [ "$load_state" != loaded ] || [ "$active_state" != inactive ] || \
   [ "$enabled_state" != disabled ]; then exit 73; fi
quarantine="/etc/systemd/system/$unit.d/90-comis-replay-quarantine.conf"
if [ -L "$quarantine" ] || [ ! -f "$quarantine" ] || \
   [ "$(stat -c '%u:%g:%a' "$quarantine" 2>/dev/null || true)" != 0:0:644 ] || \
   [ "$(sha256sum "$quarantine" 2>/dev/null | awk '{print $1}')" != ${TARGET_REPLAY_QUARANTINE_SHA256} ]; then
  exit 74
fi
drop_in_paths="$(systemctl show "$unit" --property=DropInPaths --value 2>/dev/null || true)"
quarantine_seen=0
last_drop_in=
for drop_in in $drop_in_paths; do
  last_drop_in="$drop_in"
  if [ "$drop_in" = "$quarantine" ]; then quarantine_seen=1; fi
done
if [ "$quarantine_seen" -ne 1 ] || [ "$last_drop_in" != "$quarantine" ]; then exit 74; fi
require_effective_property() {
  property="$1"
  expected="$2"
  actual="$(systemctl show "$unit" --property="$property" --value 2>/dev/null || true)"
  if [ "$actual" != "$expected" ]; then exit 74; fi
}
require_effective_property PrivateNetwork yes
require_effective_property RestrictAddressFamilies AF_UNIX
require_effective_property PrivateDevices yes
require_effective_property PrivateTmp yes
require_effective_property PrivateMounts yes
require_effective_property ProtectSystem strict
require_effective_property ProtectHome read-only
require_effective_property NoNewPrivileges yes
require_effective_property ProtectKernelTunables yes
require_effective_property ProtectControlGroups yes
require_effective_property SocketBindDeny any
require_effective_property CapabilityBoundingSet ''
require_effective_property AmbientCapabilities ''
require_effective_property RestrictNamespaces yes
require_effective_property ReadWritePaths /run/comis-replay
require_effective_property UMask 0077
etc_comis_mode="$(stat -c '%a' /etc/comis 2>/dev/null || true)"
case "$etc_comis_mode" in ''|*[!0-7]*) exit 75 ;; esac
if [ ! -d /etc/comis ] || [ -L /etc/comis ] || \
   [ "$(stat -c '%u:%g' /etc/comis 2>/dev/null || true)" != 0:0 ] || \
   [ "$(( 0$etc_comis_mode & 0022 ))" -ne 0 ]; then
  exit 75
fi
case "$run_id" in [A-Za-z0-9]*) ;; *) exit 76 ;; esac
case "$run_id" in *[!A-Za-z0-9_-]*) exit 76 ;; esac
if [ "$(printf '%s' "$run_id" | wc -c | tr -d ' ')" -gt 64 ]; then exit 76; fi
canonical_data_dir="$(realpath -m -- "$data_dir")"
if [ "$canonical_data_dir" != "$data_dir" ] || [ "$data_dir" = / ]; then exit 77; fi
if ! id "$service_user" >/dev/null 2>&1; then exit 78; fi
service_group_id="$(id -g "$service_user")"
data_parent="$(dirname -- "$data_dir")"
data_mount="$(findmnt -n -o TARGET --target "$data_parent")"
if [ -z "$data_mount" ]; then exit 79; fi
if [ "$data_mount" = / ]; then
  state_root=/.comis-self-driving
else
  state_root="$data_mount/.comis-self-driving"
fi
control_dir="$state_root/restore-$run_id"
coordination_root=/var/lib/comis-self-driving
active_restore="$coordination_root/active-restore"
current_restore="$coordination_root/current-restore"
current_restore_incoming="$coordination_root/.current-restore-$run_id"
operation_lock="$coordination_root/restore-operation.lock"
owner_marker="$coordination_root/restore-$run_id.owner"
coordination_identity="$coordination_root/restore-$run_id.identity"
expected_data_dir_sha256="$(python3 - "$data_dir" <<'PYTHON_DATA_DIR_CANDIDATE'
import hashlib
import sys

print(hashlib.sha256(b"comis-replay-data-dir-v1\0" + sys.argv[1].encode("utf8")).hexdigest())
PYTHON_DATA_DIR_CANDIDATE
)"
coordination_identity_scratch="$coordination_root/.restore-$run_id-$expected_data_dir_sha256.identity.scratch"
coordination_identity_candidate="$coordination_root/.restore-$run_id.identity.incoming"
runtime_root=/run/comis-self-driving
runtime_dir="$runtime_root/restore-$run_id"
${TARGET_MOUNT_OVERLAP_GUARD}
if [ -L "$state_root" ] || [ -L "$coordination_root" ] || [ -L "$runtime_root" ]; then
  exit 79
fi
if [ -e "$state_root" ] && \
   { [ ! -d "$state_root" ] || [ "$(stat -c '%u:%g:%a' "$state_root")" != 0:0:700 ]; }; then
  exit 79
fi
if [ -e "$runtime_root" ] && \
   { [ ! -d "$runtime_root" ] || [ "$(stat -c '%u:%g:%a' "$runtime_root")" != 0:0:700 ]; }; then
  exit 79
fi
if [ -e "$coordination_root" ] && \
   { [ ! -d "$coordination_root" ] || \
     [ "$(stat -c '%u:%g:%a' "$coordination_root")" != 0:0:700 ]; }; then
  exit 79
fi
if [ -e "$control_dir" ] && \
   { [ ! -d "$control_dir" ] || [ "$(stat -c '%u:%g:%a' "$control_dir")" != 0:0:700 ]; }; then
  exit 79
fi
archive="$control_dir/snapshot.tar"
extract_dir="$control_dir/extracted"
transaction_marker="$control_dir/transaction-owned"
transaction_identity="$control_dir/transaction-identity"
expected_manifest="$control_dir/expected-manifest.json"
source_env_copy="$control_dir/source-env.original"
attestation_path="$control_dir/replay-attestation.json"
expected_overlay_sha="$control_dir/replay-overlay.sha256"
data_was_immutable="$control_dir/data-was-immutable"
old_data_unlocked="$control_dir/old-data-root-unlocked"
bytes_received_path="$control_dir/bytes-received"
incoming_data="$data_dir.restore-$run_id"
rollback_data="$control_dir/rollback-data"
env_path=/etc/comis/env
env_incoming="/etc/comis/.env.incoming-$run_id"
env_rollback="/etc/comis/.env.rollback-$run_id"
overlay_path=/etc/comis/replay-quarantine.yaml
overlay_incoming="/etc/comis/.replay-quarantine.incoming-$run_id"
overlay_rollback="/etc/comis/.replay-quarantine.rollback-$run_id"
seal_path=/etc/comis/replay-restore-attestation.json
seal_incoming="/etc/comis/.replay-restore-attestation.incoming-$run_id"
seal_rollback="/etc/comis/.replay-restore-attestation.rollback-$run_id"
reattest_script="$control_dir/reattest-restored-state.py"
commit_authorized="$control_dir/commit-authorized"
promoting_marker="$control_dir/promoting"
rolling_back_marker="$control_dir/rolling-back"
finalizing_marker="$control_dir/finalizing"
finalized_marker="$control_dir/finalized"
rolled_back_marker="$control_dir/rolled-back"
if [ -f "$expected_manifest" ] && [ ! -L "$expected_manifest" ]; then
  expected_service_identity="$(python3 -c '
import json
import sys
manifest = json.load(open(sys.argv[1], "r", encoding="utf8"))
entry = next(entry for entry in manifest["entries"] if entry["path"] == "data")
print(str(entry["uid"]) + ":" + str(entry["gid"]))
' "$expected_manifest")"
  actual_service_identity="$(id -u "$service_user"):$(id -g "$service_user")"
  case "$expected_service_identity" in
    ''|*[!0-9:]*) exit 78 ;;
  esac
  if [ "$actual_service_identity" != "$expected_service_identity" ]; then exit 78; fi
fi
`;

const TARGET_TRANSACTION_IDENTITY_EXPECTATION = String.raw`expected_data_dir_sha256="$(python3 - "$data_dir" <<'PYTHON_DATA_DIR_IDENTITY'
import hashlib
import sys

print(hashlib.sha256(b"comis-replay-data-dir-v1\0" + sys.argv[1].encode("utf8")).hexdigest())
PYTHON_DATA_DIR_IDENTITY
)"
expected_transaction_identity="$(printf 'schemaVersion=1\nrunId=%s\ntargetMachineIdSha256=%s\ndataDirSha256=%s\nservice=%s\nserviceUser=%s\n' \
  "$run_id" "$expected_machine" "$expected_data_dir_sha256" "$unit" "$service_user")"
`;

const TARGET_TRANSACTION_IDENTITY_GUARD = String.raw`${TARGET_TRANSACTION_IDENTITY_EXPECTATION}
for identity_path in "$transaction_identity" "$coordination_identity"; do
  if [ ! -f "$identity_path" ] || [ -L "$identity_path" ] || \
     [ "$(stat -c '%u:%g:%a' "$identity_path" 2>/dev/null || true)" != 0:0:400 ] || \
     [ "$(stat -c '%s' "$identity_path" 2>/dev/null || true)" -gt 512 ] || \
     [ "$(cat "$identity_path" 2>/dev/null || true)" != "$expected_transaction_identity" ]; then
    exit 79
  fi
done
if ! cmp -s -- "$transaction_identity" "$coordination_identity"; then exit 79; fi
`;

const TARGET_TRANSACTION_OWNERSHIP_GUARD = String.raw`if [ -e "$active_restore" ] || [ -L "$active_restore" ]; then
  if [ ! -f "$active_restore" ] || [ -L "$active_restore" ] || \
     [ "$(stat -c '%u:%g:%a' "$active_restore" 2>/dev/null || true)" != 0:0:400 ] || \
     [ "$(cat "$active_restore" 2>/dev/null || true)" != "$run_id" ] || \
     [ ! -f "$owner_marker" ] || [ -L "$owner_marker" ] || \
     [ "$(stat -c '%u:%g:%a' "$owner_marker" 2>/dev/null || true)" != 0:0:400 ] || \
     [ "$(cat "$owner_marker" 2>/dev/null || true)" != "$run_id" ] || \
     [ "$(stat -c '%d:%i' "$active_restore" 2>/dev/null || true)" != \
       "$(stat -c '%d:%i' "$owner_marker" 2>/dev/null || true)" ]; then exit 79; fi
else
  terminal_state_valid=0
  if [ -f "$finalized_marker" ] && [ ! -L "$finalized_marker" ] && \
     [ "$(stat -c '%u:%g:%a' "$finalized_marker" 2>/dev/null || true)" = 0:0:400 ] && \
     [ "$(cat "$finalized_marker" 2>/dev/null || true)" = finalized ] && \
     [ -f "$current_restore" ] && [ ! -L "$current_restore" ] && \
     [ -f "$owner_marker" ] && [ ! -L "$owner_marker" ] && \
     [ "$(stat -c '%u:%g:%a' "$current_restore" 2>/dev/null || true)" = 0:0:400 ] && \
     [ "$(cat "$current_restore" 2>/dev/null || true)" = "$run_id" ] && \
     [ "$(stat -c '%d:%i' "$current_restore" 2>/dev/null || true)" = \
       "$(stat -c '%d:%i' "$owner_marker" 2>/dev/null || true)" ]; then
    terminal_state_valid=1
  fi
  if [ -f "$rolled_back_marker" ] && [ ! -L "$rolled_back_marker" ] && \
     [ "$(stat -c '%u:%g:%a' "$rolled_back_marker" 2>/dev/null || true)" = 0:0:400 ] && \
     [ "$(cat "$rolled_back_marker" 2>/dev/null || true)" = rolled-back ]; then
    terminal_state_valid=1
  fi
  if [ "$terminal_state_valid" -ne 1 ]; then exit 79; fi
fi
`;

const TARGET_TRANSACTION_GUARD = String.raw`if [ -L "$operation_lock" ] || \
   [ ! -f "$operation_lock" ] || \
   [ "$(stat -c '%u:%g:%a' "$operation_lock" 2>/dev/null || true)" != 0:0:600 ]; then
  exit 79
fi
exec 9<>"$operation_lock"
if ! flock -n 9; then exit 79; fi
${TARGET_TRANSACTION_IDENTITY_GUARD}
${TARGET_TRANSACTION_OWNERSHIP_GUARD}`;

const TARGET_RECOVERY_GUARD = String.raw`if [ "$(id -u)" -ne 0 ] || [ "$(uname -s)" != Linux ]; then exit 70; fi
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then exit 71; fi
case "$service" in *.service) unit="$service" ;; *) unit="$service.service" ;; esac
case "$run_id" in [A-Za-z0-9]*) ;; *) exit 76 ;; esac
case "$run_id" in *[!A-Za-z0-9_-]*) exit 76 ;; esac
if [ "$(printf '%s' "$run_id" | wc -c | tr -d ' ')" -gt 64 ]; then exit 76; fi
canonical_data_dir="$(realpath -m -- "$data_dir")"
if [ "$canonical_data_dir" != "$data_dir" ] || [ "$data_dir" = / ]; then exit 77; fi
if ! id "$service_user" >/dev/null 2>&1; then exit 78; fi
service_group_id="$(id -g "$service_user")"
etc_comis_mode="$(stat -c '%a' /etc/comis 2>/dev/null || true)"
case "$etc_comis_mode" in ''|*[!0-7]*) exit 75 ;; esac
if [ ! -d /etc/comis ] || [ -L /etc/comis ] || \
   [ "$(stat -c '%u:%g' /etc/comis 2>/dev/null || true)" != 0:0 ] || \
   [ "$(( 0$etc_comis_mode & 0022 ))" -ne 0 ]; then
  exit 75
fi
data_parent="$(dirname -- "$data_dir")"
data_mount="$(findmnt -n -o TARGET --target "$data_parent")"
if [ -z "$data_mount" ]; then exit 79; fi
if [ "$data_mount" = / ]; then
  state_root=/.comis-self-driving
else
  state_root="$data_mount/.comis-self-driving"
fi
control_dir="$state_root/restore-$run_id"
coordination_root=/var/lib/comis-self-driving
active_restore="$coordination_root/active-restore"
current_restore="$coordination_root/current-restore"
current_restore_incoming="$coordination_root/.current-restore-$run_id"
operation_lock="$coordination_root/restore-operation.lock"
owner_marker="$coordination_root/restore-$run_id.owner"
coordination_identity="$coordination_root/restore-$run_id.identity"
expected_data_dir_sha256="$(python3 - "$data_dir" <<'PYTHON_DATA_DIR_CANDIDATE'
import hashlib
import sys

print(hashlib.sha256(b"comis-replay-data-dir-v1\0" + sys.argv[1].encode("utf8")).hexdigest())
PYTHON_DATA_DIR_CANDIDATE
)"
coordination_identity_scratch="$coordination_root/.restore-$run_id-$expected_data_dir_sha256.identity.scratch"
coordination_identity_candidate="$coordination_root/.restore-$run_id.identity.incoming"
runtime_root=/run/comis-self-driving
runtime_dir="$runtime_root/restore-$run_id"
${TARGET_MOUNT_OVERLAP_GUARD}
for guarded_root in "$state_root" "$coordination_root"; do
  if [ -L "$guarded_root" ]; then exit 79; fi
  if [ -e "$guarded_root" ] && \
     { [ ! -d "$guarded_root" ] || [ "$(stat -c '%u:%g:%a' "$guarded_root")" != 0:0:700 ]; }; then
    exit 79
  fi
done
if [ -L "$runtime_root" ] || [ -L "$control_dir" ]; then exit 79; fi
if [ -e "$control_dir" ] && \
   { [ ! -d "$control_dir" ] || [ "$(stat -c '%u:%g:%a' "$control_dir")" != 0:0:700 ]; }; then
  exit 79
fi
archive="$control_dir/snapshot.tar"
extract_dir="$control_dir/extracted"
transaction_marker="$control_dir/transaction-owned"
transaction_identity="$control_dir/transaction-identity"
expected_manifest="$control_dir/expected-manifest.json"
source_env_copy="$control_dir/source-env.original"
attestation_path="$control_dir/replay-attestation.json"
expected_overlay_sha="$control_dir/replay-overlay.sha256"
data_was_immutable="$control_dir/data-was-immutable"
old_data_unlocked="$control_dir/old-data-root-unlocked"
bytes_received_path="$control_dir/bytes-received"
incoming_data="$data_dir.restore-$run_id"
rollback_data="$control_dir/rollback-data"
env_path=/etc/comis/env
env_incoming="/etc/comis/.env.incoming-$run_id"
env_rollback="/etc/comis/.env.rollback-$run_id"
overlay_path=/etc/comis/replay-quarantine.yaml
overlay_incoming="/etc/comis/.replay-quarantine.incoming-$run_id"
overlay_rollback="/etc/comis/.replay-quarantine.rollback-$run_id"
seal_path=/etc/comis/replay-restore-attestation.json
seal_incoming="/etc/comis/.replay-restore-attestation.incoming-$run_id"
seal_rollback="/etc/comis/.replay-restore-attestation.rollback-$run_id"
reattest_script="$control_dir/reattest-restored-state.py"
commit_authorized="$control_dir/commit-authorized"
promoting_marker="$control_dir/promoting"
rolling_back_marker="$control_dir/rolling-back"
finalizing_marker="$control_dir/finalizing"
finalized_marker="$control_dir/finalized"
rolled_back_marker="$control_dir/rolled-back"
`;

const TARGET_REPLAY_CONFIGURATION_GUARD = String.raw`service_group_id="$(id -g "$service_user")"
if [ ! -f "$env_path" ] || [ -L "$env_path" ] || \
   [ "$(stat -c '%u:%g:%a' "$env_path" 2>/dev/null || true)" != "0:$service_group_id:640" ] || \
   [ ! -f "$overlay_path" ] || [ -L "$overlay_path" ] || \
   [ "$(stat -c '%u:%g:%a' "$overlay_path" 2>/dev/null || true)" != "0:$service_group_id:640" ] || \
   [ ! -f "$expected_overlay_sha" ] || [ -L "$expected_overlay_sha" ] || \
   [ "$(stat -c '%u:%g:%a:%s' "$expected_overlay_sha" 2>/dev/null || true)" != 0:0:400:65 ]; then
  exit 95
fi
expected_overlay_digest="$(tr -d '\n' < "$expected_overlay_sha")"
if [ "${"$"}{#expected_overlay_digest}" -ne 64 ]; then exit 95; fi
case "$expected_overlay_digest" in *[!a-f0-9]*) exit 95 ;; esac
if [ "$(sha256sum "$overlay_path" | awk '{print $1}')" != "$expected_overlay_digest" ]; then
  exit 95
fi
`;

const TARGET_AUTHORIZATION_RECEIPT_FUNCTION = String.raw`write_authorization_receipt() {
  receipt_path="$1"
  manifest_digest="$(sha256sum "$expected_manifest" | awk '{print $1}')"
  attestation_digest="$(sha256sum "$attestation_path" | awk '{print $1}')"
  printf 'schemaVersion=1\nstate=authorized\nrunId=%s\ntargetMachineIdSha256=%s\nsnapshotManifestSha256=%s\nrestoreAttestationSha256=%s\n' \
    "$run_id" "$expected_machine" "$manifest_digest" "$attestation_digest" > "$receipt_path"
  chmod 0400 "$receipt_path"
  sync -f "$receipt_path"
}
`;

function buildSourceStreamPrepareScript(streamScript: string): string {
  const encoded = Buffer.from(streamScript, "utf8").toString("base64");
  return String.raw`set -euo pipefail
expected_machine="$1"
run_id="$2"
exec 1>/dev/null
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then exit 71; fi
case "$run_id" in [A-Za-z0-9]*) ;; *) exit 72 ;; esac
case "$run_id" in *[!A-Za-z0-9_-]*) exit 72 ;; esac
if [ "$(printf '%s' "$run_id" | wc -c | tr -d ' ')" -gt 64 ]; then exit 72; fi
stage_root=/run/comis-self-driving
stage_dir="$stage_root/$run_id"
stream_path="$stage_dir/stream-restore.sh"
if [ -L "$stage_root" ] || [ -L "$stage_dir" ] || \
   [ "$(stat -c '%u:%a' "$stage_root" 2>/dev/null || true)" != 0:700 ] || \
   [ "$(stat -c '%u:%a' "$stage_dir" 2>/dev/null || true)" != 0:700 ] || \
   [ ! -f "$stage_dir/manifest.json" ] || [ -e "$stream_path" ] || [ -L "$stream_path" ]; then
  exit 73
fi
printf '%s' '${encoded}' | base64 --decode > "$stream_path"
chmod 0700 "$stream_path"
`;
}

function buildTargetPrepareScript(manifestJson: string, overlayYaml: string): string {
  const manifestBase64 = Buffer.from(manifestJson, "utf8").toString("base64");
  const overlayBase64 = Buffer.from(overlayYaml, "utf8").toString("base64");
  const overlaySha256 = createHash("sha256").update(overlayYaml).digest("hex");
  return String.raw`set -euo pipefail
expected_machine="$1"
data_dir="$2"
run_id="$3"
service="$4"
service_user="$5"
maximum_bytes="$6"
minimum_free_bytes="$7"
minimum_free_inodes="$8"
minimum_etc_free_bytes="$9"
minimum_etc_free_inodes="${"$"}{10}"
exec 1>/dev/null
${TARGET_GUARD}
case "$maximum_bytes:$minimum_free_bytes:$minimum_free_inodes:$minimum_etc_free_bytes:$minimum_etc_free_inodes" in
  *[!0-9:]*) exit 80 ;;
esac
if [ "$maximum_bytes" -le 0 ] || [ "$maximum_bytes" -gt ${String(MAXIMUM_RESTORE_BYTES)} ]; then
  exit 80
fi
if [ "$minimum_free_bytes" -le "$maximum_bytes" ] || \
   [ "$minimum_free_bytes" -gt ${String(MAXIMUM_RESTORE_HEADROOM_BYTES)} ]; then exit 80; fi
if [ "$minimum_free_inodes" -le 0 ] || [ "$minimum_etc_free_bytes" -le 0 ] || \
   [ "$minimum_etc_free_inodes" -le 0 ]; then exit 80; fi
if [ ! -d "$data_dir" ] || [ -L "$data_dir" ] || [ ! -f "$env_path" ] || \
   [ -L "$env_path" ]; then exit 81; fi
for required_command in python3 tar base64 chattr lsattr cmp flock; do
  if ! command -v "$required_command" >/dev/null 2>&1; then exit 82; fi
done
service_group_id="$(id -g "$service_user")"
if [ "$(stat -c '%u:%g:%a:%h' "$env_path" 2>/dev/null || true)" != \
     "0:$service_group_id:640:1" ]; then exit 81; fi
if [ -e "$overlay_path" ] || [ -L "$overlay_path" ]; then
  if [ ! -f "$overlay_path" ] || [ -L "$overlay_path" ] || \
     [ "$(stat -c '%u:%g:%a:%h' "$overlay_path" 2>/dev/null || true)" != \
       "0:$service_group_id:640:1" ]; then exit 81; fi
fi
if [ -e "$seal_path" ] || [ -L "$seal_path" ]; then
  if [ ! -f "$seal_path" ] || [ -L "$seal_path" ] || \
     [ "$(stat -c '%u:%g:%a:%h' "$seal_path" 2>/dev/null || true)" != 0:0:444:1 ]; then
    exit 81
  fi
fi
install -d -m 0700 -o root -g root "$coordination_root"
sync -f /var/lib
if [ "$(stat -c '%u:%g:%a' "$coordination_root")" != 0:0:700 ]; then exit 84; fi
if [ -e "$operation_lock" ] || [ -L "$operation_lock" ]; then
  if [ ! -f "$operation_lock" ] || [ -L "$operation_lock" ] || \
     [ "$(stat -c '%u:%g:%a' "$operation_lock" 2>/dev/null || true)" != 0:0:600 ]; then
    exit 84
  fi
else
  old_umask="$(umask)"
  umask 077
  (set -C; : > "$operation_lock") 2>/dev/null || true
  umask "$old_umask"
fi
if [ ! -f "$operation_lock" ] || [ -L "$operation_lock" ] || \
   [ "$(stat -c '%u:%g:%a' "$operation_lock" 2>/dev/null || true)" != 0:0:600 ]; then
  exit 84
fi
exec 9<>"$operation_lock"
if ! flock -n 9; then exit 84; fi
sync -f "$operation_lock"
sync -f "$coordination_root"
if [ -e "$control_dir" ] || [ -L "$control_dir" ] || \
   [ -e "$active_restore" ] || [ -L "$active_restore" ] || \
   [ -e "$owner_marker" ] || [ -L "$owner_marker" ] || \
   [ -e "$coordination_identity" ] || [ -L "$coordination_identity" ] || \
   [ -e "$coordination_identity_scratch" ] || [ -L "$coordination_identity_scratch" ] || \
   [ -e "$coordination_identity_candidate" ] || [ -L "$coordination_identity_candidate" ] || \
   [ -e "$current_restore_incoming" ] || [ -L "$current_restore_incoming" ] || \
   [ -e "$runtime_dir" ] || [ -L "$runtime_dir" ] || \
   [ -e "$incoming_data" ] || [ -L "$incoming_data" ] || \
   [ -e "$env_incoming" ] || [ -L "$env_incoming" ] || \
   [ -e "$env_rollback" ] || [ -L "$env_rollback" ] || \
   [ -e "$overlay_incoming" ] || [ -L "$overlay_incoming" ] || \
   [ -e "$overlay_rollback" ] || [ -L "$overlay_rollback" ] || \
   [ -e "$seal_incoming" ] || [ -L "$seal_incoming" ] || \
   [ -e "$seal_rollback" ] || [ -L "$seal_rollback" ]; then exit 83; fi
coordination_identity_scratch_created=0
coordination_identity_candidate_created=0
coordination_identity_created=0
control_created=0
runtime_created=0
owner_created=0
active_created=0
cleanup_prepare() {
  rc="$1"
  trap - EXIT HUP INT TERM
  if [ "$active_created" -eq 1 ]; then rm -f -- "$active_restore"; fi
  if [ "$control_created" -eq 1 ]; then
    chattr -R -i -a "$incoming_data" 2>/dev/null || true
    rm -rf -- "$incoming_data" "$control_dir"
    rm -f -- "$env_incoming" "$env_rollback" \
      "$overlay_incoming" "$overlay_rollback" \
      "$seal_incoming" "$seal_rollback"
  fi
  if [ "$runtime_created" -eq 1 ]; then rm -rf -- "$runtime_dir"; fi
  if [ "$owner_created" -eq 1 ]; then
    rm -f -- "$current_restore_incoming" "$owner_marker"
  fi
  if [ "$coordination_identity_scratch_created" -eq 1 ]; then
    rm -f -- "$coordination_identity_scratch"
  fi
  if [ "$coordination_identity_candidate_created" -eq 1 ]; then
    if [ -f "$coordination_identity_candidate" ] && \
       [ ! -L "$coordination_identity_candidate" ] && \
       [ "$(stat -c '%u:%g:%a:%h' "$coordination_identity_candidate" \
         2>/dev/null || true)" = 0:0:400:1 ] && \
       [ "$(cat "$coordination_identity_candidate" 2>/dev/null || true)" = \
         "$expected_transaction_identity" ]; then
      rm -f -- "$coordination_identity_candidate"
    fi
  fi
  sync -f "$state_root"
  sync -f "$data_mount"
  sync -f "$runtime_root"
  sync -f /etc/comis
  sync -f "$coordination_root"
  if [ "$coordination_identity_created" -eq 1 ]; then
    if [ -f "$coordination_identity" ] && [ ! -L "$coordination_identity" ] && \
       [ "$(stat -c '%u:%g:%a' "$coordination_identity" 2>/dev/null || true)" = 0:0:400 ] && \
       [ "$(cat "$coordination_identity" 2>/dev/null || true)" = \
         "$expected_transaction_identity" ]; then
      rm -f -- "$coordination_identity"
    fi
    sync -f "$coordination_root"
  fi
  exit "$rc"
}
cleanup_prepare_on_exit() {
  rc=$?
  cleanup_prepare "$rc"
}
trap cleanup_prepare_on_exit EXIT
trap 'cleanup_prepare 129' HUP
trap 'cleanup_prepare 130' INT
trap 'cleanup_prepare 143' TERM
${TARGET_TRANSACTION_IDENTITY_EXPECTATION}
old_umask="$(umask)"
umask 377
coordination_identity_scratch_created=1
(set -C; printf '%s\n' "$expected_transaction_identity" > "$coordination_identity_scratch") \
  2>/dev/null || exit 84
umask "$old_umask"
chmod 0400 "$coordination_identity_scratch"
sync -f "$coordination_identity_scratch"
sync -f "$coordination_root"
coordination_identity_candidate_created=1
mv --no-clobber -- "$coordination_identity_scratch" "$coordination_identity_candidate"
if [ -e "$coordination_identity_scratch" ] || [ -L "$coordination_identity_scratch" ] || \
   [ ! -f "$coordination_identity_candidate" ] || \
   [ -L "$coordination_identity_candidate" ] || \
   [ "$(stat -c '%u:%g:%a:%h' "$coordination_identity_candidate" \
     2>/dev/null || true)" != 0:0:400:1 ] || \
   [ "$(cat "$coordination_identity_candidate" 2>/dev/null || true)" != \
     "$expected_transaction_identity" ]; then exit 84; fi
coordination_identity_scratch_created=0
chmod 0400 "$coordination_identity_candidate"
sync -f "$coordination_identity_candidate"
sync -f "$coordination_root"
coordination_identity_created=1
mv --no-clobber -- "$coordination_identity_candidate" "$coordination_identity"
if [ -e "$coordination_identity_candidate" ] || [ -L "$coordination_identity_candidate" ] || \
   [ ! -f "$coordination_identity" ] || [ -L "$coordination_identity" ] || \
   [ "$(stat -c '%u:%g:%a' "$coordination_identity" 2>/dev/null || true)" != 0:0:400 ] || \
   [ "$(cat "$coordination_identity" 2>/dev/null || true)" != \
     "$expected_transaction_identity" ]; then exit 84; fi
coordination_identity_candidate_created=0
sync -f "$coordination_identity"
sync -f "$coordination_root"
install -d -m 0700 -o root -g root "$state_root" "$runtime_root"
sync -f "$data_mount"
sync -f /run
control_created=1
mkdir -m 0700 -- "$control_dir"
mkdir -m 0700 -- "$extract_dir"
sync -f "$state_root"
runtime_created=1
mkdir -m 0700 -- "$runtime_dir"
sync -f "$runtime_root"
if [ "$(stat -c '%u:%g:%a' "$state_root")" != 0:0:700 ] || \
   [ "$(stat -c '%u:%g:%a' "$runtime_root")" != 0:0:700 ] || \
   [ "$(stat -c '%u:%g:%a' "$control_dir")" != 0:0:700 ] || \
   [ "$(stat -c '%u:%g:%a' "$runtime_dir")" != 0:0:700 ] || \
   [ "$(stat -c '%d' "$control_dir")" != "$(stat -c '%d' "$data_parent")" ] || \
   [ "$(stat -c '%d' "$control_dir")" != "$(stat -c '%d' "$data_dir")" ]; then
  exit 84
fi
printf '%s\n' "$expected_transaction_identity" > "$transaction_identity"
chmod 0400 "$transaction_identity"
sync -f "$transaction_identity"
printf '%s\n' "$run_id" > "$transaction_marker"
chmod 0400 "$transaction_marker"
sync -f "$transaction_marker"
sync -f "$control_dir"
owner_created=1
printf '%s\n' "$run_id" > "$owner_marker"
chmod 0400 "$owner_marker"
sync -f "$owner_marker"
sync -f "$coordination_root"
active_created=1
ln -- "$owner_marker" "$active_restore"
sync -f "$coordination_root"
available_bytes="$(df -PB1 "$control_dir" | awk 'NR == 2 {print $4}')"
available_inodes="$(df -Pi "$control_dir" | awk 'NR == 2 {print $4}')"
available_etc_bytes="$(df -PB1 /etc/comis | awk 'NR == 2 {print $4}')"
available_etc_inodes="$(df -Pi /etc/comis | awk 'NR == 2 {print $4}')"
for available in "$available_bytes" "$available_inodes" "$available_etc_bytes" "$available_etc_inodes"; do
  case "$available" in ''|*[!0-9]*) exit 85 ;; esac
done
data_device="$(stat -c '%d' "$control_dir")"
etc_device="$(stat -c '%d' /etc/comis)"
if [ "$data_device" = "$etc_device" ]; then
  required_shared_bytes="$(( minimum_free_bytes + minimum_etc_free_bytes ))"
  required_shared_inodes="$(( minimum_free_inodes + minimum_etc_free_inodes ))"
  if [ "$available_bytes" -lt "$required_shared_bytes" ] || \
     [ "$available_inodes" -lt "$required_shared_inodes" ]; then exit 85; fi
elif [ "$available_bytes" -lt "$minimum_free_bytes" ] || \
     [ "$available_inodes" -lt "$minimum_free_inodes" ] || \
     [ "$available_etc_bytes" -lt "$minimum_etc_free_bytes" ] || \
     [ "$available_etc_inodes" -lt "$minimum_etc_free_inodes" ]; then
  exit 85
fi
printf '%s' '${manifestBase64}' | base64 --decode > "$expected_manifest"
printf '%s' '${overlayBase64}' | base64 --decode > "$control_dir/replay-overlay.yaml"
printf '%s\n' '${overlaySha256}' > "$expected_overlay_sha"
chmod 0400 "$expected_manifest" "$control_dir/replay-overlay.yaml" "$expected_overlay_sha"
if [ "$(sha256sum "$control_dir/replay-overlay.yaml" | awk '{print $1}')" != \
     "$(tr -d '\n' < "$expected_overlay_sha")" ]; then exit 86; fi
case "$(lsattr -d "$data_dir" | awk '{print $1}')" in
  *i*) printf '%s\n' true > "$data_was_immutable" ;;
  *) printf '%s\n' false > "$data_was_immutable" ;;
esac
chmod 0400 "$data_was_immutable"
if [ -e "$overlay_path" ]; then
  if [ ! -f "$overlay_path" ] || [ -L "$overlay_path" ]; then exit 86; fi
  printf '%s\n' true > "$control_dir/overlay-existed"
else
  printf '%s\n' false > "$control_dir/overlay-existed"
fi
chmod 0400 "$control_dir/overlay-existed"
if [ -e "$seal_path" ] || [ -L "$seal_path" ]; then
  if [ -L "$seal_path" ] || [ ! -f "$seal_path" ] || \
     [ "$(stat -c '%u:%g:%a' "$seal_path" 2>/dev/null || true)" != 0:0:444 ]; then
    exit 86
  fi
  printf '%s\n' true > "$control_dir/seal-existed"
else
  printf '%s\n' false > "$control_dir/seal-existed"
fi
chmod 0400 "$control_dir/seal-existed"
sync -f "$control_dir"
cat > "$runtime_dir/receive.sh" <<'RECEIVER'
#!/usr/bin/env bash
set -euo pipefail
expected_machine="$1"
data_dir="$2"
run_id="$3"
service="$4"
service_user="$5"
maximum_bytes="$6"
exec 1>/dev/null
${TARGET_GUARD}
if { [ ! -e "$control_dir" ] && [ ! -L "$control_dir" ]; } && \
   { [ ! -e "$active_restore" ] && [ ! -L "$active_restore" ]; }; then exit 0; fi
${TARGET_TRANSACTION_GUARD}
if [ -f "$rolled_back_marker" ] && [ ! -L "$rolled_back_marker" ] && \
   [ "$(stat -c '%u:%g:%a' "$rolled_back_marker" 2>/dev/null || true)" = 0:0:400 ] && \
   [ "$(cat "$rolled_back_marker" 2>/dev/null || true)" = rolled-back ]; then
  rm -f -- "$active_restore"
  rm -f -- "$owner_marker"
  sync -f "$coordination_root"
  exit 0
fi
case "$maximum_bytes" in ''|*[!0-9]*) exit 80 ;; esac
if [ ! -d "$control_dir" ] || [ -L "$control_dir" ] || \
   [ "$(stat -c '%u:%g:%a' "$control_dir" 2>/dev/null || true)" != 0:0:700 ] || \
   [ "$(stat -c '%u:%g:%a' "$transaction_marker" 2>/dev/null || true)" != 0:0:400 ] || \
   [ "$(cat "$transaction_marker" 2>/dev/null || true)" != "$run_id" ] || \
   [ -e "$archive" ] || [ -L "$archive" ]; then exit 87; fi
archive_part="$archive.part"
rm -f -- "$archive_part"
umask 077
head -c "$(( maximum_bytes + 1 ))" > "$archive_part"
received_bytes="$(stat -c '%s' "$archive_part")"
if [ "$received_bytes" -gt "$maximum_bytes" ]; then
  rm -f -- "$archive_part"
  exit 88
fi
chmod 0600 "$archive_part"
mv -- "$archive_part" "$archive"
printf '%s\n' "$received_bytes" > "$bytes_received_path.tmp"
chmod 0400 "$bytes_received_path.tmp"
sync -f "$bytes_received_path.tmp"
mv -- "$bytes_received_path.tmp" "$bytes_received_path"
sync -f "$control_dir"
RECEIVER
chmod 0700 "$runtime_dir/receive.sh"
trap - EXIT HUP INT TERM
`;
}

const TARGET_VERIFY_AND_PROMOTE_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
data_dir="$2"
run_id="$3"
service="$4"
service_user="$5"
manifest_sha256="$6"
exec 1>/dev/null
${TARGET_GUARD}
${TARGET_TRANSACTION_GUARD}
if [ ! -f "$transaction_marker" ] || [ -L "$transaction_marker" ] || \
   [ "$(stat -c '%u:%g:%a' "$transaction_marker" 2>/dev/null || true)" != 0:0:400 ] || \
   [ "$(cat "$transaction_marker" 2>/dev/null || true)" != "$run_id" ] || \
   [ ! -f "$archive" ] || [ -L "$archive" ] || \
   [ "$(stat -c '%u:%g:%a' "$archive" 2>/dev/null || true)" != 0:0:600 ] || \
   [ ! -f "$bytes_received_path" ] || [ -L "$bytes_received_path" ] || \
   [ "$(stat -c '%u:%g:%a' "$bytes_received_path" 2>/dev/null || true)" != 0:0:400 ] || \
   [ "$(cat "$bytes_received_path" 2>/dev/null || true)" != "$(stat -c '%s' "$archive")" ] || \
   [ ! -f "$expected_manifest" ] || [ -L "$expected_manifest" ] || \
   [ ! -f "$expected_overlay_sha" ] || [ -L "$expected_overlay_sha" ] || \
   [ ! -f "$data_was_immutable" ] || [ -L "$data_was_immutable" ] || \
   [ "$(stat -c '%u:%g:%a' "$data_was_immutable" 2>/dev/null || true)" != 0:0:400 ]; then
  exit 89
fi
case "$(cat "$data_was_immutable")" in true|false) ;; *) exit 89 ;; esac
if [ "$(sha256sum "$expected_manifest" | awk '{print $1}')" != "$manifest_sha256" ]; then
  exit 90
fi
python3 - "$archive" "$expected_manifest" <<'PYTHON_ARCHIVE'
import json
import sys
import tarfile
from pathlib import PurePosixPath

archive_path, manifest_path = sys.argv[1:]

def fail():
    raise SystemExit(91)

def safe_path(value):
    if not isinstance(value, str) or not value or value.startswith("/") or "\\" in value:
        fail()
    if any(ord(character) <= 31 or ord(character) == 127 for character in value):
        fail()
    path = PurePosixPath(value)
    if any(part in ("", ".", "..") for part in path.parts):
        fail()
    return value

try:
    expected_raw = open(manifest_path, "rb").read()
    manifest = json.loads(expected_raw)
    records = {entry["path"]: entry for entry in manifest["entries"]}
    expected_names = set(records)
    expected_names.add("manifest.json")
    seen = set()
    symlink_prefixes = []
    with tarfile.open(archive_path, "r:*") as archive:
        members = archive.getmembers()
        if len(members) != len(expected_names):
            fail()
        for member in members:
            name = safe_path(member.name)
            if name in seen or name not in expected_names:
                fail()
            seen.add(name)
            if member.isdev() or member.isfifo():
                fail()
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                fail()
            if name == "manifest.json":
                if not member.isfile() or member.size != len(expected_raw) or member.mode != 0o600:
                    fail()
                stream = archive.extractfile(member)
                if stream is None or stream.read() != expected_raw:
                    fail()
                continue
            record = records[name]
            if member.isfile() or member.islnk():
                if record["type"] not in ("file", "hardlink"):
                    fail()
            else:
                actual_type = "directory" if member.isdir() else "symlink"
                if actual_type != record["type"]:
                    fail()
            if member.mode != int(record["mode"], 8) or member.uid != record["uid"] or member.gid != record["gid"]:
                fail()
            if member.isfile() and member.size != record["size"]:
                fail()
            if member.islnk():
                target_name = safe_path(member.linkname)
                target = records.get(target_name)
                if target is None or target["type"] not in ("file", "hardlink"):
                    fail()
                canonical = record.get("hardlinkTarget", name)
                target_canonical = target.get("hardlinkTarget", target_name)
                if canonical != target_canonical:
                    fail()
            if member.issym():
                if member.linkname != record["linkTarget"]:
                    fail()
                symlink_prefixes.append(name + "/")
        if seen != expected_names:
            fail()
        for name in seen:
            if any(name.startswith(prefix) for prefix in symlink_prefixes):
                fail()
except (OSError, KeyError, TypeError, ValueError, tarfile.TarError):
    fail()
PYTHON_ARCHIVE
if [ -n "$(find "$extract_dir" -mindepth 1 -print -quit)" ]; then exit 92; fi
tar --extract --file="$archive" --directory="$extract_dir" --acls --xattrs --xattrs-include='*' \
  --numeric-owner --same-owner --same-permissions --delay-directory-restore --no-overwrite-dir
python3 - "$extract_dir" "$expected_manifest" <<'PYTHON_VERIFY'
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
from urllib.parse import quote

root, manifest_path = sys.argv[1:]

def fail(code=93):
    raise SystemExit(code)

def mode_of(value):
    return format(stat.S_IMODE(value.st_mode), "04o")

def file_hash(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                return digest.hexdigest()
            digest.update(chunk)

def command_output(command, arguments):
    completed = subprocess.run(
        [command, *arguments], check=False, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
    )
    if completed.returncode != 0:
        fail()
    return completed.stdout.decode("utf8")

def metadata_digests(path, is_symlink, identity):
    result = {}
    if identity["acl"] == "captured":
        value = "" if is_symlink else command_output("getfacl", ["-cEn", "--", path])
        result["aclSha256"] = hashlib.sha256(value.encode("utf8")).hexdigest()
    if identity["xattr"] == "captured":
        arguments = ["--absolute-names", "--dump", "--encoding=hex", "-m", "-"]
        if is_symlink:
            arguments.append("-h")
        output = command_output("getfattr", [*arguments, "--", path])
        lines = [line for line in output.split("\n") if line and not line.startswith("#")]
        canonical = "\n".join(sorted(lines, key=lambda line: line.encode("utf8")))
        result["xattrSha256"] = hashlib.sha256(canonical.encode("utf8")).hexdigest()
    if identity["capability"] == "captured":
        canonical = ""
        if not is_symlink:
            output = command_output("getcap", ["-n", path]).strip()
            prefix = path + " "
            canonical = output[len(prefix):] if output.startswith(prefix) else output
        result["capabilitySha256"] = hashlib.sha256(canonical.encode("utf8")).hexdigest()
    return result

try:
    manifest = json.load(open(manifest_path, "r", encoding="utf8"))
    records = {entry["path"]: entry for entry in manifest["entries"]}
    expected_paths = set(records)
    actual_paths = set()
    actual_stats = {}
    identity = manifest["metadataIdentity"]
    for kind, command in (("acl", "getfacl"), ("xattr", "getfattr"), ("capability", "getcap")):
        if identity[kind] == "captured" and shutil.which(command) is None:
            fail()

    def walk(relative):
        absolute = os.path.join(root, relative)
        value = os.lstat(absolute)
        actual_paths.add(relative)
        actual_stats[relative] = value
        record = records.get(relative)
        if (
            record is None
            or mode_of(value) != record["mode"]
            or value.st_uid != record["uid"]
            or value.st_gid != record["gid"]
            or str(value.st_mtime_ns) != record["mtimeNs"]
        ):
            fail()
        metadata = metadata_digests(absolute, stat.S_ISLNK(value.st_mode), identity)
        if any(record.get(field) != digest for field, digest in metadata.items()):
            fail()
        if stat.S_ISREG(value.st_mode):
            if record["type"] not in ("file", "hardlink") or value.st_size != record["size"]:
                fail()
            if record["type"] == "file" and file_hash(absolute) != record["sha256"]:
                fail()
            return
        if stat.S_ISLNK(value.st_mode):
            if record["type"] != "symlink" or value.st_size != record["size"]:
                fail()
            if os.readlink(absolute) != record["linkTarget"]:
                fail()
            return
        if not stat.S_ISDIR(value.st_mode) or record["type"] != "directory":
            fail()
        for child in sorted(os.listdir(absolute), key=lambda name: name.encode("utf8")):
            walk(relative + "/" + child)

    walk("data")
    walk("system")
    if actual_paths != expected_paths:
        fail()
    canonical_inodes = {}
    for relative in sorted(expected_paths, key=lambda path: path.encode("utf8")):
        record = records[relative]
        if record["type"] == "file":
            inode = (actual_stats[relative].st_dev, actual_stats[relative].st_ino)
            if inode in canonical_inodes:
                fail()
            canonical_inodes[inode] = relative
        elif record["type"] == "hardlink":
            target = record["hardlinkTarget"]
            value = actual_stats[relative]
            target_value = actual_stats.get(target)
            if target_value is None or (value.st_dev, value.st_ino) != (target_value.st_dev, target_value.st_ino):
                fail()
    excluded_paths = {entry["path"] for entry in manifest["exclusions"]}
    for relative in excluded_paths:
        if os.path.lexists(os.path.join(root, relative)):
            fail()

    databases = []
    for relative in sorted(expected_paths, key=lambda path: path.encode("utf8")):
        record = records[relative]
        if record["type"] != "file" or not relative.startswith("data/"):
            continue
        absolute = os.path.join(root, relative)
        with open(absolute, "rb") as handle:
            if handle.read(16) == b"SQLite format 3\0":
                databases.append(absolute)
    for index, database in enumerate(databases):
        with tempfile.TemporaryDirectory(
            prefix="comis-restore-sqlite-", dir=os.path.dirname(root)
        ) as scratch_root:
            scratch_database = os.path.join(scratch_root, str(index) + ".sqlite")
            shutil.copyfile(database, scratch_database)
            for suffix in ("-wal", "-shm"):
                sidecar = database + suffix
                if os.path.isfile(sidecar):
                    shutil.copyfile(sidecar, scratch_database + suffix)
            uri = "file:" + quote(scratch_database, safe="/") + "?mode=ro"
            connection = sqlite3.connect(uri, uri=True)
            try:
                quick = connection.execute("PRAGMA quick_check").fetchall()
                integrity = connection.execute("PRAGMA integrity_check").fetchall()
                foreign_keys = connection.execute("PRAGMA foreign_key_check").fetchall()
                if quick != [("ok",)] or integrity != [("ok",)] or foreign_keys:
                    fail(94)
            finally:
                connection.close()
except (OSError, KeyError, TypeError, ValueError, sqlite3.Error):
    fail(94)
PYTHON_VERIFY
source_env="$extract_dir/system/etc/comis/env"
if [ ! -f "$source_env" ] || [ -L "$source_env" ]; then exit 95; fi
cp --archive --no-dereference -- "$source_env" "$source_env_copy"
cmp -s -- "$source_env" "$source_env_copy"
chattr +i "$source_env_copy"
case "$(lsattr -d "$source_env_copy" | awk '{print $1}')" in *i*) ;; *) exit 95 ;; esac
service_group="$(id -gn "$service_user")"
mv -- "$extract_dir/data" "$incoming_data"
cp --archive --no-dereference -- "$source_env" "$env_incoming"
printf '\n\nCOMIS_CONFIG_PATHS=%s/config.yaml:%s\n' "$data_dir" "$overlay_path" >> "$env_incoming"
chown root:"$service_group" "$env_incoming"
chmod 0640 "$env_incoming"
install -o root -g "$service_group" -m 0640 \
  "$control_dir/replay-overlay.yaml" "$overlay_incoming"

${TARGET_GUARD}

begin_rolling_back() {
  if [ -e "$rolling_back_marker" ] || [ -L "$rolling_back_marker" ]; then
    if [ ! -f "$rolling_back_marker" ] || [ -L "$rolling_back_marker" ] || \
       [ "$(stat -c '%u:%g:%a' "$rolling_back_marker" 2>/dev/null || true)" != 0:0:400 ] || \
       [ "$(cat "$rolling_back_marker" 2>/dev/null || true)" != rolling-back ]; then
      exit 95
    fi
    return
  fi
  if [ -e "$control_dir/rolling-back.tmp" ] || \
     [ -L "$control_dir/rolling-back.tmp" ]; then exit 95; fi
  printf '%s\n' rolling-back > "$control_dir/rolling-back.tmp"
  chmod 0400 "$control_dir/rolling-back.tmp"
  sync -f "$control_dir/rolling-back.tmp"
  mv -- "$control_dir/rolling-back.tmp" "$rolling_back_marker"
  sync -f "$control_dir"
}

rollback_promote() {
  rc=$?
  trap - EXIT HUP INT TERM
  begin_rolling_back
  if [ -e "$rollback_data" ] && [ ! -L "$rollback_data" ]; then
    chattr -R -i -a "$data_dir" 2>/dev/null || true
    rm -rf -- "$data_dir"
    mv -- "$rollback_data" "$data_dir"
    if [ "$(cat "$data_was_immutable" 2>/dev/null || true)" = true ]; then
      chattr +i "$data_dir"
    fi
  elif [ "$(cat "$data_was_immutable" 2>/dev/null || true)" = true ] && \
       [ -f "$old_data_unlocked" ] && [ ! -L "$old_data_unlocked" ] && \
       [ -d "$data_dir" ] && [ ! -L "$data_dir" ]; then
    chattr +i "$data_dir"
  fi
  if [ -e "$env_rollback" ] || [ -L "$env_rollback" ]; then
    if ! { [ -f "$env_rollback" ] && [ ! -L "$env_rollback" ] && \
      [ "$(stat -c '%h' "$env_rollback" 2>/dev/null || true)" = 1 ] && \
      [ "$(stat -c '%u:%g:%a' "$env_rollback" 2>/dev/null || true)" = \
        "0:$service_group_id:640" ]; }; then exit 98; fi
    rm -f -- "$env_path"
    mv -- "$env_rollback" "$env_path"
  fi
  if [ -e "$overlay_rollback" ] || [ -L "$overlay_rollback" ]; then
    if ! { [ -f "$overlay_rollback" ] && [ ! -L "$overlay_rollback" ] && \
      [ "$(stat -c '%h' "$overlay_rollback" 2>/dev/null || true)" = 1 ] && \
      [ "$(stat -c '%u:%g:%a' "$overlay_rollback" 2>/dev/null || true)" = \
        "0:$service_group_id:640" ]; }; then exit 98; fi
    rm -f -- "$overlay_path"
    mv -- "$overlay_rollback" "$overlay_path"
  elif [ "$(cat "$control_dir/overlay-existed" 2>/dev/null || true)" = false ]; then
    rm -f -- "$overlay_path"
  fi
  if [ -e "$seal_rollback" ] || [ -L "$seal_rollback" ]; then
    if ! { [ -f "$seal_rollback" ] && [ ! -L "$seal_rollback" ] && \
      [ "$(stat -c '%h' "$seal_rollback" 2>/dev/null || true)" = 1 ] && \
      [ "$(stat -c '%u:%g:%a' "$seal_rollback" 2>/dev/null || true)" = 0:0:444 ]; }; then
      exit 98
    fi
    rm -f -- "$seal_path"
    mv -- "$seal_rollback" "$seal_path"
  elif [ "$(cat "$control_dir/seal-existed" 2>/dev/null || true)" = false ]; then
    rm -f -- "$seal_path"
  fi
  rm -rf -- "$incoming_data"
  rm -f -- "$env_incoming" "$overlay_incoming" "$seal_incoming"
  sync -f "$data_parent"
  sync -f /etc/comis
  sync -f "$control_dir"
  exit "$rc"
}
trap rollback_promote EXIT HUP INT TERM
if [ -e "$promoting_marker" ] || [ -L "$promoting_marker" ] || \
   [ -e "$control_dir/promoting.tmp" ] || [ -L "$control_dir/promoting.tmp" ]; then
  exit 95
fi
printf '%s\n' promoting > "$control_dir/promoting.tmp"
chmod 0400 "$control_dir/promoting.tmp"
sync -f "$control_dir/promoting.tmp"
mv -- "$control_dir/promoting.tmp" "$promoting_marker"
sync -f "$control_dir"
if [ "$(cat "$control_dir/seal-existed")" = true ]; then
  mv -- "$seal_path" "$seal_rollback"
  sync -f /etc/comis
fi
printf '%s\n' unlocked > "$old_data_unlocked.tmp"
chmod 0400 "$old_data_unlocked.tmp"
sync -f "$old_data_unlocked.tmp"
mv -- "$old_data_unlocked.tmp" "$old_data_unlocked"
sync -f "$control_dir"
chattr -i "$data_dir" 2>/dev/null || true
mv -- "$data_dir" "$rollback_data"
mv -- "$incoming_data" "$data_dir"
mv -- "$env_path" "$env_rollback"
mv -- "$env_incoming" "$env_path"
if [ "$(cat "$control_dir/overlay-existed")" = true ]; then
  mv -- "$overlay_path" "$overlay_rollback"
fi
mv -- "$overlay_incoming" "$overlay_path"
find "$data_dir" -xdev \( -type d -o -type f \) -exec chattr +i -- {} +
sync -f "$data_parent"
sync -f /etc/comis
sync -f "$control_dir"
${TARGET_REPLAY_CONFIGURATION_GUARD}
if [ -e "$reattest_script" ] || [ -L "$reattest_script" ]; then exit 95; fi
cat > "$reattest_script" <<'PYTHON_REATTEST'
import hashlib
import fcntl
import json
import os
import re
import shutil
import stat
import struct
import subprocess
import sys

(
    data_dir,
    source_env_path,
    effective_env_path,
    overlay_path,
    expected_overlay_sha_path,
    manifest_path,
    run_id,
    target_machine_sha256,
    output_path,
) = sys.argv[1:]

FS_IOC_GETFLAGS = 0x80086601
FS_IMMUTABLE_FL = 0x00000010

def fail():
    raise SystemExit(95)

def hash_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                return digest.hexdigest()
            digest.update(chunk)

def require_immutable(path):
    if sys.platform != "linux":
        return
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        buffer = bytearray(4)
        fcntl.ioctl(descriptor, FS_IOC_GETFLAGS, buffer, True)
        if struct.unpack("I", buffer)[0] & FS_IMMUTABLE_FL == 0:
            fail()
    finally:
        os.close(descriptor)

def command_output(command, arguments):
    completed = subprocess.run(
        [command, *arguments], check=False, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
    )
    if completed.returncode != 0:
        fail()
    return completed.stdout.decode("utf8")

def metadata_digests(path, is_symlink, identity):
    result = {}
    if identity["acl"] == "captured":
        value = "" if is_symlink else command_output("getfacl", ["-cEn", "--", path])
        result["aclSha256"] = hashlib.sha256(value.encode("utf8")).hexdigest()
    if identity["xattr"] == "captured":
        arguments = ["--absolute-names", "--dump", "--encoding=hex", "-m", "-"]
        if is_symlink:
            arguments.append("-h")
        output = command_output("getfattr", [*arguments, "--", path])
        lines = [line for line in output.split("\n") if line and not line.startswith("#")]
        canonical = "\n".join(sorted(lines, key=lambda line: line.encode("utf8")))
        result["xattrSha256"] = hashlib.sha256(canonical.encode("utf8")).hexdigest()
    if identity["capability"] == "captured":
        canonical = ""
        if not is_symlink:
            output = command_output("getcap", ["-n", path]).strip()
            prefix = path + " "
            canonical = output[len(prefix):] if output.startswith(prefix) else output
        result["capabilitySha256"] = hashlib.sha256(canonical.encode("utf8")).hexdigest()
    return result

def entry_record(path, relative, identity, inode_targets):
    value = os.lstat(path)
    record = {
        "path": relative,
        "mode": format(stat.S_IMODE(value.st_mode), "04o"),
        "size": value.st_size,
        "uid": value.st_uid,
        "gid": value.st_gid,
        "mtimeNs": str(value.st_mtime_ns),
        **metadata_digests(path, stat.S_ISLNK(value.st_mode), identity),
    }
    if stat.S_ISREG(value.st_mode):
        inode = (value.st_dev, value.st_ino)
        target = inode_targets.get(inode)
        if target is not None:
            return {**record, "type": "hardlink", "hardlinkTarget": target}
        inode_targets[inode] = relative
        return {**record, "type": "file", "sha256": hash_file(path)}
    if stat.S_ISLNK(value.st_mode):
        return {**record, "type": "symlink", "linkTarget": os.readlink(path)}
    if stat.S_ISDIR(value.st_mode):
        return {**record, "type": "directory", "size": 0}
    fail()

def scan_data(identity):
    paths = []
    def collect(path, relative):
        paths.append((path, relative))
        value = os.lstat(path)
        if stat.S_ISDIR(value.st_mode) or stat.S_ISREG(value.st_mode):
            require_immutable(path)
        if not stat.S_ISDIR(value.st_mode):
            return
        for child in sorted(os.listdir(path), key=lambda name: name.encode("utf8")):
            collect(os.path.join(path, child), relative + "/" + child)
    collect(data_dir, "data")
    inode_targets = {}
    return [
        entry_record(path, relative, identity, inode_targets)
        for path, relative in sorted(paths, key=lambda item: item[1].encode("utf8"))
    ]

def update_field(digest, value):
    digest.update(str(value).encode("utf8"))
    digest.update(b"\0")

def identity_digest(domain, records, identity):
    digest = hashlib.sha256(domain)
    update_field(digest, identity["acl"])
    update_field(digest, identity["xattr"])
    update_field(digest, identity["capability"])
    for gap in sorted(identity["gaps"], key=lambda item: item["kind"].encode("utf8")):
        update_field(digest, gap["kind"])
        update_field(digest, gap["reason"])
    fields = (
        "path", "type", "mode", "size", "uid", "gid", "mtimeNs", "sha256",
        "linkTarget", "hardlinkTarget", "aclSha256", "xattrSha256", "capabilitySha256",
    )
    for record in sorted(records, key=lambda item: item["path"].encode("utf8")):
        for field in fields:
            update_field(digest, record.get(field, ""))
    return digest.hexdigest()

try:
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", run_id) is None:
        fail()
    if re.fullmatch(r"[a-f0-9]{64}", target_machine_sha256) is None:
        fail()
    manifest_raw = open(manifest_path, "rb").read()
    manifest = json.loads(manifest_raw)
    identity = manifest["metadataIdentity"]
    for kind, command in (("acl", "getfacl"), ("xattr", "getfattr"), ("capability", "getcap")):
        if identity[kind] == "captured" and shutil.which(command) is None:
            fail()

    expected_data = {
        entry["path"]: entry
        for entry in manifest["entries"]
        if entry["path"] == "data" or entry["path"].startswith("data/")
    }
    actual_data = scan_data(identity)
    if {entry["path"]: entry for entry in actual_data} != expected_data:
        fail()
    for exclusion in manifest["exclusions"]:
        relative = exclusion["path"]
        if relative.startswith("data/") and os.path.lexists(
            os.path.join(data_dir, relative[len("data/"):])
        ):
            fail()

    restored_data_identity = identity_digest(
        b"comis-snapshot-data-tree-v1\0", actual_data, identity
    )
    if restored_data_identity != manifest["dataTreeIdentitySha256"]:
        fail()

    expected_environment = next(
        entry for entry in manifest["entries"] if entry["path"] == "system/etc/comis/env"
    )
    actual_environment = entry_record(
        source_env_path, "system/etc/comis/env", identity, {}
    )
    if actual_environment != expected_environment:
        fail()
    source_environment_identity = identity_digest(
        b"comis-snapshot-source-environment-v1\0", [actual_environment], identity
    )
    if source_environment_identity != manifest["sourceEnvironmentEvidenceIdentitySha256"]:
        fail()

    expected_overlay_sha256 = open(
        expected_overlay_sha_path, "r", encoding="ascii"
    ).read()
    if re.fullmatch(r"[a-f0-9]{64}\n", expected_overlay_sha256) is None:
        fail()
    expected_overlay_sha256 = expected_overlay_sha256.rstrip("\n")
    overlay_sha256 = hash_file(overlay_path)
    if overlay_sha256 != expected_overlay_sha256:
        fail()

    expected_suffix = (
        b"\n\nCOMIS_CONFIG_PATHS="
        + data_dir.encode("utf8")
        + b"/config.yaml:/etc/comis/replay-quarantine.yaml\n"
    )
    if os.path.getsize(effective_env_path) != os.path.getsize(source_env_path) + len(expected_suffix):
        fail()
    with open(source_env_path, "rb") as source_handle, open(effective_env_path, "rb") as effective_handle:
        while True:
            source_chunk = source_handle.read(1024 * 1024)
            if not source_chunk:
                break
            if effective_handle.read(len(source_chunk)) != source_chunk:
                fail()
        if effective_handle.read(len(expected_suffix)) != expected_suffix:
            fail()
        if effective_handle.read(1):
            fail()

    data_dir_identity = hashlib.sha256(
        b"comis-replay-data-dir-v1\0" + data_dir.encode("utf8")
    ).hexdigest()
    attestation = {
        "schemaVersion": 1,
        "state": "committed",
        "runId": run_id,
        "targetMachineIdSha256": target_machine_sha256,
        "baselineImmutable": True,
        "dataDirSha256": data_dir_identity,
        "snapshotManifestSha256": hashlib.sha256(manifest_raw).hexdigest(),
        "restoredDataTreeDigestSha256": restored_data_identity,
        "sourceEnvironmentEvidenceIdentitySha256": source_environment_identity,
        "effectiveEnvironmentContentSha256": hash_file(effective_env_path),
        "replayOverlayContentSha256": overlay_sha256,
        "dataEntryCount": len(actual_data),
        "dataBytes": sum(
            entry["size"] for entry in actual_data if entry["type"] == "file"
        ),
    }
    descriptor = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
    with os.fdopen(descriptor, "w", encoding="utf8") as handle:
        json.dump(attestation, handle, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
except (KeyError, OSError, StopIteration, TypeError, UnicodeError, ValueError):
    fail()
PYTHON_REATTEST
chmod 0500 "$reattest_script"
sync -f "$control_dir"
python3 "$reattest_script" "$data_dir" "$source_env_copy" "$env_path" \
  "$overlay_path" "$expected_overlay_sha" "$expected_manifest" "$run_id" \
  "$expected_machine" "$attestation_path"
printf '%s\n' installed > "$control_dir/installed.tmp"
chmod 0400 "$control_dir/installed.tmp"
sync -f "$control_dir/installed.tmp"
mv -- "$control_dir/installed.tmp" "$control_dir/installed"
sync -f "$control_dir"
rm -f -- "$promoting_marker"
sync -f "$control_dir"
rm -rf -- "$extract_dir/system"
rm -f -- "$archive"
rm -rf -- "$runtime_dir"
sync -f "$control_dir"
trap - EXIT HUP INT TERM
`;

const TARGET_READ_ATTESTATION_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
data_dir="$2"
run_id="$3"
service="$4"
service_user="$5"
${TARGET_GUARD}
${TARGET_TRANSACTION_GUARD}
if [ ! -f "$transaction_marker" ] || [ -L "$transaction_marker" ] || \
   [ "$(stat -c '%u:%g:%a' "$transaction_marker" 2>/dev/null || true)" != 0:0:400 ] || \
   [ "$(cat "$transaction_marker" 2>/dev/null || true)" != "$run_id" ] || \
   [ -e "$promoting_marker" ] || [ -L "$promoting_marker" ] || \
   [ -e "$rolling_back_marker" ] || [ -L "$rolling_back_marker" ] || \
   [ ! -f "$control_dir/installed" ] || [ -L "$control_dir/installed" ] || \
   [ ! -f "$attestation_path" ] || [ -L "$attestation_path" ] || \
   [ "$(stat -c '%u:%g:%a' "$attestation_path" 2>/dev/null || true)" != 0:0:400 ] || \
   [ "$(stat -c '%s' "$attestation_path" 2>/dev/null || true)" -gt 4096 ]; then exit 96; fi
cat -- "$attestation_path"
`;

const TARGET_STATUS_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
data_dir="$2"
run_id="$3"
service="$4"
service_user="$5"
${TARGET_RECOVERY_GUARD}
emit_absent_status() {
  printf '{"schemaVersion":1,"runId":"%s","targetMachineIdSha256":"%s","state":"absent","bytesTransferred":null,"restoreAttestationBase64":null,"restoreAttestationSha256":null}\n' \
    "$run_id" "$expected_machine"
}
cleanup_unpromoted_restore() {
  if [ -e "$coordination_identity" ] || [ -L "$coordination_identity" ]; then
    :
  else
    exit 79
  fi
  if [ -e "$rollback_data" ] || [ -L "$rollback_data" ] || \
     [ -e "$env_rollback" ] || [ -L "$env_rollback" ] || \
     [ -e "$overlay_rollback" ] || [ -L "$overlay_rollback" ] || \
     [ -e "$seal_rollback" ] || [ -L "$seal_rollback" ] || \
     [ -e "$old_data_unlocked" ] || [ -L "$old_data_unlocked" ] || \
     [ -e "$promoting_marker" ] || [ -L "$promoting_marker" ] || \
     [ -e "$rolling_back_marker" ] || [ -L "$rolling_back_marker" ] || \
     [ -e "$control_dir/installed" ] || [ -L "$control_dir/installed" ] || \
     [ -e "$commit_authorized" ] || [ -L "$commit_authorized" ] || \
     [ -e "$finalizing_marker" ] || [ -L "$finalizing_marker" ] || \
     [ -e "$finalized_marker" ] || [ -L "$finalized_marker" ] || \
     [ -e "$rolled_back_marker" ] || [ -L "$rolled_back_marker" ]; then exit 79; fi
  if [ -e "$transaction_identity" ] || [ -L "$transaction_identity" ]; then
    if [ ! -f "$transaction_identity" ] || [ -L "$transaction_identity" ] || \
       [ "$(stat -c '%u:%g:%a' "$transaction_identity" 2>/dev/null || true)" != 0:0:400 ] || \
       [ "$(cat "$transaction_identity" 2>/dev/null || true)" != "$expected_transaction_identity" ]; then
      transaction_identity_incomplete=1
    fi
  fi
  if [ -e "$transaction_marker" ] || [ -L "$transaction_marker" ]; then
    if [ ! -f "$transaction_marker" ] || [ -L "$transaction_marker" ] || \
       [ "$(stat -c '%u:%g:%a' "$transaction_marker" 2>/dev/null || true)" != 0:0:400 ] || \
       [ "$(cat "$transaction_marker" 2>/dev/null || true)" != "$run_id" ]; then
      transaction_marker_incomplete=1
    fi
  fi
  chattr -R -i -a "$incoming_data" 2>/dev/null || true
  rm -rf -- "$runtime_dir" "$incoming_data" "$control_dir"
  rm -f -- "$env_incoming" "$overlay_incoming" "$seal_incoming"
  if [ -d "$state_root" ] && [ ! -L "$state_root" ]; then sync -f "$state_root"; fi
  sync -f "$data_parent"
  sync -f /etc/comis
  if [ -d "$runtime_root" ] && [ ! -L "$runtime_root" ]; then sync -f "$runtime_root"; fi
  rm -f -- "$active_restore" "$current_restore_incoming" "$owner_marker"
  sync -f "$coordination_root"
  for prepare_artifact in "$runtime_dir" "$incoming_data" "$control_dir" \
    "$env_incoming" "$overlay_incoming" "$seal_incoming" \
    "$active_restore" "$current_restore_incoming" "$owner_marker"; do
    if [ -e "$prepare_artifact" ] || [ -L "$prepare_artifact" ]; then exit 79; fi
  done
  rm -f -- "$coordination_identity"
  sync -f "$coordination_root"
  emit_absent_status
  exit 0
}
if { [ ! -e "$control_dir" ] && [ ! -L "$control_dir" ]; } && \
   { [ ! -e "$active_restore" ] && [ ! -L "$active_restore" ]; }; then
  if { [ ! -e "$owner_marker" ] && [ ! -L "$owner_marker" ]; } && \
     { [ ! -e "$coordination_identity" ] && [ ! -L "$coordination_identity" ]; } && \
     { [ ! -e "$coordination_identity_scratch" ] && [ ! -L "$coordination_identity_scratch" ]; } && \
     { [ ! -e "$coordination_identity_candidate" ] && [ ! -L "$coordination_identity_candidate" ]; } && \
     { [ ! -e "$current_restore_incoming" ] && [ ! -L "$current_restore_incoming" ]; } && \
     { [ ! -e "$runtime_dir" ] && [ ! -L "$runtime_dir" ]; } && \
     { [ ! -e "$incoming_data" ] && [ ! -L "$incoming_data" ]; } && \
     { [ ! -e "$env_incoming" ] && [ ! -L "$env_incoming" ]; } && \
     { [ ! -e "$env_rollback" ] && [ ! -L "$env_rollback" ]; } && \
     { [ ! -e "$overlay_incoming" ] && [ ! -L "$overlay_incoming" ]; } && \
     { [ ! -e "$overlay_rollback" ] && [ ! -L "$overlay_rollback" ]; } && \
     { [ ! -e "$seal_incoming" ] && [ ! -L "$seal_incoming" ]; } && \
     { [ ! -e "$seal_rollback" ] && [ ! -L "$seal_rollback" ]; }; then
    emit_absent_status
    exit 0
  fi
  if [ ! -d "$coordination_root" ] || [ -L "$coordination_root" ] || \
     [ "$(stat -c '%u:%g:%a' "$coordination_root" 2>/dev/null || true)" != 0:0:700 ] || \
     [ ! -f "$operation_lock" ] || [ -L "$operation_lock" ] || \
     [ "$(stat -c '%u:%g:%a' "$operation_lock" 2>/dev/null || true)" != 0:0:600 ]; then
    exit 79
  fi
  exec 8<>"$operation_lock"
  if ! flock -n 8; then exit 79; fi
  if [ -e "$control_dir" ] || [ -L "$control_dir" ] || \
     [ -e "$active_restore" ] || [ -L "$active_restore" ]; then
    exit 79
  fi
  ${TARGET_TRANSACTION_IDENTITY_EXPECTATION}
  if [ -e "$coordination_identity_scratch" ] || [ -L "$coordination_identity_scratch" ]; then
    if [ ! -f "$coordination_identity_scratch" ] || \
       [ -L "$coordination_identity_scratch" ] || \
       [ "$(stat -c '%u:%g:%a:%h' "$coordination_identity_scratch" \
         2>/dev/null || true)" != 0:0:400:1 ]; then exit 79; fi
    rm -f -- "$coordination_identity_scratch"
    sync -f "$coordination_root"
  fi
  if [ ! -e "$coordination_identity" ] && [ ! -L "$coordination_identity" ]; then
    for identity_prefix_artifact in "$owner_marker" "$current_restore_incoming" \
      "$runtime_dir" "$incoming_data" "$env_incoming" "$env_rollback" \
      "$overlay_incoming" "$overlay_rollback" "$seal_incoming" "$seal_rollback"; do
      if [ -e "$identity_prefix_artifact" ] || [ -L "$identity_prefix_artifact" ]; then
        exit 79
      fi
    done
    if [ -e "$coordination_identity_candidate" ] || [ -L "$coordination_identity_candidate" ]; then
      if [ ! -f "$coordination_identity_candidate" ] || \
         [ -L "$coordination_identity_candidate" ] || \
         [ "$(stat -c '%u:%g:%a:%h' "$coordination_identity_candidate" \
           2>/dev/null || true)" != 0:0:400:1 ] || \
         [ "$(cat "$coordination_identity_candidate" 2>/dev/null || true)" != \
           "$expected_transaction_identity" ]; then exit 79; fi
      rm -f -- "$coordination_identity_candidate"
      sync -f "$coordination_root"
    fi
    emit_absent_status
    exit 0
  fi
  if [ -e "$coordination_identity_candidate" ] || \
     [ -L "$coordination_identity_candidate" ]; then exit 79; fi
  if [ ! -f "$coordination_identity" ] || [ -L "$coordination_identity" ] || \
     [ "$(stat -c '%u:%g:%a' "$coordination_identity" 2>/dev/null || true)" != 0:0:400 ] || \
     [ "$(cat "$coordination_identity" 2>/dev/null || true)" != "$expected_transaction_identity" ]; then
    exit 79
  fi
  if [ -e "$owner_marker" ] || [ -L "$owner_marker" ]; then
    if [ ! -f "$owner_marker" ] || [ -L "$owner_marker" ] || \
       [ "$(stat -c '%u:%g:%a' "$owner_marker" 2>/dev/null || true)" != 0:0:400 ] || \
       [ "$(cat "$owner_marker" 2>/dev/null || true)" != "$run_id" ]; then
      owner_marker_incomplete=1
    fi
  fi
  if [ -e "$current_restore_incoming" ] || [ -L "$current_restore_incoming" ]; then
    if [ ! -f "$current_restore_incoming" ] || [ -L "$current_restore_incoming" ] || \
       [ ! -f "$owner_marker" ] || [ -L "$owner_marker" ] || \
       [ "$(stat -c '%u:%g:%a' "$current_restore_incoming" 2>/dev/null || true)" != 0:0:400 ] || \
       [ "$(cat "$current_restore_incoming" 2>/dev/null || true)" != "$run_id" ] || \
       [ "$(stat -c '%d:%i' "$current_restore_incoming" 2>/dev/null || true)" != \
         "$(stat -c '%d:%i' "$owner_marker" 2>/dev/null || true)" ]; then exit 79; fi
  fi
  if [ -e "$current_restore" ] || [ -L "$current_restore" ]; then
    if [ ! -f "$current_restore" ] || [ -L "$current_restore" ] || \
       [ "$(stat -c '%u:%g:%a' "$current_restore" 2>/dev/null || true)" != 0:0:400 ]; then
      exit 79
    fi
    if [ -f "$owner_marker" ] && \
       [ "$(stat -c '%d:%i' "$current_restore")" = \
       "$(stat -c '%d:%i' "$owner_marker")" ]; then exit 79; fi
  fi
  chattr -R -i -a "$incoming_data" 2>/dev/null || true
  rm -rf -- "$runtime_dir" "$incoming_data"
  rm -f -- "$env_incoming" "$env_rollback" \
    "$overlay_incoming" "$overlay_rollback" \
    "$seal_incoming" "$seal_rollback"
  sync -f "$state_root"
  sync -f "$data_parent"
  sync -f /etc/comis
  if [ -d "$runtime_root" ] && [ ! -L "$runtime_root" ]; then sync -f "$runtime_root"; fi
  rm -f -- "$active_restore" "$current_restore_incoming" "$owner_marker"
  sync -f "$coordination_root"
  for orphan_artifact in "$runtime_dir" "$incoming_data" "$env_incoming" \
    "$env_rollback" "$overlay_incoming" "$overlay_rollback" \
    "$seal_incoming" "$seal_rollback" "$active_restore" \
    "$current_restore_incoming" "$owner_marker"; do
    if [ -e "$orphan_artifact" ] || [ -L "$orphan_artifact" ]; then exit 79; fi
  done
  rm -f -- "$coordination_identity"
  sync -f "$coordination_root"
  emit_absent_status
  exit 0
fi
if { [ -e "$control_dir" ] && [ ! -L "$control_dir" ]; } && \
   { [ ! -e "$active_restore" ] && [ ! -L "$active_restore" ]; }; then
  if { [ ! -e "$finalized_marker" ] && [ ! -L "$finalized_marker" ]; } && \
     { [ ! -e "$rolled_back_marker" ] && [ ! -L "$rolled_back_marker" ]; }; then
    if [ ! -f "$operation_lock" ] || [ -L "$operation_lock" ] || \
       [ "$(stat -c '%u:%g:%a' "$operation_lock" 2>/dev/null || true)" != 0:0:600 ]; then
      exit 79
    fi
    exec 8<>"$operation_lock"
    if ! flock -n 8; then exit 79; fi
    if [ ! -d "$control_dir" ] || [ -L "$control_dir" ] || \
       [ -e "$active_restore" ] || [ -L "$active_restore" ]; then exit 79; fi
    ${TARGET_TRANSACTION_IDENTITY_EXPECTATION}
    if [ ! -f "$coordination_identity" ] || [ -L "$coordination_identity" ] || \
       [ "$(stat -c '%u:%g:%a' "$coordination_identity" 2>/dev/null || true)" != 0:0:400 ] || \
       [ "$(cat "$coordination_identity" 2>/dev/null || true)" != \
         "$expected_transaction_identity" ]; then exit 79; fi
    cleanup_unpromoted_restore
  fi
fi
${TARGET_TRANSACTION_GUARD}
if [ ! -f "$transaction_marker" ] || [ -L "$transaction_marker" ] || \
   [ "$(stat -c '%u:%g:%a' "$transaction_marker" 2>/dev/null || true)" != 0:0:400 ] || \
   [ "$(cat "$transaction_marker" 2>/dev/null || true)" != "$run_id" ]; then exit 96; fi
terminal_cleanup_complete=0
if [ -f "$finalized_marker" ] && [ ! -L "$finalized_marker" ] && \
   [ ! -e "$finalizing_marker" ] && [ ! -L "$finalizing_marker" ]; then
  terminal_cleanup_complete=1
fi
if [ -f "$rolled_back_marker" ] && [ ! -L "$rolled_back_marker" ] && \
   [ ! -e "$rolling_back_marker" ] && [ ! -L "$rolling_back_marker" ]; then
  terminal_cleanup_complete=1
fi
if [ "$terminal_cleanup_complete" -eq 1 ]; then
  for terminal_external_artifact in "$env_incoming" "$env_rollback" \
    "$overlay_incoming" "$overlay_rollback" "$seal_incoming" "$seal_rollback" \
    "$runtime_dir" "$incoming_data"; do
    if [ -e "$terminal_external_artifact" ] || [ -L "$terminal_external_artifact" ]; then
      exit 96
    fi
  done
fi
python3 - "$run_id" "$expected_machine" "$data_dir" "$seal_path" \
  "$bytes_received_path" "$attestation_path" "$control_dir/installed" \
  "$promoting_marker" "$rolling_back_marker" "$commit_authorized" \
  "$finalizing_marker" "$finalized_marker" "$rolled_back_marker" \
  "$active_restore" "$current_restore" "$current_restore_incoming" \
  "$owner_marker" <<'PYTHON_STATUS'
import base64
import hashlib
import json
import os
import stat
import sys

(
    run_id,
    target_machine_sha256,
    data_dir,
    public_seal_path,
    bytes_path,
    attestation_path,
    installed_path,
    promoting_path,
    rolling_back_path,
    authorized_path,
    finalizing_path,
    finalized_path,
    rolled_back_path,
    active_restore_path,
    current_restore_path,
    current_restore_incoming_path,
    owner_marker_path,
) = sys.argv[1:]

def fail():
    raise SystemExit(96)

def trusted_file(path, mode, maximum_bytes):
    try:
        value = os.lstat(path)
    except FileNotFoundError:
        return None
    if (
        not stat.S_ISREG(value.st_mode)
        or value.st_uid != 0
        or value.st_gid != 0
        or stat.S_IMODE(value.st_mode) != mode
        or value.st_size <= 0
        or value.st_size > maximum_bytes
    ):
        fail()
    with open(path, "rb") as handle:
        return handle.read()

def exact_marker(path, expected):
    value = trusted_file(path, 0o400, 64)
    if value is None:
        return False
    if value != expected:
        fail()
    return True

rolled_back = exact_marker(rolled_back_path, b"rolled-back\n")
finalized = exact_marker(finalized_path, b"finalized\n")
finalizing = exact_marker(finalizing_path, b"finalizing\n")
rolling_back = exact_marker(rolling_back_path, b"rolling-back\n")
promoting = exact_marker(promoting_path, b"promoting\n")
installed = exact_marker(installed_path, b"installed\n")
authorized_raw = trusted_file(authorized_path, 0o400, 512)
bytes_raw = trusted_file(bytes_path, 0o400, 64)
attestation_raw = trusted_file(attestation_path, 0o400, 4096)

terminal_generation = False
if finalized:
    seal_raw = trusted_file(public_seal_path, 0o444, 4096)
    current_raw = trusted_file(current_restore_path, 0o400, 64)
    owner_raw = trusted_file(owner_marker_path, 0o400, 64)
    if current_raw == (run_id + "\n").encode("ascii") and owner_raw == current_raw:
        current_status = os.lstat(current_restore_path)
        owner_status = os.lstat(owner_marker_path)
        terminal_generation = (
            current_status.st_dev == owner_status.st_dev
            and current_status.st_ino == owner_status.st_ino
            and not os.path.lexists(active_restore_path)
            and seal_raw == attestation_raw
        )

if rolling_back:
    if finalized or finalizing or authorized_raw is not None:
        fail()
    state = "rolling_back"
elif rolled_back:
    if (
        promoting
        or finalized
        or finalizing
        or installed
        or authorized_raw is not None
        or attestation_raw is not None
        or os.path.lexists(active_restore_path)
        or os.path.lexists(current_restore_incoming_path)
        or os.path.lexists(owner_marker_path)
    ):
        fail()
    state = "rolled_back"
elif promoting:
    if finalized or finalizing or authorized_raw is not None:
        fail()
    state = "promoting"
elif finalized and terminal_generation:
    state = "finalized"
elif finalizing or finalized:
    state = "finalizing"
elif authorized_raw is not None:
    state = "authorized"
elif installed:
    state = "promoted"
elif bytes_raw is not None:
    state = "received"
else:
    state = "prepared"

bytes_transferred = None
if bytes_raw is not None:
    try:
        bytes_text = bytes_raw.decode("ascii")
    except UnicodeDecodeError:
        fail()
    if not bytes_text.endswith("\n") or not bytes_text[:-1].isdigit():
        fail()
    bytes_transferred = int(bytes_text[:-1])
    if bytes_transferred <= 0 or bytes_transferred > 8 * 1024 * 1024 * 1024 * 1024:
        fail()

requires_attestation = state in ("promoted", "authorized", "finalizing", "finalized")
allows_optional_attestation = state in ("promoting", "rolling_back")
if (requires_attestation and attestation_raw is None) or (
    not requires_attestation and not allows_optional_attestation and attestation_raw is not None
):
    fail()
if state in ("received", "promoting", "promoted", "authorized", "finalizing", "finalized") and bytes_transferred is None:
    fail()
if attestation_raw is not None and bytes_transferred is None and state != "rolling_back":
    fail()

attestation_base64 = None
attestation_sha256 = None
if attestation_raw is not None:
    try:
        attestation = json.loads(attestation_raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail()
    if (
        not isinstance(attestation, dict)
        or attestation.get("runId") != run_id
        or attestation.get("targetMachineIdSha256") != target_machine_sha256
        or attestation.get("state") != "committed"
        or attestation.get("baselineImmutable") is not True
        or attestation.get("dataDirSha256") != hashlib.sha256(
            b"comis-replay-data-dir-v1\0" + data_dir.encode("utf8")
        ).hexdigest()
    ):
        fail()
    attestation_sha256 = hashlib.sha256(attestation_raw).hexdigest()
    attestation_base64 = base64.b64encode(attestation_raw).decode("ascii")
    if state in ("authorized", "finalizing", "finalized"):
        expected_authorization = (
            "schemaVersion=1\n"
            "state=authorized\n"
            f"runId={run_id}\n"
            f"targetMachineIdSha256={target_machine_sha256}\n"
            f"snapshotManifestSha256={attestation.get('snapshotManifestSha256')}\n"
            f"restoreAttestationSha256={attestation_sha256}\n"
        ).encode("ascii")
        if authorized_raw != expected_authorization:
            fail()

print(json.dumps({
    "schemaVersion": 1,
    "runId": run_id,
    "targetMachineIdSha256": target_machine_sha256,
    "state": state,
    "bytesTransferred": bytes_transferred,
    "restoreAttestationBase64": attestation_base64,
    "restoreAttestationSha256": attestation_sha256,
}, separators=(",", ":")))
PYTHON_STATUS
`;

const TARGET_ROLLBACK_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
data_dir="$2"
run_id="$3"
service="$4"
service_user="$5"
exec 1>/dev/null
${TARGET_RECOVERY_GUARD}
if { [ ! -e "$control_dir" ] && [ ! -L "$control_dir" ]; } && \
   { [ ! -e "$active_restore" ] && [ ! -L "$active_restore" ]; } && \
   { [ ! -e "$owner_marker" ] && [ ! -L "$owner_marker" ]; } && \
   { [ ! -e "$coordination_identity" ] && [ ! -L "$coordination_identity" ]; } && \
   { [ ! -e "$coordination_identity_scratch" ] && [ ! -L "$coordination_identity_scratch" ]; } && \
   { [ ! -e "$coordination_identity_candidate" ] && [ ! -L "$coordination_identity_candidate" ]; } && \
   { [ ! -e "$current_restore_incoming" ] && [ ! -L "$current_restore_incoming" ]; } && \
   { [ ! -e "$runtime_dir" ] && [ ! -L "$runtime_dir" ]; } && \
   { [ ! -e "$incoming_data" ] && [ ! -L "$incoming_data" ]; } && \
   { [ ! -e "$env_incoming" ] && [ ! -L "$env_incoming" ]; } && \
   { [ ! -e "$env_rollback" ] && [ ! -L "$env_rollback" ]; } && \
   { [ ! -e "$overlay_incoming" ] && [ ! -L "$overlay_incoming" ]; } && \
   { [ ! -e "$overlay_rollback" ] && [ ! -L "$overlay_rollback" ]; } && \
   { [ ! -e "$seal_incoming" ] && [ ! -L "$seal_incoming" ]; } && \
   { [ ! -e "$seal_rollback" ] && [ ! -L "$seal_rollback" ]; }; then
  exit 0
fi
if [ ! -d "$coordination_root" ]; then
  install -d -m 0700 -o root -g root "$coordination_root"
fi
if [ ! -e "$operation_lock" ] && [ ! -L "$operation_lock" ]; then
  old_umask="$(umask)"
  umask 077
  (set -C; : > "$operation_lock") 2>/dev/null || true
  umask "$old_umask"
fi
if [ ! -f "$operation_lock" ] || [ -L "$operation_lock" ] || \
   [ "$(stat -c '%u:%g:%a' "$operation_lock" 2>/dev/null || true)" != 0:0:600 ]; then
  exit 79
fi
exec 9<>"$operation_lock"
if ! flock -n 9; then exit 79; fi
${TARGET_TRANSACTION_IDENTITY_EXPECTATION}
if [ -e "$coordination_identity_scratch" ] || [ -L "$coordination_identity_scratch" ]; then
  if [ ! -f "$coordination_identity_scratch" ] || \
     [ -L "$coordination_identity_scratch" ] || \
     [ "$(stat -c '%u:%g:%a:%h' "$coordination_identity_scratch" \
       2>/dev/null || true)" != 0:0:400:1 ]; then exit 79; fi
  rm -f -- "$coordination_identity_scratch"
  sync -f "$coordination_root"
fi
if [ ! -e "$coordination_identity" ] && [ ! -L "$coordination_identity" ]; then
  if [ -e "$control_dir" ] || [ -L "$control_dir" ] || \
     [ -e "$active_restore" ] || [ -L "$active_restore" ]; then exit 79; fi
  for identity_prefix_artifact in "$owner_marker" "$current_restore_incoming" \
    "$runtime_dir" "$incoming_data" "$env_incoming" "$env_rollback" \
    "$overlay_incoming" "$overlay_rollback" "$seal_incoming" "$seal_rollback"; do
    if [ -e "$identity_prefix_artifact" ] || [ -L "$identity_prefix_artifact" ]; then
      exit 79
    fi
  done
  if [ -e "$coordination_identity_candidate" ] || [ -L "$coordination_identity_candidate" ]; then
    if [ ! -f "$coordination_identity_candidate" ] || \
       [ -L "$coordination_identity_candidate" ] || \
       [ "$(stat -c '%u:%g:%a:%h' "$coordination_identity_candidate" \
         2>/dev/null || true)" != 0:0:400:1 ] || \
       [ "$(cat "$coordination_identity_candidate" 2>/dev/null || true)" != \
         "$expected_transaction_identity" ]; then exit 79; fi
    rm -f -- "$coordination_identity_candidate"
    sync -f "$coordination_root"
  fi
  exit 0
fi
if [ -e "$coordination_identity_candidate" ] || \
   [ -L "$coordination_identity_candidate" ]; then exit 79; fi
if [ ! -f "$coordination_identity" ] || [ -L "$coordination_identity" ] || \
   [ "$(stat -c '%u:%g:%a' "$coordination_identity" 2>/dev/null || true)" != 0:0:400 ] || \
   [ "$(cat "$coordination_identity" 2>/dev/null || true)" != \
     "$expected_transaction_identity" ]; then exit 79; fi
systemctl stop "$unit" >/dev/null 2>&1 || true
systemctl kill --kill-who=all "$unit" >/dev/null 2>&1 || true
systemctl disable "$unit" >/dev/null 2>&1 || true
recovery_active_state="$(systemctl is-active "$unit" 2>/dev/null || true)"
recovery_enabled_state="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
case "$recovery_active_state" in inactive|failed|unknown) ;; *) exit 73 ;; esac
case "$recovery_enabled_state" in disabled|masked|not-found) ;; *) exit 73 ;; esac
if [ ! -e "$control_dir" ] && [ ! -L "$control_dir" ]; then
  ${TARGET_TRANSACTION_IDENTITY_EXPECTATION}
  if [ ! -f "$coordination_identity" ] || [ -L "$coordination_identity" ] || \
     [ "$(stat -c '%u:%g:%a' "$coordination_identity" 2>/dev/null || true)" != 0:0:400 ] || \
     [ "$(cat "$coordination_identity" 2>/dev/null || true)" != "$expected_transaction_identity" ]; then
    exit 79
  fi
  if [ -e "$active_restore" ] || [ -L "$active_restore" ]; then
    if [ ! -f "$active_restore" ] || [ -L "$active_restore" ] || \
       [ "$(stat -c '%u:%g:%a' "$active_restore" 2>/dev/null || true)" != 0:0:400 ] || \
       [ "$(cat "$active_restore" 2>/dev/null || true)" != "$run_id" ] || \
       [ ! -f "$owner_marker" ] || [ -L "$owner_marker" ] || \
       [ "$(stat -c '%d:%i' "$active_restore" 2>/dev/null || true)" != \
         "$(stat -c '%d:%i' "$owner_marker" 2>/dev/null || true)" ]; then exit 79; fi
  fi
  if [ -e "$owner_marker" ] || [ -L "$owner_marker" ]; then
    if [ ! -f "$owner_marker" ] || [ -L "$owner_marker" ] || \
       [ "$(stat -c '%u:%g:%a' "$owner_marker" 2>/dev/null || true)" != 0:0:400 ] || \
       [ "$(cat "$owner_marker" 2>/dev/null || true)" != "$run_id" ]; then exit 79; fi
  fi
  if [ -e "$current_restore_incoming" ] || [ -L "$current_restore_incoming" ]; then
    if [ ! -f "$current_restore_incoming" ] || [ -L "$current_restore_incoming" ] || \
       [ ! -f "$owner_marker" ] || [ -L "$owner_marker" ] || \
       [ "$(stat -c '%u:%g:%a' "$current_restore_incoming" 2>/dev/null || true)" != 0:0:400 ] || \
       [ "$(cat "$current_restore_incoming" 2>/dev/null || true)" != "$run_id" ] || \
       [ "$(stat -c '%d:%i' "$current_restore_incoming" 2>/dev/null || true)" != \
         "$(stat -c '%d:%i' "$owner_marker" 2>/dev/null || true)" ]; then exit 79; fi
  fi
  if [ -e "$current_restore" ] || [ -L "$current_restore" ]; then
    if [ ! -f "$current_restore" ] || [ -L "$current_restore" ] || \
       [ "$(stat -c '%u:%g:%a' "$current_restore" 2>/dev/null || true)" != 0:0:400 ]; then
      exit 79
    fi
    if [ -f "$owner_marker" ] && \
       [ "$(stat -c '%d:%i' "$current_restore")" = \
         "$(stat -c '%d:%i' "$owner_marker")" ]; then exit 79; fi
  fi
  chattr -R -i -a "$incoming_data" 2>/dev/null || true
  rm -rf -- "$runtime_dir" "$incoming_data"
  rm -f -- "$env_incoming" "$env_rollback" \
    "$overlay_incoming" "$overlay_rollback" \
    "$seal_incoming" "$seal_rollback"
  if [ -d "$state_root" ] && [ ! -L "$state_root" ]; then sync -f "$state_root"; fi
  sync -f "$data_parent"
  sync -f /etc/comis
  if [ -d "$runtime_root" ] && [ ! -L "$runtime_root" ]; then sync -f "$runtime_root"; fi
  rm -f -- "$active_restore" "$current_restore_incoming" "$owner_marker"
  sync -f "$coordination_root"
  for orphan_artifact in "$runtime_dir" "$incoming_data" "$env_incoming" \
    "$env_rollback" "$overlay_incoming" "$overlay_rollback" \
    "$seal_incoming" "$seal_rollback" "$active_restore" \
    "$current_restore_incoming" "$owner_marker"; do
    if [ -e "$orphan_artifact" ] || [ -L "$orphan_artifact" ]; then exit 79; fi
  done
  rm -f -- "$coordination_identity"
  sync -f "$coordination_root"
  exit 0
fi
if { [ -e "$control_dir" ] && [ ! -L "$control_dir" ]; } && \
   { [ ! -e "$active_restore" ] && [ ! -L "$active_restore" ]; }; then
  if { [ ! -e "$finalized_marker" ] && [ ! -L "$finalized_marker" ]; } && \
     { [ ! -e "$rolled_back_marker" ] && [ ! -L "$rolled_back_marker" ]; }; then
  if [ -e "$rollback_data" ] || [ -L "$rollback_data" ] || \
     [ -e "$env_rollback" ] || [ -L "$env_rollback" ] || \
     [ -e "$overlay_rollback" ] || [ -L "$overlay_rollback" ] || \
     [ -e "$seal_rollback" ] || [ -L "$seal_rollback" ] || \
     [ -e "$old_data_unlocked" ] || [ -L "$old_data_unlocked" ] || \
     [ -e "$promoting_marker" ] || [ -L "$promoting_marker" ] || \
     [ -e "$rolling_back_marker" ] || [ -L "$rolling_back_marker" ] || \
     [ -e "$control_dir/installed" ] || [ -L "$control_dir/installed" ] || \
     [ -e "$commit_authorized" ] || [ -L "$commit_authorized" ] || \
     [ -e "$finalizing_marker" ] || [ -L "$finalizing_marker" ]; then exit 79; fi
  ${TARGET_TRANSACTION_IDENTITY_EXPECTATION}
  if [ ! -f "$coordination_identity" ] || [ -L "$coordination_identity" ] || \
     [ "$(stat -c '%u:%g:%a' "$coordination_identity" 2>/dev/null || true)" != 0:0:400 ] || \
     [ "$(cat "$coordination_identity" 2>/dev/null || true)" != \
       "$expected_transaction_identity" ]; then exit 79; fi
  if [ -e "$transaction_identity" ] || [ -L "$transaction_identity" ]; then
    if [ ! -f "$transaction_identity" ] || [ -L "$transaction_identity" ] || \
       [ "$(stat -c '%u:%g:%a' "$transaction_identity" 2>/dev/null || true)" != 0:0:400 ] || \
       [ "$(cat "$transaction_identity" 2>/dev/null || true)" != \
         "$expected_transaction_identity" ]; then transaction_identity_incomplete=1; fi
  fi
  if [ -e "$transaction_marker" ] || [ -L "$transaction_marker" ]; then
    if [ ! -f "$transaction_marker" ] || [ -L "$transaction_marker" ] || \
       [ "$(stat -c '%u:%g:%a' "$transaction_marker" 2>/dev/null || true)" != 0:0:400 ] || \
       [ "$(cat "$transaction_marker" 2>/dev/null || true)" != "$run_id" ]; then
      transaction_marker_incomplete=1
    fi
  fi
  chattr -R -i -a "$incoming_data" 2>/dev/null || true
  rm -rf -- "$runtime_dir" "$incoming_data"
  rm -f -- "$env_incoming" "$env_rollback" \
    "$overlay_incoming" "$overlay_rollback" \
    "$seal_incoming" "$seal_rollback"
  sync -f "$data_parent"
  sync -f /etc/comis
  if [ -d "$runtime_root" ] && [ ! -L "$runtime_root" ]; then sync -f "$runtime_root"; fi
  rm -rf -- "$control_dir"
  sync -f "$state_root"
  rm -f -- "$active_restore" "$current_restore_incoming" "$owner_marker"
  sync -f "$coordination_root"
  for orphan_artifact in "$runtime_dir" "$control_dir" "$incoming_data" \
    "$env_incoming" "$env_rollback" "$overlay_incoming" "$overlay_rollback" \
    "$seal_incoming" "$seal_rollback" "$active_restore" \
    "$current_restore_incoming" "$owner_marker"; do
    if [ -e "$orphan_artifact" ] || [ -L "$orphan_artifact" ]; then exit 79; fi
  done
  rm -f -- "$coordination_identity"
  sync -f "$coordination_root"
  exit 0
  fi
fi
${TARGET_TRANSACTION_IDENTITY_GUARD}
${TARGET_TRANSACTION_OWNERSHIP_GUARD}
if [ ! -f "$transaction_marker" ] || [ -L "$transaction_marker" ] || \
   [ "$(stat -c '%u:%g:%a' "$transaction_marker" 2>/dev/null || true)" != 0:0:400 ] || \
   [ "$(cat "$transaction_marker" 2>/dev/null || true)" != "$run_id" ]; then
  exit 0
fi
if [ -e "$finalizing_marker" ] || [ -L "$finalizing_marker" ] || \
   [ -e "$finalized_marker" ] || [ -L "$finalized_marker" ]; then exit 98; fi
if [ -e "$commit_authorized" ]; then
  if [ ! -f "$commit_authorized" ] || [ -L "$commit_authorized" ] || \
     [ "$(stat -c '%u:%g:%a' "$commit_authorized" 2>/dev/null || true)" != 0:0:400 ] || \
     [ "$(stat -c '%s' "$commit_authorized" 2>/dev/null || true)" -gt 512 ]; then exit 98; fi
  exit 98
fi
rolling_back_present=0
if [ -e "$rolling_back_marker" ] || [ -L "$rolling_back_marker" ]; then
  if [ ! -f "$rolling_back_marker" ] || [ -L "$rolling_back_marker" ] || \
     [ "$(stat -c '%u:%g:%a' "$rolling_back_marker" 2>/dev/null || true)" != 0:0:400 ] || \
     [ "$(cat "$rolling_back_marker" 2>/dev/null || true)" != rolling-back ]; then exit 98; fi
  rolling_back_present=1
fi
rolled_back_present=0
if [ -e "$rolled_back_marker" ] || [ -L "$rolled_back_marker" ]; then
  if [ ! -f "$rolled_back_marker" ] || [ -L "$rolled_back_marker" ] || \
     [ "$(stat -c '%u:%g:%a' "$rolled_back_marker" 2>/dev/null || true)" != 0:0:400 ] || \
     [ "$(cat "$rolled_back_marker" 2>/dev/null || true)" != rolled-back ]; then exit 98; fi
  rolled_back_present=1
fi
if [ "$rolled_back_present" -eq 1 ] && [ "$rolling_back_present" -eq 0 ]; then
  for terminal_artifact in "$active_restore" "$current_restore_incoming" "$owner_marker" \
    "$runtime_dir" "$incoming_data" "$rollback_data" "$env_incoming" "$env_rollback" \
    "$overlay_incoming" "$overlay_rollback" "$seal_incoming" "$seal_rollback" \
    "$promoting_marker" "$control_dir/installed" "$commit_authorized" \
    "$bytes_received_path" "$attestation_path"; do
    if [ -e "$terminal_artifact" ] || [ -L "$terminal_artifact" ]; then exit 98; fi
  done
  unexpected_control="$(find "$control_dir" -mindepth 1 -maxdepth 1 \
    ! -path "$transaction_marker" ! -path "$transaction_identity" \
    ! -path "$rolled_back_marker" -print -quit)"
  if [ -n "$unexpected_control" ]; then exit 98; fi
  exit 0
fi
if [ "$rolling_back_present" -eq 0 ]; then
  rm -f -- "$control_dir/rolling-back.tmp"
  printf '%s\n' rolling-back > "$control_dir/rolling-back.tmp"
  chmod 0400 "$control_dir/rolling-back.tmp"
  sync -f "$control_dir/rolling-back.tmp"
  mv -- "$control_dir/rolling-back.tmp" "$rolling_back_marker"
  sync -f "$control_dir"
fi
if [ -e "$rollback_data" ] && [ ! -L "$rollback_data" ]; then
  chattr -R -i -a "$data_dir" 2>/dev/null || true
  rm -rf -- "$data_dir"
  mv -- "$rollback_data" "$data_dir"
  if [ "$(cat "$data_was_immutable" 2>/dev/null || true)" = true ]; then
    chattr +i "$data_dir"
  fi
elif [ "$(cat "$data_was_immutable" 2>/dev/null || true)" = true ] && \
     [ -f "$old_data_unlocked" ] && [ ! -L "$old_data_unlocked" ] && \
     [ -d "$data_dir" ] && [ ! -L "$data_dir" ]; then
  chattr +i "$data_dir"
fi
if [ -e "$env_rollback" ] || [ -L "$env_rollback" ]; then
  if ! { [ -f "$env_rollback" ] && [ ! -L "$env_rollback" ] && \
    [ "$(stat -c '%h' "$env_rollback" 2>/dev/null || true)" = 1 ] && \
    [ "$(stat -c '%u:%g:%a' "$env_rollback" 2>/dev/null || true)" = \
      "0:$service_group_id:640" ]; }; then exit 98; fi
  rm -f -- "$env_path"
  mv -- "$env_rollback" "$env_path"
fi
if [ -e "$overlay_rollback" ] || [ -L "$overlay_rollback" ]; then
  if ! { [ -f "$overlay_rollback" ] && [ ! -L "$overlay_rollback" ] && \
    [ "$(stat -c '%h' "$overlay_rollback" 2>/dev/null || true)" = 1 ] && \
    [ "$(stat -c '%u:%g:%a' "$overlay_rollback" 2>/dev/null || true)" = \
      "0:$service_group_id:640" ]; }; then exit 98; fi
  rm -f -- "$overlay_path"
  mv -- "$overlay_rollback" "$overlay_path"
elif [ "$(cat "$control_dir/overlay-existed" 2>/dev/null || true)" = false ]; then
  rm -f -- "$overlay_path"
fi
if [ -e "$seal_rollback" ] || [ -L "$seal_rollback" ]; then
  if ! { [ -f "$seal_rollback" ] && [ ! -L "$seal_rollback" ] && \
    [ "$(stat -c '%h' "$seal_rollback" 2>/dev/null || true)" = 1 ] && \
    [ "$(stat -c '%u:%g:%a' "$seal_rollback" 2>/dev/null || true)" = 0:0:444 ]; }; then
    exit 98
  fi
  rm -f -- "$seal_path"
  mv -- "$seal_rollback" "$seal_path"
elif [ "$(cat "$control_dir/seal-existed" 2>/dev/null || true)" = false ]; then
  rm -f -- "$seal_path"
fi
if [ -e "$source_env_copy" ] && [ ! -L "$source_env_copy" ]; then
  chattr -i "$source_env_copy" 2>/dev/null || true
fi
chattr -R -i -a "$incoming_data" "$extract_dir" 2>/dev/null || true
rm -rf -- "$incoming_data" "$runtime_dir"
rm -f -- "$env_incoming" "$overlay_incoming" "$seal_incoming"
sync -f "$data_parent"
sync -f /etc/comis
if [ "$rolled_back_present" -eq 0 ]; then
  rm -f -- "$control_dir/rolled-back.tmp"
  printf '%s\n' rolled-back > "$control_dir/rolled-back.tmp"
  chmod 0400 "$control_dir/rolled-back.tmp"
  sync -f "$control_dir/rolled-back.tmp"
  mv -- "$control_dir/rolled-back.tmp" "$rolled_back_marker"
  sync -f "$control_dir"
fi
find "$control_dir" -depth -mindepth 1 \
  ! -path "$transaction_marker" ! -path "$transaction_identity" \
  ! -path "$rolling_back_marker" ! -path "$rolled_back_marker" -delete
sync -f "$control_dir"
rm -f -- "$active_restore" "$current_restore_incoming" "$owner_marker"
sync -f "$coordination_root"
rm -f -- "$rolling_back_marker"
sync -f "$control_dir"
`;

const TARGET_COMMIT_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
data_dir="$2"
run_id="$3"
service="$4"
service_user="$5"
approved_attestation_sha256="$6"
exec 1>/dev/null
${TARGET_GUARD}
${TARGET_TRANSACTION_GUARD}
${TARGET_AUTHORIZATION_RECEIPT_FUNCTION}
if [ "${"$"}{#approved_attestation_sha256}" -ne 64 ]; then exit 96; fi
case "$approved_attestation_sha256" in *[!a-f0-9]*) exit 96 ;; esac
if [ ! -f "$attestation_path" ] || [ -L "$attestation_path" ] || \
   [ "$(stat -c '%u:%g:%a' "$attestation_path" 2>/dev/null || true)" != 0:0:400 ] || \
   [ -e "$promoting_marker" ] || [ -L "$promoting_marker" ] || \
   [ -e "$rolling_back_marker" ] || [ -L "$rolling_back_marker" ] || \
   [ "$(sha256sum "$attestation_path" | awk '{print $1}')" != \
     "$approved_attestation_sha256" ]; then exit 96; fi
if [ -f "$finalized_marker" ] && [ ! -L "$finalized_marker" ] && \
   [ "$(stat -c '%u:%g:%a' "$finalized_marker" 2>/dev/null || true)" = 0:0:400 ] && \
   [ "$(cat "$finalized_marker" 2>/dev/null || true)" = finalized ]; then exit 0; fi
if [ -f "$finalizing_marker" ] && [ ! -L "$finalizing_marker" ] && \
   [ "$(stat -c '%u:%g:%a' "$finalizing_marker" 2>/dev/null || true)" = 0:0:400 ] && \
   [ "$(cat "$finalizing_marker" 2>/dev/null || true)" = finalizing ]; then exit 0; fi
if [ ! -f "$transaction_marker" ] || [ -L "$transaction_marker" ] || \
   [ "$(stat -c '%u:%g:%a' "$transaction_marker" 2>/dev/null || true)" != 0:0:400 ] || \
   [ "$(cat "$transaction_marker" 2>/dev/null || true)" != "$run_id" ] || \
   [ ! -f "$control_dir/installed" ] || [ -L "$control_dir/installed" ] || \
   [ ! -d "$data_dir" ] || [ ! -e "$rollback_data" ] || \
   [ ! -f "$source_env_copy" ] || [ -L "$source_env_copy" ] || \
   [ ! -f "$reattest_script" ] || [ -L "$reattest_script" ] || \
   [ "$(stat -c '%u:%g:%a' "$reattest_script" 2>/dev/null || true)" != 0:0:500 ] || \
   [ ! -f "$attestation_path" ] || [ -L "$attestation_path" ] || \
   [ "$(stat -c '%u:%g:%a' "$attestation_path" 2>/dev/null || true)" != 0:0:400 ]; then exit 96; fi
commit_attestation="$control_dir/commit-attestation.json"
if [ -L "$commit_attestation" ]; then exit 96; fi
if [ -e "$commit_attestation" ]; then
  if [ ! -f "$commit_attestation" ] || \
     [ "$(stat -c '%u:%g:%a' "$commit_attestation" 2>/dev/null || true)" != 0:0:400 ]; then
    exit 96
  fi
  rm -f -- "$commit_attestation"
fi
${TARGET_REPLAY_CONFIGURATION_GUARD}
python3 "$reattest_script" "$data_dir" "$source_env_copy" "$env_path" \
  "$overlay_path" "$expected_overlay_sha" "$expected_manifest" "$run_id" \
  "$expected_machine" "$commit_attestation"
if ! cmp -s -- "$commit_attestation" "$attestation_path"; then exit 96; fi
rm -f -- "$commit_attestation"
authorization_candidate="$control_dir/commit-authorized.candidate"
rm -f -- "$authorization_candidate"
write_authorization_receipt "$authorization_candidate"
if [ -e "$commit_authorized" ] || [ -L "$commit_authorized" ]; then
  if [ ! -f "$commit_authorized" ] || [ -L "$commit_authorized" ] || \
     [ "$(stat -c '%u:%g:%a' "$commit_authorized" 2>/dev/null || true)" != 0:0:400 ] || \
     ! cmp -s -- "$authorization_candidate" "$commit_authorized"; then exit 97; fi
  rm -f -- "$authorization_candidate"
  exit 0
fi
mv -- "$authorization_candidate" "$commit_authorized"
sync -f "$control_dir"
`;

const TARGET_FINALIZE_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
data_dir="$2"
run_id="$3"
service="$4"
service_user="$5"
exec 1>/dev/null
${TARGET_GUARD}
${TARGET_TRANSACTION_GUARD}
${TARGET_AUTHORIZATION_RECEIPT_FUNCTION}
if [ ! -f "$transaction_marker" ] || [ -L "$transaction_marker" ] || \
   [ "$(stat -c '%u:%g:%a' "$transaction_marker" 2>/dev/null || true)" != 0:0:400 ] || \
   [ "$(cat "$transaction_marker" 2>/dev/null || true)" != "$run_id" ] || \
   [ -e "$promoting_marker" ] || [ -L "$promoting_marker" ] || \
   [ -e "$rolling_back_marker" ] || [ -L "$rolling_back_marker" ] || \
   [ ! -f "$commit_authorized" ] || [ -L "$commit_authorized" ] || \
   [ "$(stat -c '%u:%g:%a' "$commit_authorized" 2>/dev/null || true)" != 0:0:400 ] || \
   [ "$(stat -c '%s' "$commit_authorized" 2>/dev/null || true)" -gt 512 ] || \
   [ ! -f "$attestation_path" ] || [ -L "$attestation_path" ] || \
   [ "$(stat -c '%u:%g:%a' "$attestation_path" 2>/dev/null || true)" != 0:0:400 ]; then exit 98; fi
already_finalized=0
if [ -e "$finalized_marker" ] || [ -L "$finalized_marker" ]; then
  if [ ! -f "$finalized_marker" ] || [ -L "$finalized_marker" ] || \
     [ "$(stat -c '%u:%g:%a' "$finalized_marker" 2>/dev/null || true)" != 0:0:400 ] || \
     [ "$(cat "$finalized_marker" 2>/dev/null || true)" != finalized ]; then exit 98; fi
  already_finalized=1
fi
if [ "$already_finalized" -eq 1 ]; then
  :
elif [ -e "$finalizing_marker" ] || [ -L "$finalizing_marker" ]; then
  if [ ! -f "$finalizing_marker" ] || [ -L "$finalizing_marker" ] || \
     [ "$(stat -c '%u:%g:%a' "$finalizing_marker" 2>/dev/null || true)" != 0:0:400 ] || \
     [ "$(cat "$finalizing_marker" 2>/dev/null || true)" != finalizing ]; then exit 98; fi
else
  if [ ! -f "$source_env_copy" ] || [ -L "$source_env_copy" ] || \
     [ ! -f "$reattest_script" ] || [ -L "$reattest_script" ] || \
     [ ! -f "$expected_manifest" ] || [ -L "$expected_manifest" ]; then exit 98; fi
  commit_attestation="$control_dir/commit-attestation.json"
  if [ -e "$commit_attestation" ] || [ -L "$commit_attestation" ]; then exit 98; fi
  authorization_candidate="$control_dir/commit-authorized.candidate"
  rm -f -- "$authorization_candidate"
  write_authorization_receipt "$authorization_candidate"
  if ! cmp -s -- "$authorization_candidate" "$commit_authorized"; then exit 98; fi
  rm -f -- "$authorization_candidate"
  ${TARGET_REPLAY_CONFIGURATION_GUARD}
  python3 "$reattest_script" "$data_dir" "$source_env_copy" "$env_path" \
    "$overlay_path" "$expected_overlay_sha" "$expected_manifest" "$run_id" \
    "$expected_machine" "$commit_attestation"
  if ! cmp -s -- "$commit_attestation" "$attestation_path"; then exit 98; fi
  rm -f -- "$commit_attestation"
  printf '%s\n' finalizing > "$control_dir/finalizing.tmp"
  chmod 0400 "$control_dir/finalizing.tmp"
  sync -f "$control_dir/finalizing.tmp"
  mv -- "$control_dir/finalizing.tmp" "$finalizing_marker"
  sync -f "$control_dir"
fi
if [ -L "$rollback_data" ] || [ -L "$source_env_copy" ]; then exit 98; fi
if [ -e "$source_env_copy" ]; then chattr -i "$source_env_copy"; fi
if [ -e "$rollback_data" ]; then
  chattr -R -i -a "$rollback_data" 2>/dev/null || true
fi
rm -rf -- "$rollback_data" "$extract_dir" "$runtime_dir"
rm -f -- "$source_env_copy"
rm -f -- "$expected_manifest"
rm -f -- "$reattest_script"
rm -f -- "$env_rollback" "$overlay_rollback" "$seal_rollback" "$archive" \
  "$control_dir/replay-overlay.yaml" \
  "$expected_overlay_sha" "$data_was_immutable" "$old_data_unlocked" \
  "$control_dir/overlay-existed" "$control_dir/seal-existed" \
  "$control_dir/installed" "$control_dir/commit-attestation.json" \
  "$control_dir/commit-authorized.candidate"
rm -f -- "$env_incoming" "$overlay_incoming" "$seal_incoming"
sync -f "$state_root"
sync -f /etc/comis
for retained in "$rollback_data" "$env_rollback" "$overlay_rollback" \
  "$seal_rollback" "$source_env_copy" "$expected_manifest" "$reattest_script"; do
  if [ -e "$retained" ] || [ -L "$retained" ]; then exit 98; fi
done
install -o root -g root -m 0444 "$attestation_path" "$seal_incoming"
mv -- "$seal_incoming" "$seal_path"
sync -f "$seal_path"
sync -f /etc/comis
if [ "$already_finalized" -eq 0 ]; then
  printf '%s\n' finalized > "$control_dir/finalized.tmp"
  chmod 0400 "$control_dir/finalized.tmp"
  sync -f "$control_dir/finalized.tmp"
  mv -- "$control_dir/finalized.tmp" "$finalized_marker"
fi
sync -f "$control_dir"
rm -f -- "$finalizing_marker"
sync -f "$control_dir"
current_matches_owner=0
if [ -e "$current_restore" ] || [ -L "$current_restore" ]; then
  if [ ! -f "$current_restore" ] || [ -L "$current_restore" ] || \
     [ "$(stat -c '%u:%g:%a' "$current_restore" 2>/dev/null || true)" != 0:0:400 ]; then
    exit 98
  fi
  if [ "$(stat -c '%d:%i' "$current_restore")" = "$(stat -c '%d:%i' "$owner_marker")" ]; then
    current_matches_owner=1
  fi
fi
rm -f -- "$current_restore_incoming"
if [ "$current_matches_owner" -eq 0 ]; then
  ln -- "$owner_marker" "$current_restore_incoming"
  mv -- "$current_restore_incoming" "$current_restore"
fi
sync -f "$coordination_root"
rm -f -- "$active_restore"
sync -f "$coordination_root"
`;

function buildSourceCleanupInvocation(request: ProductionRestoreRequest): ProductionRemoteInvocation {
  return invocation(
    "cleanup-snapshot-source",
    request.profile.source,
    request.snapshot.cleanup.args,
    request.snapshot.cleanup.stdin,
  );
}

function buildCanonicalSnapshotPlan(
  request: ProductionRestoreRequest,
): Result<ProductionSnapshotPlan, ProductionRestoreError> {
  const canonical = buildProductionSnapshotPlan({
    runId: request.runId,
    expectedMachineIdSha256: request.profile.source.expectedMachineIdSha256,
    service: request.profile.source.service,
    dataDir: request.profile.source.dataDir,
    captureMode: request.snapshot.captureMode,
  });
  if (!canonical.ok) {
    return invalidRequest("snapshot", "Snapshot transport plan cannot be reconstructed safely");
  }
  return ok(canonical.value);
}

function validateRestoreRequest(
  request: ProductionRestoreRequest,
): Result<
  {
    manifest: ProductionSnapshotManifest;
    overlayYaml: string;
    canonicalSnapshot: ProductionSnapshotPlan;
  },
  ProductionRestoreError
> {
  if (!SAFE_RUN_ID_RE.test(request.runId)) {
    return invalidRequest("runId", "Restore run ID contains unsafe characters");
  }
  if (request.profile.source.role !== "production" || request.profile.target.role !== "test") {
    return invalidRequest("profile", "Restore profile roles are invalid");
  }
  if (
    !isSafeSshTarget(request.profile.source.ssh) ||
    !isSafeSshTarget(request.profile.target.ssh) ||
    !SAFE_REMOTE_NAME_RE.test(request.profile.source.comisUser) ||
    !SAFE_REMOTE_NAME_RE.test(request.profile.target.comisUser) ||
    !SAFE_REMOTE_NAME_RE.test(request.profile.source.service) ||
    !SAFE_REMOTE_NAME_RE.test(request.profile.target.service) ||
    !SHA256_RE.test(request.profile.source.expectedMachineIdSha256) ||
    !SHA256_RE.test(request.profile.target.expectedMachineIdSha256)
  ) {
    return invalidRequest("profile", "Restore profile contains unsafe remote fields");
  }
  if (
    sshHostIdentity(request.profile.source.ssh) === sshHostIdentity(request.profile.target.ssh) ||
    request.profile.source.expectedMachineIdSha256 ===
      request.profile.target.expectedMachineIdSha256
  ) {
    return invalidRequest("profile", "Restore source and target identities must be distinct");
  }
  for (const port of [request.profile.source.sshPort, request.profile.target.sshPort]) {
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
      return invalidRequest("profile", "Restore profile contains an invalid SSH port");
    }
  }
  if (
    !isSafeRemotePath(request.profile.source.dataDir) ||
    !isSafeRemotePath(request.profile.target.dataDir)
  ) {
    return invalidRequest(
      "profile",
      "Restore data paths cannot be represented safely by remote commands",
    );
  }
  if (
    FIXED_RESTORE_CONTROL_ROOTS.some((controlRoot) =>
      pathsOverlap(request.profile.target.dataDir, controlRoot),
    )
  ) {
    return invalidRequest("profile", "Restore target data path overlaps a control root");
  }
  const parsed = parseProductionSnapshotManifest(request.manifestJson);
  if (!parsed.ok) {
    return invalidRequest("manifestJson", "Snapshot manifest failed strict validation");
  }
  const manifest = parsed.value;
  if (
    manifest.runId !== request.runId ||
    manifest.sourceMachineIdSha256 !== request.profile.source.expectedMachineIdSha256 ||
    manifest.service !== request.profile.source.service ||
    manifest.captureMode !== request.snapshot.captureMode
  ) {
    return invalidRequest("manifestJson", "Snapshot manifest does not match the restore request");
  }
  const expectedStageDir = `/run/comis-self-driving/${request.runId}`;
  const canonicalSnapshot = buildCanonicalSnapshotPlan(request);
  if (!canonicalSnapshot.ok) return canonicalSnapshot;
  if (
    request.snapshot.stageDir !== expectedStageDir ||
    request.snapshot.manifestPath !== `${expectedStageDir}/manifest.json` ||
    request.snapshot.stream.stdout !== "archive" ||
    request.snapshot.cleanup.stdout !== "none" ||
    request.snapshot.stream.stdin !== canonicalSnapshot.value.stream.stdin ||
    request.snapshot.cleanup.stdin !== canonicalSnapshot.value.cleanup.stdin ||
    JSON.stringify(request.snapshot.stream.args) !==
      JSON.stringify(canonicalSnapshot.value.stream.args) ||
    JSON.stringify(request.snapshot.cleanup.args) !==
      JSON.stringify(canonicalSnapshot.value.cleanup.args)
  ) {
    return invalidRequest("snapshot", "Snapshot transport plan is inconsistent");
  }
  const overlay = buildReplayQuarantineOverlay(request.agentIds);
  if (!overlay.ok) {
    return invalidRequest("agentIds", "Replay quarantine agent identifiers are invalid");
  }
  return ok({ manifest, overlayYaml: overlay.value, canonicalSnapshot: canonicalSnapshot.value });
}

export function buildProductionRestorePlan(
  request: ProductionRestoreRequest,
): Result<ProductionRestorePlan, ProductionRestoreError> {
  const validated = validateRestoreRequest(request);
  if (!validated.ok) return validated;
  const manifestBytes = Buffer.byteLength(request.manifestJson, "utf8");
  const maximumBytes = calculateMaximumArchiveBytes(validated.value.manifest, manifestBytes);
  if (!maximumBytes.ok) return maximumBytes;
  const minimumTargetFreeBytes = calculateMinimumTargetFreeBytes(
    validated.value.manifest,
    maximumBytes.value,
    manifestBytes,
  );
  if (!minimumTargetFreeBytes.ok) return minimumTargetFreeBytes;
  const minimumTargetFreeInodes = calculateMinimumTargetFreeInodes(validated.value.manifest);
  if (!minimumTargetFreeInodes.ok) return minimumTargetFreeInodes;
  const minimumEtcFreeBytes = calculateMinimumEtcFreeBytes(validated.value.manifest);
  if (!minimumEtcFreeBytes.ok) return minimumEtcFreeBytes;
  const minimumEtcFreeInodes = ETC_RESTORE_INODE_OVERHEAD;
  const manifestSha256 = createHash("sha256").update(request.manifestJson).digest("hex");
  const restoreAttestationExpectation = buildRestoreAttestationExpectation(
    request.runId,
    request.profile.target.expectedMachineIdSha256,
    request.profile.target.dataDir,
    validated.value.manifest,
    manifestSha256,
    validated.value.overlayYaml,
  );
  const targetBaseArgs = [
    request.profile.target.expectedMachineIdSha256,
    request.profile.target.dataDir,
    request.runId,
    request.profile.target.service,
    request.profile.target.comisUser,
  ] as const;
  const sourceStreamPath = `${request.snapshot.stageDir}/stream-restore.sh`;
  const receiverPath = `/run/comis-self-driving/restore-${request.runId}/receive.sh`;
  const safeRequest = { ...request, snapshot: validated.value.canonicalSnapshot };
  const sourceCleanup = buildSourceCleanupInvocation(safeRequest);

  return ok({
    manifest: validated.value.manifest,
    manifestSha256,
    restoreAttestationExpectation,
    minimumTargetFreeBytes: minimumTargetFreeBytes.value,
    minimumTargetFreeInodes: minimumTargetFreeInodes.value,
    minimumEtcFreeBytes: minimumEtcFreeBytes.value,
    minimumEtcFreeInodes,
    sourceStreamPrepare: invocation(
      "prepare-snapshot-stream-source",
      request.profile.source,
      [
        "sudo",
        "bash",
        "-s",
        "--",
        request.profile.source.expectedMachineIdSha256,
        request.runId,
      ],
      buildSourceStreamPrepareScript(validated.value.canonicalSnapshot.stream.stdin),
    ),
    targetPrepare: invocation(
      "prepare-snapshot-restore-target",
      request.profile.target,
      [
        "sudo",
        "bash",
        "-s",
        "--",
        ...targetBaseArgs,
        String(maximumBytes.value),
        String(minimumTargetFreeBytes.value),
        String(minimumTargetFreeInodes.value),
        String(minimumEtcFreeBytes.value),
        String(minimumEtcFreeInodes),
      ],
      buildTargetPrepareScript(request.manifestJson, validated.value.overlayYaml),
    ),
    stream: {
      maximumBytes: maximumBytes.value,
      source: endpoint(request.profile.source, [
        "sudo",
        "bash",
        sourceStreamPath,
        request.profile.source.expectedMachineIdSha256,
        request.runId,
      ]),
      target: endpoint(request.profile.target, [
        "sudo",
        "bash",
        receiverPath,
        ...targetBaseArgs,
        String(maximumBytes.value),
      ]),
    },
    targetVerifyAndPromote: invocation(
      "verify-and-promote-snapshot-target",
      request.profile.target,
      ["sudo", "bash", "-s", "--", ...targetBaseArgs, manifestSha256],
      TARGET_VERIFY_AND_PROMOTE_SCRIPT,
    ),
    targetReadAttestation: {
      ...invocation(
        "read-promoted-snapshot-attestation",
        request.profile.target,
        ["sudo", "bash", "-s", "--", ...targetBaseArgs],
        TARGET_READ_ATTESTATION_SCRIPT,
      ),
      stdoutLimitBytes: 4096,
    },
    targetStatus: {
      ...invocation(
        "inspect-snapshot-target",
        request.profile.target,
        ["sudo", "bash", "-s", "--", ...targetBaseArgs],
        TARGET_STATUS_SCRIPT,
      ),
      stdoutLimitBytes: 8192,
    },
    targetRollback: invocation(
      "rollback-snapshot-target",
      request.profile.target,
      ["sudo", "bash", "-s", "--", ...targetBaseArgs],
      TARGET_ROLLBACK_SCRIPT,
    ),
    targetCommit: invocation(
      "commit-snapshot-target",
      request.profile.target,
      ["sudo", "bash", "-s", "--", ...targetBaseArgs],
      TARGET_COMMIT_SCRIPT,
    ),
    targetFinalize: invocation(
      "finalize-snapshot-target",
      request.profile.target,
      ["sudo", "bash", "-s", "--", ...targetBaseArgs],
      TARGET_FINALIZE_SCRIPT,
    ),
    sourceCleanup,
  });
}

function buildProductionRestoreRecoveryInvocations(
  request: ProductionRestoreRecoveryRequest,
): Result<
  {
    readonly status: ProductionRemoteInvocation;
    readonly finalize: ProductionRemoteInvocation;
    readonly rollback: ProductionRemoteInvocation;
  },
  ProductionRestoreError
> {
  const { profile, runId } = request;
  if (
    !SAFE_RUN_ID_RE.test(runId) ||
    profile.source.role !== "production" ||
    profile.target.role !== "test" ||
    !isSafeSshTarget(profile.target.ssh) ||
    !SAFE_REMOTE_NAME_RE.test(profile.target.comisUser) ||
    !SAFE_REMOTE_NAME_RE.test(profile.target.service) ||
    !SHA256_RE.test(profile.target.expectedMachineIdSha256) ||
    !isSafeRemotePath(profile.target.dataDir) ||
    sshHostIdentity(profile.source.ssh) === sshHostIdentity(profile.target.ssh) ||
    profile.source.expectedMachineIdSha256 === profile.target.expectedMachineIdSha256 ||
    (profile.target.sshPort !== undefined &&
      (!Number.isInteger(profile.target.sshPort) ||
        profile.target.sshPort < 1 ||
        profile.target.sshPort > 65_535))
  ) {
    return invalidRequest("recovery", "Restore recovery request is unsafe");
  }
  const args = [
    profile.target.expectedMachineIdSha256,
    profile.target.dataDir,
    runId,
    profile.target.service,
    profile.target.comisUser,
  ] as const;
  return ok({
    status: {
      ...invocation(
        "inspect-snapshot-target",
        profile.target,
        ["sudo", "bash", "-s", "--", ...args],
        TARGET_STATUS_SCRIPT,
      ),
      stdoutLimitBytes: 8192,
    },
    finalize: invocation(
      "finalize-snapshot-target",
      profile.target,
      ["sudo", "bash", "-s", "--", ...args],
      TARGET_FINALIZE_SCRIPT,
    ),
    rollback: invocation(
      "rollback-snapshot-target",
      profile.target,
      ["sudo", "bash", "-s", "--", ...args],
      TARGET_ROLLBACK_SCRIPT,
    ),
  });
}

async function runSilent(
  executor: ProductionRemoteExecutor,
  command: ProductionRemoteInvocation,
): Promise<Result<ProductionRemoteResult, ProductionRestoreError>> {
  const attempted = await fromPromise(Promise.resolve().then(() => executor.run(command)));
  if (!attempted.ok) {
    return err({
      kind: "remote_failure",
      stage: command.label,
      message: `Remote restore stage ${command.label} failed`,
    });
  }
  const result = attempted.value;
  if (!result.ok || result.value.exitCode !== 0 || result.value.stdout !== "") {
    return err({
      kind: "remote_failure",
      stage: command.label,
      message: `Remote restore stage ${command.label} failed`,
    });
  }
  return ok(result.value);
}

function restoreAttestationMatchesExpectation(
  observed: ProductionReplayRestoreAttestation,
  expected: ProductionReplayRestoreAttestationExpectation,
): boolean {
  return (
    observed.schemaVersion === expected.schemaVersion &&
    observed.state === expected.state &&
    observed.runId === expected.runId &&
    observed.targetMachineIdSha256 === expected.targetMachineIdSha256 &&
    observed.baselineImmutable === expected.baselineImmutable &&
    observed.dataDirSha256 === expected.dataDirSha256 &&
    observed.snapshotManifestSha256 === expected.snapshotManifestSha256 &&
    observed.restoredDataTreeDigestSha256 === expected.restoredDataTreeDigestSha256 &&
    observed.sourceEnvironmentEvidenceIdentitySha256 ===
      expected.sourceEnvironmentEvidenceIdentitySha256 &&
    observed.replayOverlayContentSha256 === expected.replayOverlayContentSha256 &&
    observed.dataEntryCount === expected.dataEntryCount &&
    observed.dataBytes === expected.dataBytes
  );
}

async function readTargetRestoreAttestation(
  executor: ProductionRemoteExecutor,
  command: ProductionRemoteInvocation,
  expected: ProductionReplayRestoreAttestationExpectation,
): Promise<
  Result<
    {
      readonly value: ProductionReplayRestoreAttestation;
      readonly sha256: string;
    },
    ProductionRestoreError
  >
> {
  const attempted = await fromPromise(Promise.resolve().then(() => executor.run(command)));
  if (!attempted.ok || !attempted.value.ok || attempted.value.value.exitCode !== 0) {
    return err({
      kind: "attestation_failure",
      stage: "read-promoted-snapshot-attestation",
      message: "Promoted snapshot attestation could not be read from the target",
    });
  }
  const raw = attempted.value.value.stdout;
  const parsed = parseProductionReplayRestoreAttestation(raw);
  if (!parsed.ok || !restoreAttestationMatchesExpectation(parsed.value, expected)) {
    return err({
      kind: "attestation_failure",
      stage: "read-promoted-snapshot-attestation",
      message: "Promoted snapshot attestation does not match the captured state",
    });
  }
  return ok({
    value: parsed.value,
    sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
  });
}

async function inspectTargetRestoreStatus(
  executor: ProductionRemoteExecutor,
  command: ProductionRemoteInvocation,
): Promise<Result<ProductionRestoreStatus, ProductionRestoreError>> {
  const attempted = await fromPromise(Promise.resolve().then(() => executor.run(command)));
  if (!attempted.ok || !attempted.value.ok || attempted.value.value.exitCode !== 0) {
    return err({
      kind: "remote_failure",
      stage: "inspect-snapshot-target",
      message: "Durable restore status could not be inspected",
    });
  }
  return parseProductionRestoreStatus(attempted.value.value.stdout);
}

export async function inspectProductionRestore(
  request: ProductionRestoreRecoveryRequest,
  executor: ProductionRemoteExecutor,
): Promise<Result<ProductionRestoreStatus, ProductionRestoreError>> {
  const invocations = buildProductionRestoreRecoveryInvocations(request);
  if (!invocations.ok) return invocations;
  const inspected = await inspectTargetRestoreStatus(executor, invocations.value.status);
  if (
    !inspected.ok ||
    inspected.value.runId !== request.runId ||
    inspected.value.targetMachineIdSha256 !== request.profile.target.expectedMachineIdSha256
  ) {
    if (!inspected.ok) return inspected;
    return err({
      kind: "invalid_restore_status",
      stage: "inspect-snapshot-target",
      message: "Durable restore status does not match the recovery request",
    });
  }
  return inspected;
}

function committedRestoreFromStatus(
  status: ProductionRestoreStatus,
): Result<CommittedProductionRestore, ProductionRestoreError> {
  if (status.state !== "finalized" || status.restoreAttestation === null) {
    return err({
      kind: "attestation_required",
      message: "Restore recovery requires a durable authorized or finalized transaction",
    });
  }
  return ok({
    runId: status.runId,
    state: "committed",
    restoredDataTreeIdentitySha256:
      status.restoreAttestation.restoredDataTreeDigestSha256,
    sourceEnvironmentEvidenceIdentitySha256:
      status.restoreAttestation.sourceEnvironmentEvidenceIdentitySha256,
  });
}

export async function resumeProductionRestore(
  request: ProductionRestoreRecoveryRequest,
  executor: ProductionRemoteExecutor,
): Promise<Result<CommittedProductionRestore, ProductionRestoreError>> {
  const invocations = buildProductionRestoreRecoveryInvocations(request);
  if (!invocations.ok) return invocations;
  const inspected = await inspectProductionRestore(request, executor);
  if (!inspected.ok) return inspected;
  if (inspected.value.state === "finalized") {
    return committedRestoreFromStatus(inspected.value);
  }
  if (inspected.value.state !== "authorized" && inspected.value.state !== "finalizing") {
    return err({
      kind: "attestation_required",
      message: "Restore recovery cannot finalize a transaction without durable authorization",
    });
  }
  const finalized = await runSilent(executor, invocations.value.finalize);
  if (!finalized.ok) {
    return err({
      kind: "finalization_failure",
      stage: "finalize-snapshot-target",
      message: "Committed snapshot target finalization must be retried",
    });
  }
  const observed = await inspectProductionRestore(request, executor);
  if (!observed.ok) return observed;
  return committedRestoreFromStatus(observed.value);
}

export async function rollbackProductionRestoreRecovery(
  request: ProductionRestoreRecoveryRequest,
  executor: ProductionRemoteExecutor,
): Promise<Result<ProductionRestoreStatus, ProductionRestoreError>> {
  const invocations = buildProductionRestoreRecoveryInvocations(request);
  if (!invocations.ok) return invocations;
  const inspected = await inspectProductionRestore(request, executor);
  if (!inspected.ok) return inspected;
  if (inspected.value.state === "absent" || inspected.value.state === "rolled_back") {
    return inspected;
  }
  if (
    inspected.value.state === "authorized" ||
    inspected.value.state === "finalizing" ||
    inspected.value.state === "finalized"
  ) {
    return err({
      kind: "attestation_required",
      message: "Durably authorized restore recovery cannot be rolled back",
    });
  }
  const rolledBack = await runSilent(executor, invocations.value.rollback);
  if (!rolledBack.ok) {
    return err({
      kind: "rollback_failure",
      stage: "rollback-snapshot-target",
      message: "Interrupted restore rollback must be retried",
    });
  }
  const observed = await inspectProductionRestore(request, executor);
  if (!observed.ok) return observed;
  if (observed.value.state !== "absent" && observed.value.state !== "rolled_back") {
    return err({
      kind: "rollback_failure",
      stage: "rollback-snapshot-target",
      message: "Interrupted restore rollback did not reach a durable terminal state",
    });
  }
  return observed;
}

async function rollbackAfterFault(
  executor: ProductionRemoteExecutor,
  command: ProductionRemoteInvocation,
): Promise<Result<void, ProductionRestoreError>> {
  const rollback = await runSilent(executor, command);
  if (!rollback.ok) {
    return err({
      kind: "rollback_failure",
      stage: "rollback-snapshot-target",
      message: "Snapshot target rollback failed",
    });
  }
  return ok(undefined);
}

export async function prepareProductionRestore(
  request: ProductionRestoreRequest,
  deps: ProductionRestoreDeps,
): Promise<Result<PendingProductionRestore, ProductionRestoreError>> {
  const planned = buildProductionRestorePlan(request);
  if (!planned.ok) {
    const canonicalSnapshot = buildCanonicalSnapshotPlan(request);
    if (!canonicalSnapshot.ok) return planned;
    const cleanup = await runSilent(
      deps.executor,
      buildSourceCleanupInvocation({ ...request, snapshot: canonicalSnapshot.value }),
    );
    if (!cleanup.ok) {
      return err({
        kind: "source_cleanup_failure",
        stage: "cleanup-snapshot-source",
        message: "Snapshot source staging cleanup failed",
      });
    }
    return planned;
  }
  const plan = planned.value;
  let primaryError: ProductionRestoreError | undefined;
  let bytesTransferred = 0;
  let observedAttestation:
    | {
        readonly value: ProductionReplayRestoreAttestation;
        readonly sha256: string;
      }
    | undefined;

  const targetPrepare = await runSilent(deps.executor, plan.targetPrepare);
  if (!targetPrepare.ok) {
    primaryError = targetPrepare.error;
  } else {
    const sourcePrepare = await runSilent(deps.executor, plan.sourceStreamPrepare);
    if (!sourcePrepare.ok) {
      primaryError = sourcePrepare.error;
    } else {
      const transferAttempt = await fromPromise(
        Promise.resolve().then(() =>
          deps.bridge.transfer({
            label: "snapshot-archive",
            maximumBytes: plan.stream.maximumBytes,
            source: plan.stream.source,
            target: plan.stream.target,
          }),
        ),
      );
      if (!transferAttempt.ok || !transferAttempt.value.ok) {
        primaryError = {
          kind: "transfer_failure",
          stage: "snapshot-archive",
          message: "Encrypted snapshot transfer failed",
        };
      } else {
        bytesTransferred = transferAttempt.value.value.bytesTransferred;
        const promoted = await runSilent(deps.executor, plan.targetVerifyAndPromote);
        if (!promoted.ok) {
          primaryError = promoted.error;
        } else {
          const readAttestation = await readTargetRestoreAttestation(
            deps.executor,
            plan.targetReadAttestation,
            plan.restoreAttestationExpectation,
          );
          if (!readAttestation.ok) {
            primaryError = readAttestation.error;
          } else {
            observedAttestation = readAttestation.value;
          }
        }
      }
    }
  }

  const sourceCleanup = await runSilent(deps.executor, plan.sourceCleanup);
  if (!sourceCleanup.ok && primaryError === undefined) {
    primaryError = {
      kind: "source_cleanup_failure",
      stage: "cleanup-snapshot-source",
      message: "Snapshot source staging cleanup failed",
    };
  }
  if (primaryError !== undefined) {
    const rolledBack = await rollbackAfterFault(deps.executor, plan.targetRollback);
    if (!rolledBack.ok) return rolledBack;
    return err(primaryError);
  }
  if (observedAttestation === undefined) {
    const rolledBack = await rollbackAfterFault(deps.executor, plan.targetRollback);
    if (!rolledBack.ok) return rolledBack;
    return err({
      kind: "attestation_failure",
      stage: "read-promoted-snapshot-attestation",
      message: "Promoted snapshot attestation was not observed",
    });
  }

  return ok({
    state: "awaiting-attestation",
    runId: request.runId,
    targetMachineIdSha256: request.profile.target.expectedMachineIdSha256,
    manifestSha256: plan.manifestSha256,
    bytesTransferred,
    restoredDataTreeIdentitySha256:
      plan.restoreAttestationExpectation.restoredDataTreeDigestSha256,
    sourceEnvironmentEvidenceIdentitySha256:
      plan.restoreAttestationExpectation.sourceEnvironmentEvidenceIdentitySha256,
    restoreAttestation: observedAttestation.value,
    restoreAttestationSha256: observedAttestation.sha256,
    targetCommit: {
      ...plan.targetCommit,
      args: [...plan.targetCommit.args, observedAttestation.sha256],
    },
    targetFinalize: plan.targetFinalize,
    targetStatus: plan.targetStatus,
    targetRollback: plan.targetRollback,
  });
}

function attestationMatches(
  pending: PendingProductionRestore,
  attestation: ProductionRestoreCommitAttestation,
): boolean {
  return (
    attestation.decision === "commit" &&
    attestation.runId === pending.runId &&
    attestation.targetMachineIdSha256 === pending.targetMachineIdSha256 &&
    attestation.manifestSha256 === pending.manifestSha256 &&
    attestation.bytesTransferred === pending.bytesTransferred &&
    attestation.restoreAttestationSha256 === pending.restoreAttestationSha256
  );
}

function restoreAttestationsMatch(
  pending: ProductionReplayRestoreAttestation,
  observed: ProductionReplayRestoreAttestation,
): boolean {
  return (
    pending.schemaVersion === observed.schemaVersion &&
    pending.state === observed.state &&
    pending.runId === observed.runId &&
    pending.targetMachineIdSha256 === observed.targetMachineIdSha256 &&
    pending.baselineImmutable === observed.baselineImmutable &&
    pending.dataDirSha256 === observed.dataDirSha256 &&
    pending.snapshotManifestSha256 === observed.snapshotManifestSha256 &&
    pending.restoredDataTreeDigestSha256 === observed.restoredDataTreeDigestSha256 &&
    pending.sourceEnvironmentEvidenceIdentitySha256 ===
      observed.sourceEnvironmentEvidenceIdentitySha256 &&
    pending.effectiveEnvironmentContentSha256 ===
      observed.effectiveEnvironmentContentSha256 &&
    pending.replayOverlayContentSha256 === observed.replayOverlayContentSha256 &&
    pending.dataEntryCount === observed.dataEntryCount &&
    pending.dataBytes === observed.dataBytes
  );
}

function restoreStatusMatchesPending(
  pending: PendingProductionRestore,
  status: ProductionRestoreStatus,
): boolean {
  return (
    status.runId === pending.runId &&
    status.targetMachineIdSha256 === pending.targetMachineIdSha256 &&
    status.bytesTransferred === pending.bytesTransferred &&
    status.restoreAttestationSha256 === pending.restoreAttestationSha256 &&
    status.restoreAttestation !== null &&
    status.restoreAttestation.snapshotManifestSha256 === pending.manifestSha256 &&
    restoreAttestationsMatch(pending.restoreAttestation, status.restoreAttestation)
  );
}

export async function commitProductionRestore(
  pending: PendingProductionRestore,
  attestation: ProductionRestoreCommitAttestation,
  executor: ProductionRemoteExecutor,
): Promise<Result<CommittedProductionRestore, ProductionRestoreError>> {
  if (!attestationMatches(pending, attestation)) {
    return err({
      kind: "attestation_required",
      message: "Exact restore transaction attestation is required before commit",
    });
  }
  const committed = await runSilent(executor, pending.targetCommit);
  let observedStatus: ProductionRestoreStatus | undefined;
  if (!committed.ok) {
    const inspected = await inspectTargetRestoreStatus(executor, pending.targetStatus);
    if (!inspected.ok) {
      return err({
        kind: "commit_state_unknown",
        stage: "commit-snapshot-target",
        message: "Restore commit outcome is ambiguous and must be inspected or resumed",
      });
    }
    observedStatus = inspected.value;
    if (!restoreStatusMatchesPending(pending, observedStatus)) {
      return err({
        kind: "commit_state_unknown",
        stage: "commit-snapshot-target",
        message: "Restore commit outcome is ambiguous and must be inspected or resumed",
      });
    }
    if (observedStatus.state === "promoted") {
      const retried = await runSilent(executor, pending.targetCommit);
      if (!retried.ok) {
        return err({
          kind: "commit_state_unknown",
          stage: "commit-snapshot-target",
          message: "Restore commit outcome is ambiguous and must be inspected or resumed",
        });
      }
    } else if (
      observedStatus.state !== "authorized" &&
      observedStatus.state !== "finalizing" &&
      observedStatus.state !== "finalized"
    ) {
      return err({
        kind: "commit_state_unknown",
        stage: "commit-snapshot-target",
        message: "Restore commit outcome is ambiguous and must be inspected or resumed",
      });
    }
  }
  if (observedStatus?.state !== "finalized") {
    const finalized = await runSilent(executor, pending.targetFinalize);
    if (!finalized.ok) {
      return err({
        kind: "finalization_failure",
        stage: "finalize-snapshot-target",
        message: "Committed snapshot target finalization must be retried",
      });
    }
  }
  return ok({
    runId: pending.runId,
    state: "committed",
    restoredDataTreeIdentitySha256: pending.restoredDataTreeIdentitySha256,
    sourceEnvironmentEvidenceIdentitySha256:
      pending.sourceEnvironmentEvidenceIdentitySha256,
  });
}

export async function rollbackProductionRestore(
  pending: PendingProductionRestore,
  executor: ProductionRemoteExecutor,
): Promise<Result<void, ProductionRestoreError>> {
  return rollbackAfterFault(executor, pending.targetRollback);
}
