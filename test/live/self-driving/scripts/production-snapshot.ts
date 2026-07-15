// SPDX-License-Identifier: Apache-2.0
import { isAbsolute } from "node:path";

import { err, ok, tryCatch, type Result } from "@comis/shared";

export type ProductionSnapshotEntryType = "file" | "directory" | "symlink";

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
  readonly sha256?: string;
  readonly linkTarget?: string;
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
const DEFAULT_WATCHDOG_SECONDS = 60;
const MIN_WATCHDOG_SECONDS = 5;
const MAX_WATCHDOG_SECONDS = 300;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_RECORDS = 2_000_000;
const STAGE_ROOT = "/run/comis-self-driving";

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
    find -P . -printf '%P\t%y\t%m\t%s\t%T@\t%C@\0' \
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

tar --create --file=- --acls --xattrs --numeric-owner --atime-preserve=system --sparse \
  --no-recursion --null --verbatim-files-from --directory="$data_dir" \
  --files-from="$include_list" \
  | tar --extract --file=- --acls --xattrs --numeric-owner --same-owner \
      --same-permissions --directory="$tree_dir/data"

tar --create --file=- --acls --xattrs --numeric-owner --atime-preserve=system \
  --directory=/ etc/comis/env \
  | tar --extract --file=- --acls --xattrs --numeric-owner --same-owner \
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
  return (stat.mode & 0o7777).toString(8).padStart(4, "0");
}

const entries = [];
function walk(absolutePath, relativePath) {
  const safeRelative = safePath(relativePath);
  const stat = lstatSync(absolutePath, { bigint: false });
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error("entry size is unsafe");
  const base = { path: safeRelative, mode: modeOf(stat), size: stat.size };
  if (stat.isFile()) {
    entries.push({ ...base, type: "file", sha256: hashFile(absolutePath) });
    return;
  }
  if (stat.isSymbolicLink()) {
    const linkTarget = readlinkSync(absolutePath);
    if (linkTarget.length === 0 || controlPattern.test(linkTarget)) {
      throw new Error("symlink target is unsafe for the manifest");
    }
    entries.push({ ...base, type: "symlink", linkTarget });
    return;
  }
  if (!stat.isDirectory()) throw new Error("staging tree contains an unsupported entry");
  entries.push({ ...base, type: "directory" });
  for (const name of readdirSync(absolutePath).sort((left, right) => left.localeCompare(right))) {
    walk(join(absolutePath, name), safeRelative + "/" + name);
  }
}
walk(join(treeDir, "data"), "data");
walk(join(treeDir, "system"), "system");
entries.sort((left, right) => left.path.localeCompare(right.path));

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
exclusions.sort((left, right) => left.path.localeCompare(right.path));

const manifest = {
  schemaVersion: 1,
  runId,
  sourceMachineIdSha256: machineId,
  service,
  captureMode,
  captureStartedAtMs: Number(startedRaw),
  captureCompletedAtMs: Number(completedRaw),
  freezeDurationMs: Number(freezeRaw),
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
tar --create --file=- --format=posix --acls --xattrs --numeric-owner --hard-dereference \
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

function parseEntry(value: unknown): Result<ProductionSnapshotEntry, ProductionSnapshotError> {
  if (!isRecord(value)) return malformedManifest("entries", "Snapshot entry must be an object");
  const type = value["type"];
  if (type !== "file" && type !== "directory" && type !== "symlink") {
    return malformedManifest("entries.type", "Snapshot entry type is not recognized");
  }
  const keys =
    type === "file"
      ? ["path", "type", "mode", "size", "sha256"]
      : type === "symlink"
        ? ["path", "type", "mode", "size", "linkTarget"]
        : ["path", "type", "mode", "size"];
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
  if (type === "file") {
    const sha256 = value["sha256"];
    if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) {
      return malformedManifest("entries.sha256", "Snapshot file digest is invalid");
    }
    return ok({ path: path.value, type, mode: mode.value, size: size.value, sha256 });
  }
  if (type === "symlink") {
    const linkTarget = value["linkTarget"];
    if (
      typeof linkTarget !== "string" ||
      linkTarget.length === 0 ||
      linkTarget.length > 8192 ||
      hasControlCharacters(linkTarget)
    ) {
      return malformedManifest("entries.linkTarget", "Snapshot symlink target is invalid");
    }
    return ok({
      path: path.value,
      type,
      mode: mode.value,
      size: size.value,
      linkTarget,
    });
  }
  return ok({ path: path.value, type, mode: mode.value, size: size.value });
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
    const entry = parseEntry(entryValue);
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

  return ok({
    schemaVersion: 1,
    runId,
    sourceMachineIdSha256: machineId,
    service,
    captureMode,
    captureStartedAtMs: started.value,
    captureCompletedAtMs: completed.value,
    freezeDurationMs: freezeDuration.value,
    entries,
    exclusions,
  });
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
