// SPDX-License-Identifier: Apache-2.0
import { err, ok, type Result } from "@comis/shared";

import type { ProductionReplayProfile } from "./production-profile.js";

export interface ProductionHostFacts {
  readonly machineIdSha256: string;
  readonly environmentRole?: string;
  readonly osId: string;
  readonly osVersion: string;
  readonly arch: string;
  readonly sudoReady: boolean;
  readonly systemdReady: boolean;
  readonly freezeReady: boolean;
  readonly bashReady: boolean;
  readonly tarReady: boolean;
  readonly rsyncReady: boolean;
  readonly curlReady: boolean;
  readonly nodeReady: boolean;
  readonly npmReady: boolean;
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

function parseKeyValues(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/u)) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (/^[A-Za-z][A-Za-z0-9]*$/u.test(key)) values[key] = value;
  }
  return values;
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
  const values = parseKeyValues(raw);
  const machineId = requireValue(values, "machineIdSha256");
  if (!machineId.ok) return machineId;
  if (!SHA256_RE.test(machineId.value)) {
    return err({
      kind: "malformed_facts",
      field: "machineIdSha256",
      message: "machineIdSha256 must be a lowercase SHA-256 digest",
    });
  }
  const osId = requireValue(values, "osId");
  if (!osId.ok) return osId;
  const osVersion = requireValue(values, "osVersion");
  if (!osVersion.ok) return osVersion;
  const arch = requireValue(values, "arch");
  if (!arch.ok) return arch;

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
  return ok({
    machineIdSha256: machineId.value,
    ...(environmentRole !== undefined && environmentRole !== "" ? { environmentRole } : {}),
    osId: osId.value,
    osVersion: osVersion.value,
    arch: arch.value,
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
  if (!facts.systemdReady || !facts.freezeReady || facts.serviceState !== "active") {
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

sudo_ready=false
if sudo -n true 2>/dev/null; then sudo_ready=true; fi
systemd_ready=false
if command -v systemctl >/dev/null 2>&1; then systemd_ready=true; fi
freeze_ready=false
if [ "$systemd_ready" = true ] && systemctl --help 2>/dev/null | grep -q 'freeze'; then freeze_ready=true; fi

service_state=missing
service_enabled=false
if [ "$systemd_ready" = true ]; then
  load_state="$(systemctl show "$service" --property=LoadState --value 2>/dev/null || true)"
  if [ -n "$load_state" ] && [ "$load_state" != not-found ]; then
    service_state="$(systemctl is-active "$service" 2>/dev/null || true)"
    case "$service_state" in active|inactive|failed) ;; *) service_state=unknown ;; esac
    if systemctl is-enabled "$service" >/dev/null 2>&1; then service_enabled=true; fi
  fi
fi

comis_home="$(getent passwd "$comis_user" 2>/dev/null | awk -F: '{print $6}')"
package_json="$comis_home/.npm-global/lib/node_modules/comisai/package.json"
comis_installed=false
comis_version=""
if [ -n "$comis_home" ] && sudo -n test -r "$package_json" 2>/dev/null; then
  comis_installed=true
  comis_version="$(sudo -n -u "$comis_user" /usr/bin/node -e "const fs=require('node:fs');const raw=fs.readFileSync(process.argv[1],'utf8');process.stdout.write(JSON.parse(raw).version)" "$package_json" 2>/dev/null || true)"
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
  "sudoReady=$sudo_ready" \
  "systemdReady=$systemd_ready" \
  "freezeReady=$freeze_ready" \
  "bashReady=$(bool_command bash)" \
  "tarReady=$(bool_command tar)" \
  "rsyncReady=$(bool_command rsync)" \
  "curlReady=$(bool_command curl)" \
  "nodeReady=$(bool_command node)" \
  "npmReady=$(bool_command npm)" \
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
