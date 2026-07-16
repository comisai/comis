// SPDX-License-Identifier: Apache-2.0
import { isAbsolute } from "node:path";
import { createHash, type Hash } from "node:crypto";

import { err, ok, tryCatch, type Result } from "@comis/shared";

export type ProductionSnapshotEntryType = "file" | "directory" | "symlink" | "hardlink";

export type ProductionSnapshotExcludedType =
  | ProductionSnapshotEntryType
  | "socket"
  | "fifo"
  | "character_device"
  | "block_device"
  | "unknown";

export type ProductionSnapshotExclusionReason =
  | "daemon_lock"
  | "sqlite_shm"
  | "runtime_socket"
  | "unsupported_special";

export interface ProductionSnapshotEntry {
  readonly path: string;
  readonly type: ProductionSnapshotEntryType;
  readonly mode: string;
  readonly size: number;
  readonly uid: number;
  readonly gid: number;
  /** Signed decimal nanoseconds since the Unix epoch. */
  readonly mtimeNs: string;
  readonly sha256?: string;
  readonly linkTarget?: string;
  readonly hardlinkTarget?: string;
  readonly aclSha256?: string;
  readonly xattrSha256?: string;
  readonly capabilitySha256?: string;
}

export type ProductionSnapshotMetadataKind = "acl" | "xattr" | "capability";

export type ProductionSnapshotMetadataStatus = "captured" | "unavailable";

export interface ProductionSnapshotMetadataGap {
  readonly kind: ProductionSnapshotMetadataKind;
  readonly reason: "source_tool_unavailable";
}

export interface ProductionSnapshotMetadataIdentity {
  readonly acl: ProductionSnapshotMetadataStatus;
  readonly xattr: ProductionSnapshotMetadataStatus;
  readonly capability: ProductionSnapshotMetadataStatus;
  readonly gaps: readonly ProductionSnapshotMetadataGap[];
}

export interface ProductionSnapshotExclusion {
  readonly path: string;
  readonly type: ProductionSnapshotExcludedType;
  readonly mode: string;
  readonly size: number;
  readonly reason: ProductionSnapshotExclusionReason;
}

export interface ProductionSnapshotManifest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sourceMachineIdSha256: string;
  readonly service: string;
  readonly captureMode: ProductionSnapshotCaptureMode;
  readonly captureStartedAtMs: number;
  readonly captureCompletedAtMs: number;
  readonly freezeDurationMs: number;
  readonly metadataIdentity: ProductionSnapshotMetadataIdentity;
  readonly treeIdentitySha256: string;
  readonly entries: readonly ProductionSnapshotEntry[];
  readonly exclusions: readonly ProductionSnapshotExclusion[];
}

export interface ProductionSnapshotRequest {
  readonly runId: string;
  readonly expectedMachineIdSha256: string;
  readonly service: string;
  readonly dataDir: string;
  readonly captureMode: ProductionSnapshotCaptureMode;
  readonly watchdogSeconds?: number;
}

/** Offline requires an inactive unit; bounded-freeze is the explicit operational-control opt-in. */
export type ProductionSnapshotCaptureMode = "offline" | "bounded-freeze";

export interface ProductionSnapshotRemoteCommand {
  readonly args: readonly string[];
  readonly stdin: string;
  /** Archive stdout is secret-bearing binary transport and must be piped directly to a receiver. */
  readonly stdout: "none" | "archive";
}

export interface ProductionSnapshotPlan {
  readonly captureMode: ProductionSnapshotCaptureMode;
  readonly stageDir: string;
  readonly manifestPath: string;
  readonly prepare: ProductionSnapshotRemoteCommand;
  readonly stream: ProductionSnapshotRemoteCommand;
  readonly cleanup: ProductionSnapshotRemoteCommand;
}

export type ProductionSnapshotError =
  | {
      readonly kind: "invalid_request";
      readonly field: string;
      readonly message: string;
    }
  | {
      readonly kind: "malformed_manifest";
      readonly field: string;
      readonly message: string;
    }
  | {
      readonly kind: "unsafe_manifest_path";
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly kind: "inconsistent_manifest";
      readonly message: string;
    };

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SAFE_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SAFE_SERVICE_RE = /^[A-Za-z_][A-Za-z0-9_.@-]*$/u;
const MODE_RE = /^[0-7]{4}$/u;
const MTIME_NS_RE = /^-?(?:0|[1-9][0-9]{0,29})$/u;
const DEFAULT_WATCHDOG_SECONDS = 60;
const MIN_WATCHDOG_SECONDS = 5;
const MAX_WATCHDOG_SECONDS = 300;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_RECORDS = 2_000_000;
const STAGE_ROOT = "/run/comis-self-driving";
const TREE_IDENTITY_DOMAIN = "comis-snapshot-tree-v1\0";

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function updateIdentityField(hash: Hash, value: string): void {
  hash.update(value).update("\0");
}

/** Canonical content and filesystem-metadata identity shared by capture and restore. */
export function deriveProductionSnapshotTreeIdentity(
  manifest: Pick<ProductionSnapshotManifest, "entries" | "metadataIdentity">,
): string {
  const hash = createHash("sha256").update(TREE_IDENTITY_DOMAIN);
  updateIdentityField(hash, manifest.metadataIdentity.acl);
  updateIdentityField(hash, manifest.metadataIdentity.xattr);
  updateIdentityField(hash, manifest.metadataIdentity.capability);
  for (const gap of [...manifest.metadataIdentity.gaps].sort((left, right) =>
    compareUtf8(left.kind, right.kind),
  )) {
    updateIdentityField(hash, gap.kind);
    updateIdentityField(hash, gap.reason);
  }
  for (const entry of [...manifest.entries].sort((left, right) =>
    compareUtf8(left.path, right.path),
  )) {
    for (const value of [
      entry.path,
      entry.type,
      entry.mode,
      String(entry.size),
      String(entry.uid),
      String(entry.gid),
      entry.mtimeNs ?? "",
      entry.sha256 ?? "",
      entry.linkTarget ?? "",
      entry.hardlinkTarget ?? "",
      entry.aclSha256 ?? "",
      entry.xattrSha256 ?? "",
      entry.capabilitySha256 ?? "",
    ]) {
      updateIdentityField(hash, value);
    }
  }
  return hash.digest("hex");
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

const PREPARE_TEMPLATE = String.raw`set -euo pipefail
expected_machine="$1"
service="$2"
data_dir="$3"
run_id="$4"
capture_mode="$5"
watchdog_seconds="$6"
exec 1>/dev/null

case "$service" in
  *.service) unit="$service" ;;
  *) unit="$service.service" ;;
esac

case "$run_id" in
  [A-Za-z0-9]*) ;;
  *) printf '%s\n' 'snapshot run ID is unsafe' >&2; exit 68 ;;
esac
case "$run_id" in
  *[!A-Za-z0-9_-]*) printf '%s\n' 'snapshot run ID is unsafe' >&2; exit 68 ;;
esac
run_id_length="$(printf '%s' "$run_id" | wc -c | tr -d ' ')"
if [ "$run_id_length" -gt 64 ]; then
  printf '%s\n' 'snapshot run ID is unsafe' >&2
  exit 68
fi
case "$service" in
  [A-Za-z_]* ) ;;
  *) printf '%s\n' 'snapshot service name is unsafe' >&2; exit 69 ;;
esac
case "$service" in
  *[!A-Za-z0-9_.@-]*) printf '%s\n' 'snapshot service name is unsafe' >&2; exit 69 ;;
esac
canonical_data_dir="$(realpath -m -- "$data_dir")"
if [ "$canonical_data_dir" != "$data_dir" ] || [ "$data_dir" = / ]; then
  printf '%s\n' 'snapshot data path is unsafe' >&2
  exit 70
fi

stage_root=/run/comis-self-driving
stage_dir="$stage_root/$run_id"
tree_dir="$stage_dir/tree"
include_list="$stage_dir/include.nul"
exclusion_list="$stage_dir/exclusions.nul"
manifest="$stage_dir/manifest.json"
builder="$stage_dir/build-manifest.mjs"
watchdog_unit="comis-snapshot-thaw-$run_id"
completed=0
stage_created=0
__CAPTURE_CLEANUP__

actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then
  printf '%s\n' 'source machine identity mismatch' >&2
  exit 71
fi
if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' 'source snapshot requires root' >&2
  exit 72
fi
if [ ! -d "$data_dir" ] || [ -L "$data_dir" ]; then
  printf '%s\n' 'source data directory is unavailable or is a symlink' >&2
  exit 73
fi
if [ "$(stat -c '%a' "$data_dir")" != 700 ]; then
  printf '%s\n' 'source data directory is not private' >&2
  exit 74
fi
if [ ! -f /etc/comis/env ] || [ -L /etc/comis/env ]; then
  printf '%s\n' 'source service environment file is unavailable or is a symlink' >&2
  exit 75
fi
if [ "$(findmnt -n -o FSTYPE --target /run)" != tmpfs ]; then
  printf '%s\n' 'source staging root is not memory-backed tmpfs' >&2
  exit 76
fi
if [ -L "$stage_root" ]; then
  printf '%s\n' 'source staging root is a symlink' >&2
  exit 77
fi
install -d -m 0700 -o root -g root "$stage_root"
if [ -e "$stage_dir" ] || [ -L "$stage_dir" ]; then
  printf '%s\n' 'source snapshot run already exists' >&2
  exit 78
fi
install -d -m 0700 -o root -g root "$stage_dir"
stage_created=1
install -d -m 0700 -o root -g root "$tree_dir" "$tree_dir/data" "$tree_dir/system"

data_bytes="$(du -sb -- "$data_dir" | awk '{print $1}')"
env_bytes="$(stat -c '%s' /etc/comis/env)"
available_bytes="$(df -PB1 /run | awk 'NR == 2 {print $4}')"
required_bytes=$(( data_bytes + env_bytes + 67108864 ))
if [ "$available_bytes" -lt "$required_bytes" ]; then
  printf '%s\n' 'source tmpfs lacks snapshot headroom' >&2
  exit 79
fi

capture_started_ms="$(date +%s%3N)"
__CAPTURE_BEGIN__

if (
  cd -- "$data_dir"
  find -P . \( -name .daemon.lock -o -name '*-shm' \) -type d -print -quit | grep -q .
); then
  printf '%s\n' 'runtime artifact path is unexpectedly a directory' >&2
  exit 87
fi

tree_fingerprint() {
  (
    cd -- "$data_dir"
    find -P . -printf '%P\t%y\t%m\t%U\t%G\t%s\t%T@\t%C@\t%D:%i:%n\0' \
      | LC_ALL=C sort -z \
      | sha256sum \
      | awk '{print $1}'
  )
}
environment_fingerprint() {
  {
    stat -c '%f:%s:%y:%z' /etc/comis/env
    sha256sum /etc/comis/env
  } | sha256sum | awk '{print $1}'
}
tree_fingerprint_before="$(tree_fingerprint)"
environment_fingerprint_before="$(environment_fingerprint)"

(
  cd -- "$data_dir"
  find -P . \( -name .daemon.lock -o -name '*-shm' \) -prune -o \
    \( -type f -o -type d -o -type l \) -print0
) > "$include_list"
chmod 0600 "$include_list"
: > "$exclusion_list"
chmod 0600 "$exclusion_list"

(
  cd -- "$data_dir"
  find -P . \( -name .daemon.lock -o -name '*-shm' -o \
    ! \( -type f -o -type d -o -type l \) \) -print0 \
    | while IFS= read -r -d '' item; do
      rel="$(printf '%s' "$item" | sed 's|^\./||')"
      path="data/$rel"
      name="$(basename -- "$item")"
      if [ -L "$item" ]; then type=symlink
      elif [ -S "$item" ]; then type=socket
      elif [ -p "$item" ]; then type=fifo
      elif [ -c "$item" ]; then type=character_device
      elif [ -b "$item" ]; then type=block_device
      elif [ -d "$item" ]; then type=directory
      elif [ -f "$item" ]; then type=file
      else type=unknown
      fi
      if [ "$name" = .daemon.lock ]; then reason=daemon_lock
      elif case "$name" in *-shm) true ;; *) false ;; esac; then reason=sqlite_shm
      elif [ "$type" = socket ]; then reason=runtime_socket
      else reason=unsupported_special
      fi
      mode="$(stat -c '%a' -- "$item")"
      size="$(stat -c '%s' -- "$item")"
      printf '%s\0%s\0%s\0%s\0%s\0' "$path" "$type" "$mode" "$size" "$reason" >> "$exclusion_list"
    done
)

tar --create --file=- --format=posix --acls --xattrs --xattrs-include='*' --numeric-owner --atime-preserve=system --sparse \
  --no-recursion --null --verbatim-files-from --directory="$data_dir" \
  --files-from="$include_list" \
  | tar --extract --file=- --acls --xattrs --xattrs-include='*' --numeric-owner --same-owner \
      --same-permissions --directory="$tree_dir/data"

tar --create --file=- --format=posix --acls --xattrs --xattrs-include='*' --numeric-owner --atime-preserve=system \
  --directory=/ etc/comis/env \
  | tar --extract --file=- --acls --xattrs --xattrs-include='*' --numeric-owner --same-owner \
      --same-permissions --directory="$tree_dir/system"

tree_fingerprint_after="$(tree_fingerprint)"
environment_fingerprint_after="$(environment_fingerprint)"
if [ "$tree_fingerprint_before" != "$tree_fingerprint_after" ] || \
   [ "$environment_fingerprint_before" != "$environment_fingerprint_after" ]; then
  printf '%s\n' 'source persistent tree changed during capture' >&2
  exit 88
fi

__CAPTURE_END__

capture_completed_ms="$(date +%s%3N)"

cat > "$builder" <<'NODE'
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const [stageDir, runId, machineId, service, captureMode, startedRaw, completedRaw, freezeRaw] = process.argv.slice(2);
if (!stageDir || !runId || !machineId || !service || !captureMode || !startedRaw || !completedRaw || !freezeRaw) {
  throw new Error("manifest builder arguments are incomplete");
}
const treeDir = join(stageDir, "tree");
const exclusionsPath = join(stageDir, "exclusions.nul");
const manifestPath = join(stageDir, "manifest.json");
const manifestTmp = manifestPath + ".tmp";
const controlPattern = /[\u0000-\u001f\u007f]/u;
const emptySha256 = createHash("sha256").update("").digest("hex");

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function safePath(value) {
  if (value.length === 0 || value.startsWith("/") || value.includes("\\") || controlPattern.test(value)) {
    throw new Error("manifest path is unsafe");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("manifest path has an unsafe segment");
  }
  return value;
}

function hashFile(path) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, "r");
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function modeOf(stat) {
  return Number(stat.mode & 0o7777n).toString(8).padStart(4, "0");
}

function safeNumber(value, field) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(field + " is unsafe");
  return result;
}

function safeLinkTarget(entryPath, target) {
  if (
    target.length === 0 ||
    target.startsWith("/") ||
    target.includes("\\") ||
    controlPattern.test(target)
  ) {
    throw new Error("symlink target is unsafe for the manifest");
  }
  const resolved = entryPath.split("/").slice(0, -1);
  const rootDepth = 1;
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") {
      if (segment === "") throw new Error("symlink target is unsafe for the manifest");
      continue;
    }
    if (segment === "..") {
      if (resolved.length <= rootDepth) {
        throw new Error("symlink target escapes its restorable root");
      }
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return target;
}

function commandAvailable(name) {
  const checked = spawnSync("/bin/sh", ["-c", "command -v " + name + " >/dev/null 2>&1"]);
  return checked.status === 0;
}

const metadataIdentity = {
  acl: commandAvailable("getfacl") ? "captured" : "unavailable",
  xattr: commandAvailable("getfattr") ? "captured" : "unavailable",
  capability: commandAvailable("getcap") ? "captured" : "unavailable",
  gaps: [],
};
for (const kind of ["acl", "xattr", "capability"]) {
  if (metadataIdentity[kind] === "unavailable") {
    metadataIdentity.gaps.push({ kind, reason: "source_tool_unavailable" });
  }
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error(command + " metadata capture failed");
  return result.stdout;
}

function metadataDigests(path, isSymlink) {
  const result = {};
  if (metadataIdentity.acl === "captured") {
    const value = isSymlink ? "" : commandOutput("getfacl", ["-cEn", "--", path]);
    result.aclSha256 = createHash("sha256").update(value).digest("hex");
  }
  if (metadataIdentity.xattr === "captured") {
    const output = commandOutput("getfattr", [
      "--absolute-names",
      "--dump",
      "--encoding=hex",
      "-m",
      "-",
      ...(isSymlink ? ["-h"] : []),
      "--",
      path,
    ]);
    const canonical = output
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .sort(compareUtf8)
      .join("\n");
    result.xattrSha256 = createHash("sha256").update(canonical).digest("hex");
  }
  if (metadataIdentity.capability === "captured") {
    let canonical = "";
    if (!isSymlink) {
      const output = commandOutput("getcap", ["-n", path]).trim();
      canonical = output.startsWith(path + " ") ? output.slice(path.length + 1) : output;
    }
    result.capabilitySha256 = canonical.length === 0
      ? emptySha256
      : createHash("sha256").update(canonical).digest("hex");
  }
  return result;
}

const candidates = [];
function walk(absolutePath, relativePath) {
  const safeRelative = safePath(relativePath);
  const stat = lstatSync(absolutePath, { bigint: true });
  const base = {
    path: safeRelative,
    mode: modeOf(stat),
    size: safeNumber(stat.size, "entry size"),
    uid: safeNumber(stat.uid, "entry uid"),
    gid: safeNumber(stat.gid, "entry gid"),
    mtimeNs: stat.mtimeNs.toString(),
    ...metadataDigests(absolutePath, stat.isSymbolicLink()),
  };
  if (stat.isFile()) {
    candidates.push({
      ...base,
      type: "file",
      absolutePath,
      inodeKey: stat.dev.toString() + ":" + stat.ino.toString(),
    });
    return;
  }
  if (stat.isSymbolicLink()) {
    const linkTarget = safeLinkTarget(safeRelative, readlinkSync(absolutePath));
    candidates.push({ ...base, type: "symlink", linkTarget });
    return;
  }
  if (!stat.isDirectory()) throw new Error("staging tree contains an unsupported entry");
  candidates.push({ ...base, type: "directory", size: 0 });
  for (const name of readdirSync(absolutePath).sort(compareUtf8)) {
    walk(join(absolutePath, name), safeRelative + "/" + name);
  }
}
walk(join(treeDir, "data"), "data");
walk(join(treeDir, "system"), "system");
candidates.sort((left, right) => compareUtf8(left.path, right.path));
const canonicalInodes = new Map();
const entries = [];
for (const candidate of candidates) {
  if (candidate.type !== "file") {
    entries.push(candidate);
    continue;
  }
  const { absolutePath, inodeKey, ...base } = candidate;
  const canonicalPath = canonicalInodes.get(inodeKey);
  if (canonicalPath !== undefined) {
    entries.push({ ...base, type: "hardlink", hardlinkTarget: canonicalPath });
    continue;
  }
  canonicalInodes.set(inodeKey, candidate.path);
  entries.push({ ...base, sha256: hashFile(absolutePath) });
}

const exclusionBuffer = readFileSync(exclusionsPath);
const exclusionParts = exclusionBuffer.toString("utf8").split("\0");
if (exclusionParts.at(-1) === "") exclusionParts.pop();
if (exclusionParts.length % 5 !== 0) throw new Error("exclusion inventory is malformed");
const exclusions = [];
for (let index = 0; index < exclusionParts.length; index += 5) {
  const path = safePath(exclusionParts[index]);
  const type = exclusionParts[index + 1];
  const rawMode = exclusionParts[index + 2];
  const rawSize = exclusionParts[index + 3];
  const reason = exclusionParts[index + 4];
  if (!/^[0-7]{3,4}$/u.test(rawMode) || !/^[0-9]+$/u.test(rawSize)) {
    throw new Error("exclusion metadata is malformed");
  }
  const size = Number(rawSize);
  if (!Number.isSafeInteger(size)) throw new Error("exclusion size is unsafe");
  exclusions.push({ path, type, mode: rawMode.padStart(4, "0"), size, reason });
}
exclusions.sort((left, right) => compareUtf8(left.path, right.path));

function updateIdentityField(hash, value) {
  hash.update(value).update("\0");
}

function treeIdentity() {
  const hash = createHash("sha256").update("comis-snapshot-tree-v1\0");
  updateIdentityField(hash, metadataIdentity.acl);
  updateIdentityField(hash, metadataIdentity.xattr);
  updateIdentityField(hash, metadataIdentity.capability);
  for (const gap of [...metadataIdentity.gaps].sort((left, right) => compareUtf8(left.kind, right.kind))) {
    updateIdentityField(hash, gap.kind);
    updateIdentityField(hash, gap.reason);
  }
  for (const entry of entries) {
    for (const value of [
      entry.path,
      entry.type,
      entry.mode,
      String(entry.size),
      String(entry.uid),
      String(entry.gid),
      entry.mtimeNs,
      entry.sha256 ?? "",
      entry.linkTarget ?? "",
      entry.hardlinkTarget ?? "",
      entry.aclSha256 ?? "",
      entry.xattrSha256 ?? "",
      entry.capabilitySha256 ?? "",
    ]) updateIdentityField(hash, value);
  }
  return hash.digest("hex");
}

const manifest = {
  schemaVersion: 1,
  runId,
  sourceMachineIdSha256: machineId,
  service,
  captureMode,
  captureStartedAtMs: Number(startedRaw),
  captureCompletedAtMs: Number(completedRaw),
  freezeDurationMs: Number(freezeRaw),
  metadataIdentity,
  treeIdentitySha256: treeIdentity(),
  entries,
  exclusions,
};
writeFileSync(manifestTmp, JSON.stringify(manifest), { encoding: "utf8", flag: "wx", mode: 0o600 });
renameSync(manifestTmp, manifestPath);
NODE
chmod 0600 "$builder"
node "$builder" "$stage_dir" "$run_id" "$expected_machine" "$service" "$capture_mode" \
  "$capture_started_ms" "$capture_completed_ms" "$freeze_duration_ms"
chmod 0600 "$manifest"
rm -f -- "$include_list" "$exclusion_list" "$builder"
completed=1
`;

const BOUNDED_CAPTURE_CLEANUP = String.raw`frozen=0

stop_watchdog() {
  systemctl stop "$watchdog_unit.timer" "$watchdog_unit.service" >/dev/null 2>&1 || true
  systemctl reset-failed "$watchdog_unit.timer" "$watchdog_unit.service" >/dev/null 2>&1 || true
}

cleanup() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [ "$frozen" -eq 1 ]; then
    systemctl thaw "$unit" >/dev/null 2>&1 || true
  fi
  stop_watchdog
  if [ "$completed" -ne 1 ] && [ "$stage_created" -eq 1 ]; then
    rm -rf -- "$stage_dir"
  fi
  if [ "$rc" -eq 0 ] && [ "$completed" -ne 1 ]; then rc=1; fi
  exit "$rc"
}
trap cleanup EXIT HUP INT TERM`;

const OFFLINE_CAPTURE_CLEANUP = String.raw`cleanup() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [ "$completed" -ne 1 ] && [ "$stage_created" -eq 1 ]; then
    rm -rf -- "$stage_dir"
  fi
  if [ "$rc" -eq 0 ] && [ "$completed" -ne 1 ]; then rc=1; fi
  exit "$rc"
}
trap cleanup EXIT HUP INT TERM`;

const BOUNDED_CAPTURE_BEGIN = String.raw`systemctl_bin="$(command -v systemctl)"
on_active="$watchdog_seconds"
on_active="$on_active"s
systemd-run --quiet --collect --unit="$watchdog_unit" --on-active="$on_active" \
  "$systemctl_bin" thaw "$unit"

freeze_started_ms="$(date +%s%3N)"
systemctl freeze "$unit"
frozen=1
freeze_state=""
for _attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  freeze_state="$(systemctl show "$unit" --property=FreezerState --value)"
  if [ "$freeze_state" = frozen ]; then break; fi
  sleep 0.1
done
if [ "$freeze_state" != frozen ]; then
  printf '%s\n' 'source service did not enter the frozen state' >&2
  exit 80
fi`;

const OFFLINE_CAPTURE_BEGIN = String.raw`source_load_state="$(systemctl show "$unit" --property=LoadState --value 2>/dev/null || true)"
source_state="$(systemctl is-active "$unit" 2>/dev/null || true)"
if [ "$source_load_state" != loaded ] || [ "$source_state" != inactive ]; then
  printf '%s\n' 'offline snapshot requires an inactive service' >&2
  exit 82
fi`;

const BOUNDED_CAPTURE_END = String.raw`if [ "$(systemctl show "$unit" --property=FreezerState --value)" != frozen ]; then
  printf '%s\n' 'source thaw watchdog fired before capture completed' >&2
  exit 81
fi
freeze_completed_ms="$(date +%s%3N)"
systemctl thaw "$unit"
frozen=0
stop_watchdog
freeze_duration_ms=$(( freeze_completed_ms - freeze_started_ms ))`;

const OFFLINE_CAPTURE_END = String.raw`source_state="$(systemctl is-active "$unit" 2>/dev/null || true)"
if [ "$source_state" != inactive ]; then
  printf '%s\n' 'source service became active during offline capture' >&2
  exit 83
fi
freeze_duration_ms=0`;

function buildPrepareScript(captureMode: ProductionSnapshotCaptureMode): string {
  const cleanup =
    captureMode === "bounded-freeze" ? BOUNDED_CAPTURE_CLEANUP : OFFLINE_CAPTURE_CLEANUP;
  const begin = captureMode === "bounded-freeze" ? BOUNDED_CAPTURE_BEGIN : OFFLINE_CAPTURE_BEGIN;
  const end = captureMode === "bounded-freeze" ? BOUNDED_CAPTURE_END : OFFLINE_CAPTURE_END;
  return PREPARE_TEMPLATE.replace("__CAPTURE_CLEANUP__", cleanup)
    .replace("__CAPTURE_BEGIN__", begin)
    .replace("__CAPTURE_END__", end);
}

const STREAM_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
run_id="$2"
case "$run_id" in
  [A-Za-z0-9]*) ;;
  *) printf '%s\n' 'snapshot run ID is unsafe' >&2; exit 68 ;;
esac
case "$run_id" in
  *[!A-Za-z0-9_-]*) printf '%s\n' 'snapshot run ID is unsafe' >&2; exit 68 ;;
esac
run_id_length="$(printf '%s' "$run_id" | wc -c | tr -d ' ')"
if [ "$run_id_length" -gt 64 ]; then exit 68; fi
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then
  printf '%s\n' 'source machine identity mismatch' >&2
  exit 71
fi
stage_root=/run/comis-self-driving
stage_dir="$stage_root/$run_id"
tree_dir="$stage_dir/tree"
manifest="$stage_dir/manifest.json"
if [ -L "$stage_root" ] || [ -L "$stage_dir" ] || [ -L "$tree_dir" ] || [ -L "$manifest" ]; then
  printf '%s\n' 'snapshot staging path is unsafe' >&2
  exit 84
fi
if [ "$(stat -c '%u:%a' "$stage_root" 2>/dev/null || true)" != 0:700 ] || \
   [ "$(stat -c '%u:%a' "$stage_dir" 2>/dev/null || true)" != 0:700 ] || \
   [ "$(stat -c '%u:%a' "$manifest" 2>/dev/null || true)" != 0:600 ]; then
  printf '%s\n' 'snapshot staging permissions are unsafe' >&2
  exit 85
fi
if [ ! -d "$tree_dir/data" ] || [ ! -f "$tree_dir/system/etc/comis/env" ]; then
  printf '%s\n' 'snapshot staging tree is incomplete' >&2
  exit 86
fi
cleanup_stream() {
  rc=$?
  trap - EXIT HUP INT TERM
  rm -rf -- "$stage_dir"
  exit "$rc"
}
trap cleanup_stream EXIT HUP INT TERM
tar --create --file=- --format=posix --acls --xattrs --xattrs-include='*' --numeric-owner \
  --atime-preserve=system --sparse --directory="$stage_dir" \
  --transform='flags=rh;s|^tree/||' manifest.json tree/data tree/system
`;

const BOUNDED_CLEANUP_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
service="$2"
run_id="$3"
case "$run_id" in
  [A-Za-z0-9]*) ;;
  *) printf '%s\n' 'snapshot run ID is unsafe' >&2; exit 68 ;;
esac
case "$run_id" in
  *[!A-Za-z0-9_-]*) printf '%s\n' 'snapshot run ID is unsafe' >&2; exit 68 ;;
esac
run_id_length="$(printf '%s' "$run_id" | wc -c | tr -d ' ')"
if [ "$run_id_length" -gt 64 ]; then exit 68; fi
case "$service" in
  [A-Za-z_]* ) ;;
  *) printf '%s\n' 'snapshot service name is unsafe' >&2; exit 69 ;;
esac
case "$service" in
  *[!A-Za-z0-9_.@-]*) printf '%s\n' 'snapshot service name is unsafe' >&2; exit 69 ;;
esac
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then
  printf '%s\n' 'source machine identity mismatch' >&2
  exit 71
fi
case "$service" in
  *.service) unit="$service" ;;
  *) unit="$service.service" ;;
esac
stage_root=/run/comis-self-driving
stage_dir="$stage_root/$run_id"
watchdog_unit="comis-snapshot-thaw-$run_id"
systemctl thaw "$unit" >/dev/null 2>&1 || true
systemctl stop "$watchdog_unit.timer" "$watchdog_unit.service" >/dev/null 2>&1 || true
systemctl reset-failed "$watchdog_unit.timer" "$watchdog_unit.service" >/dev/null 2>&1 || true
rm -rf -- "$stage_dir"
`;

const OFFLINE_CLEANUP_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
run_id="$2"
case "$run_id" in
  [A-Za-z0-9]*) ;;
  *) printf '%s\n' 'snapshot run ID is unsafe' >&2; exit 68 ;;
esac
case "$run_id" in
  *[!A-Za-z0-9_-]*) printf '%s\n' 'snapshot run ID is unsafe' >&2; exit 68 ;;
esac
run_id_length="$(printf '%s' "$run_id" | wc -c | tr -d ' ')"
if [ "$run_id_length" -gt 64 ]; then exit 68; fi
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then
  printf '%s\n' 'source machine identity mismatch' >&2
  exit 71
fi
stage_root=/run/comis-self-driving
stage_dir="$stage_root/$run_id"
rm -rf -- "$stage_dir"
`;

function invalidRequest(field: string, message: string): Result<never, ProductionSnapshotError> {
  return err({ kind: "invalid_request", field, message });
}

function validateRequest(
  request: ProductionSnapshotRequest,
): Result<number, ProductionSnapshotError> {
  if (request.captureMode !== "offline" && request.captureMode !== "bounded-freeze") {
    return invalidRequest(
      "captureMode",
      "Source capture mode must explicitly be offline or bounded-freeze",
    );
  }
  if (!SAFE_RUN_ID_RE.test(request.runId)) {
    return invalidRequest("runId", "Snapshot run ID contains unsafe characters");
  }
  if (!SHA256_RE.test(request.expectedMachineIdSha256)) {
    return invalidRequest(
      "expectedMachineIdSha256",
      "Source machine identity must be a lowercase SHA-256 digest",
    );
  }
  if (!SAFE_SERVICE_RE.test(request.service)) {
    return invalidRequest("service", "Source service name contains unsafe characters");
  }
  const pathSegments = request.dataDir.split("/");
  if (
    !isAbsolute(request.dataDir) ||
    request.dataDir === "/" ||
    request.dataDir.includes("\\") ||
    hasControlCharacters(request.dataDir) ||
    pathSegments
      .slice(1)
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return invalidRequest("dataDir", "Source data directory must be a safe absolute path");
  }
  const watchdogSeconds = request.watchdogSeconds ?? DEFAULT_WATCHDOG_SECONDS;
  if (
    !Number.isInteger(watchdogSeconds) ||
    watchdogSeconds < MIN_WATCHDOG_SECONDS ||
    watchdogSeconds > MAX_WATCHDOG_SECONDS
  ) {
    return invalidRequest(
      "watchdogSeconds",
      `Snapshot thaw watchdog must be between ${MIN_WATCHDOG_SECONDS} and ${MAX_WATCHDOG_SECONDS} seconds`,
    );
  }
  return ok(watchdogSeconds);
}

export function buildProductionSnapshotPlan(
  request: ProductionSnapshotRequest,
): Result<ProductionSnapshotPlan, ProductionSnapshotError> {
  const validated = validateRequest(request);
  if (!validated.ok) return validated;
  const stageDir = `${STAGE_ROOT}/${request.runId}`;
  const cleanupArgs =
    request.captureMode === "bounded-freeze"
      ? [
          "sudo",
          "bash",
          "-s",
          "--",
          request.expectedMachineIdSha256,
          request.service,
          request.runId,
        ]
      : ["sudo", "bash", "-s", "--", request.expectedMachineIdSha256, request.runId];
  return ok({
    captureMode: request.captureMode,
    stageDir,
    manifestPath: `${stageDir}/manifest.json`,
    prepare: {
      args: [
        "sudo",
        "bash",
        "-s",
        "--",
        request.expectedMachineIdSha256,
        request.service,
        request.dataDir,
        request.runId,
        request.captureMode,
        String(validated.value),
      ],
      stdin: buildPrepareScript(request.captureMode),
      stdout: "none",
    },
    stream: {
      args: [
        "sudo",
        "bash",
        "-s",
        "--",
        request.expectedMachineIdSha256,
        request.runId,
      ],
      stdin: STREAM_SCRIPT,
      stdout: "archive",
    },
    cleanup: {
      args: cleanupArgs,
      stdin:
        request.captureMode === "bounded-freeze"
          ? BOUNDED_CLEANUP_SCRIPT
          : OFFLINE_CLEANUP_SCRIPT,
      stdout: "none",
    },
  });
}

function malformedManifest(
  field: string,
  message: string,
): Result<never, ProductionSnapshotError> {
  return err({ kind: "malformed_manifest", field, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) && keys.every((key) => key in value);
}

function isSafeManifestPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.length > 8192 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    hasControlCharacters(path)
  ) {
    return false;
  }
  const segments = path.split("/");
  return !segments.some((segment) => segment === "" || segment === "." || segment === "..");
}

function validatePath(path: unknown): Result<string, ProductionSnapshotError> {
  if (typeof path !== "string") {
    return malformedManifest("path", "Snapshot record path must be a string");
  }
  if (!isSafeManifestPath(path)) {
    return err({
      kind: "unsafe_manifest_path",
      path,
      message: "Snapshot record path is not a safe relative path",
    });
  }
  return ok(path);
}

function readMode(value: unknown, field: string): Result<string, ProductionSnapshotError> {
  if (typeof value !== "string" || !MODE_RE.test(value)) {
    return malformedManifest(field, "Snapshot mode must contain four octal digits");
  }
  return ok(value);
}

function readNonNegativeInteger(
  value: unknown,
  field: string,
): Result<number, ProductionSnapshotError> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return malformedManifest(field, "Snapshot numeric field must be a non-negative safe integer");
  }
  return ok(value);
}

function isSafeLinkTarget(entryPath: string, target: string): boolean {
  if (
    target.length === 0 ||
    target.length > 8192 ||
    target.startsWith("/") ||
    target.includes("\\") ||
    hasControlCharacters(target)
  ) {
    return false;
  }
  const resolved = entryPath.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "") return false;
    if (segment === ".") continue;
    if (segment === "..") {
      if (resolved.length <= 1) return false;
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return true;
}

function parseMetadataIdentity(
  value: unknown,
): Result<ProductionSnapshotMetadataIdentity, ProductionSnapshotError> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["acl", "xattr", "capability", "gaps"])
  ) {
    return malformedManifest(
      "metadataIdentity",
      "Snapshot metadata identity declaration is malformed",
    );
  }
  const statuses = [value["acl"], value["xattr"], value["capability"]];
  if (statuses.some((status) => status !== "captured" && status !== "unavailable")) {
    return malformedManifest(
      "metadataIdentity",
      "Snapshot metadata identity status is invalid",
    );
  }
  if (!Array.isArray(value["gaps"]) || value["gaps"].length > 3) {
    return malformedManifest("metadataIdentity.gaps", "Snapshot metadata gaps are invalid");
  }
  const gaps: ProductionSnapshotMetadataGap[] = [];
  const seen = new Set<ProductionSnapshotMetadataKind>();
  for (const gap of value["gaps"]) {
    if (
      !isRecord(gap) ||
      !hasOnlyKeys(gap, ["kind", "reason"]) ||
      (gap["kind"] !== "acl" && gap["kind"] !== "xattr" && gap["kind"] !== "capability") ||
      gap["reason"] !== "source_tool_unavailable" ||
      seen.has(gap["kind"])
    ) {
      return malformedManifest("metadataIdentity.gaps", "Snapshot metadata gap is invalid");
    }
    seen.add(gap["kind"]);
    gaps.push({ kind: gap["kind"], reason: "source_tool_unavailable" });
  }
  const metadataIdentity: ProductionSnapshotMetadataIdentity = {
    acl: value["acl"] as ProductionSnapshotMetadataStatus,
    xattr: value["xattr"] as ProductionSnapshotMetadataStatus,
    capability: value["capability"] as ProductionSnapshotMetadataStatus,
    gaps,
  };
  for (const kind of ["acl", "xattr", "capability"] as const) {
    const hasGap = seen.has(kind);
    if ((metadataIdentity[kind] === "unavailable") !== hasGap) {
      return malformedManifest(
        "metadataIdentity.gaps",
        "Snapshot metadata gaps do not match capture availability",
      );
    }
  }
  return ok(metadataIdentity);
}

function parseEntry(
  value: unknown,
  metadataIdentity: ProductionSnapshotMetadataIdentity,
): Result<ProductionSnapshotEntry, ProductionSnapshotError> {
  if (!isRecord(value)) return malformedManifest("entries", "Snapshot entry must be an object");
  const type = value["type"];
  if (type !== "file" && type !== "directory" && type !== "symlink" && type !== "hardlink") {
    return malformedManifest("entries.type", "Snapshot entry type is not recognized");
  }
  const keys = [
    "path",
    "type",
    "mode",
    "size",
    "uid",
    "gid",
    "mtimeNs",
    ...(metadataIdentity.acl === "captured" ? ["aclSha256"] : []),
    ...(metadataIdentity.xattr === "captured" ? ["xattrSha256"] : []),
    ...(metadataIdentity.capability === "captured" ? ["capabilitySha256"] : []),
    ...(
    type === "file"
      ? ["sha256"]
      : type === "symlink"
        ? ["linkTarget"]
        : type === "hardlink"
          ? ["hardlinkTarget"]
          : []),
  ];
  if (!hasOnlyKeys(value, keys)) {
    return malformedManifest(
      "entries",
      "Snapshot entry has missing, unexpected, or content-bearing fields",
    );
  }
  const path = validatePath(value["path"]);
  if (!path.ok) return path;
  const mode = readMode(value["mode"], "entries.mode");
  if (!mode.ok) return mode;
  const size = readNonNegativeInteger(value["size"], "entries.size");
  if (!size.ok) return size;
  const uid = readNonNegativeInteger(value["uid"], "entries.uid");
  if (!uid.ok) return uid;
  const gid = readNonNegativeInteger(value["gid"], "entries.gid");
  if (!gid.ok) return gid;
  const mtimeNs = value["mtimeNs"];
  if (typeof mtimeNs !== "string" || !MTIME_NS_RE.test(mtimeNs)) {
    return malformedManifest(
      "entries.mtimeNs",
      "Snapshot modification time must be signed decimal nanoseconds",
    );
  }
  const metadata: {
    aclSha256?: string;
    xattrSha256?: string;
    capabilitySha256?: string;
  } = {};
  for (const [status, field] of [
    [metadataIdentity.acl, "aclSha256"],
    [metadataIdentity.xattr, "xattrSha256"],
    [metadataIdentity.capability, "capabilitySha256"],
  ] as const) {
    if (status !== "captured") continue;
    const digest = value[field];
    if (typeof digest !== "string" || !SHA256_RE.test(digest)) {
      return malformedManifest(`entries.${field}`, "Snapshot metadata digest is invalid");
    }
    metadata[field] = digest;
  }
  const base = {
    path: path.value,
    mode: mode.value,
    size: size.value,
    uid: uid.value,
    gid: gid.value,
    mtimeNs,
    ...metadata,
  };
  if (type === "directory" && size.value !== 0) {
    return malformedManifest(
      "entries.size",
      "Snapshot directory size must use the portable canonical zero value",
    );
  }
  if (type === "file") {
    const sha256 = value["sha256"];
    if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) {
      return malformedManifest("entries.sha256", "Snapshot file digest is invalid");
    }
    return ok({ ...base, type, sha256 });
  }
  if (type === "symlink") {
    const linkTarget = value["linkTarget"];
    if (
      typeof linkTarget !== "string" ||
      !isSafeLinkTarget(path.value, linkTarget) ||
      size.value !== Buffer.byteLength(linkTarget, "utf8")
    ) {
      return malformedManifest("entries.linkTarget", "Snapshot symlink target is invalid");
    }
    return ok({ ...base, type, linkTarget });
  }
  if (type === "hardlink") {
    const hardlinkTarget = validatePath(value["hardlinkTarget"]);
    if (!hardlinkTarget.ok) return hardlinkTarget;
    return ok({ ...base, type, hardlinkTarget: hardlinkTarget.value });
  }
  return ok({ ...base, type });
}

const EXCLUDED_TYPES = new Set<ProductionSnapshotExcludedType>([
  "file",
  "directory",
  "symlink",
  "socket",
  "fifo",
  "character_device",
  "block_device",
  "unknown",
]);
const EXCLUSION_REASONS = new Set<ProductionSnapshotExclusionReason>([
  "daemon_lock",
  "sqlite_shm",
  "runtime_socket",
  "unsupported_special",
]);

function parseExclusion(
  value: unknown,
): Result<ProductionSnapshotExclusion, ProductionSnapshotError> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["path", "type", "mode", "size", "reason"])) {
    return malformedManifest(
      "exclusions",
      "Snapshot exclusion has missing, unexpected, or content-bearing fields",
    );
  }
  const path = validatePath(value["path"]);
  if (!path.ok) return path;
  const type = value["type"];
  if (typeof type !== "string" || !EXCLUDED_TYPES.has(type as ProductionSnapshotExcludedType)) {
    return malformedManifest("exclusions.type", "Snapshot exclusion type is not recognized");
  }
  const mode = readMode(value["mode"], "exclusions.mode");
  if (!mode.ok) return mode;
  const size = readNonNegativeInteger(value["size"], "exclusions.size");
  if (!size.ok) return size;
  const reason = value["reason"];
  if (
    typeof reason !== "string" ||
    !EXCLUSION_REASONS.has(reason as ProductionSnapshotExclusionReason)
  ) {
    return malformedManifest("exclusions.reason", "Snapshot exclusion reason is not recognized");
  }
  if (reason === "daemon_lock" && !path.value.endsWith("/.daemon.lock")) {
    return malformedManifest("exclusions.reason", "Daemon-lock exclusion path is inconsistent");
  }
  if (reason === "sqlite_shm" && !path.value.endsWith("-shm")) {
    return malformedManifest("exclusions.reason", "SQLite SHM exclusion path is inconsistent");
  }
  if (reason === "runtime_socket" && type !== "socket") {
    return malformedManifest("exclusions.reason", "Runtime-socket exclusion type is inconsistent");
  }
  if (path.value.endsWith("/.daemon.lock") && (reason !== "daemon_lock" || type !== "file")) {
    return malformedManifest("exclusions.reason", "Daemon-lock exclusion metadata is inconsistent");
  }
  if (path.value.endsWith("-shm") && (reason !== "sqlite_shm" || type !== "file")) {
    return malformedManifest("exclusions.reason", "SQLite SHM exclusion metadata is inconsistent");
  }
  if (type === "socket" && reason !== "runtime_socket") {
    return malformedManifest("exclusions.reason", "Socket exclusion reason is inconsistent");
  }
  if (
    reason === "unsupported_special" &&
    type !== "fifo" &&
    type !== "character_device" &&
    type !== "block_device" &&
    type !== "unknown"
  ) {
    return malformedManifest(
      "exclusions.reason",
      "Unsupported-special exclusion type is inconsistent",
    );
  }
  return ok({
    path: path.value,
    type: type as ProductionSnapshotExcludedType,
    mode: mode.value,
    size: size.value,
    reason: reason as ProductionSnapshotExclusionReason,
  });
}

function validateManifestObject(
  value: unknown,
): Result<ProductionSnapshotManifest, ProductionSnapshotError> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "runId",
      "sourceMachineIdSha256",
      "service",
      "captureMode",
      "captureStartedAtMs",
      "captureCompletedAtMs",
      "freezeDurationMs",
      "metadataIdentity",
      "treeIdentitySha256",
      "entries",
      "exclusions",
    ])
  ) {
    return malformedManifest(
      "manifest",
      "Snapshot manifest has missing, unexpected, or content-bearing fields",
    );
  }
  if (value["schemaVersion"] !== 1) {
    return malformedManifest("schemaVersion", "Snapshot manifest schema version is unsupported");
  }
  const runId = value["runId"];
  if (typeof runId !== "string" || !SAFE_RUN_ID_RE.test(runId)) {
    return malformedManifest("runId", "Snapshot run ID is invalid");
  }
  const machineId = value["sourceMachineIdSha256"];
  if (typeof machineId !== "string" || !SHA256_RE.test(machineId)) {
    return malformedManifest("sourceMachineIdSha256", "Snapshot source identity is invalid");
  }
  const service = value["service"];
  if (typeof service !== "string" || !SAFE_SERVICE_RE.test(service)) {
    return malformedManifest("service", "Snapshot service name is invalid");
  }
  const captureMode = value["captureMode"];
  if (captureMode !== "offline" && captureMode !== "bounded-freeze") {
    return malformedManifest("captureMode", "Snapshot capture mode is invalid");
  }
  const started = readNonNegativeInteger(value["captureStartedAtMs"], "captureStartedAtMs");
  if (!started.ok) return started;
  const completed = readNonNegativeInteger(value["captureCompletedAtMs"], "captureCompletedAtMs");
  if (!completed.ok) return completed;
  const freezeDuration = readNonNegativeInteger(value["freezeDurationMs"], "freezeDurationMs");
  if (!freezeDuration.ok) return freezeDuration;
  if (
    completed.value < started.value ||
    freezeDuration.value > completed.value - started.value ||
    (captureMode === "offline" && freezeDuration.value !== 0) ||
    (captureMode === "bounded-freeze" && freezeDuration.value === 0)
  ) {
    return malformedManifest("captureCompletedAtMs", "Snapshot capture timing is inconsistent");
  }
  const metadataIdentity = parseMetadataIdentity(value["metadataIdentity"]);
  if (!metadataIdentity.ok) return metadataIdentity;
  const treeIdentitySha256 = value["treeIdentitySha256"];
  if (typeof treeIdentitySha256 !== "string" || !SHA256_RE.test(treeIdentitySha256)) {
    return malformedManifest("treeIdentitySha256", "Snapshot tree identity is invalid");
  }

  const entryValues = value["entries"];
  const exclusionValues = value["exclusions"];
  if (
    !Array.isArray(entryValues) ||
    !Array.isArray(exclusionValues) ||
    entryValues.length === 0 ||
    entryValues.length > MAX_MANIFEST_RECORDS ||
    exclusionValues.length > MAX_MANIFEST_RECORDS
  ) {
    return malformedManifest("entries", "Snapshot manifest record count is invalid");
  }
  const entries: ProductionSnapshotEntry[] = [];
  for (const entryValue of entryValues) {
    const entry = parseEntry(entryValue, metadataIdentity.value);
    if (!entry.ok) return entry;
    if (
      entry.value.path !== "data" &&
      !entry.value.path.startsWith("data/") &&
      entry.value.path !== "system" &&
      entry.value.path !== "system/etc" &&
      entry.value.path !== "system/etc/comis" &&
      entry.value.path !== "system/etc/comis/env"
    ) {
      return err({
        kind: "unsafe_manifest_path",
        path: entry.value.path,
        message: "Snapshot entry is outside the restorable namespaces",
      });
    }
    if (entry.value.path.endsWith("/.daemon.lock") || entry.value.path.endsWith("-shm")) {
      return err({
        kind: "inconsistent_manifest",
        message: "Runtime-only artifact appears in the restorable entry set",
      });
    }
    entries.push(entry.value);
  }

  const exclusions: ProductionSnapshotExclusion[] = [];
  for (const exclusionValue of exclusionValues) {
    const exclusion = parseExclusion(exclusionValue);
    if (!exclusion.ok) return exclusion;
    if (!exclusion.value.path.startsWith("data/")) {
      return err({
        kind: "unsafe_manifest_path",
        path: exclusion.value.path,
        message: "Snapshot exclusion is outside the data namespace",
      });
    }
    exclusions.push(exclusion.value);
  }

  const entryPaths = new Set<string>();
  for (const entry of entries) {
    if (entryPaths.has(entry.path)) {
      return err({ kind: "inconsistent_manifest", message: "Snapshot entry path is duplicated" });
    }
    entryPaths.add(entry.path);
  }
  const exclusionPaths = new Set<string>();
  for (const exclusion of exclusions) {
    if (entryPaths.has(exclusion.path) || exclusionPaths.has(exclusion.path)) {
      return err({
        kind: "inconsistent_manifest",
        message: "Snapshot exclusion path is duplicated or restorable",
      });
    }
    exclusionPaths.add(exclusion.path);
  }
  const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    if (entry.type !== "hardlink") continue;
    const target = entriesByPath.get(entry.hardlinkTarget ?? "");
    if (
      target?.type !== "file" ||
      compareUtf8(target.path, entry.path) >= 0 ||
      target.path.split("/", 1)[0] !== entry.path.split("/", 1)[0] ||
      target.mode !== entry.mode ||
      target.size !== entry.size ||
      target.uid !== entry.uid ||
      target.gid !== entry.gid ||
      target.mtimeNs !== entry.mtimeNs ||
      target.aclSha256 !== entry.aclSha256 ||
      target.xattrSha256 !== entry.xattrSha256 ||
      target.capabilitySha256 !== entry.capabilitySha256
    ) {
      return err({
        kind: "inconsistent_manifest",
        message: "Snapshot hardlink does not reference its canonical file identity",
      });
    }
  }
  const dataRoot = entries.find(({ path }) => path === "data");
  const environment = entries.find(({ path }) => path === "system/etc/comis/env");
  if (dataRoot?.type !== "directory" || environment?.type !== "file") {
    return err({
      kind: "inconsistent_manifest",
      message: "Snapshot omits the data root or service environment file",
    });
  }
  for (const entry of entries) {
    if (!entry.path.endsWith("-wal")) continue;
    const mainPath = entry.path.slice(0, -4);
    const main = entries.find(({ path }) => path === mainPath);
    if (entry.type !== "file" || main?.type !== "file") {
      return err({
        kind: "inconsistent_manifest",
        message: "Snapshot WAL file does not have a restorable main database file",
      });
    }
  }

  const manifest: ProductionSnapshotManifest = {
    schemaVersion: 1,
    runId,
    sourceMachineIdSha256: machineId,
    service,
    captureMode,
    captureStartedAtMs: started.value,
    captureCompletedAtMs: completed.value,
    freezeDurationMs: freezeDuration.value,
    metadataIdentity: metadataIdentity.value,
    treeIdentitySha256,
    entries,
    exclusions,
  };
  if (deriveProductionSnapshotTreeIdentity(manifest) !== treeIdentitySha256) {
    return err({
      kind: "inconsistent_manifest",
      message: "Snapshot tree identity does not match its canonical records",
    });
  }
  return ok(manifest);
}

export function parseProductionSnapshotManifest(
  raw: string,
): Result<ProductionSnapshotManifest, ProductionSnapshotError> {
  if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) {
    return malformedManifest("manifest", "Snapshot manifest exceeds the size limit");
  }
  const parsed = tryCatch<unknown>(() => JSON.parse(raw));
  if (!parsed.ok) return malformedManifest("manifest", "Snapshot manifest is not valid JSON");
  return validateManifestObject(parsed.value);
}
