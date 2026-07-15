// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

import { err, fromPromise, ok, type Result } from "@comis/shared";

import type {
  BinarySshEndpoint,
  ProductionBinarySshBridge,
} from "./production-binary-ssh.js";
import type {
  ProductionRemoteExecutor,
  ProductionRemoteInvocation,
  ProductionRemoteResult,
} from "./production-bootstrap.js";
import type { ProductionReplayProfile } from "./production-profile.js";
import { buildReplayQuarantineOverlay } from "./production-quarantine.js";
import {
  buildProductionSnapshotPlan,
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
  readonly restoreAttestation: ProductionReplayRestoreAttestation;
  readonly sourceStreamPrepare: ProductionRemoteInvocation;
  readonly targetPrepare: ProductionRemoteInvocation;
  readonly stream: ProductionRestoreStreamPlan;
  readonly targetVerifyAndPromote: ProductionRemoteInvocation;
  readonly targetRollback: ProductionRemoteInvocation;
  readonly targetCommit: ProductionRemoteInvocation;
  readonly sourceCleanup: ProductionRemoteInvocation;
}

export interface ProductionReplayRestoreAttestation {
  readonly schemaVersion: 1;
  readonly state: "committed";
  readonly dataDirSha256: string;
  readonly snapshotManifestSha256: string;
  readonly restoredTreeDigestSha256: string;
  readonly entryCount: number;
  readonly bytes: number;
}

export interface PendingProductionRestore {
  readonly state: "awaiting-attestation";
  readonly runId: string;
  readonly targetMachineIdSha256: string;
  readonly manifestSha256: string;
  readonly bytesTransferred: number;
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
const RESTORED_TREE_DIGEST_DOMAIN = "comis-replay-restored-tree-v1\0";

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

function buildRestoredTreeDigest(manifest: ProductionSnapshotManifest): string {
  const digest = createHash("sha256").update(RESTORED_TREE_DIGEST_DOMAIN);
  const entries = [...manifest.entries].sort((left, right) => left.path.localeCompare(right.path));
  for (const entry of entries) {
    digest
      .update(entry.type)
      .update("\0")
      .update(entry.path)
      .update("\0")
      .update(entry.mode)
      .update("\0")
      .update(String(entry.size))
      .update("\0");
    if (entry.type === "file") digest.update(entry.sha256);
    if (entry.type === "symlink") digest.update(entry.linkTarget);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function buildRestoreAttestation(
  dataDir: string,
  manifest: ProductionSnapshotManifest,
  manifestSha256: string,
): ProductionReplayRestoreAttestation {
  return {
    schemaVersion: 1,
    state: "committed",
    dataDirSha256: createHash("sha256")
      .update(DATA_DIR_DIGEST_DOMAIN)
      .update(dataDir)
      .digest("hex"),
    snapshotManifestSha256: manifestSha256,
    restoredTreeDigestSha256: buildRestoredTreeDigest(manifest),
    entryCount: manifest.entries.length,
    bytes: manifest.entries.reduce(
      (total, entry) => total + (entry.type === "file" ? entry.size : 0),
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
   ! grep -Fqx 'IPAddressDeny=any' "$quarantine"; then exit 74; fi
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
            if member.isdev() or member.isfifo() or member.islnk():
                fail()
            if not (member.isfile() or member.isdir() or member.issym()):
                fail()
            if name == "manifest.json":
                if not member.isfile() or member.size != len(expected_raw) or member.mode != 0o600:
                    fail()
                stream = archive.extractfile(member)
                if stream is None or stream.read() != expected_raw:
                    fail()
                continue
            record = records[name]
            actual_type = "file" if member.isfile() else "directory" if member.isdir() else "symlink"
            if actual_type != record["type"] or member.mode != int(record["mode"], 8):
                fail()
            if member.isfile() and member.size != record["size"]:
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
tar --extract --file="$archive" --directory="$extract_dir" --acls --xattrs \
  --numeric-owner --same-owner --same-permissions --delay-directory-restore --no-overwrite-dir
python3 - "$extract_dir" "$expected_manifest" <<'PYTHON_VERIFY'
import hashlib
import json
import os
import sqlite3
import stat
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

try:
    manifest = json.load(open(manifest_path, "r", encoding="utf8"))
    records = {entry["path"]: entry for entry in manifest["entries"]}
    expected_paths = set(records)
    actual_paths = set()

    def walk(relative):
        absolute = os.path.join(root, relative)
        value = os.lstat(absolute)
        actual_paths.add(relative)
        record = records.get(relative)
        if record is None or mode_of(value) != record["mode"]:
            fail()
        if stat.S_ISREG(value.st_mode):
            if record["type"] != "file" or value.st_size != record["size"]:
                fail()
            if file_hash(absolute) != record["sha256"]:
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
        for child in sorted(os.listdir(absolute)):
            walk(relative + "/" + child)

    walk("data")
    walk("system")
    if actual_paths != expected_paths:
        fail()
    excluded_paths = {entry["path"] for entry in manifest["exclusions"]}
    for relative in excluded_paths:
        if os.path.lexists(os.path.join(root, relative)):
            fail()

    databases = []
    for relative in sorted(expected_paths):
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
python3 - "$expected_manifest" "$data_dir" "$manifest_sha256" \
  "$control_dir/replay-attestation.json" <<'PYTHON_ATTESTATION'
import hashlib
import json
import os
import sys

manifest_path, data_dir, manifest_sha256, output_path = sys.argv[1:]

try:
    manifest = json.load(open(manifest_path, "r", encoding="utf8"))
    digest = hashlib.sha256(b"comis-replay-restored-tree-v1\0")
    total_bytes = 0
    for entry in sorted(manifest["entries"], key=lambda item: item["path"]):
        for value in (entry["type"], entry["path"], entry["mode"], str(entry["size"])):
            digest.update(value.encode("utf8"))
            digest.update(b"\0")
        if entry["type"] == "file":
            digest.update(entry["sha256"].encode("utf8"))
            total_bytes += entry["size"]
        elif entry["type"] == "symlink":
            digest.update(entry["linkTarget"].encode("utf8"))
        digest.update(b"\0")
    data_digest = hashlib.sha256(b"comis-replay-data-dir-v1\0" + data_dir.encode("utf8"))
    attestation = {
        "schemaVersion": 1,
        "state": "committed",
        "dataDirSha256": data_digest.hexdigest(),
        "snapshotManifestSha256": manifest_sha256,
        "restoredTreeDigestSha256": digest.hexdigest(),
        "entryCount": len(manifest["entries"]),
        "bytes": total_bytes,
    }
    descriptor = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
    with os.fdopen(descriptor, "w", encoding="utf8") as handle:
        json.dump(attestation, handle, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
except (KeyError, OSError, TypeError, ValueError):
    raise SystemExit(95)
PYTHON_ATTESTATION
source_env="$extract_dir/system/etc/comis/env"
if [ ! -f "$source_env" ] || [ -L "$source_env" ]; then exit 95; fi
cp --archive --no-dereference -- "$source_env" "$source_env_copy"
cmp -s -- "$source_env" "$source_env_copy"
chattr +i "$source_env_copy"
case "$(lsattr -d "$source_env_copy" | awk '{print $1}')" in *i*) ;; *) exit 95 ;; esac
service_group="$(id -gn "$service_user")"
mv -- "$extract_dir/data" "$incoming_data"
chown -hR "$service_user:$service_group" "$incoming_data"
cp --archive --no-dereference -- "$source_env" "$env_incoming"
printf '\n\nCOMIS_CONFIG_PATHS=%s/config.yaml:%s\n' "$data_dir" "$overlay_path" >> "$env_incoming"
chown root:"$service_group" "$env_incoming"
chmod 0640 "$env_incoming"
install -o root -g "$service_group" -m 0640 \
  "$control_dir/replay-overlay.yaml" "$overlay_incoming"
install -o root -g root -m 0444 \
  "$control_dir/replay-attestation.json" "$seal_incoming"

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
   [ ! -f "$seal_path" ] || [ -L "$seal_path" ] || \
   [ "$(stat -c '%u:%g:%a' "$seal_path" 2>/dev/null || true)" != 0:0:444 ]; then exit 96; fi
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
  const restoreAttestation = buildRestoreAttestation(
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
    restoreAttestation,
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
  return ok({ runId: pending.runId, state: "committed" });
}

export async function rollbackProductionRestore(
  pending: PendingProductionRestore,
  executor: ProductionRemoteExecutor,
): Promise<Result<void, ProductionRestoreError>> {
  return rollbackAfterFault(executor, pending.targetRollback);
}
