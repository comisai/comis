// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute } from "node:path";

import { err, ok, type Result } from "@comis/shared";

import type {
  BinarySshEndpoint,
  ProductionBinarySshBridge,
} from "./production-binary-ssh.js";
import type {
  ProductionRemoteLeaseClient,
  ProductionRemoteLeaseError,
  ProductionRemoteLeaseRequest,
} from "./production-remote-lease.js";
import { buildProductionRuntimeVaultJournalShellLibrary } from "./production-runtime-vault-journal-shell.js";
import { buildProductionRuntimeVaultTransactionObservationProgram } from "./production-runtime-vault-transaction-shell.js";
import {
  classifyProductionRuntimeVaultTransaction,
  computeProductionRuntimeVaultTransactionIdentity,
  parseProductionRuntimeVaultTransactionObservation,
  type ProductionRuntimeVaultTransactionDisposition,
} from "./production-runtime-vault-transaction.js";
import {
  TARGET_REPLAY_QUARANTINE_SHA256,
  type ProductionRemoteExecutor,
  type ProductionRemoteInvocation,
} from "./production-bootstrap.js";
import type { ProductionReplayProfile } from "./production-profile.js";
import {
  inspectRuntimeArtifactAttestations,
  type RuntimeArtifactAttestation,
} from "./production-runtime.js";
import {
  RUNTIME_TREE_FACTS_BEGIN,
  RUNTIME_TREE_FACTS_END,
  buildRuntimeTreeProbeScript,
  compareRuntimeTreeAttestations,
  parseRuntimeTreeFacts,
  type RuntimeTreeAttestation,
} from "./production-runtime-tree.js";
import { TOOLCHAIN_ROOT_SHELL_PREFIX } from "./production-toolchain-contract.js";

export const RUNTIME_VAULT_STATUS_BEGIN = "COMIS_RUNTIME_VAULT_STATUS_V1_BEGIN";
export const RUNTIME_VAULT_STATUS_END = "COMIS_RUNTIME_VAULT_STATUS_V1_END";

const RUNTIME_VAULT_PAYLOAD_BEGIN = "COMIS_RUNTIME_VAULT_PAYLOAD_V1_BEGIN";
const RUNTIME_VAULT_PAYLOAD_END = "COMIS_RUNTIME_VAULT_PAYLOAD_V1_END";
const RUNTIME_VAULT_BASE = "/opt/comis-replay";
const RUNTIME_VAULT_ROOT = "/opt/comis-replay/runtimes/sha256";
const SAFE_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const ATTEMPT_ID_RE = /^[a-f0-9]{32}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const STREAM_ENTRY_OVERHEAD_BYTES = 16 * 1024;
const STREAM_FIXED_OVERHEAD_BYTES = 128 * 1024 * 1024;
const MAX_STATUS_BYTES = 8 * 1024;

export interface RuntimePayloadIdentity {
  readonly digestSha256: string;
  readonly entryCount: number;
  readonly bytes: number;
  readonly version: string;
}

export interface ProductionRuntimeVaultPlanBaseRequest {
  readonly runId: string;
  readonly attemptId: string;
  readonly profile: ProductionReplayProfile;
  readonly sourceRuntime: RuntimeArtifactAttestation;
  readonly targetRuntime: RuntimeArtifactAttestation;
  readonly sourceTree: RuntimeTreeAttestation;
}

export interface ProductionRuntimeVaultPlanRequest
  extends ProductionRuntimeVaultPlanBaseRequest {
  readonly authorityDigestSha256: string;
}

export interface ProductionRuntimeVaultPlanBase {
  readonly payloadPath: string;
  readonly maximumArchiveBytes: number;
  readonly targetControlDir: string;
  readonly targetIncomingRoot: string;
  readonly targetTransactionDir: string;
}

export interface ProductionRuntimeVaultStreamPlan {
  readonly label: "stream-runtime-vault";
  readonly source: BinarySshEndpoint;
  readonly target: BinarySshEndpoint;
  readonly sourceStdin: string;
  readonly maximumBytes: number;
  readonly expectedBytes?: never;
  readonly timeoutMs?: number;
}

export interface ProductionRuntimeVaultPlan {
  readonly payloadPath: string;
  readonly authorityDigestSha256: string;
  readonly transactionIdentitySha256: string;
  readonly controllerLease: ProductionRemoteLeaseRequest;
  readonly targetPrepare: ProductionRemoteInvocation;
  readonly stream: ProductionRuntimeVaultStreamPlan;
  readonly targetVerify: ProductionRemoteInvocation;
  readonly targetPublish: ProductionRemoteInvocation;
  readonly targetRollback: ProductionRemoteInvocation;
  readonly targetTransactionStatus: ProductionRemoteInvocation;
  readonly targetFinishPublish: ProductionRemoteInvocation;
  readonly targetReconcile: ProductionRemoteInvocation;
}

export interface ProductionRuntimeVaultStatusAbsent {
  readonly state: "absent";
  readonly runtimeDigestSha256: string;
  readonly payloadPath: string;
}

export interface ProductionRuntimeVaultStatusPresent {
  readonly state: "present";
  readonly runtimeDigestSha256: string;
  readonly payloadPath: string;
  readonly payload: RuntimeTreeAttestation;
}

export type ProductionRuntimeVaultStatus =
  | ProductionRuntimeVaultStatusAbsent
  | ProductionRuntimeVaultStatusPresent;

export interface InspectProductionRuntimeVaultRequest {
  readonly profile: ProductionReplayProfile;
  readonly runtimeDigestSha256: string;
}

export interface SealProductionRuntimeRequest {
  readonly runId: string;
  readonly attemptId: string;
  readonly authorityDigestSha256: string;
  readonly profile: ProductionReplayProfile;
  readonly executor: ProductionRemoteExecutor;
  readonly bridge: ProductionBinarySshBridge;
  readonly leaseClient: ProductionRemoteLeaseClient;
}

export interface RecoverProductionRuntimeVaultRequest {
  readonly runId: string;
  readonly attemptId: string;
  readonly authorityDigestSha256: string;
  readonly profile: ProductionReplayProfile;
  readonly executor: ProductionRemoteExecutor;
}

export interface ReconcileProductionRuntimeVaultTargetRequest {
  readonly plan: ProductionRuntimeVaultPlan;
  readonly executor: ProductionRemoteExecutor;
  readonly leaseClient: ProductionRemoteLeaseClient;
}

export interface ProductionRuntimeVaultTargetReconciliationReport {
  readonly disposition:
    | "not_started"
    | "reused_existing"
    | "rolled_back"
    | "published";
}

export interface ProductionRuntimeVaultReport {
  readonly disposition: "published" | "reused";
  readonly bytesTransferred: number;
  readonly payload: RuntimePayloadIdentity;
  readonly payloadPath: string;
  readonly importReceiptDigestSha256: string;
  readonly compatibility: {
    readonly status: "unsupported";
    readonly reason: "no_digest_pinned_adapter";
  };
  readonly sourceConsistency: {
    readonly method: "bounded_double_scan";
    readonly atomicSnapshot: false;
  };
  readonly targetInstallationPreserved: true;
  readonly normalServiceTouched: false;
}

export interface ProductionRuntimeVaultRecoveryReport {
  readonly disposition: "staging_rolled_back" | "published_recovered";
  readonly payload: RuntimePayloadIdentity;
  readonly payloadPath: string;
  readonly sourceConsistency: {
    readonly method: "bounded_double_scan";
    readonly atomicSnapshot: false;
  };
  readonly targetInstallationPreserved: true;
  readonly normalServiceTouched: false;
}

export interface ProductionRuntimeVaultPlanError {
  readonly kind: "invalid_request" | "precondition";
  readonly field: string;
  readonly message: string;
}

export type ProductionRuntimeVaultRemoteOutcome =
  | { readonly kind: "transport_failure" }
  | { readonly kind: "remote_exit"; readonly exitCode: number };

export interface ProductionRuntimeVaultRemoteFailure {
  readonly kind: "remote_failure";
  readonly stage: string;
  readonly message: string;
  readonly outcome: ProductionRuntimeVaultRemoteOutcome;
}

export type ProductionRuntimeVaultPrimaryError =
  | ProductionRuntimeVaultPlanError
  | ProductionRuntimeVaultRemoteFailure
  | {
      readonly kind: "transfer_failure";
      readonly stage: "stream-runtime-vault";
      readonly message: string;
    }
  | {
      readonly kind: "attestation_failure";
      readonly stage: string;
      readonly message: string;
    }
  | {
      readonly kind: "lease_failure";
      readonly stage: "acquire-runtime-vault-lease";
      readonly message: string;
      readonly outcome: ProductionRemoteLeaseError;
    };

export type ProductionRuntimeVaultError =
  | ProductionRuntimeVaultPrimaryError
  | {
      readonly kind: "rollback_failure";
      readonly stage: "rollback-runtime-vault";
      readonly message: string;
      readonly primary: ProductionRuntimeVaultPrimaryError;
      readonly rollback: {
        readonly stage: "rollback-runtime-vault-target";
        readonly outcome: ProductionRuntimeVaultRemoteOutcome;
      };
    }
  | {
      readonly kind: "lease_release_failure";
      readonly stage: "release-runtime-vault-lease";
      readonly message: string;
      readonly outcome: ProductionRemoteLeaseError;
      readonly primary: ProductionRuntimeVaultError | null;
    };

const RUNTIME_ARTIFACT_FIELDS = [
  "digestSha256",
  "entryCount",
  "bytes",
  "packageRoot",
  "version",
  "osId",
  "osVersion",
  "architecture",
  "kernelRelease",
  "libcKind",
  "libcVersion",
  "nodeVersion",
  "nodeAbi",
  "timezone",
  "tzdataSha256",
  "launcherKind",
  "applicationLauncherSha256",
  "confinementKind",
  "confinementSha256",
  "browserStatus",
  "browserSha256",
  "mediaStatus",
  "mediaSha256",
  "nativeToolsStatus",
  "nativeToolsSha256",
] as const;

function invalid(
  kind: ProductionRuntimeVaultPlanError["kind"],
  field: string,
  message: string,
): Result<never, ProductionRuntimeVaultPlanError> {
  return err({ kind, field, message });
}

function isSafePackageRoot(value: string): boolean {
  let hasControlCharacter = false;
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (codePoint <= 31 || codePoint === 127) {
      hasControlCharacter = true;
      break;
    }
  }
  return (
    isAbsolute(value) &&
    basename(value) === "comisai" &&
    basename(dirname(value)) === "node_modules" &&
    !value.includes("\\") &&
    !hasControlCharacter &&
    !value.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
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

function rootShellArgs(args: readonly string[]): readonly string[] {
  return [...TOOLCHAIN_ROOT_SHELL_PREFIX, ...args];
}

function payloadIdentity(facts: RuntimeTreeAttestation): RuntimePayloadIdentity {
  return {
    digestSha256: facts.digestSha256,
    entryCount: facts.entryCount,
    bytes: facts.bytes,
    version: facts.version,
  };
}

function runtimeArtifactEqual(
  expected: RuntimeArtifactAttestation,
  actual: RuntimeArtifactAttestation,
): boolean {
  return RUNTIME_ARTIFACT_FIELDS.every((field) => expected[field] === actual[field]);
}

function maximumStreamBytes(
  sourceTree: RuntimeTreeAttestation,
): Result<number, ProductionRuntimeVaultPlanError> {
  const value =
    sourceTree.bytes +
    sourceTree.entryCount * STREAM_ENTRY_OVERHEAD_BYTES +
    STREAM_FIXED_OVERHEAD_BYTES;
  if (!Number.isSafeInteger(value) || value <= sourceTree.bytes) {
    return invalid("invalid_request", "sourceTree", "Runtime stream size bound is unsafe");
  }
  return ok(value);
}

function buildSourceStreamProgram(): string {
  const probe = buildRuntimeTreeProbeScript();
  return String.raw`set -euo pipefail
expected_machine="$1"
service="$2"
package_root="$3"
expected_digest="$4"
expected_entry_count="$5"
expected_bytes="$6"
expected_version="$7"
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then exit 71; fi
case "$service" in *.service) unit="$service" ;; *) unit="$service.service" ;; esac
if [ "$(systemctl is-active "$unit" 2>/dev/null || true)" != inactive ]; then exit 72; fi
case "$package_root" in /*/node_modules/comisai) ;; *) exit 73 ;; esac
if [ -L "$package_root" ] || [ "$(readlink -f -- "$package_root")" != "$package_root" ] || \
   [ ! -d "$package_root" ]; then exit 73; fi
for command in zstd unshare mount findmnt tar python3; do
  if ! command -v "$command" >/dev/null 2>&1; then exit 74; fi
done
if [ ! -d /tmp ] || [ -L /tmp ]; then exit 74; fi
python3 - "$package_root" <<'COMIS_RUNTIME_SOURCE_MOUNT_GUARD'
import posixpath
import re
import sys

root = posixpath.normpath(sys.argv[1])
with open("/proc/self/mountinfo", "r", encoding="utf8") as source:
    for line in source:
        left, separator, _right = line.rstrip("\n").partition(" - ")
        fields = left.split()
        if separator == "" or len(fields) < 6:
            raise SystemExit(1)
        target = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), fields[4])
        target = posixpath.normpath(target)
        if target.startswith(root + "/"):
            raise SystemExit(1)
COMIS_RUNTIME_SOURCE_MOUNT_GUARD
attest_tree() {
  bash -s -- "$package_root" <<'COMIS_RUNTIME_TREE_SOURCE_PROBE'
${probe}
COMIS_RUNTIME_TREE_SOURCE_PROBE
}
before="$(attest_tree)"
expected="${RUNTIME_TREE_FACTS_BEGIN}
digestSha256=$expected_digest
entryCount=$expected_entry_count
bytes=$expected_bytes
root=$package_root
version=$expected_version
${RUNTIME_TREE_FACTS_END}"
if [ "$before" != "$expected" ]; then exit 75; fi
unshare --mount --propagation private bash -s -- "$package_root" <<'COMIS_RUNTIME_READ_ONLY_ARCHIVE'
set -euo pipefail
package_root="$1"
mount --make-rprivate /
mount -t tmpfs -o mode=0700,nosuid,nodev,noexec,size=16m comis-runtime-capture /tmp
capture_root=/tmp/comis-runtime-capture
mkdir -m 0700 -- "$capture_root"
mount --bind "$package_root" "$capture_root"
mount -o remount,bind,ro,noatime,nodiratime,nosuid,nodev,noexec "$capture_root"
options="$(findmnt -n -o OPTIONS --target "$capture_root")"
for required in ro noatime nodiratime nosuid nodev noexec; do
  case ",$options," in *",$required,"*) ;; *) exit 77 ;; esac
done
if [ "$(findmnt -n -o TARGET --target "$capture_root")" != "$capture_root" ]; then exit 77; fi
tar --create --file=- --format=posix --zstd --numeric-owner \
  --pax-option=delete=atime,delete=ctime \
  --directory="$capture_root" .
COMIS_RUNTIME_READ_ONLY_ARCHIVE
after="$(attest_tree)"
if [ "$after" != "$before" ]; then exit 76; fi
`;
}

const TARGET_GUARD = String.raw`if [ "$(id -u)" -ne 0 ] || [ "$(uname -s)" != Linux ]; then exit 70; fi
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then exit 71; fi
role_marker=/etc/comis/environment-role
if [ -L "$role_marker" ] || [ ! -f "$role_marker" ] || \
   [ "$(stat -c '%u:%g:%a:%s' "$role_marker" 2>/dev/null || true)" != 0:0:644:5 ] || \
   [ "$(cat "$role_marker" 2>/dev/null || true)" != test ]; then exit 72; fi
case "$service" in *.service) unit="$service" ;; *) unit="$service.service" ;; esac
if [ "$(systemctl show "$unit" --property=LoadState --value 2>/dev/null || true)" != loaded ] || \
   [ "$(systemctl is-active "$unit" 2>/dev/null || true)" != inactive ] || \
   [ "$(systemctl is-enabled "$unit" 2>/dev/null || true)" != disabled ]; then exit 73; fi
quarantine="/etc/systemd/system/$unit.d/90-comis-replay-quarantine.conf"
if [ -L "$quarantine" ] || [ ! -f "$quarantine" ] || \
   [ "$(stat -c '%u:%g:%a' "$quarantine" 2>/dev/null || true)" != 0:0:644 ] || \
   [ "$(sha256sum "$quarantine" 2>/dev/null | awk '{print $1}')" != ${TARGET_REPLAY_QUARANTINE_SHA256} ]; then exit 74; fi
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
`;

const TARGET_PATH_ASSIGNMENTS = String.raw`vault_base=/opt/comis-replay
vault_parent="$vault_base/runtimes"
vault_root="$vault_parent/sha256"
final_root="$vault_root/$expected_digest"
payload_path="$final_root/payload"
coordination_parent=/var/lib/comis-self-driving
coordination_root="$coordination_parent/runtime-vault"
transaction_parent="$coordination_root/transactions"
transaction_dir="$transaction_parent/$attempt_id"
control_dir="$coordination_root/capture-$run_id-$attempt_id"
incoming_root="$vault_root/.incoming-$run_id-$attempt_id-$expected_digest"
operation_lock="$coordination_root/operation.lock"
controller_lock="$coordination_root/controller-$attempt_id.lock"
identity_path="$coordination_root/capture-$run_id-$attempt_id.identity"
identity_incoming="$coordination_root/.capture-$run_id-$attempt_id.identity.incoming"
active_capture="$coordination_root/active-capture"
`;

const TARGET_JOURNAL_LIBRARY = buildProductionRuntimeVaultJournalShellLibrary();

const TARGET_MOUNT_GUARD = String.raw`mount_overlap_status=0
python3 - "$vault_base" "$coordination_root" /etc/comis /run "$target_data" \
  "$target_package_root" \
  <<'COMIS_RUNTIME_MOUNT_GUARD' || mount_overlap_status=$?
import posixpath
import re
import sys
from typing import NamedTuple

class Mount(NamedTuple):
    mount_id: int
    device: str
    root: str
    target: str

def decode(value: str) -> str:
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), value)

def normalize(path: str) -> str:
    value = posixpath.normpath(path)
    if not value.startswith("/"):
        raise ValueError("path is not absolute")
    return value

def beneath(path: str, root: str) -> bool:
    return root == "/" or path == root or path.startswith(root + "/")

def coordinate(path: str, mount: Mount) -> str:
    relative = posixpath.relpath(path, mount.target)
    return mount.root if relative == "." else normalize(posixpath.join(mount.root, relative))

mounts = []
with open("/proc/self/mountinfo", "r", encoding="utf8") as source:
    for line in source:
        left, separator, _right = line.rstrip("\n").partition(" - ")
        fields = left.split()
        if separator == "" or len(fields) < 6:
            raise SystemExit(11)
        mounts.append(Mount(int(fields[0]), fields[2], normalize(decode(fields[3])), normalize(decode(fields[4]))))
if not mounts:
    raise SystemExit(11)

def regions(path: str):
    path = normalize(path)
    containing = [mount for mount in mounts if beneath(path, mount.target)]
    if not containing:
        raise SystemExit(11)
    selected = max(containing, key=lambda mount: (len(mount.target), mount.mount_id))
    result = [(selected.device, coordinate(path, selected))]
    result.extend((mount.device, mount.root) for mount in mounts if mount.target != path and beneath(mount.target, path))
    return result

write_regions = [regions(path) for path in sys.argv[1:3]]
protected_regions = [regions(path) for path in sys.argv[3:]]
for index, left_regions in enumerate(write_regions):
    for right_regions in write_regions[index + 1:] + protected_regions:
        for left_device, left_root in left_regions:
            for right_device, right_root in right_regions:
                if left_device == right_device and (beneath(left_root, right_root) or beneath(right_root, left_root)):
                    raise SystemExit(10)
COMIS_RUNTIME_MOUNT_GUARD
case "$mount_overlap_status" in 0) ;; 10) exit 77 ;; *) exit 79 ;; esac
`;

const TARGET_ANCESTOR_GUARD = String.raw`python3 - /opt /opt/comis-replay /opt/comis-replay/runtimes \
  /opt/comis-replay/runtimes/sha256 /var /var/lib "$coordination_parent" "$coordination_root" \
  "$transaction_parent" \
  <<'TARGET_RUNTIME_VAULT_ANCESTORS'
import os
import stat
import sys

for index, path in enumerate(sys.argv[1:]):
    try:
        value = os.lstat(path)
    except FileNotFoundError:
        continue
    if not stat.S_ISDIR(value.st_mode) or stat.S_ISLNK(value.st_mode) or value.st_uid != 0 or value.st_gid != 0:
        raise SystemExit(1)
    mode = stat.S_IMODE(value.st_mode)
    if index in (0, 4, 5):
        if mode & 0o022:
            raise SystemExit(1)
    elif mode != 0o700:
        raise SystemExit(1)
TARGET_RUNTIME_VAULT_ANCESTORS
`;

const TARGET_CANONICAL_PATH_GUARD = String.raw`for guarded_path in "$vault_base" "$coordination_root" "$target_data" "$target_package_root"; do
  if [ "$(realpath -m -- "$guarded_path")" != "$guarded_path" ]; then exit 78; fi
done
`;

const TARGET_DYNAMIC_MOUNT_GUARD = String.raw`dynamic_mount_status=0
python3 - "$incoming_root" "$control_dir" "$transaction_dir" "$final_root" \
  <<'COMIS_RUNTIME_DYNAMIC_MOUNT_GUARD' || dynamic_mount_status=$?
import posixpath
import re
import sys

guarded = [posixpath.normpath(path) for path in sys.argv[1:]]
with open("/proc/self/mountinfo", "r", encoding="utf8") as source:
    for line in source:
        left, separator, _right = line.rstrip("\n").partition(" - ")
        fields = left.split()
        if separator == "" or len(fields) < 6:
            raise SystemExit(11)
        target = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), fields[4])
        target = posixpath.normpath(target)
        if any(target == path or target.startswith(path + "/") for path in guarded):
            raise SystemExit(10)
COMIS_RUNTIME_DYNAMIC_MOUNT_GUARD
case "$dynamic_mount_status" in 0) ;; 10) exit 77 ;; *) exit 79 ;; esac
`;

const TARGET_FINAL_MOUNT_GUARD = String.raw`final_mount_status=0
python3 - "$vault_base" "$coordination_root" "$final_root" \
  <<'COMIS_RUNTIME_FINAL_MOUNT_GUARD' || final_mount_status=$?
import posixpath
import re
import sys

guarded = [posixpath.normpath(path) for path in sys.argv[1:]]
with open("/proc/self/mountinfo", "r", encoding="utf8") as source:
    for line in source:
        left, separator, _right = line.rstrip("\n").partition(" - ")
        fields = left.split()
        if separator == "" or len(fields) < 6:
            raise SystemExit(11)
        target = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), fields[4])
        target = posixpath.normpath(target)
        if any(target == path or target.startswith(path + "/") for path in guarded):
            raise SystemExit(10)
COMIS_RUNTIME_FINAL_MOUNT_GUARD
case "$final_mount_status" in 0) ;; 10) exit 77 ;; *) exit 79 ;; esac
`;

const TARGET_CLAIM_GUARD = String.raw`if [ ! -f "$identity_path" ] || [ -L "$identity_path" ] || \
   [ "$(stat -c '%u:%g:%a:%h' "$identity_path" 2>/dev/null || true)" != 0:0:400:2 ] || \
   [ "$(cat "$identity_path" 2>/dev/null || true)" != "$expected_transaction_identity" ] || \
   [ ! -f "$active_capture" ] || [ -L "$active_capture" ] || \
   [ "$(cat "$active_capture" 2>/dev/null || true)" != "$expected_transaction_identity" ] || \
   [ "$(stat -c '%d:%i' "$identity_path" 2>/dev/null || true)" != \
     "$(stat -c '%d:%i' "$active_capture" 2>/dev/null || true)" ]; then exit 84; fi
`;

const TARGET_OPERATION_LOCK_GUARD = String.raw`python3 - "$operation_lock" \
  <<'COMIS_RUNTIME_OPERATION_LOCK_GUARD'
import os
import stat
import sys

path = sys.argv[1]
value = os.lstat(path)
if (
    not stat.S_ISREG(value.st_mode)
    or value.st_uid != 0
    or value.st_gid != 0
    or stat.S_IMODE(value.st_mode) != 0o600
    or value.st_nlink != 1
    or value.st_size != 0
    or os.listxattr(path, follow_symlinks=False)
):
    raise SystemExit(1)
descriptor = os.open(path, os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
try:
    opened = os.fstat(descriptor)
    if (opened.st_dev, opened.st_ino) != (value.st_dev, value.st_ino):
        raise SystemExit(1)
finally:
    os.close(descriptor)
COMIS_RUNTIME_OPERATION_LOCK_GUARD
exec 9<>"$operation_lock"
if ! flock -n 9; then exit 82; fi
if [ -L "$operation_lock" ] || \
   [ "$(stat -c '%d:%i:%u:%g:%a:%h:%s' "$operation_lock" 2>/dev/null || true)" != \
     "$(stat -Lc '%d:%i:%u:%g:%a:%h:%s' "/proc/$$/fd/9" 2>/dev/null || true)" ] || \
   [ "$(stat -c '%u:%g:%a:%h:%s' "$operation_lock" 2>/dev/null || true)" != 0:0:600:1:0 ]; then exit 81; fi
`;

const TARGET_CONTROLLER_LOCK_INVENTORY = String.raw`python3 - "$controller_lock" \
  <<'COMIS_RUNTIME_CONTROLLER_LOCK'
import os
import stat
import sys

path = sys.argv[1]
value = os.lstat(path)
if (
    not stat.S_ISREG(value.st_mode)
    or value.st_uid != 0
    or value.st_gid != 0
    or stat.S_IMODE(value.st_mode) != 0o600
    or value.st_nlink != 1
    or value.st_size != 0
    or os.listxattr(path, follow_symlinks=False)
):
    raise SystemExit(1)
descriptor = os.open(path, os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
try:
    opened = os.fstat(descriptor)
    if (opened.st_dev, opened.st_ino) != (value.st_dev, value.st_ino):
        raise SystemExit(1)
finally:
    os.close(descriptor)
COMIS_RUNTIME_CONTROLLER_LOCK
`;

const TARGET_CONTROLLER_LEASE_HELD_GUARD = String.raw`${TARGET_CONTROLLER_LOCK_INVENTORY}
controller_lease_status=0
flock -n "$controller_lock" true || controller_lease_status=$?
case "$controller_lease_status" in
  1) ;;
  *) exit 89 ;;
esac
# COMIS_RUNTIME_CONTROLLER_LEASE_HELD_GUARD
`;

const TARGET_CONTROLLER_LEASE_ACQUIRE_GUARD = String.raw`${TARGET_CONTROLLER_LOCK_INVENTORY}
exec 8<>"$controller_lock"
if ! flock -n 8; then exit 89; fi
if [ -L "$controller_lock" ] || \
   [ "$(stat -c '%d:%i:%u:%g:%a:%h:%s' "$controller_lock" 2>/dev/null || true)" != \
     "$(stat -Lc '%d:%i:%u:%g:%a:%h:%s' "/proc/$$/fd/8" 2>/dev/null || true)" ] || \
   [ "$(stat -c '%u:%g:%a:%h:%s' "$controller_lock" 2>/dev/null || true)" != 0:0:600:1:0 ]; then exit 81; fi
# COMIS_RUNTIME_CONTROLLER_LEASE_ACQUIRE_GUARD
`;

const TARGET_PARTIAL_CLAIM_GUARD = String.raw`python3 - "$expected_transaction_identity" \
  "$identity_incoming" "$identity_path" "$active_capture" "$control_dir" "$incoming_root" \
  <<'COMIS_RUNTIME_PARTIAL_CLAIM_GUARD'
import os
import stat
import sys

expected = sys.argv[1]
identity_incoming, identity_path, active_capture, control_dir, incoming_root = sys.argv[2:]

def regular(path, allow_partial):
    if not os.path.lexists(path):
        return None
    value = os.lstat(path)
    if (
        not stat.S_ISREG(value.st_mode)
        or value.st_uid != 0
        or value.st_gid != 0
        or stat.S_IMODE(value.st_mode) != 0o400
        or value.st_size > 65
        or os.listxattr(path, follow_symlinks=False)
    ):
        raise SystemExit(1)
    with open(path, "r", encoding="ascii") as source:
        content = source.read()
    committed = expected + "\n"
    if allow_partial:
        if value.st_nlink != 1 or not committed.startswith(content):
            raise SystemExit(1)
    elif content != committed:
        raise SystemExit(1)
    return value

incoming_value = regular(identity_incoming, True)
identity_value = regular(identity_path, False)
active_value = regular(active_capture, False)
if incoming_value is not None and (identity_value is not None or active_value is not None):
    raise SystemExit(1)
if identity_value is not None and active_value is not None:
    if (
        identity_value.st_nlink != 2
        or active_value.st_nlink != 2
        or (identity_value.st_dev, identity_value.st_ino) != (active_value.st_dev, active_value.st_ino)
    ):
        raise SystemExit(1)
elif identity_value is not None and identity_value.st_nlink != 1:
    raise SystemExit(1)
elif active_value is not None and active_value.st_nlink != 1:
    raise SystemExit(1)

owned_directory_seen = False
for path in (control_dir, incoming_root):
    if not os.path.lexists(path):
        continue
    value = os.lstat(path)
    if (
        not stat.S_ISDIR(value.st_mode)
        or value.st_uid != 0
        or value.st_gid != 0
        or stat.S_IMODE(value.st_mode) != 0o700
        or os.listxattr(path, follow_symlinks=False)
    ):
        raise SystemExit(1)
    owned_directory_seen = True
if owned_directory_seen and (identity_value is None or active_value is None):
    raise SystemExit(1)
COMIS_RUNTIME_PARTIAL_CLAIM_GUARD
`;

const TARGET_RECOVERY_FINAL_GUARD = String.raw`if [ -e "$final_root" ] || [ -L "$final_root" ]; then
  if [ ! -d "$final_root" ] || [ -L "$final_root" ] || \
     [ "$(stat -c '%u:%g:%a' "$final_root" 2>/dev/null || true)" != 0:0:700 ] || \
     [ ! -d "$payload_path" ] || [ -L "$payload_path" ] || \
     [ ! -f "$final_root/payload.attestation" ] || [ -L "$final_root/payload.attestation" ] || \
     [ "$(stat -c '%u:%g:%a:%h' "$final_root/payload.attestation" 2>/dev/null || true)" != 0:0:400:1 ] || \
     [ "$(stat -c '%s' "$final_root/payload.attestation" 2>/dev/null || true)" -gt 512 ]; then exit 88; fi
  python3 - "$final_root" "$payload_path" "$final_root/payload.attestation" \
    <<'COMIS_RUNTIME_RECOVERY_FINAL_INVENTORY'
import os
import stat
import sys

final_root, payload_path, attestation_path = sys.argv[1:]
if set(os.listdir(final_root)) != {"payload", "payload.attestation"}:
    raise SystemExit(1)
for path in (final_root, attestation_path):
    value = os.lstat(path)
    if stat.S_ISLNK(value.st_mode) or value.st_uid != 0 or value.st_gid != 0:
        raise SystemExit(1)
payload = os.lstat(payload_path)
if not stat.S_ISDIR(payload.st_mode) or stat.S_ISLNK(payload.st_mode):
    raise SystemExit(1)
for path in (final_root, payload_path, attestation_path):
    if os.listxattr(path, follow_symlinks=False):
        raise SystemExit(1)
COMIS_RUNTIME_RECOVERY_FINAL_INVENTORY
  facts="$(probe_tree "$payload_path")"
  expected_facts="${RUNTIME_TREE_FACTS_BEGIN}
digestSha256=$expected_digest
entryCount=$expected_entry_count
bytes=$expected_bytes
root=$payload_path
version=$expected_version
${RUNTIME_TREE_FACTS_END}"
  if [ "$facts" != "$expected_facts" ]; then exit 88; fi
  expected_payload_attestation="${RUNTIME_VAULT_PAYLOAD_BEGIN}
digestSha256=$expected_digest
entryCount=$expected_entry_count
bytes=$expected_bytes
version=$expected_version
storagePolicy=root_only_read_only_bind_v1
${RUNTIME_VAULT_PAYLOAD_END}"
  if [ "$(cat "$final_root/payload.attestation" 2>/dev/null || true)" != \
    "$expected_payload_attestation" ]; then exit 88; fi
fi
`;

const TARGET_HEADROOM_GUARD = String.raw`runtime_headroom() {
  python3 - "$1" "$2" "$3" <<'COMIS_RUNTIME_HEADROOM_GUARD'
import os
import stat
import sys

path = sys.argv[1]
required_bytes = int(sys.argv[2])
required_inodes = int(sys.argv[3])
if (
    required_bytes < 0
    or required_bytes > 2**63 - 1
    or required_inodes < 0
    or required_inodes > 2**63 - 1
):
    raise SystemExit(1)
value = os.lstat(path)
if not stat.S_ISDIR(value.st_mode) or stat.S_ISLNK(value.st_mode) or os.path.realpath(path) != path:
    raise SystemExit(1)
filesystem = os.statvfs(path)
available_bytes = filesystem.f_bavail * filesystem.f_frsize
available_inodes = filesystem.f_favail
if available_bytes < required_bytes or available_inodes < required_inodes:
    raise SystemExit(1)
COMIS_RUNTIME_HEADROOM_GUARD
}
`;

const SAFE_EXTRACTOR = String.raw`import decimal
import os
import posixpath
import stat
import sys
import tarfile

root = sys.argv[1]
expected_entry_count = int(sys.argv[2])
expected_bytes = int(sys.argv[3])
maximum_uncompressed_bytes = int(sys.argv[4])
seen = set()
symlinks = set()
declared_directories = set()
metadata = []
entry_count = 0
total_bytes = 0
MAXIMUM_PATH_BYTES = 4096
MAXIMUM_PATH_COMPONENTS = 256
MAXIMUM_LINK_TARGET_BYTES = 4096
MAXIMUM_METADATA_HEADER_BYTES = 16384

def fail(message):
    raise ValueError(message)

class BoundedReader:
    def __init__(self, source, maximum):
        self.source = source
        self.maximum = maximum
        self.observed = 0

    def read(self, size=-1):
        remaining = self.maximum - self.observed
        request_size = remaining + 1 if size < 0 or size > remaining + 1 else size
        chunk = self.source.read(request_size)
        self.observed += len(chunk)
        if self.observed > self.maximum:
            fail("maximum_uncompressed_bytes exceeded")
        return chunk

def parse_pax_records(payload):
    headers = {}
    position = 0
    while position < len(payload):
        separator = payload.find(b" ", position)
        if separator <= position:
            fail("invalid pax record framing")
        raw_length = payload[position:separator]
        if not raw_length.isdigit():
            fail("invalid pax record length")
        length = int(raw_length)
        end = position + length
        if length < 5 or end > len(payload) or payload[end - 1:end] != b"\n":
            fail("invalid pax record framing")
        record = payload[separator + 1:end - 1]
        raw_key, equals, raw_value = record.partition(b"=")
        if not raw_key or equals != b"=":
            fail("invalid pax record framing")
        try:
            key = raw_key.decode("ascii", "strict")
            value = raw_value.decode("utf-8", "strict")
        except UnicodeError:
            fail("pax record is not canonical utf-8")
        if key in headers:
            fail("duplicate pax key")
        headers[key] = value
        position = end
    return headers

class SafeTarInfo(tarfile.TarInfo):
    def require_bounded_metadata(self):
        if self.size < 0 or self.size > MAXIMUM_METADATA_HEADER_BYTES:
            fail("archive metadata header exceeds 16384 bytes")

    def _proc_gnulong(self, archive):
        self.require_bounded_metadata()
        fail("gnu long-name metadata is not supported")

    def _proc_sparse(self, archive):
        fail("sparse archive member is not supported")

    def _proc_pax(self, archive):
        self.require_bounded_metadata()
        if self.type != tarfile.XHDTYPE:
            fail("global or vendor pax metadata is not supported")
        padded_size = self._block(self.size)
        padded = archive.fileobj.read(padded_size)
        if len(padded) != padded_size:
            fail("truncated pax metadata")
        headers = parse_pax_records(padded[:self.size])
        if any(key.startswith("GNU.sparse.") for key in headers):
            fail("sparse archive member is not supported")
        try:
            next_member = self.fromtarfile(archive)
        except tarfile.HeaderError:
            fail("pax metadata has no archive member")
        allowed = {"mtime", "path"}
        if next_member.issym():
            allowed.add("linkpath")
        if any(key not in allowed for key in headers):
            fail("unsupported pax key for archive member")
        next_member._apply_pax_info(headers, archive.encoding, archive.errors)
        next_member.offset = self.offset
        return next_member

def encoded_length(value, label):
    try:
        return len(os.fsencode(value))
    except UnicodeError:
        fail(label + " is not representable as filesystem bytes")

def mtime_ns(member):
    raw = member.pax_headers.get("mtime", str(member.mtime))
    value = decimal.Decimal(raw) * decimal.Decimal(1_000_000_000)
    if value != value.to_integral_value():
        fail("mtime is not representable in nanoseconds")
    return int(value)

def filter_member(member, destination):
    global entry_count, total_bytes
    name = member.name
    if not name or "\0" in name or name.startswith("/"):
        fail("invalid archive path")
    if encoded_length(name, "archive path") > MAXIMUM_PATH_BYTES:
        fail("archive path exceeds 4096 bytes")
    normalized = posixpath.normpath(name)
    if normalized == ".." or normalized.startswith("../"):
        fail("archive path escaped payload")
    canonical = "." if normalized == "." else normalized.removeprefix("./")
    if encoded_length(canonical, "archive path") > MAXIMUM_PATH_BYTES:
        fail("archive path exceeds 4096 bytes")
    components = [] if canonical == "." else canonical.split("/")
    if len(components) > MAXIMUM_PATH_COMPONENTS:
        fail("archive path exceeds 256 components")
    if canonical in seen:
        fail("duplicate archive path")
    if member.islnk():
        fail("hard link is not supported")
    if not (member.isdir() or member.isreg() or member.issym()):
        fail("special archive member is not supported")
    if member.type == tarfile.GNUTYPE_SPARSE or member.sparse is not None:
        fail("sparse archive member is not supported")
    if canonical == "." and not member.isdir():
        fail("archive root must be a directory")
    if canonical != ".":
        if "." not in declared_directories:
            fail("archive parent directory was not declared")
        parent = ""
        for component in components[:-1]:
            parent = component if parent == "" else parent + "/" + component
            if parent in symlinks:
                fail("archive path descends through symlink")
            if parent not in declared_directories:
                fail("archive parent directory was not declared")
    if member.mode & 0o6000:
        fail("setuid or setgid archive mode")
    if member.issym():
        if member.mode & 0o777 != 0o777:
            fail("symbolic link mode is not reproducible")
        if encoded_length(member.linkname, "symbolic link target") > MAXIMUM_LINK_TARGET_BYTES:
            fail("symbolic link target exceeds 4096 bytes")
        symlinks.add(canonical)
    allowed_pax_keys = {"mtime", "path"}
    if member.issym():
        allowed_pax_keys.add("linkpath")
    if any(key not in allowed_pax_keys for key in member.pax_headers):
        fail("unsupported pax key for archive member")
    entry_count += 1
    if entry_count > expected_entry_count:
        fail("expected_entry_count exceeded")
    if member.isreg():
        total_bytes += member.size
        if total_bytes > expected_bytes:
            fail("expected_bytes exceeded")
    filtered = tarfile.data_filter(member, destination)
    if filtered is None:
        fail("archive member was rejected")
    filtered = filtered.replace(
        mode=member.mode & 0o1777,
        uid=member.uid,
        gid=member.gid,
        uname=None,
        gname=None,
        mtime=member.mtime,
    )
    metadata.append((canonical, member.isdir(), member.isreg(), member.issym(), member.mode & 0o1777, member.uid, member.gid, mtime_ns(member)))
    seen.add(canonical)
    if member.isdir():
        declared_directories.add(canonical)
    return filtered

with tarfile.open(
    fileobj=BoundedReader(sys.stdin.buffer, maximum_uncompressed_bytes),
    mode="r|",
    tarinfo=SafeTarInfo,
) as archive:
    archive.extractall(root, filter=filter_member)

if entry_count != expected_entry_count or total_bytes != expected_bytes or "." not in seen:
    fail("archive totals do not match expected identity")

def absolute(canonical):
    return root if canonical == "." else os.path.join(root, *canonical.split("/"))

non_directories = [item for item in metadata if not item[1]]
directories = sorted((item for item in metadata if item[1]), key=lambda item: item[0].count("/"), reverse=True)
for canonical, _is_dir, is_file, is_link, mode, uid, gid, nanoseconds in non_directories + directories:
    path = absolute(canonical)
    value = os.lstat(path)
    if is_file and not stat.S_ISREG(value.st_mode):
        fail("extracted file type changed")
    if is_link and not stat.S_ISLNK(value.st_mode):
        fail("extracted link type changed")
    if not is_link:
        os.chmod(path, mode, follow_symlinks=False)
    os.chown(path, uid, gid, follow_symlinks=False)
    os.utime(path, ns=(nanoseconds, nanoseconds), follow_symlinks=False)
    if is_file:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

for canonical, is_dir, _is_file, _is_link, _mode, _uid, _gid, _nanoseconds in directories:
    if not is_dir:
        continue
    descriptor = os.open(absolute(canonical), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
`;

function targetArgs(
  request: ProductionRuntimeVaultPlanRequest,
  maximumArchiveBytes: number,
  transactionIdentitySha256: string,
): readonly string[] {
  return [
    request.profile.target.expectedMachineIdSha256,
    request.profile.target.service,
    request.runId,
    request.profile.target.dataDir,
    request.targetRuntime.packageRoot,
    request.profile.source.expectedMachineIdSha256,
    request.sourceTree.digestSha256,
    String(request.sourceTree.entryCount),
    String(request.sourceTree.bytes),
    request.sourceTree.version,
    String(maximumArchiveBytes),
    request.attemptId,
    request.authorityDigestSha256,
    transactionIdentitySha256,
  ];
}

function targetVariablePrelude(): string {
  return String.raw`expected_machine="$1"
service="$2"
run_id="$3"
target_data="$4"
target_package_root="$5"
source_machine="$6"
expected_digest="$7"
expected_entry_count="$8"
expected_bytes="$9"
shift 9
expected_version="$1"
maximum_archive_bytes="$2"
attempt_id="$3"
expected_authority_digest="$4"
expected_transaction_identity="$5"
`;
}

function buildTargetControllerLeaseScript(readyLine: string): string {
  return String.raw`set -euo pipefail
${targetVariablePrelude()}${TARGET_GUARD}${TARGET_PATH_ASSIGNMENTS}${TARGET_CANONICAL_PATH_GUARD}${TARGET_MOUNT_GUARD}${TARGET_ANCESTOR_GUARD}${TARGET_DYNAMIC_MOUNT_GUARD}
install -d -m 0700 -o root -g root "$coordination_parent"
sync -f /var/lib
install -d -m 0700 -o root -g root "$coordination_root"
sync -f "$coordination_parent"
python3 - "$controller_lock" <<'COMIS_RUNTIME_CONTROLLER_LOCK_CREATE'
import os
import stat
import sys

path = sys.argv[1]
flags = os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW
try:
    descriptor = os.open(path, flags | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    value = os.lstat(path)
    if (
        not stat.S_ISREG(value.st_mode)
        or value.st_uid != 0
        or value.st_gid != 0
        or stat.S_IMODE(value.st_mode) != 0o600
        or value.st_nlink != 1
        or value.st_size != 0
        or os.listxattr(path, follow_symlinks=False)
    ):
        raise SystemExit(1)
    descriptor = os.open(path, flags)
try:
    os.fchmod(descriptor, 0o600)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
COMIS_RUNTIME_CONTROLLER_LOCK_CREATE
sync -f "$coordination_root"
${TARGET_CONTROLLER_LEASE_ACQUIRE_GUARD}
printf '%s\n' '${readyLine}'
if IFS= read -r unexpected_input; then exit 90; fi
`;
}

function buildTargetPrepareScript(): string {
  return `${String.raw`set -euo pipefail
${targetVariablePrelude()}${TARGET_GUARD}${TARGET_PATH_ASSIGNMENTS}${TARGET_CANONICAL_PATH_GUARD}${TARGET_MOUNT_GUARD}${TARGET_ANCESTOR_GUARD}${TARGET_DYNAMIC_MOUNT_GUARD}${TARGET_HEADROOM_GUARD}
if [ -e "$final_root" ] || [ -L "$final_root" ]; then exit 80; fi
runtime_headroom /opt "$maximum_archive_bytes" "$((expected_entry_count + 1024))"
runtime_headroom /var/lib 67108864 128
install -d -m 0700 -o root -g root /opt/comis-replay
sync -f /opt
install -d -m 0700 -o root -g root "$vault_parent"
sync -f "$vault_base"
install -d -m 0700 -o root -g root "$vault_root"
sync -f "$vault_parent"
install -d -m 0700 -o root -g root "$coordination_parent"
sync -f /var/lib
install -d -m 0700 -o root -g root "$coordination_root"
sync -f "$coordination_parent"
install -d -m 0700 -o root -g root "$transaction_parent"
sync -f "$coordination_root"
python3 - "$operation_lock" <<'COMIS_RUNTIME_OPERATION_LOCK'
import os
import stat
import sys

lock_path = sys.argv[1]
flags = os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW
try:
    descriptor = os.open(lock_path, flags | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
except FileExistsError:
    value = os.lstat(lock_path)
    if (
        not stat.S_ISREG(value.st_mode)
        or value.st_uid != 0
        or value.st_gid != 0
        or stat.S_IMODE(value.st_mode) != 0o600
        or value.st_nlink != 1
        or value.st_size != 0
        or os.listxattr(lock_path, follow_symlinks=False)
    ):
        raise SystemExit(1)
    descriptor = os.open(lock_path, flags)
    opened = os.fstat(descriptor)
    if (opened.st_dev, opened.st_ino) != (value.st_dev, value.st_ino):
        raise SystemExit(1)
try:
    os.fchmod(descriptor, 0o600)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
COMIS_RUNTIME_OPERATION_LOCK
sync -f "$coordination_root"
exec 9<>"$operation_lock"
if ! flock -n 9; then exit 82; fi
if [ "$(stat -c '%d:%i:%u:%g:%a:%h:%s' "$operation_lock" 2>/dev/null || true)" != \
   "$(stat -Lc '%d:%i:%u:%g:%a:%h:%s' "/proc/$$/fd/9" 2>/dev/null || true)" ] || \
   [ "$(stat -c '%u:%g:%a:%h:%s' "$operation_lock" 2>/dev/null || true)" != 0:0:600:1:0 ]; then exit 81; fi
${TARGET_CONTROLLER_LEASE_HELD_GUARD}
${TARGET_JOURNAL_LIBRARY}
runtime_journal_initialize
runtime_journal_append prepare_intent
if [ -e "$identity_path" ] || [ -L "$identity_path" ] || \
   [ -e "$identity_incoming" ] || [ -L "$identity_incoming" ] || \
   [ -e "$active_capture" ] || [ -L "$active_capture" ] || \
   [ -e "$control_dir" ] || [ -L "$control_dir" ] || \
   [ -e "$incoming_root" ] || [ -L "$incoming_root" ]; then exit 83; fi
identity_created=0
active_created=0
control_created=0
incoming_created=0
cleanup_prepare() {
  rc=$?
  if [ "$#" -gt 0 ]; then rc="$1"; fi
  trap - EXIT HUP INT TERM
  if [ "$incoming_created" -eq 1 ]; then rm -rf -- "$incoming_root"; fi
  if [ "$control_created" -eq 1 ]; then rm -rf -- "$control_dir"; fi
  sync -f "$vault_root"
  sync -f "$coordination_root"
  if [ "$active_created" -eq 1 ]; then rm -f -- "$active_capture"; fi
  if [ "$identity_created" -eq 1 ]; then rm -f -- "$identity_path"; fi
  rm -f -- "$identity_incoming"
  sync -f "$coordination_root"
  exit "$rc"
}
trap cleanup_prepare EXIT
trap 'cleanup_prepare 129' HUP
trap 'cleanup_prepare 130' INT
trap 'cleanup_prepare 143' TERM
old_umask="$(umask)"
umask 377
(set -C; printf '%s\n' "$expected_transaction_identity" > "$identity_incoming")
umask "$old_umask"
chmod 0400 "$identity_incoming"
sync -f "$identity_incoming"
sync -f "$coordination_root"
identity_created=1
mv --no-clobber -- "$identity_incoming" "$identity_path"
sync -f "$identity_path"
sync -f "$coordination_root"
active_created=1
ln -- "$identity_path" "$active_capture"
sync -f "$coordination_root"
control_created=1
mkdir -m 0700 -- "$control_dir"
sync -f "$coordination_root"
incoming_created=1
mkdir -m 0700 -- "$incoming_root"
mkdir -m 0700 -- "$incoming_root/payload"
sync -f "$vault_root"
cat > "$control_dir/extract.py" <<'COMIS_RUNTIME_SAFE_EXTRACTOR'
${SAFE_EXTRACTOR}
COMIS_RUNTIME_SAFE_EXTRACTOR
chmod 0700 "$control_dir/extract.py"
cat > "$control_dir/receive.sh" <<'COMIS_RUNTIME_RECEIVER'
#!/usr/bin/env bash
set -euo pipefail
expected_machine="$1"
service="$2"
run_id="$3"
target_data="$4"
target_package_root="$5"
source_machine="$6"
expected_digest="$7"
expected_entry_count="$8"
expected_bytes="$9"
shift 9
expected_version="$1"
maximum_archive_bytes="$2"
attempt_id="$3"
expected_authority_digest="$4"
expected_transaction_identity="$5"
${TARGET_GUARD}${TARGET_PATH_ASSIGNMENTS}${TARGET_CANONICAL_PATH_GUARD}${TARGET_MOUNT_GUARD}${TARGET_ANCESTOR_GUARD}${TARGET_DYNAMIC_MOUNT_GUARD}${TARGET_HEADROOM_GUARD}
if [ ! -f "$operation_lock" ] || [ -L "$operation_lock" ] || \
   [ "$(stat -c '%u:%g:%a' "$operation_lock" 2>/dev/null || true)" != 0:0:600 ]; then exit 84; fi
${TARGET_OPERATION_LOCK_GUARD}
${TARGET_CONTROLLER_LEASE_HELD_GUARD}
${TARGET_CLAIM_GUARD}
${TARGET_JOURNAL_LIBRARY}
runtime_journal_append receive_intent
if [ ! -d "$incoming_root" ] || [ -L "$incoming_root" ] || \
   [ "$(stat -c '%u:%g:%a' "$incoming_root" 2>/dev/null || true)" != 0:0:700 ]; then exit 85; fi
runtime_headroom /opt "$maximum_archive_bytes" "$((expected_entry_count + 1024))"
printf '%s\n' "$$" > "$control_dir/receiver.pid.tmp"
chmod 0600 "$control_dir/receiver.pid.tmp"
mv -- "$control_dir/receiver.pid.tmp" "$control_dir/receiver.pid"
set -o pipefail
zstd -dc | python3 "$control_dir/extract.py" "$incoming_root/payload" \
  "$expected_entry_count" "$expected_bytes" "$maximum_archive_bytes"
sync -f "$incoming_root"
runtime_journal_append received
COMIS_RUNTIME_RECEIVER
chmod 0700 "$control_dir/receive.sh"
sync -f "$control_dir"
runtime_journal_append prepared
trap - EXIT HUP INT TERM
`}`;
}

function probeFunction(): string {
  return String.raw`probe_tree() {
  bash -s -- "$1" <<'COMIS_RUNTIME_TREE_TARGET_PROBE'
${buildRuntimeTreeProbeScript()}
COMIS_RUNTIME_TREE_TARGET_PROBE
}
`;
}

function factsVerification(rootVariable: string): string {
  return String.raw`facts="$(probe_tree "${rootVariable}")"
expected_facts="${RUNTIME_TREE_FACTS_BEGIN}
digestSha256=$expected_digest
entryCount=$expected_entry_count
bytes=$expected_bytes
root=${rootVariable}
version=$expected_version
${RUNTIME_TREE_FACTS_END}"
if [ "$facts" != "$expected_facts" ]; then exit 86; fi
`;
}

function buildTargetVerifyScript(): string {
  return String.raw`set -euo pipefail
${targetVariablePrelude()}${TARGET_GUARD}${TARGET_PATH_ASSIGNMENTS}${TARGET_CANONICAL_PATH_GUARD}${TARGET_MOUNT_GUARD}${TARGET_ANCESTOR_GUARD}${TARGET_DYNAMIC_MOUNT_GUARD}${TARGET_HEADROOM_GUARD}
${TARGET_OPERATION_LOCK_GUARD}
${TARGET_CONTROLLER_LEASE_HELD_GUARD}
${TARGET_CLAIM_GUARD}
${TARGET_JOURNAL_LIBRARY}
runtime_journal_append verify_intent
if [ ! -d "$incoming_root/payload" ] || [ -L "$incoming_root/payload" ]; then exit 85; fi
${probeFunction()}${factsVerification("$incoming_root/payload")}
cat > "$incoming_root/payload.attestation" <<COMIS_RUNTIME_PAYLOAD_ATTESTATION
${RUNTIME_VAULT_PAYLOAD_BEGIN}
digestSha256=$expected_digest
entryCount=$expected_entry_count
bytes=$expected_bytes
version=$expected_version
storagePolicy=root_only_read_only_bind_v1
${RUNTIME_VAULT_PAYLOAD_END}
COMIS_RUNTIME_PAYLOAD_ATTESTATION
chmod 0400 "$incoming_root/payload.attestation"
sync -f "$incoming_root/payload.attestation"
sync -f "$incoming_root"
runtime_journal_append verified
printf '%s\n' "$facts"
`;
}

function buildTargetPublishScript(): string {
  return String.raw`set -euo pipefail
${targetVariablePrelude()}${TARGET_GUARD}${TARGET_PATH_ASSIGNMENTS}${TARGET_CANONICAL_PATH_GUARD}${TARGET_MOUNT_GUARD}${TARGET_ANCESTOR_GUARD}${TARGET_DYNAMIC_MOUNT_GUARD}${TARGET_HEADROOM_GUARD}
${TARGET_OPERATION_LOCK_GUARD}
${TARGET_CONTROLLER_LEASE_HELD_GUARD}
${TARGET_CLAIM_GUARD}
${TARGET_JOURNAL_LIBRARY}
if [ ! -d "$incoming_root/payload" ] || [ -L "$incoming_root/payload" ] || \
   [ ! -f "$incoming_root/payload.attestation" ] || \
   [ -L "$incoming_root/payload.attestation" ] || \
   [ "$(stat -c '%u:%g:%a' "$incoming_root/payload.attestation" 2>/dev/null || true)" != 0:0:400 ]; then exit 85; fi
${probeFunction()}${factsVerification("$incoming_root/payload")}
expected_payload_attestation="${RUNTIME_VAULT_PAYLOAD_BEGIN}
digestSha256=$expected_digest
entryCount=$expected_entry_count
bytes=$expected_bytes
version=$expected_version
storagePolicy=root_only_read_only_bind_v1
${RUNTIME_VAULT_PAYLOAD_END}"
if [ "$(cat "$incoming_root/payload.attestation" 2>/dev/null || true)" != \
  "$expected_payload_attestation" ]; then exit 87; fi
runtime_journal_append publish_intent
runtime_headroom /opt 134217728 1024
sync -f "$incoming_root"
sync -f "$vault_root"
python3 - "$incoming_root" "$final_root" <<'COMIS_RUNTIME_PUBLISH'
import ctypes
import errno
import os
import sys

AT_FDCWD = -100
RENAME_NOREPLACE = 1
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = getattr(libc, "renameat2", None)
if renameat2 is None:
    raise SystemExit(2)
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
result = renameat2(AT_FDCWD, os.fsencode(sys.argv[1]), AT_FDCWD, os.fsencode(sys.argv[2]), RENAME_NOREPLACE)
if result != 0:
    error = ctypes.get_errno()
    raise SystemExit(17 if error == errno.EEXIST else 2)
COMIS_RUNTIME_PUBLISH
sync -f "$final_root"
sync -f "$vault_root"
runtime_journal_append published
rm -rf -- "$control_dir"
sync -f "$coordination_root"
rm -f -- "$active_capture" "$identity_path"
sync -f "$coordination_root"
runtime_journal_append cleanup_complete
printf '%s\n' published
`;
}

function buildTargetRollbackScript(
  leaseMode: "held" | "acquire",
): string {
  const controllerGuard =
    leaseMode === "held"
      ? TARGET_CONTROLLER_LEASE_HELD_GUARD
      : TARGET_CONTROLLER_LEASE_ACQUIRE_GUARD;
  return String.raw`set -euo pipefail
${targetVariablePrelude()}${TARGET_GUARD}${TARGET_PATH_ASSIGNMENTS}${TARGET_CANONICAL_PATH_GUARD}${TARGET_MOUNT_GUARD}${TARGET_ANCESTOR_GUARD}${TARGET_DYNAMIC_MOUNT_GUARD}
${controllerGuard}
if [ ! -e "$operation_lock" ] && [ ! -L "$operation_lock" ]; then
  if [ -e "$final_root" ] || [ -L "$final_root" ] || \
     [ -e "$transaction_dir" ] || [ -L "$transaction_dir" ] || \
     [ -e "$identity_path" ] || [ -L "$identity_path" ] || \
     [ -e "$identity_incoming" ] || [ -L "$identity_incoming" ] || \
     [ -e "$active_capture" ] || [ -L "$active_capture" ] || \
     [ -e "$control_dir" ] || [ -L "$control_dir" ] || \
     [ -e "$incoming_root" ] || [ -L "$incoming_root" ]; then exit 84; fi
  exit 0
fi
${TARGET_OPERATION_LOCK_GUARD}
${probeFunction()}${TARGET_RECOVERY_FINAL_GUARD}
if [ -e "$final_root" ] || [ -L "$final_root" ]; then exit 91; fi
if [ ! -e "$identity_path" ] && [ ! -L "$identity_path" ] && \
   [ ! -e "$identity_incoming" ] && [ ! -L "$identity_incoming" ] && \
   [ ! -e "$active_capture" ] && [ ! -L "$active_capture" ] && \
   [ ! -e "$control_dir" ] && [ ! -L "$control_dir" ] && \
   [ ! -e "$incoming_root" ] && [ ! -L "$incoming_root" ] && \
   [ ! -e "$transaction_dir" ] && [ ! -L "$transaction_dir" ]; then exit 0; fi
if [ ! -d "$transaction_dir" ] || [ -L "$transaction_dir" ]; then exit 84; fi
${TARGET_JOURNAL_LIBRARY}
runtime_journal_append rollback_intent
${TARGET_PARTIAL_CLAIM_GUARD}
rm -rf -- "$incoming_root" "$control_dir"
sync -f "$vault_root"
sync -f "$coordination_root"
rm -f -- "$identity_incoming" "$active_capture" "$identity_path"
sync -f "$coordination_root"
runtime_journal_append rolled_back
`;
}

function buildTargetTransactionStatusScript(): string {
  const observation = buildProductionRuntimeVaultTransactionObservationProgram();
  return String.raw`set -euo pipefail
${targetVariablePrelude()}${TARGET_GUARD}${TARGET_PATH_ASSIGNMENTS}${TARGET_CANONICAL_PATH_GUARD}${TARGET_MOUNT_GUARD}${TARGET_ANCESTOR_GUARD}${TARGET_DYNAMIC_MOUNT_GUARD}
${TARGET_CONTROLLER_LEASE_HELD_GUARD}
if [ -e "$operation_lock" ] || [ -L "$operation_lock" ]; then
${TARGET_OPERATION_LOCK_GUARD}
fi
${probeFunction()}
final_state=absent
if [ -e "$final_root" ] || [ -L "$final_root" ]; then
  if (
${TARGET_RECOVERY_FINAL_GUARD}
  ); then
    final_state=exact
  else
    final_state=conflict
  fi
fi
bash -s -- "$transaction_parent" "$transaction_dir" \
  "$expected_authority_digest" "$expected_transaction_identity" "$final_state" \
  <<'COMIS_RUNTIME_TRANSACTION_OBSERVATION_PROGRAM'
${observation}COMIS_RUNTIME_TRANSACTION_OBSERVATION_PROGRAM
`;
}

function buildTargetFinishPublishScript(): string {
  return String.raw`set -euo pipefail
${targetVariablePrelude()}${TARGET_GUARD}${TARGET_PATH_ASSIGNMENTS}${TARGET_CANONICAL_PATH_GUARD}${TARGET_MOUNT_GUARD}${TARGET_ANCESTOR_GUARD}${TARGET_DYNAMIC_MOUNT_GUARD}
${TARGET_CONTROLLER_LEASE_HELD_GUARD}
${TARGET_OPERATION_LOCK_GUARD}
${probeFunction()}${TARGET_RECOVERY_FINAL_GUARD}
if [ ! -d "$final_root" ] || [ -L "$final_root" ]; then exit 91; fi
${TARGET_PARTIAL_CLAIM_GUARD}
${TARGET_JOURNAL_LIBRARY}
runtime_journal_append published
rm -rf -- "$control_dir"
sync -f "$coordination_root"
rm -f -- "$identity_incoming" "$active_capture" "$identity_path"
sync -f "$coordination_root"
runtime_journal_append cleanup_complete
printf '%s\n' published_recovered
`;
}

function buildVaultStatusScript(): string {
  const probe = probeFunction();
  return String.raw`set -euo pipefail
expected_machine="$1"
service="$2"
target_data="$3"
expected_digest="$4"
${TARGET_GUARD}
vault_base=/opt/comis-replay
vault_parent="$vault_base/runtimes"
vault_root="$vault_parent/sha256"
final_root="$vault_root/$expected_digest"
payload_path="$final_root/payload"
coordination_parent=/var/lib/comis-self-driving
coordination_root="$coordination_parent/runtime-vault"
transaction_parent="$coordination_root/transactions"
${TARGET_ANCESTOR_GUARD}${TARGET_FINAL_MOUNT_GUARD}
if [ ! -e "$final_root" ] && [ ! -L "$final_root" ]; then
  printf '%s\n' '${RUNTIME_VAULT_STATUS_BEGIN}' 'state=absent' '${RUNTIME_VAULT_STATUS_END}'
  exit 0
fi
if [ ! -d "$final_root" ] || [ -L "$final_root" ] || \
   [ "$(stat -c '%u:%g:%a' "$final_root" 2>/dev/null || true)" != 0:0:700 ] || \
   [ ! -d "$payload_path" ] || [ -L "$payload_path" ] || \
   [ ! -f "$final_root/payload.attestation" ] || [ -L "$final_root/payload.attestation" ] || \
   [ "$(stat -c '%u:%g:%a:%h' "$final_root/payload.attestation" 2>/dev/null || true)" != 0:0:400:1 ] || \
   [ "$(stat -c '%s' "$final_root/payload.attestation" 2>/dev/null || true)" -gt 512 ]; then exit 88; fi
python3 - "$final_root" "$payload_path" "$final_root/payload.attestation" \
  <<'COMIS_RUNTIME_STRICT_FINAL_INVENTORY'
import os
import stat
import sys

final_root, payload_path, attestation_path = sys.argv[1:]
if set(os.listdir(final_root)) != {"payload", "payload.attestation"}:
    raise SystemExit("unexpected runtime vault root inventory")
for path in (final_root, attestation_path):
    value = os.lstat(path)
    if stat.S_ISLNK(value.st_mode) or value.st_uid != 0 or value.st_gid != 0:
        raise SystemExit(1)
payload = os.lstat(payload_path)
if not stat.S_ISDIR(payload.st_mode) or stat.S_ISLNK(payload.st_mode):
    raise SystemExit(1)
for path in (final_root, payload_path, attestation_path):
    if os.listxattr(path, follow_symlinks=False):
        raise SystemExit(1)
if os.lstat(attestation_path).st_nlink != 1:
    raise SystemExit(1)
COMIS_RUNTIME_STRICT_FINAL_INVENTORY
${probe}
facts="$(probe_tree "$payload_path")"
digest="$(printf '%s\n' "$facts" | sed -n 's/^digestSha256=//p')"
entry_count="$(printf '%s\n' "$facts" | sed -n 's/^entryCount=//p')"
bytes="$(printf '%s\n' "$facts" | sed -n 's/^bytes=//p')"
version="$(printf '%s\n' "$facts" | sed -n 's/^version=//p')"
root="$(printf '%s\n' "$facts" | sed -n 's/^root=//p')"
if [ "$digest" != "$expected_digest" ] || [ "$root" != "$payload_path" ]; then exit 88; fi
expected_payload_attestation="${RUNTIME_VAULT_PAYLOAD_BEGIN}
digestSha256=$digest
entryCount=$entry_count
bytes=$bytes
version=$version
storagePolicy=root_only_read_only_bind_v1
${RUNTIME_VAULT_PAYLOAD_END}"
if [ "$(cat "$final_root/payload.attestation" 2>/dev/null || true)" != \
  "$expected_payload_attestation" ]; then exit 88; fi
printf '%s\n' '${RUNTIME_VAULT_STATUS_BEGIN}' 'state=present' \
  "digestSha256=$digest" "entryCount=$entry_count" "bytes=$bytes" \
  "root=$root" "version=$version" '${RUNTIME_VAULT_STATUS_END}'
`;
}

export function buildProductionRuntimeVaultPlanBase(
  request: ProductionRuntimeVaultPlanBaseRequest,
): Result<ProductionRuntimeVaultPlanBase, ProductionRuntimeVaultPlanError> {
  if (!SAFE_RUN_ID_RE.test(request.runId)) {
    return invalid("invalid_request", "runId", "Runtime vault run ID contains unsafe characters");
  }
  if (!ATTEMPT_ID_RE.test(request.attemptId)) {
    return invalid(
      "invalid_request",
      "attemptId",
      "Runtime vault attempt ID is malformed",
    );
  }
  if (!isSafePackageRoot(request.sourceRuntime.packageRoot)) {
    return invalid("invalid_request", "sourceRuntime.packageRoot", "Source package root is unsafe");
  }
  if (!isSafePackageRoot(request.targetRuntime.packageRoot)) {
    return invalid("invalid_request", "targetRuntime.packageRoot", "Target package root is unsafe");
  }
  if (pathsOverlap(RUNTIME_VAULT_BASE, request.targetRuntime.packageRoot)) {
    return invalid(
      "precondition",
      "targetRuntime.packageRoot",
      "Runtime vault overlaps the installed target package",
    );
  }
  if (
    request.sourceRuntime.confinementKind !== "source" ||
    request.targetRuntime.confinementKind !== "target_quarantine" ||
    request.targetRuntime.confinementSha256 !== TARGET_REPLAY_QUARANTINE_SHA256
  ) {
    return invalid("precondition", "runtime", "Runtime host roles are not safely attested");
  }
  if (
    request.sourceTree.root !== request.sourceRuntime.packageRoot ||
    request.sourceTree.version !== request.sourceRuntime.version
  ) {
    return invalid("precondition", "sourceTree", "Runtime tree does not bind the source launcher");
  }
  if (
    !SHA256_RE.test(request.sourceTree.digestSha256) ||
    !Number.isSafeInteger(request.sourceTree.entryCount) ||
    request.sourceTree.entryCount < 1 ||
    !Number.isSafeInteger(request.sourceTree.bytes) ||
    request.sourceTree.bytes < 0
  ) {
    return invalid("invalid_request", "sourceTree", "Runtime tree identity is malformed");
  }
  const maximum = maximumStreamBytes(request.sourceTree);
  if (!maximum.ok) return maximum;
  const payloadPath = `${RUNTIME_VAULT_ROOT}/${request.sourceTree.digestSha256}/payload`;
  return ok({
    payloadPath,
    maximumArchiveBytes: maximum.value,
    targetControlDir:
      `/var/lib/comis-self-driving/runtime-vault/capture-${request.runId}-${request.attemptId}`,
    targetIncomingRoot:
      `${RUNTIME_VAULT_ROOT}/.incoming-${request.runId}-${request.attemptId}-${request.sourceTree.digestSha256}`,
    targetTransactionDir:
      `/var/lib/comis-self-driving/runtime-vault/transactions/${request.attemptId}`,
  });
}

export function buildProductionRuntimeVaultPlan(
  request: ProductionRuntimeVaultPlanRequest,
): Result<ProductionRuntimeVaultPlan, ProductionRuntimeVaultPlanError> {
  const base = buildProductionRuntimeVaultPlanBase(request);
  if (!base.ok) return base;
  if (!SHA256_RE.test(request.authorityDigestSha256)) {
    return invalid(
      "invalid_request",
      "authorityDigestSha256",
      "Runtime vault recovery authority digest is malformed",
    );
  }
  const transactionIdentitySha256 =
    computeProductionRuntimeVaultTransactionIdentity([
      request.profile.target.expectedMachineIdSha256,
      request.profile.source.expectedMachineIdSha256,
      request.runId,
      request.attemptId,
      request.authorityDigestSha256,
      request.profile.target.service,
      request.profile.target.dataDir,
      request.targetRuntime.packageRoot,
      request.sourceTree.digestSha256,
      String(request.sourceTree.entryCount),
      String(request.sourceTree.bytes),
      request.sourceTree.version,
      String(base.value.maximumArchiveBytes),
    ]);
  const args = targetArgs(
    request,
    base.value.maximumArchiveBytes,
    transactionIdentitySha256,
  );
  const controlDir = base.value.targetControlDir;
  const readyLine = `COMIS_RUNTIME_VAULT_CONTROLLER_READY_${request.attemptId}`;
  const sourceStdin = buildSourceStreamProgram();
  return ok({
    payloadPath: base.value.payloadPath,
    authorityDigestSha256: request.authorityDigestSha256,
    transactionIdentitySha256,
    controllerLease: {
      label: "runtime-vault-controller",
      host: request.profile.target.ssh,
      ...(request.profile.target.sshPort !== undefined
        ? { port: request.profile.target.sshPort }
        : {}),
      args: rootShellArgs(args),
      remoteProgram: buildTargetControllerLeaseScript(readyLine),
      readyLine,
    },
    targetPrepare: invocation(
      "prepare-runtime-vault-target",
      request.profile.target,
      rootShellArgs(args),
      buildTargetPrepareScript(),
    ),
    stream: {
      label: "stream-runtime-vault",
      maximumBytes: base.value.maximumArchiveBytes,
      sourceStdin,
      source: endpoint(request.profile.source, rootShellArgs([
        request.profile.source.expectedMachineIdSha256,
        request.profile.source.service,
        request.sourceTree.root,
        request.sourceTree.digestSha256,
        String(request.sourceTree.entryCount),
        String(request.sourceTree.bytes),
        request.sourceTree.version,
      ])),
      target: endpoint(request.profile.target, [
        "sudo",
        "bash",
        `${controlDir}/receive.sh`,
        ...args,
      ]),
    },
    targetVerify: invocation(
      "verify-runtime-vault-target",
      request.profile.target,
      rootShellArgs(args),
      buildTargetVerifyScript(),
    ),
    targetPublish: invocation(
      "publish-runtime-vault-target",
      request.profile.target,
      rootShellArgs(args),
      buildTargetPublishScript(),
    ),
    targetRollback: invocation(
      "rollback-runtime-vault-target",
      request.profile.target,
      rootShellArgs(args),
      buildTargetRollbackScript("held"),
    ),
    targetTransactionStatus: invocation(
      "observe-runtime-vault-transaction-target",
      request.profile.target,
      rootShellArgs(args),
      buildTargetTransactionStatusScript(),
    ),
    targetFinishPublish: invocation(
      "finish-runtime-vault-publication-target",
      request.profile.target,
      rootShellArgs(args),
      buildTargetFinishPublishScript(),
    ),
    targetReconcile: invocation(
      "reconcile-runtime-vault-target",
      request.profile.target,
      rootShellArgs(args),
      buildTargetRollbackScript("acquire"),
    ),
  });
}

function statusInvocation(
  request: InspectProductionRuntimeVaultRequest,
): ProductionRemoteInvocation {
  return invocation(
    "runtime-vault-status-target",
    request.profile.target,
    rootShellArgs([
      request.profile.target.expectedMachineIdSha256,
      request.profile.target.service,
      request.profile.target.dataDir,
      request.runtimeDigestSha256,
    ]),
    buildVaultStatusScript(),
  );
}

function parseVaultStatus(
  raw: string,
  runtimeDigestSha256: string,
): Result<ProductionRuntimeVaultStatus, ProductionRuntimeVaultError> {
  if (Buffer.byteLength(raw, "utf8") > MAX_STATUS_BYTES || !raw.endsWith("\n")) {
    return err({
      kind: "attestation_failure",
      stage: "runtime-vault-status-target",
      message: "Runtime vault status envelope is malformed",
    });
  }
  const lines = raw.slice(0, -1).split("\n");
  const payloadPath = `${RUNTIME_VAULT_ROOT}/${runtimeDigestSha256}/payload`;
  if (
    lines.length === 3 &&
    lines[0] === RUNTIME_VAULT_STATUS_BEGIN &&
    lines[1] === "state=absent" &&
    lines[2] === RUNTIME_VAULT_STATUS_END
  ) {
    return ok({ state: "absent", runtimeDigestSha256, payloadPath });
  }
  if (
    lines.length !== 8 ||
    lines[0] !== RUNTIME_VAULT_STATUS_BEGIN ||
    lines[1] !== "state=present" ||
    lines[7] !== RUNTIME_VAULT_STATUS_END
  ) {
    return err({
      kind: "attestation_failure",
      stage: "runtime-vault-status-target",
      message: "Runtime vault status envelope is malformed",
    });
  }
  const treeRaw = [
    RUNTIME_TREE_FACTS_BEGIN,
    ...lines.slice(2, 7),
    RUNTIME_TREE_FACTS_END,
    "",
  ].join("\n");
  const parsed = parseRuntimeTreeFacts(treeRaw);
  if (
    !parsed.ok ||
    parsed.value.digestSha256 !== runtimeDigestSha256 ||
    parsed.value.root !== payloadPath
  ) {
    return err({
      kind: "attestation_failure",
      stage: "runtime-vault-status-target",
      message: "Runtime vault payload identity is invalid",
    });
  }
  return ok({
    state: "present",
    runtimeDigestSha256,
    payloadPath,
    payload: parsed.value,
  });
}

export async function inspectProductionRuntimeVault(
  request: InspectProductionRuntimeVaultRequest,
  executor: ProductionRemoteExecutor,
): Promise<Result<ProductionRuntimeVaultStatus, ProductionRuntimeVaultError>> {
  if (!SHA256_RE.test(request.runtimeDigestSha256)) {
    return invalid("invalid_request", "runtimeDigestSha256", "Runtime digest is malformed");
  }
  const remote = await executor.run(statusInvocation(request));
  if (!remote.ok || remote.value.exitCode !== 0) {
    return err({
      kind: "remote_failure",
      stage: "runtime-vault-status-target",
      message: "Runtime vault status probe failed",
      outcome: remote.ok
        ? { kind: "remote_exit", exitCode: remote.value.exitCode }
        : { kind: "transport_failure" },
    });
  }
  return parseVaultStatus(remote.value.stdout, request.runtimeDigestSha256);
}

async function executeSourceTreeProbe(
  profile: ProductionReplayProfile,
  root: string,
  executor: ProductionRemoteExecutor,
): Promise<Result<RuntimeTreeAttestation, ProductionRuntimeVaultError>> {
  const command = invocation(
    "runtime-tree-attest-source",
    profile.source,
    rootShellArgs([root]),
    buildRuntimeTreeProbeScript(),
  );
  const remote = await executor.run(command);
  if (!remote.ok || remote.value.exitCode !== 0) {
    return err({
      kind: "remote_failure",
      stage: command.label,
      message: "Source runtime tree probe failed",
      outcome: remote.ok
        ? { kind: "remote_exit", exitCode: remote.value.exitCode }
        : { kind: "transport_failure" },
    });
  }
  const parsed = parseRuntimeTreeFacts(remote.value.stdout);
  if (!parsed.ok || parsed.value.root !== root) {
    return err({
      kind: "attestation_failure",
      stage: command.label,
      message: "Source runtime tree facts are invalid",
    });
  }
  return parsed;
}

async function runStage(
  executor: ProductionRemoteExecutor,
  command: ProductionRemoteInvocation,
): Promise<Result<string, ProductionRuntimeVaultRemoteFailure>> {
  const result = await executor.run(command);
  if (!result.ok || result.value.exitCode !== 0) {
    return err({
      kind: "remote_failure",
      stage: command.label,
      message: `Runtime vault stage ${command.label} failed`,
      outcome: result.ok
        ? { kind: "remote_exit", exitCode: result.value.exitCode }
        : { kind: "transport_failure" },
    });
  }
  return ok(result.value.stdout);
}

async function observeTargetTransaction(
  request: ReconcileProductionRuntimeVaultTargetRequest,
): Promise<
  Result<ProductionRuntimeVaultTransactionDisposition, ProductionRuntimeVaultError>
> {
  const observed = await runStage(
    request.executor,
    request.plan.targetTransactionStatus,
  );
  if (!observed.ok) return observed;
  const parsed = parseProductionRuntimeVaultTransactionObservation(
    observed.value,
    request.plan.authorityDigestSha256,
    request.plan.transactionIdentitySha256,
  );
  if (!parsed.ok) {
    return err({
      kind: "attestation_failure",
      stage: "parse-runtime-vault-transaction",
      message: "Runtime vault transaction observation is malformed",
    });
  }
  const classified = classifyProductionRuntimeVaultTransaction(parsed.value);
  if (!classified.ok) {
    return err({
      kind: "attestation_failure",
      stage: "classify-runtime-vault-transaction",
      message: "Runtime vault transaction cannot be recovered safely",
    });
  }
  return classified;
}

function terminalReconciliationReport(
  disposition: ProductionRuntimeVaultTransactionDisposition,
): Result<
  ProductionRuntimeVaultTargetReconciliationReport,
  ProductionRuntimeVaultError
> {
  switch (disposition.disposition) {
    case "not_started":
      return ok({ disposition: "not_started" });
    case "reused_existing":
      return ok({ disposition: "reused_existing" });
    case "already_rolled_back":
      return ok({ disposition: "rolled_back" });
    case "published_complete":
      return ok({ disposition: "published" });
    case "transaction_active":
    case "published_recovered":
      return err({
        kind: "attestation_failure",
        stage: "verify-runtime-vault-transaction-terminal",
        message: "Runtime vault transaction did not reach a terminal state",
      });
    default: {
      const _exhaustive: never = disposition;
      return _exhaustive;
    }
  }
}

export async function reconcileProductionRuntimeVaultTarget(
  request: ReconcileProductionRuntimeVaultTargetRequest,
): Promise<
  Result<ProductionRuntimeVaultTargetReconciliationReport, ProductionRuntimeVaultError>
> {
  const acquired = await request.leaseClient.acquire(request.plan.controllerLease);
  if (!acquired.ok) {
    return err({
      kind: "lease_failure",
      stage: "acquire-runtime-vault-lease",
      message: "Runtime vault controller lease could not be acquired",
      outcome: acquired.error,
    });
  }

  const primary = await (async (): Promise<
    Result<ProductionRuntimeVaultTargetReconciliationReport, ProductionRuntimeVaultError>
  > => {
    const initial = await observeTargetTransaction(request);
    if (!initial.ok) return initial;
    if (
      initial.value.disposition !== "transaction_active" &&
      initial.value.disposition !== "published_recovered"
    ) {
      return terminalReconciliationReport(initial.value);
    }

    const action =
      initial.value.disposition === "published_recovered"
        ? request.plan.targetFinishPublish
        : request.plan.targetRollback;
    const acted = await runStage(request.executor, action);
    if (!acted.ok) return acted;
    const acknowledgementIsExact =
      initial.value.disposition === "published_recovered"
        ? acted.value === "published_recovered\n"
        : acted.value === "";
    if (!acknowledgementIsExact) {
      return err({
        kind: "attestation_failure",
        stage: action.label,
        message: "Runtime vault recovery acknowledgement is malformed",
      });
    }

    const terminal = await observeTargetTransaction(request);
    if (!terminal.ok) return terminal;
    const report = terminalReconciliationReport(terminal.value);
    if (!report.ok) return report;
    const expected =
      initial.value.disposition === "published_recovered"
        ? "published"
        : "rolled_back";
    if (report.value.disposition !== expected) {
      return err({
        kind: "attestation_failure",
        stage: "verify-runtime-vault-transaction-terminal",
        message: "Runtime vault recovery reached the wrong terminal state",
      });
    }
    return report;
  })();

  const released = await acquired.value.release();
  if (!released.ok) {
    return err({
      kind: "lease_release_failure",
      stage: "release-runtime-vault-lease",
      message: "Runtime vault controller lease could not be released",
      outcome: released.error,
      primary: primary.ok ? null : primary.error,
    });
  }
  return primary;
}

async function rollback(
  executor: ProductionRemoteExecutor,
  plan: ProductionRuntimeVaultPlan,
): Promise<Result<void, ProductionRuntimeVaultRemoteFailure>> {
  const result = await runStage(executor, plan.targetRollback);
  if (!result.ok) {
    if (result.error.kind === "remote_failure") return err(result.error);
    return err({
      kind: "remote_failure",
      stage: plan.targetRollback.label,
      message: "Runtime vault rollback returned an unexpected failure",
      outcome: { kind: "transport_failure" },
    });
  }
  return ok(undefined);
}

async function failAfterRollback(
  executor: ProductionRemoteExecutor,
  plan: ProductionRuntimeVaultPlan,
  failure: ProductionRuntimeVaultPrimaryError,
): Promise<Result<never, ProductionRuntimeVaultError>> {
  const rolledBack = await rollback(executor, plan);
  if (rolledBack.ok) return err(failure);
  return err({
    kind: "rollback_failure",
    stage: "rollback-runtime-vault",
    message: "Runtime vault staging could not be rolled back",
    primary: failure,
    rollback: {
      stage: "rollback-runtime-vault-target",
      outcome: rolledBack.error.outcome,
    },
  });
}

function report(
  disposition: "published" | "reused",
  bytesTransferred: number,
  runId: string,
  profile: ProductionReplayProfile,
  sourceTree: RuntimeTreeAttestation,
): ProductionRuntimeVaultReport {
  const importReceiptDigestSha256 = createHash("sha256")
    .update("comis-runtime-vault-import-receipt-v1\0")
    .update(runId)
    .update("\0")
    .update(profile.source.expectedMachineIdSha256)
    .update("\0")
    .update(profile.target.expectedMachineIdSha256)
    .update("\0")
    .update(sourceTree.digestSha256)
    .digest("hex");
  return {
    disposition,
    bytesTransferred,
    payload: payloadIdentity(sourceTree),
    payloadPath: `${RUNTIME_VAULT_ROOT}/${sourceTree.digestSha256}/payload`,
    importReceiptDigestSha256,
    compatibility: {
      status: "unsupported",
      reason: "no_digest_pinned_adapter",
    },
    sourceConsistency: {
      method: "bounded_double_scan",
      atomicSnapshot: false,
    },
    targetInstallationPreserved: true,
    normalServiceTouched: false,
  };
}

function recoveryReport(
  disposition: ProductionRuntimeVaultRecoveryReport["disposition"],
  sourceTree: RuntimeTreeAttestation,
): ProductionRuntimeVaultRecoveryReport {
  return {
    disposition,
    payload: payloadIdentity(sourceTree),
    payloadPath: `${RUNTIME_VAULT_ROOT}/${sourceTree.digestSha256}/payload`,
    sourceConsistency: {
      method: "bounded_double_scan",
      atomicSnapshot: false,
    },
    targetInstallationPreserved: true,
    normalServiceTouched: false,
  };
}

export async function recoverProductionRuntimeVault(
  request: RecoverProductionRuntimeVaultRequest,
): Promise<Result<ProductionRuntimeVaultRecoveryReport, ProductionRuntimeVaultError>> {
  if (!SAFE_RUN_ID_RE.test(request.runId)) {
    return invalid("invalid_request", "runId", "Runtime vault run ID contains unsafe characters");
  }
  if (!ATTEMPT_ID_RE.test(request.attemptId)) {
    return invalid(
      "invalid_request",
      "attemptId",
      "Runtime vault attempt ID is malformed",
    );
  }
  const before = await inspectRuntimeArtifactAttestations(request.profile, request.executor);
  if (!before.ok) {
    return err({
      kind: "attestation_failure",
      stage: "attest-installed-runtime-before-vault-recovery",
      message: "Installed runtimes could not be attested before recovery",
    });
  }
  const sourceTree = await executeSourceTreeProbe(
    request.profile,
    before.value.source.packageRoot,
    request.executor,
  );
  if (!sourceTree.ok) return sourceTree;
  if (sourceTree.value.version !== before.value.source.version) {
    return err({
      kind: "attestation_failure",
      stage: "bind-source-runtime-tree-for-recovery",
      message: "Source runtime tree does not match its launcher artifact",
    });
  }
  const plan = buildProductionRuntimeVaultPlan({
    runId: request.runId,
    attemptId: request.attemptId,
    authorityDigestSha256: request.authorityDigestSha256,
    profile: request.profile,
    sourceRuntime: before.value.source,
    targetRuntime: before.value.target,
    sourceTree: sourceTree.value,
  });
  if (!plan.ok) return plan;
  const reconciled = await runStage(request.executor, plan.value.targetReconcile);
  if (!reconciled.ok) return reconciled;
  const [after, sourceTreeAfter, finalStatus] = await Promise.all([
    inspectRuntimeArtifactAttestations(request.profile, request.executor),
    executeSourceTreeProbe(request.profile, before.value.source.packageRoot, request.executor),
    inspectProductionRuntimeVault(
      { profile: request.profile, runtimeDigestSha256: sourceTree.value.digestSha256 },
      request.executor,
    ),
  ]);
  if (
    !after.ok ||
    !sourceTreeAfter.ok ||
    !finalStatus.ok ||
    !runtimeArtifactEqual(before.value.source, after.value.source) ||
    !runtimeArtifactEqual(before.value.target, after.value.target) ||
    !compareRuntimeTreeAttestations(sourceTree.value, sourceTreeAfter.value).ok
  ) {
    return err({
      kind: "attestation_failure",
      stage: "verify-runtime-vault-recovery",
      message: "Source or installed target runtime changed during recovery",
    });
  }
  if (finalStatus.value.state === "present") {
    if (!compareRuntimeTreeAttestations(sourceTree.value, finalStatus.value.payload).ok) {
      return err({
        kind: "attestation_failure",
        stage: "verify-runtime-vault-recovery",
        message: "Recovered runtime vault payload conflicts with the source",
      });
    }
    return ok(recoveryReport("published_recovered", sourceTree.value));
  }
  return ok(recoveryReport("staging_rolled_back", sourceTree.value));
}

export async function sealProductionRuntime(
  request: SealProductionRuntimeRequest,
): Promise<Result<ProductionRuntimeVaultReport, ProductionRuntimeVaultError>> {
  if (!SAFE_RUN_ID_RE.test(request.runId)) {
    return invalid("invalid_request", "runId", "Runtime vault run ID contains unsafe characters");
  }
  const before = await inspectRuntimeArtifactAttestations(request.profile, request.executor);
  if (!before.ok) {
    return err({
      kind: "attestation_failure",
      stage: "attest-installed-runtime-before-vault",
      message: "Installed runtimes could not be attested before capture",
    });
  }
  const sourceTree = await executeSourceTreeProbe(
    request.profile,
    before.value.source.packageRoot,
    request.executor,
  );
  if (!sourceTree.ok) return sourceTree;
  if (sourceTree.value.version !== before.value.source.version) {
    return err({
      kind: "attestation_failure",
      stage: "bind-source-runtime-tree",
      message: "Source runtime tree does not match its launcher artifact",
    });
  }
  const initialStatus = await inspectProductionRuntimeVault(
    {
      profile: request.profile,
      runtimeDigestSha256: sourceTree.value.digestSha256,
    },
    request.executor,
  );
  if (!initialStatus.ok) return initialStatus;
  if (initialStatus.value.state === "present") {
    const existing = compareRuntimeTreeAttestations(sourceTree.value, initialStatus.value.payload);
    if (!existing.ok) {
      return err({
        kind: "attestation_failure",
        stage: "reuse-runtime-vault",
        message: "Existing runtime vault payload conflicts with the source",
      });
    }
    const [after, sourceTreeAfter, finalStatus] = await Promise.all([
      inspectRuntimeArtifactAttestations(request.profile, request.executor),
      executeSourceTreeProbe(request.profile, before.value.source.packageRoot, request.executor),
      inspectProductionRuntimeVault(
        { profile: request.profile, runtimeDigestSha256: sourceTree.value.digestSha256 },
        request.executor,
      ),
    ]);
    if (
      !after.ok ||
      !sourceTreeAfter.ok ||
      !finalStatus.ok ||
      finalStatus.value.state !== "present" ||
      !runtimeArtifactEqual(before.value.source, after.value.source) ||
      !runtimeArtifactEqual(before.value.target, after.value.target) ||
      !compareRuntimeTreeAttestations(sourceTree.value, sourceTreeAfter.value).ok ||
      !compareRuntimeTreeAttestations(sourceTree.value, finalStatus.value.payload).ok
    ) {
      return err({
        kind: "attestation_failure",
        stage: "verify-runtime-vault-reuse",
        message: "Runtime or target installation changed while validating reuse",
      });
    }
    return ok(report("reused", 0, request.runId, request.profile, sourceTree.value));
  }

  const plan = buildProductionRuntimeVaultPlan({
    runId: request.runId,
    attemptId: request.attemptId,
    authorityDigestSha256: request.authorityDigestSha256,
    profile: request.profile,
    sourceRuntime: before.value.source,
    targetRuntime: before.value.target,
    sourceTree: sourceTree.value,
  });
  if (!plan.ok) return plan;
  const acquired = await request.leaseClient.acquire(plan.value.controllerLease);
  if (!acquired.ok) {
    return err({
      kind: "lease_failure",
      stage: "acquire-runtime-vault-lease",
      message: "Runtime vault controller lease could not be acquired",
      outcome: acquired.error,
    });
  }
  const captured = await (async (): Promise<
    Result<ProductionRuntimeVaultReport, ProductionRuntimeVaultError>
  > => {
    const prepared = await runStage(request.executor, plan.value.targetPrepare);
    if (!prepared.ok) return prepared;
    const transferred = await request.bridge.transfer(plan.value.stream);
    if (!transferred.ok) {
      return failAfterRollback(request.executor, plan.value, {
        kind: "transfer_failure",
        stage: "stream-runtime-vault",
        message: "Runtime vault stream failed",
      });
    }
    const staged = await runStage(request.executor, plan.value.targetVerify);
    if (!staged.ok) return failAfterRollback(request.executor, plan.value, staged.error);
    const stagedFacts = parseRuntimeTreeFacts(staged.value);
    if (
      !stagedFacts.ok ||
      !compareRuntimeTreeAttestations(sourceTree.value, stagedFacts.value).ok
    ) {
      return failAfterRollback(request.executor, plan.value, {
        kind: "attestation_failure",
        stage: "verify-runtime-vault-target",
        message: "Staged runtime payload does not match the source",
      });
    }
    const [after, sourceTreeAfter] = await Promise.all([
      inspectRuntimeArtifactAttestations(request.profile, request.executor),
      executeSourceTreeProbe(request.profile, before.value.source.packageRoot, request.executor),
    ]);
    if (
      !after.ok ||
      !sourceTreeAfter.ok ||
      !runtimeArtifactEqual(before.value.source, after.value.source) ||
      !runtimeArtifactEqual(before.value.target, after.value.target) ||
      !compareRuntimeTreeAttestations(sourceTree.value, sourceTreeAfter.value).ok
    ) {
      return failAfterRollback(request.executor, plan.value, {
        kind: "attestation_failure",
        stage: "verify-runtime-vault-stability",
        message: "Source or target installation changed during runtime capture",
      });
    }
    const published = await runStage(request.executor, plan.value.targetPublish);
    if (!published.ok || published.value !== "published\n") {
      return failAfterRollback(
        request.executor,
        plan.value,
        published.ok
          ? {
              kind: "attestation_failure",
              stage: "publish-runtime-vault-target",
              message: "Runtime vault publication acknowledgement is invalid",
            }
          : published.error,
      );
    }
    const finalStatus = await inspectProductionRuntimeVault(
      { profile: request.profile, runtimeDigestSha256: sourceTree.value.digestSha256 },
      request.executor,
    );
    if (
      !finalStatus.ok ||
      finalStatus.value.state !== "present" ||
      !compareRuntimeTreeAttestations(sourceTree.value, finalStatus.value.payload).ok
    ) {
      return err({
        kind: "attestation_failure",
        stage: "attest-published-runtime-vault",
        message: "Published runtime vault payload is not exact",
      });
    }
    return ok(
      report(
        "published",
        transferred.value.bytesTransferred,
        request.runId,
        request.profile,
        sourceTree.value,
      ),
    );
  })();
  const released = await acquired.value.release();
  if (!released.ok) {
    return err({
      kind: "lease_release_failure",
      stage: "release-runtime-vault-lease",
      message: "Runtime vault controller lease could not be released cleanly",
      outcome: released.error,
      primary: captured.ok ? null : captured.error,
    });
  }
  return captured;
}
