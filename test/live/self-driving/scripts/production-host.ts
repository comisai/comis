// SPDX-License-Identifier: Apache-2.0
import { err, ok, type Result } from "@comis/shared";

import type { ProductionReplayProfile } from "./production-profile.js";

export interface ProductionHostFacts {
  readonly machineIdSha256: string;
  readonly environmentRole?: string;
  readonly osId: string;
  readonly osVersion: string;
  readonly arch: string;
  readonly kernelRelease: string;
  readonly libcKind: "glibc" | "musl" | "darwin" | "other" | "unknown";
  readonly libcVersion: string;
  readonly nodeVersion: string;
  readonly nodeAbi: string;
  readonly timezone: string;
  readonly tzdataSha256: string;
  readonly launcherKind: "systemd" | "unsupported";
  readonly launcherSha256: string;
  readonly sudoReady: boolean;
  readonly systemdReady: boolean;
  readonly freezeReady: boolean;
  readonly bashReady: boolean;
  readonly tarReady: boolean;
  readonly rsyncReady: boolean;
  readonly curlReady: boolean;
  readonly nodeReady: boolean;
  readonly npmReady: boolean;
  readonly browserReady: boolean;
  readonly xvfbReady: boolean;
  readonly ffmpegReady: boolean;
  readonly ffprobeReady: boolean;
  readonly bwrapReady: boolean;
  readonly zstdReady: boolean;
  readonly comisInstalled: boolean;
  readonly comisVersion?: string;
  readonly serviceState: "active" | "inactive" | "failed" | "missing" | "unknown";
  readonly serviceEnabled: boolean;
  readonly dataExists: boolean;
  readonly dataMode?: string;
  readonly dataBytes: number;
  readonly diskFreeBytes: number;
}

export type TargetMutationPurpose = "bootstrap" | "restore";

export type ProductionHostError =
  | { readonly kind: "malformed_facts"; readonly field: string; readonly message: string }
  | { readonly kind: "identity_unpinned"; readonly host: "source" | "target"; readonly message: string }
  | { readonly kind: "machine_mismatch"; readonly host: "source" | "target"; readonly message: string }
  | { readonly kind: "source_target_conflict"; readonly message: string }
  | { readonly kind: "role_mismatch"; readonly host: "source" | "target"; readonly message: string }
  | { readonly kind: "unsupported_host"; readonly host: "source" | "target"; readonly message: string }
  | { readonly kind: "unsafe_version"; readonly message: string };

const SHA256_RE = /^[a-f0-9]{64}$/u;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const SERVICE_STATES = new Set(["active", "inactive", "failed", "missing", "unknown"]);
const LIBC_KINDS = new Set(["glibc", "musl", "darwin", "other", "unknown"]);
const LAUNCHER_KINDS = new Set(["systemd", "unsupported"]);
const MAX_HOST_FACTS_BYTES = 8192;
const HOST_FACT_FIELDS = [
  "machineIdSha256",
  "environmentRole",
  "osId",
  "osVersion",
  "arch",
  "kernelRelease",
  "libcKind",
  "libcVersion",
  "nodeVersion",
  "nodeAbi",
  "timezone",
  "tzdataSha256",
  "launcherKind",
  "launcherSha256",
  "sudoReady",
  "systemdReady",
  "freezeReady",
  "bashReady",
  "tarReady",
  "rsyncReady",
  "curlReady",
  "nodeReady",
  "npmReady",
  "browserReady",
  "xvfbReady",
  "ffmpegReady",
  "ffprobeReady",
  "bwrapReady",
  "zstdReady",
  "comisInstalled",
  "comisVersion",
  "serviceState",
  "serviceEnabled",
  "dataExists",
  "dataMode",
  "dataBytes",
  "diskFreeBytes",
] as const;

function parseKeyValues(raw: string): Result<Record<string, string>, ProductionHostError> {
  if (Buffer.byteLength(raw, "utf8") > MAX_HOST_FACTS_BYTES) {
    return err({
      kind: "malformed_facts",
      field: "envelope",
      message: "Host facts exceed the 8192-byte limit",
    });
  }
  if (raw.includes("\r") || raw.includes("\0")) {
    return err({
      kind: "malformed_facts",
      field: "envelope",
      message: "Host facts contain unsupported control bytes",
    });
  }
  const allowed = new Set<string>(HOST_FACT_FIELDS);
  const values: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      return err({
        kind: "malformed_facts",
        field: "envelope",
        message: "Host facts contain a malformed line",
      });
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!allowed.has(key)) {
      return err({
        kind: "malformed_facts",
        field: "envelope",
        message: "Host facts contain an unknown field",
      });
    }
    if (Object.hasOwn(values, key)) {
      return err({ kind: "malformed_facts", field: key, message: `${key} appears more than once` });
    }
    values[key] = value;
  }
  for (const field of HOST_FACT_FIELDS) {
    if (!Object.hasOwn(values, field)) {
      return err({ kind: "malformed_facts", field, message: `${field} is missing from host facts` });
    }
  }
  return ok(values);
}

function isSafeFactToken(value: string, maximumLength = 128): boolean {
  return value.length <= maximumLength && /^[A-Za-z0-9._+:/@-]+$/u.test(value);
}

function requireSafeToken(
  values: Record<string, string>,
  field: string,
  maximumLength = 128,
): Result<string, ProductionHostError> {
  const required = requireValue(values, field);
  if (!required.ok) return required;
  if (!isSafeFactToken(required.value, maximumLength)) {
    return err({ kind: "malformed_facts", field, message: `${field} is not a safe fact token` });
  }
  return required;
}

function requireValue(
  values: Record<string, string>,
  field: string,
): Result<string, ProductionHostError> {
  const value = values[field];
  if (value === undefined || value === "") {
    return err({ kind: "malformed_facts", field, message: `${field} is missing from host facts` });
  }
  return ok(value);
}

function parseBoolean(
  values: Record<string, string>,
  field: string,
): Result<boolean, ProductionHostError> {
  const value = values[field];
  if (value === "true") return ok(true);
  if (value === "false") return ok(false);
  return err({ kind: "malformed_facts", field, message: `${field} must be true or false` });
}

function parseNonNegativeNumber(
  values: Record<string, string>,
  field: string,
): Result<number, ProductionHostError> {
  const value = values[field];
  if (value === undefined || !/^[0-9]+$/u.test(value)) {
    return err({ kind: "malformed_facts", field, message: `${field} must be a non-negative integer` });
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    return err({ kind: "malformed_facts", field, message: `${field} exceeds the safe integer range` });
  }
  return ok(number);
}

export function parseHostFacts(raw: string): Result<ProductionHostFacts, ProductionHostError> {
  const parsedValues = parseKeyValues(raw);
  if (!parsedValues.ok) return parsedValues;
  const values = parsedValues.value;
  const machineId = requireValue(values, "machineIdSha256");
  if (!machineId.ok) return machineId;
  if (!SHA256_RE.test(machineId.value)) {
    return err({
      kind: "malformed_facts",
      field: "machineIdSha256",
      message: "machineIdSha256 must be a lowercase SHA-256 digest",
    });
  }
  const osId = requireSafeToken(values, "osId");
  if (!osId.ok) return osId;
  const osVersion = requireSafeToken(values, "osVersion");
  if (!osVersion.ok) return osVersion;
  const arch = requireSafeToken(values, "arch");
  if (!arch.ok) return arch;
  const kernelRelease = requireSafeToken(values, "kernelRelease");
  if (!kernelRelease.ok) return kernelRelease;
  const libcKind = requireSafeToken(values, "libcKind");
  if (!libcKind.ok) return libcKind;
  if (!LIBC_KINDS.has(libcKind.value)) {
    return err({ kind: "malformed_facts", field: "libcKind", message: "libcKind is not recognized" });
  }
  const libcVersion = requireSafeToken(values, "libcVersion");
  if (!libcVersion.ok) return libcVersion;
  const nodeVersion = requireSafeToken(values, "nodeVersion");
  if (!nodeVersion.ok) return nodeVersion;
  const nodeAbi = requireSafeToken(values, "nodeAbi");
  if (!nodeAbi.ok) return nodeAbi;
  const timezone = requireSafeToken(values, "timezone", 256);
  if (!timezone.ok) return timezone;
  const tzdataSha256 = requireSafeToken(values, "tzdataSha256");
  if (!tzdataSha256.ok) return tzdataSha256;
  if (tzdataSha256.value !== "none" && !SHA256_RE.test(tzdataSha256.value)) {
    return err({
      kind: "malformed_facts",
      field: "tzdataSha256",
      message: "tzdataSha256 must be a lowercase SHA-256 digest or none",
    });
  }
  const launcherKind = requireSafeToken(values, "launcherKind");
  if (!launcherKind.ok) return launcherKind;
  if (!LAUNCHER_KINDS.has(launcherKind.value)) {
    return err({ kind: "malformed_facts", field: "launcherKind", message: "launcherKind is not recognized" });
  }
  const launcherSha256 = requireSafeToken(values, "launcherSha256");
  if (!launcherSha256.ok) return launcherSha256;
  if (
    (launcherKind.value === "systemd" && !SHA256_RE.test(launcherSha256.value)) ||
    (launcherKind.value === "unsupported" && launcherSha256.value !== "none")
  ) {
    return err({
      kind: "malformed_facts",
      field: "launcherSha256",
      message: "launcherSha256 does not match launcherKind",
    });
  }

  const booleanFields = [
    "sudoReady",
    "systemdReady",
    "freezeReady",
    "bashReady",
    "tarReady",
    "rsyncReady",
    "curlReady",
    "nodeReady",
    "npmReady",
    "browserReady",
    "xvfbReady",
    "ffmpegReady",
    "ffprobeReady",
    "bwrapReady",
    "zstdReady",
    "comisInstalled",
    "serviceEnabled",
    "dataExists",
  ] as const;
  const booleans: Record<(typeof booleanFields)[number], boolean> = {
    sudoReady: false,
    systemdReady: false,
    freezeReady: false,
    bashReady: false,
    tarReady: false,
    rsyncReady: false,
    curlReady: false,
    nodeReady: false,
    npmReady: false,
    browserReady: false,
    xvfbReady: false,
    ffmpegReady: false,
    ffprobeReady: false,
    bwrapReady: false,
    zstdReady: false,
    comisInstalled: false,
    serviceEnabled: false,
    dataExists: false,
  };
  for (const field of booleanFields) {
    const parsed = parseBoolean(values, field);
    if (!parsed.ok) return parsed;
    booleans[field] = parsed.value;
  }

  const dataBytes = parseNonNegativeNumber(values, "dataBytes");
  if (!dataBytes.ok) return dataBytes;
  const diskFreeBytes = parseNonNegativeNumber(values, "diskFreeBytes");
  if (!diskFreeBytes.ok) return diskFreeBytes;

  const serviceState = values["serviceState"];
  if (serviceState === undefined || !SERVICE_STATES.has(serviceState)) {
    return err({
      kind: "malformed_facts",
      field: "serviceState",
      message: "serviceState is not recognized",
    });
  }

  const environmentRole = values["environmentRole"];
  const comisVersion = values["comisVersion"];
  const dataMode = values["dataMode"];
  if (
    environmentRole !== undefined &&
    environmentRole !== "" &&
    !isSafeFactToken(environmentRole)
  ) {
    return err({
      kind: "malformed_facts",
      field: "environmentRole",
      message: "environmentRole is not a safe fact token",
    });
  }
  if (comisVersion !== undefined && comisVersion !== "" && !VERSION_RE.test(comisVersion)) {
    return err({
      kind: "malformed_facts",
      field: "comisVersion",
      message: "comisVersion must be a pinned semantic version",
    });
  }
  if (dataMode !== undefined && dataMode !== "" && !/^[0-7]{3,4}$/u.test(dataMode)) {
    return err({ kind: "malformed_facts", field: "dataMode", message: "dataMode is invalid" });
  }
  const nodeIdentityIsKnown = VERSION_RE.test(nodeVersion.value) && /^[0-9]+$/u.test(nodeAbi.value);
  if (
    (booleans.nodeReady && !nodeIdentityIsKnown) ||
    (!booleans.nodeReady && (nodeVersion.value !== "unknown" || nodeAbi.value !== "unknown"))
  ) {
    return err({
      kind: "malformed_facts",
      field: "nodeVersion",
      message: "Node identity does not match nodeReady",
    });
  }
  if (
    (booleans.comisInstalled && (comisVersion === undefined || comisVersion === "")) ||
    (!booleans.comisInstalled && comisVersion !== undefined && comisVersion !== "")
  ) {
    return err({
      kind: "malformed_facts",
      field: "comisVersion",
      message: "Comis version does not match installation status",
    });
  }
  if (
    (booleans.dataExists && (dataMode === undefined || dataMode === "")) ||
    (!booleans.dataExists && ((dataMode !== undefined && dataMode !== "") || dataBytes.value !== 0))
  ) {
    return err({
      kind: "malformed_facts",
      field: "dataMode",
      message: "Data directory facts are inconsistent",
    });
  }
  if (!booleans.systemdReady && launcherKind.value !== "unsupported") {
    return err({
      kind: "malformed_facts",
      field: "launcherKind",
      message: "Launcher identity does not match systemd availability",
    });
  }
  if (serviceState === "missing" && launcherKind.value !== "unsupported") {
    return err({
      kind: "malformed_facts",
      field: "launcherKind",
      message: "A missing service cannot have a systemd launcher identity",
    });
  }
  return ok({
    machineIdSha256: machineId.value,
    ...(environmentRole !== undefined && environmentRole !== "" ? { environmentRole } : {}),
    osId: osId.value,
    osVersion: osVersion.value,
    arch: arch.value,
    kernelRelease: kernelRelease.value,
    libcKind: libcKind.value as ProductionHostFacts["libcKind"],
    libcVersion: libcVersion.value,
    nodeVersion: nodeVersion.value,
    nodeAbi: nodeAbi.value,
    timezone: timezone.value,
    tzdataSha256: tzdataSha256.value,
    launcherKind: launcherKind.value as ProductionHostFacts["launcherKind"],
    launcherSha256: launcherSha256.value,
    ...booleans,
    ...(comisVersion !== undefined && comisVersion !== "" ? { comisVersion } : {}),
    serviceState: serviceState as ProductionHostFacts["serviceState"],
    ...(dataMode !== undefined && dataMode !== "" ? { dataMode } : {}),
    dataBytes: dataBytes.value,
    diskFreeBytes: diskFreeBytes.value,
  });
}

function requirePinnedIdentity(
  host: "source" | "target",
  expected: string | undefined,
  actual: string,
): Result<void, ProductionHostError> {
  if (expected === undefined) {
    return err({
      kind: "identity_unpinned",
      host,
      message: `${host} machine identity must be pinned before use`,
    });
  }
  if (expected !== actual) {
    return err({
      kind: "machine_mismatch",
      host,
      message: `${host} machine identity does not match the configured pin`,
    });
  }
  return ok(undefined);
}

export function attestSourceReadOnly(
  profile: ProductionReplayProfile,
  facts: ProductionHostFacts,
): Result<void, ProductionHostError> {
  const identity = requirePinnedIdentity(
    "source",
    profile.source.expectedMachineIdSha256,
    facts.machineIdSha256,
  );
  if (!identity.ok) return identity;
  if (facts.environmentRole !== undefined && facts.environmentRole !== "production") {
    return err({
      kind: "role_mismatch",
      host: "source",
      message: "Configured production source has an unrecognized or test environment role",
    });
  }
  if (
    !facts.sudoReady ||
    !facts.bashReady ||
    !facts.tarReady ||
    !facts.rsyncReady ||
    !facts.nodeReady ||
    facts.kernelRelease === "unknown" ||
    facts.osId === "unknown" ||
    facts.osVersion === "unknown" ||
    facts.arch === "unknown" ||
    facts.libcKind === "unknown" ||
    facts.libcVersion === "unknown" ||
    facts.nodeVersion === "unknown" ||
    facts.nodeAbi === "unknown" ||
    facts.timezone === "unknown" ||
    facts.tzdataSha256 === "none" ||
    !facts.comisInstalled ||
    facts.comisVersion === undefined ||
    !facts.dataExists ||
    facts.dataMode !== "700"
  ) {
    return err({
      kind: "unsupported_host",
      host: "source",
      message: "Source is not a readable private Comis installation",
    });
  }
  return ok(undefined);
}

export function attestSourceSnapshotReady(
  profile: ProductionReplayProfile,
  facts: ProductionHostFacts,
): Result<void, ProductionHostError> {
  const identity = attestSourceReadOnly(profile, facts);
  if (!identity.ok) return identity;
  if (
    !facts.systemdReady ||
    !facts.freezeReady ||
    facts.serviceState !== "active" ||
    facts.launcherKind !== "systemd" ||
    !SHA256_RE.test(facts.launcherSha256)
  ) {
    return err({
      kind: "unsupported_host",
      host: "source",
      message: "Source snapshot requires an active systemd service with freeze support",
    });
  }
  return ok(undefined);
}

export function attestTargetMutation(
  profile: ProductionReplayProfile,
  facts: ProductionHostFacts,
  purpose: TargetMutationPurpose,
): Result<void, ProductionHostError> {
  if (profile.source.expectedMachineIdSha256 === facts.machineIdSha256) {
    return err({
      kind: "source_target_conflict",
      message: "Target machine identity matches the configured production source",
    });
  }
  const identity = requirePinnedIdentity(
    "target",
    profile.target.expectedMachineIdSha256,
    facts.machineIdSha256,
  );
  if (!identity.ok) return identity;
  if (facts.environmentRole !== undefined && facts.environmentRole !== "test") {
    return err({
      kind: "role_mismatch",
      host: "target",
      message: "Target has an unrecognized or production environment role",
    });
  }
  if (
    purpose === "bootstrap" &&
    facts.environmentRole === undefined &&
    (facts.comisInstalled || facts.dataExists || facts.serviceState !== "missing")
  ) {
    return err({
      kind: "role_mismatch",
      host: "target",
      message: "An unmarked target must be a fresh machine before bootstrap",
    });
  }
  if (purpose === "restore" && facts.environmentRole !== "test") {
    return err({
      kind: "role_mismatch",
      host: "target",
      message: "Restore requires the target test-role marker",
    });
  }
  if (!facts.sudoReady || !facts.systemdReady || !facts.bashReady || !facts.tarReady) {
    return err({
      kind: "unsupported_host",
      host: "target",
      message: "Target lacks sudo, systemd, bash, or tar",
    });
  }
  return ok(undefined);
}

export function buildInstallerRemoteArgs(
  version: string,
  comisUser: string,
): Result<readonly string[], ProductionHostError> {
  if (!VERSION_RE.test(version)) {
    return err({ kind: "unsafe_version", message: "Comis version is not a pinned semantic version" });
  }
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(comisUser)) {
    return err({ kind: "unsafe_version", message: "Comis service user is unsafe" });
  }
  return ok([
    "sudo",
    "bash",
    "-s",
    "--",
    "--yes",
    "--no-prompt",
    "--no-init",
    "--no-service-start",
    "--no-autostart",
    "--service",
    "systemd",
    "--user",
    comisUser,
    "--install-method",
    "npm",
    "--version",
    version,
    "--with-browser",
    "--with-xvfb",
  ]);
}

export function buildHostProbeScript(): string {
  return String.raw`set -u
LC_ALL=C
export LC_ALL
service="$1"
data_dir="$2"
comis_user="$3"

bool_command() {
  if command -v "$1" >/dev/null 2>&1; then printf 'true'; else printf 'false'; fi
}

machine_hash="$(sha256sum /etc/machine-id 2>/dev/null | awk '{print $1}')"
role="$(sudo -n cat /etc/comis/environment-role 2>/dev/null || true)"
os_id="unknown"
os_version="unknown"
if [ -r /etc/os-release ]; then
  ID=""
  VERSION_ID=""
  . /etc/os-release
  os_id="$ID"
  os_version="$VERSION_ID"
  if [ -z "$os_id" ]; then os_id=unknown; fi
  if [ -z "$os_version" ]; then os_version=unknown; fi
fi
kernel_release="$(uname -r 2>/dev/null || true)"
if [ -z "$kernel_release" ]; then kernel_release=unknown; fi

libc_kind=unknown
libc_version=unknown
gnu_libc="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
case "$gnu_libc" in
  'glibc '*) libc_kind=glibc; libc_version="$(printf '%s\n' "$gnu_libc" | cut -d ' ' -f 2-)" ;;
  *)
    if [ "$(uname -s 2>/dev/null || true)" = Darwin ]; then
      libc_kind=darwin
      libc_version="$(sw_vers -productVersion 2>/dev/null || true)"
    else
      ldd_output="$(ldd --version 2>&1 | head -n 4 || true)"
      case "$ldd_output" in
        *musl*) libc_kind=musl; libc_version="$(printf '%s\n' "$ldd_output" | sed -n 's/.*Version \([0-9][0-9.]*\).*/\1/p' | head -n 1)" ;;
        '') ;;
        *) libc_kind=other; libc_version="$(printf '%s' "$ldd_output" | sha256sum | awk '{print $1}')" ;;
      esac
    fi
    ;;
esac
if [ -z "$libc_version" ]; then libc_version=unknown; fi

timezone="$(timedatectl show --property=Timezone --value 2>/dev/null || true)"
if [ -z "$timezone" ] && [ -r /etc/timezone ]; then timezone="$(head -n 1 /etc/timezone 2>/dev/null || true)"; fi
if [ -z "$timezone" ]; then
  localtime_target="$(readlink /etc/localtime 2>/dev/null || true)"
  case "$localtime_target" in */zoneinfo/*) timezone="$(printf '%s\n' "$localtime_target" | sed 's#^.*/zoneinfo/##')" ;; esac
fi
if [ -z "$timezone" ]; then timezone=unknown; fi
tzdata_sha=none
tzdata_path=/usr/share/zoneinfo/tzdata.zi
if [ ! -r "$tzdata_path" ]; then tzdata_path=/etc/localtime; fi
if [ -r "$tzdata_path" ]; then tzdata_sha="$(sha256sum "$tzdata_path" 2>/dev/null | awk '{print $1}')"; fi
case "$tzdata_sha" in ''|*[!a-f0-9]*) tzdata_sha=none ;; esac

sudo_ready=false
if sudo -n true 2>/dev/null; then sudo_ready=true; fi
systemd_ready=false
if command -v systemctl >/dev/null 2>&1; then systemd_ready=true; fi
freeze_ready=false
if [ "$systemd_ready" = true ] && systemctl --help 2>/dev/null | grep -q 'freeze'; then freeze_ready=true; fi

service_state=missing
service_enabled=false
launcher_kind=unsupported
launcher_sha=none
exec_start=""
if [ "$systemd_ready" = true ]; then
  load_state="$(systemctl show "$service" --property=LoadState --value 2>/dev/null || true)"
  if [ -n "$load_state" ] && [ "$load_state" != not-found ]; then
    launcher_facts="$(systemctl show "$service" --no-pager --property=FragmentPath,DropInPaths,ExecStart,ExecStartPre,ExecStartPost,ExecCondition,User,Group,WorkingDirectory,RootDirectory,UMask,Environment,EnvironmentFiles,PassEnvironment,UnsetEnvironment,RuntimeDirectory,RestrictAddressFamilies,IPAddressDeny,NoNewPrivileges,ProtectSystem,ProtectHome,PrivateTmp,PrivateDevices,PrivateUsers,ProtectKernelTunables,ProtectControlGroups,ReadOnlyPaths,ReadWritePaths 2>/dev/null || true)"
    if [ -n "$launcher_facts" ]; then
      launcher_kind=systemd
      launcher_sha="$(printf '%s' "$launcher_facts" | sha256sum | awk '{print $1}')"
    fi
    exec_start="$(systemctl show "$service" --property=ExecStart --value 2>/dev/null || true)"
    service_state="$(systemctl is-active "$service" 2>/dev/null || true)"
    case "$service_state" in active|inactive|failed) ;; *) service_state=unknown ;; esac
    if systemctl is-enabled "$service" >/dev/null 2>&1; then service_enabled=true; fi
  fi
fi

node_path="$(printf '%s\n' "$exec_start" | sed -n 's/^[{ ]*path=\([^ ;]*\).*/\1/p')"
if [ -z "$node_path" ] || [ ! -x "$node_path" ]; then node_path="$(command -v node 2>/dev/null || true)"; fi
node_version=unknown
node_abi=unknown
if [ -n "$node_path" ] && [ -x "$node_path" ]; then
  node_version="$("$node_path" -p 'process.versions.node' 2>/dev/null || true)"
  node_abi="$("$node_path" -p 'process.versions.modules || "unknown"' 2>/dev/null || true)"
  if [ -z "$node_version" ]; then node_version=unknown; fi
  if [ -z "$node_abi" ]; then node_abi=unknown; fi
fi

daemon_path="$(printf '%s\n' "$exec_start" | grep -oE '/[^ ;{}]+/node_modules/@comis/daemon/dist/[A-Za-z0-9._-]+\.js' | tail -1)"
package_root="$(printf '%s\n' "$daemon_path" | sed 's#/node_modules/@comis/daemon/dist/.*##')"
package_json="$package_root/package.json"
if [ -z "$daemon_path" ]; then
  comis_home="$(getent passwd "$comis_user" 2>/dev/null | awk -F: '{print $6}')"
  package_json="$comis_home/.npm-global/lib/node_modules/comisai/package.json"
fi
comis_installed=false
comis_version=""
if [ -n "$node_path" ] && [ -x "$node_path" ] && sudo -n test -r "$package_json" 2>/dev/null; then
  comis_installed=true
  comis_version="$(sudo -n "$node_path" -e "const fs=require('node:fs');const raw=fs.readFileSync(process.argv[1],'utf8');process.stdout.write(JSON.parse(raw).version)" "$package_json" 2>/dev/null || true)"
fi

data_exists=false
data_mode=""
data_bytes=0
if sudo -n test -d "$data_dir" 2>/dev/null; then
  data_exists=true
  data_mode="$(sudo -n stat -c '%a' "$data_dir" 2>/dev/null || true)"
  data_bytes="$(sudo -n du -sb "$data_dir" 2>/dev/null | awk '{print $1}')"
fi
disk_path="$data_dir"
while [ ! -e "$disk_path" ] && [ "$disk_path" != / ]; do disk_path="$(dirname "$disk_path")"; done
disk_free="$(df -PB1 "$disk_path" 2>/dev/null | awk 'NR==2 {print $4}')"
case "$disk_free" in ''|*[!0-9]*) disk_free=0 ;; esac
case "$data_bytes" in ''|*[!0-9]*) data_bytes=0 ;; esac

printf '%s\n' \
  "machineIdSha256=$machine_hash" \
  "environmentRole=$role" \
  "osId=$os_id" \
  "osVersion=$os_version" \
  "arch=$(uname -m)" \
  "kernelRelease=$kernel_release" \
  "libcKind=$libc_kind" \
  "libcVersion=$libc_version" \
  "nodeVersion=$node_version" \
  "nodeAbi=$node_abi" \
  "timezone=$timezone" \
  "tzdataSha256=$tzdata_sha" \
  "launcherKind=$launcher_kind" \
  "launcherSha256=$launcher_sha" \
  "sudoReady=$sudo_ready" \
  "systemdReady=$systemd_ready" \
  "freezeReady=$freeze_ready" \
  "bashReady=$(bool_command bash)" \
  "tarReady=$(bool_command tar)" \
  "rsyncReady=$(bool_command rsync)" \
  "curlReady=$(bool_command curl)" \
  "nodeReady=$(if [ -n "$node_path" ] && [ -x "$node_path" ]; then printf true; else printf false; fi)" \
  "npmReady=$(bool_command npm)" \
  "browserReady=$(if command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1 || command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1; then printf true; else printf false; fi)" \
  "xvfbReady=$(bool_command Xvfb)" \
  "ffmpegReady=$(bool_command ffmpeg)" \
  "ffprobeReady=$(bool_command ffprobe)" \
  "bwrapReady=$(bool_command bwrap)" \
  "zstdReady=$(bool_command zstd)" \
  "comisInstalled=$comis_installed" \
  "comisVersion=$comis_version" \
  "serviceState=$service_state" \
  "serviceEnabled=$service_enabled" \
  "dataExists=$data_exists" \
  "dataMode=$data_mode" \
  "dataBytes=$data_bytes" \
  "diskFreeBytes=$disk_free"
`;
}
