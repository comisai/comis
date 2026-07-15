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
  readonly sourceStreamPrepare: ProductionRemoteInvocation;
  readonly targetPrepare: ProductionRemoteInvocation;
  readonly stream: ProductionRestoreStreamPlan;
  readonly targetVerifyAndPromote: ProductionRemoteInvocation;
  readonly targetRollback: ProductionRemoteInvocation;
  readonly targetCommit: ProductionRemoteInvocation;
  readonly sourceCleanup: ProductionRemoteInvocation;
}

export interface ProductionReplayRestoreAttestationExpectation {
  readonly schemaVersion: 1;
  readonly state: "committed";
  readonly dataDirSha256: string;
  readonly snapshotManifestSha256: string;
  readonly restoredDataTreeDigestSha256: string;
  readonly sourceEnvironmentEvidenceIdentitySha256: string;
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

const RESTORE_ATTESTATION_KEYS = [
  "schemaVersion",
  "state",
  "dataDirSha256",
  "snapshotManifestSha256",
  "restoredDataTreeDigestSha256",
  "sourceEnvironmentEvidenceIdentitySha256",
  "effectiveEnvironmentContentSha256",
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
    record["dataDirSha256"],
    record["snapshotManifestSha256"],
    record["restoredDataTreeDigestSha256"],
    record["sourceEnvironmentEvidenceIdentitySha256"],
    record["effectiveEnvironmentContentSha256"],
  ];
  if (
    keys.join("\0") !== expectedKeys.join("\0") ||
    record["schemaVersion"] !== 1 ||
    record["state"] !== "committed" ||
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

export interface PendingProductionRestore {
  readonly state: "awaiting-attestation";
  readonly runId: string;
  readonly targetMachineIdSha256: string;
  readonly manifestSha256: string;
  readonly bytesTransferred: number;
  readonly restoredDataTreeIdentitySha256: string;
  readonly sourceEnvironmentEvidenceIdentitySha256: string;
  readonly targetCommit: ProductionRemoteInvocation;
  readonly targetRollback: ProductionRemoteInvocation;
}

export interface ProductionRestoreCommitAttestation {
  readonly decision: "commit";
  readonly runId: string;
  readonly targetMachineIdSha256: string;
  readonly manifestSha256: string;
  readonly bytesTransferred: number;
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
    };

const SAFE_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SAFE_REMOTE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.@-]*$/u;
const SAFE_REMOTE_PATH_CHARS_RE = /^\/[A-Za-z0-9._/-]+$/u;
const SAFE_SSH_COMPONENT_RE = /^[A-Za-z0-9._-]+$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const ARCHIVE_ENTRY_OVERHEAD_BYTES = 64 * 1024;
const ARCHIVE_FIXED_OVERHEAD_BYTES = 64 * 1024 * 1024;
const MAXIMUM_RESTORE_BYTES = 8 * 1024 * 1024 * 1024 * 1024;
const DATA_DIR_DIGEST_DOMAIN = "comis-replay-data-dir-v1\0";

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

function buildRestoreAttestationExpectation(
  dataDir: string,
  manifest: ProductionSnapshotManifest,
  manifestSha256: string,
): ProductionReplayRestoreAttestationExpectation {
  return {
    schemaVersion: 1,
    state: "committed",
    dataDirSha256: createHash("sha256")
      .update(DATA_DIR_DIGEST_DOMAIN)
      .update(dataDir)
      .digest("hex"),
    snapshotManifestSha256: manifestSha256,
    restoredDataTreeDigestSha256: deriveProductionSnapshotDataTreeIdentity(manifest),
    sourceEnvironmentEvidenceIdentitySha256:
      deriveProductionSnapshotEnvironmentEvidenceIdentity(manifest),
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

const TARGET_GUARD = String.raw`if [ "$(id -u)" -ne 0 ]; then exit 70; fi
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
require_effective_property PrivateMounts yes
require_effective_property ProtectSystem strict
require_effective_property ProtectHome read-only
require_effective_property NoNewPrivileges yes
require_effective_property CapabilityBoundingSet ''
require_effective_property AmbientCapabilities ''
if [ -L /etc/comis ] || [ "$(stat -c '%u:%g' /etc/comis 2>/dev/null || true)" != 0:0 ]; then
  exit 75
fi
case "$run_id" in [A-Za-z0-9]*) ;; *) exit 76 ;; esac
case "$run_id" in *[!A-Za-z0-9_-]*) exit 76 ;; esac
if [ "$(printf '%s' "$run_id" | wc -c | tr -d ' ')" -gt 64 ]; then exit 76; fi
canonical_data_dir="$(realpath -m -- "$data_dir")"
if [ "$canonical_data_dir" != "$data_dir" ] || [ "$data_dir" = / ]; then exit 77; fi
if ! id "$service_user" >/dev/null 2>&1; then exit 78; fi
data_parent="$(dirname -- "$data_dir")"
data_mount="$(findmnt -n -o TARGET --target "$data_parent")"
if [ -z "$data_mount" ]; then exit 79; fi
if [ "$data_mount" = / ]; then
  state_root=/.comis-self-driving
else
  state_root="$data_mount/.comis-self-driving"
fi
control_dir="$state_root/restore-$run_id"
runtime_root=/run/comis-self-driving
runtime_dir="$runtime_root/restore-$run_id"
if [ -L "$state_root" ] || [ -L "$runtime_root" ]; then exit 79; fi
if [ -e "$state_root" ] && \
   { [ ! -d "$state_root" ] || [ "$(stat -c '%u:%g:%a' "$state_root")" != 0:0:700 ]; }; then
  exit 79
fi
if [ -e "$runtime_root" ] && \
   { [ ! -d "$runtime_root" ] || [ "$(stat -c '%u:%g:%a' "$runtime_root")" != 0:0:700 ]; }; then
  exit 79
fi
if [ -e "$control_dir" ] && \
   { [ ! -d "$control_dir" ] || [ "$(stat -c '%u:%g:%a' "$control_dir")" != 0:0:700 ]; }; then
  exit 79
fi
archive="$control_dir/snapshot.tar"
extract_dir="$control_dir/extracted"
transaction_marker="$control_dir/transaction-owned"
expected_manifest="$control_dir/expected-manifest.json"
source_env_copy="$control_dir/source-env.original"
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
  return String.raw`set -euo pipefail
expected_machine="$1"
data_dir="$2"
run_id="$3"
service="$4"
service_user="$5"
maximum_bytes="$6"
exec 1>/dev/null
${TARGET_GUARD}
case "$maximum_bytes" in ''|*[!0-9]*) exit 80 ;; esac
if [ "$maximum_bytes" -le 0 ] || [ "$maximum_bytes" -gt ${String(MAXIMUM_RESTORE_BYTES)} ]; then
  exit 80
fi
if [ ! -d "$data_dir" ] || [ -L "$data_dir" ] || [ ! -f "$env_path" ] || \
   [ -L "$env_path" ]; then exit 81; fi
for required_command in python3 tar base64 chattr lsattr cmp; do
  if ! command -v "$required_command" >/dev/null 2>&1; then exit 82; fi
done
if [ -e "$control_dir" ] || [ -L "$control_dir" ] || \
   [ -e "$runtime_dir" ] || [ -L "$runtime_dir" ] || \
   [ -e "$incoming_data" ] || [ -L "$incoming_data" ] || \
   [ -e "$env_incoming" ] || [ -e "$env_rollback" ] || \
   [ -e "$overlay_incoming" ] || [ -e "$overlay_rollback" ] || \
   [ -e "$seal_incoming" ] || [ -e "$seal_rollback" ]; then exit 83; fi
created=0
cleanup_prepare() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [ "$created" -eq 1 ]; then
    rm -rf -- "$runtime_dir" "$control_dir" "$incoming_data"
    rm -f -- "$env_incoming" "$overlay_incoming" "$seal_incoming"
  fi
  exit "$rc"
}
trap cleanup_prepare EXIT HUP INT TERM
install -d -m 0700 -o root -g root "$state_root" "$control_dir" "$extract_dir"
install -d -m 0700 -o root -g root "$runtime_root" "$runtime_dir"
created=1
if [ "$(stat -c '%u:%g:%a' "$state_root")" != 0:0:700 ] || \
   [ "$(stat -c '%u:%g:%a' "$control_dir")" != 0:0:700 ] || \
   [ "$(stat -c '%d' "$control_dir")" != "$(stat -c '%d' "$data_parent")" ] || \
   [ "$(stat -c '%d' "$control_dir")" != "$(stat -c '%d' "$data_dir")" ]; then
  exit 84
fi
printf '%s\n' "$run_id" > "$transaction_marker"
chmod 0400 "$transaction_marker"
available_bytes="$(df -PB1 "$control_dir" | awk 'NR == 2 {print $4}')"
required_bytes=$(( maximum_bytes + 67108864 ))
if [ "$available_bytes" -lt "$required_bytes" ]; then exit 85; fi
printf '%s' '${manifestBase64}' | base64 --decode > "$expected_manifest"
printf '%s' '${overlayBase64}' | base64 --decode > "$control_dir/replay-overlay.yaml"
chmod 0400 "$expected_manifest" "$control_dir/replay-overlay.yaml"
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
if [ ! -f "$transaction_marker" ] || [ -L "$transaction_marker" ] || \
   [ "$(stat -c '%u:%g:%a' "$transaction_marker" 2>/dev/null || true)" != 0:0:400 ] || \
   [ "$(cat "$transaction_marker" 2>/dev/null || true)" != "$run_id" ] || \
   [ ! -f "$archive" ] || [ -L "$archive" ] || \
   [ "$(stat -c '%u:%g:%a' "$archive" 2>/dev/null || true)" != 0:0:600 ] || \
   [ ! -f "$expected_manifest" ] || [ -L "$expected_manifest" ]; then exit 89; fi
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
    for database in databases:
        uri = "file:" + quote(database, safe="/") + "?mode=ro"
        connection = sqlite3.connect(uri, uri=True)
        try:
            quick = connection.execute("PRAGMA quick_check").fetchall()
            integrity = connection.execute("PRAGMA integrity_check").fetchall()
            foreign_keys = connection.execute("PRAGMA foreign_key_check").fetchall()
            if quick != [("ok",)] or integrity != [("ok",)] or foreign_keys:
                fail(94)
        finally:
            connection.close()
        shared_memory = database + "-shm"
        if os.path.exists(shared_memory):
            os.unlink(shared_memory)
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

rollback_promote() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [ -e "$rollback_data" ] && [ ! -L "$rollback_data" ]; then
    rm -rf -- "$data_dir"
    mv -- "$rollback_data" "$data_dir"
  fi
  if [ -e "$env_rollback" ] && [ ! -L "$env_rollback" ]; then
    rm -f -- "$env_path"
    mv -- "$env_rollback" "$env_path"
  fi
  if [ -e "$overlay_rollback" ] && [ ! -L "$overlay_rollback" ]; then
    rm -f -- "$overlay_path"
    mv -- "$overlay_rollback" "$overlay_path"
  elif [ "$(cat "$control_dir/overlay-existed" 2>/dev/null || true)" = false ]; then
    rm -f -- "$overlay_path"
  fi
  if [ -e "$seal_rollback" ] && [ ! -L "$seal_rollback" ]; then
    rm -f -- "$seal_path"
    mv -- "$seal_rollback" "$seal_path"
  elif [ "$(cat "$control_dir/seal-existed" 2>/dev/null || true)" = false ]; then
    rm -f -- "$seal_path"
  fi
  rm -rf -- "$incoming_data"
  rm -f -- "$env_incoming" "$overlay_incoming" "$seal_incoming"
  exit "$rc"
}
trap rollback_promote EXIT HUP INT TERM
mv -- "$data_dir" "$rollback_data"
mv -- "$incoming_data" "$data_dir"
mv -- "$env_path" "$env_rollback"
mv -- "$env_incoming" "$env_path"
if [ "$(cat "$control_dir/overlay-existed")" = true ]; then
  mv -- "$overlay_path" "$overlay_rollback"
fi
mv -- "$overlay_incoming" "$overlay_path"
if [ -e "$reattest_script" ] || [ -L "$reattest_script" ]; then exit 95; fi
cat > "$reattest_script" <<'PYTHON_REATTEST'
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys

data_dir, source_env_path, effective_env_path, manifest_path, output_path = sys.argv[1:]

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
    records = []
    inode_targets = {}
    def walk(path, relative):
        record = entry_record(path, relative, identity, inode_targets)
        records.append(record)
        if record["type"] != "directory":
            return
        for child in sorted(os.listdir(path), key=lambda name: name.encode("utf8")):
            walk(os.path.join(path, child), relative + "/" + child)
    walk(data_dir, "data")
    return records

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

    data_dir_identity = hashlib.sha256(
        b"comis-replay-data-dir-v1\0" + data_dir.encode("utf8")
    ).hexdigest()
    attestation = {
        "schemaVersion": 1,
        "state": "committed",
        "dataDirSha256": data_dir_identity,
        "snapshotManifestSha256": hashlib.sha256(manifest_raw).hexdigest(),
        "restoredDataTreeDigestSha256": restored_data_identity,
        "sourceEnvironmentEvidenceIdentitySha256": source_environment_identity,
        "effectiveEnvironmentContentSha256": hash_file(effective_env_path),
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
attestation_path="$control_dir/replay-attestation.json"
python3 "$reattest_script" "$data_dir" "$source_env_copy" "$env_path" \
  "$expected_manifest" "$attestation_path"
install -o root -g root -m 0444 "$attestation_path" "$seal_incoming"
if [ "$(cat "$control_dir/seal-existed")" = true ]; then
  mv -- "$seal_path" "$seal_rollback"
fi
mv -- "$seal_incoming" "$seal_path"
printf '%s\n' installed > "$control_dir/installed"
chmod 0400 "$control_dir/installed"
rm -rf -- "$extract_dir/system"
rm -f -- "$archive"
rm -rf -- "$runtime_dir"
trap - EXIT HUP INT TERM
`;

const TARGET_ROLLBACK_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
data_dir="$2"
run_id="$3"
service="$4"
service_user="$5"
exec 1>/dev/null
${TARGET_GUARD}
if [ ! -f "$transaction_marker" ] || [ -L "$transaction_marker" ] || \
   [ "$(stat -c '%u:%g:%a' "$transaction_marker" 2>/dev/null || true)" != 0:0:400 ] || \
   [ "$(cat "$transaction_marker" 2>/dev/null || true)" != "$run_id" ]; then
  exit 0
fi
committed_rollback="$control_dir/committed-rollback"
if [ -f "$control_dir/committed" ] && [ ! -L "$control_dir/committed" ] && \
   [ -d "$committed_rollback" ] && [ ! -L "$committed_rollback" ]; then
  if [ -e "$committed_rollback/data" ] && [ ! -e "$rollback_data" ]; then
    mv -- "$committed_rollback/data" "$rollback_data"
  fi
  if [ -e "$committed_rollback/env" ] && [ ! -e "$env_rollback" ]; then
    mv -- "$committed_rollback/env" "$env_rollback"
  fi
  if [ -e "$committed_rollback/overlay" ] && [ ! -e "$overlay_rollback" ]; then
    mv -- "$committed_rollback/overlay" "$overlay_rollback"
  fi
  if [ -e "$committed_rollback/seal" ] && [ ! -e "$seal_rollback" ]; then
    mv -- "$committed_rollback/seal" "$seal_rollback"
  fi
  rm -rf -- "$committed_rollback"
  rm -f -- "$control_dir/committed"
fi
if [ -e "$rollback_data" ] && [ ! -L "$rollback_data" ]; then
  rm -rf -- "$data_dir"
  mv -- "$rollback_data" "$data_dir"
fi
if [ -e "$env_rollback" ] && [ ! -L "$env_rollback" ]; then
  rm -f -- "$env_path"
  mv -- "$env_rollback" "$env_path"
fi
if [ -e "$overlay_rollback" ] && [ ! -L "$overlay_rollback" ]; then
  rm -f -- "$overlay_path"
  mv -- "$overlay_rollback" "$overlay_path"
elif [ "$(cat "$control_dir/overlay-existed" 2>/dev/null || true)" = false ]; then
  rm -f -- "$overlay_path"
fi
if [ -e "$seal_rollback" ] && [ ! -L "$seal_rollback" ]; then
  rm -f -- "$seal_path"
  mv -- "$seal_rollback" "$seal_path"
elif [ "$(cat "$control_dir/seal-existed" 2>/dev/null || true)" = false ]; then
  rm -f -- "$seal_path"
fi
if [ -e "$source_env_copy" ] && [ ! -L "$source_env_copy" ]; then
  chattr -i "$source_env_copy" 2>/dev/null || true
fi
rm -rf -- "$incoming_data" "$runtime_dir" "$control_dir"
rm -f -- "$env_incoming" "$overlay_incoming" "$seal_incoming"
`;

const TARGET_COMMIT_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
data_dir="$2"
run_id="$3"
service="$4"
service_user="$5"
exec 1>/dev/null
${TARGET_GUARD}
if [ ! -f "$transaction_marker" ] || [ -L "$transaction_marker" ] || \
   [ "$(stat -c '%u:%g:%a' "$transaction_marker" 2>/dev/null || true)" != 0:0:400 ] || \
   [ "$(cat "$transaction_marker" 2>/dev/null || true)" != "$run_id" ] || \
   [ ! -f "$control_dir/installed" ] || [ -L "$control_dir/installed" ] || \
   [ ! -d "$data_dir" ] || [ ! -e "$rollback_data" ] || \
   [ ! -f "$source_env_copy" ] || [ -L "$source_env_copy" ] || \
   [ ! -f "$reattest_script" ] || [ -L "$reattest_script" ] || \
   [ "$(stat -c '%u:%g:%a' "$reattest_script" 2>/dev/null || true)" != 0:0:500 ] || \
   [ ! -f "$seal_path" ] || [ -L "$seal_path" ] || \
   [ "$(stat -c '%u:%g:%a' "$seal_path" 2>/dev/null || true)" != 0:0:444 ]; then exit 96; fi
commit_attestation="$control_dir/commit-attestation.json"
if [ -e "$commit_attestation" ] || [ -L "$commit_attestation" ]; then exit 96; fi
python3 "$reattest_script" "$data_dir" "$source_env_copy" "$env_path" \
  "$expected_manifest" "$commit_attestation"
if ! cmp -s -- "$commit_attestation" "$seal_path"; then exit 96; fi
rm -f -- "$commit_attestation"
committed_rollback="$control_dir/committed-rollback"
if [ -e "$committed_rollback" ] || [ -L "$committed_rollback" ] || \
   [ -e "$control_dir/committed" ]; then exit 97; fi
install -d -m 0700 -o root -g root "$committed_rollback"
commit_data_moved=0
commit_env_moved=0
commit_overlay_moved=0
commit_seal_moved=0
rollback_commit() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [ "$commit_overlay_moved" -eq 1 ]; then
    mv -- "$committed_rollback/overlay" "$overlay_rollback"
  fi
  if [ "$commit_env_moved" -eq 1 ]; then
    mv -- "$committed_rollback/env" "$env_rollback"
  fi
  if [ "$commit_data_moved" -eq 1 ]; then
    mv -- "$committed_rollback/data" "$rollback_data"
  fi
  if [ "$commit_seal_moved" -eq 1 ]; then
    mv -- "$committed_rollback/seal" "$seal_rollback"
  fi
  rm -rf -- "$committed_rollback"
  rm -f -- "$control_dir/committed.tmp" "$control_dir/committed"
  exit "$rc"
}
trap rollback_commit EXIT HUP INT TERM
mv -- "$rollback_data" "$committed_rollback/data"
commit_data_moved=1
if [ -e "$env_rollback" ]; then
  mv -- "$env_rollback" "$committed_rollback/env"
  commit_env_moved=1
fi
if [ -e "$overlay_rollback" ]; then
  mv -- "$overlay_rollback" "$committed_rollback/overlay"
  commit_overlay_moved=1
fi
if [ -e "$seal_rollback" ]; then
  mv -- "$seal_rollback" "$committed_rollback/seal"
  commit_seal_moved=1
fi
printf '%s\n' committed > "$control_dir/committed.tmp"
chmod 0400 "$control_dir/committed.tmp"
mv -- "$control_dir/committed.tmp" "$control_dir/committed"
rm -f -- "$control_dir/installed"
trap - EXIT HUP INT TERM
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
  const manifestSha256 = createHash("sha256").update(request.manifestJson).digest("hex");
  const restoreAttestationExpectation = buildRestoreAttestationExpectation(
    request.profile.target.dataDir,
    validated.value.manifest,
    manifestSha256,
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
      ["sudo", "bash", "-s", "--", ...targetBaseArgs, String(maximumBytes.value)],
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
    sourceCleanup,
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
        if (!promoted.ok) primaryError = promoted.error;
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
    targetCommit: plan.targetCommit,
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
    attestation.bytesTransferred === pending.bytesTransferred
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
  if (!committed.ok) {
    const rolledBack = await rollbackAfterFault(executor, pending.targetRollback);
    if (!rolledBack.ok) return rolledBack;
    return committed;
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
