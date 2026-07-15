// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

import { err, ok, tryCatch, type Result } from "@comis/shared";

import type {
  ProductionRemoteExecutor,
  ProductionRemoteInvocation,
} from "./production-bootstrap.js";

export const PRODUCTION_SERVICE_FINGERPRINT_BEGIN =
  "COMIS_PRODUCTION_SERVICE_FINGERPRINT_V1_BEGIN";
export const PRODUCTION_SERVICE_FINGERPRINT_END =
  "COMIS_PRODUCTION_SERVICE_FINGERPRINT_V1_END";

const MAX_ENVELOPE_BYTES = 2048;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const HOST_CHARACTERS_RE = /^[A-Za-z0-9._@-]+$/u;
const SERVICE_RE = /^[A-Za-z_][A-Za-z0-9_.@-]{0,127}$/u;
const NON_SERVICE_SUFFIX_RE = /\.(?:automount|device|mount|path|scope|slice|socket|swap|target|timer)$/u;

const FINGERPRINT_KEYS = [
  "schema",
  "schemaVersion",
  "role",
  "machineIdSha256",
  "bootIdSha256",
  "unitSha256",
  "propertySnapshotSha256",
  "executionDefinitionSha256",
  "fingerprintSha256",
  "loadState",
  "activeState",
  "subState",
  "mainPid",
  "controlPid",
  "execMainPid",
  "stabilityMethod",
  "stable",
] as const;
const CANONICAL_FINGERPRINT_KEYS = [...FINGERPRINT_KEYS].sort();

export interface ProductionServiceFingerprintInput {
  readonly host: string;
  readonly port?: number;
  readonly role: "source" | "target";
  readonly expectedMachineIdSha256: string;
  readonly service: string;
}

export interface ProductionServiceFingerprint {
  readonly schema: "comis-production-service-fingerprint";
  readonly schemaVersion: 1;
  readonly role: "source" | "target";
  readonly machineIdSha256: string;
  readonly bootIdSha256: string;
  readonly unitSha256: string;
  readonly propertySnapshotSha256: string;
  readonly executionDefinitionSha256: string;
  readonly fingerprintSha256: string;
  readonly loadState: "loaded";
  readonly activeState: "inactive";
  readonly subState: "dead";
  readonly mainPid: 0;
  readonly controlPid: 0;
  readonly execMainPid: 0;
  readonly stabilityMethod: "bounded_double_scan";
  readonly stable: true;
}

export interface ProductionServiceFingerprintComparison {
  readonly exact: true;
  readonly machineIdSha256: string;
  readonly bootIdSha256: string;
  readonly fingerprintSha256: string;
}

export type ProductionServiceFingerprintMismatchField = Exclude<
  keyof ProductionServiceFingerprint,
  "schema" | "schemaVersion"
>;

export type ProductionServiceFingerprintError =
  | {
      readonly kind: "unsafe_input";
      readonly field: "host" | "port" | "role" | "machineIdSha256" | "service";
      readonly message: string;
    }
  | {
      readonly kind: "remote_failure";
      readonly stage: "fingerprint-source-service" | "fingerprint-target-service";
      readonly message: string;
      readonly outcome:
        | { readonly kind: "remote_exit"; readonly exitCode: number }
        | { readonly kind: "transport_failure" };
    }
  | {
      readonly kind: "malformed_fingerprint";
      readonly message: string;
    }
  | {
      readonly kind: "binding_mismatch";
      readonly field: "role" | "machineIdSha256" | "unitSha256";
      readonly message: string;
    }
  | {
      readonly kind: "fingerprint_mismatch";
      readonly field: ProductionServiceFingerprintMismatchField;
      readonly message: string;
    };

const SERVICE_FINGERPRINT_SCRIPT = String.raw`import glob
import hashlib
import json
import os
import re
import stat
import subprocess
import sys

MAX_PROPERTY_BYTES = 1048576
MAX_DEFINITION_FILES = 256
MAX_DEFINITION_FILE_BYTES = 4194304
MAX_UNIT_DEFINITION_BYTES = 16777216
MAX_ENVIRONMENT_BYTES = 16777216
MAX_PATH_BYTES = 4096
READ_CHUNK_BYTES = 65536
SHA256 = re.compile(r"^[a-f0-9]{64}$")
SERVICE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.@-]{0,127}$")
NON_SERVICE_SUFFIX = re.compile(r"\.(?:automount|device|mount|path|scope|slice|socket|swap|target|timer)$")
REQUIRED_PROPERTIES = (
    "LoadState",
    "ActiveState",
    "SubState",
    "UnitFileState",
    "MainPID",
    "ControlPID",
    "ExecMainPID",
    "StateChangeTimestampMonotonic",
    "ActiveEnterTimestampMonotonic",
    "ActiveExitTimestampMonotonic",
    "InactiveEnterTimestampMonotonic",
    "InactiveExitTimestampMonotonic",
    "ExecMainStartTimestampMonotonic",
    "ExecMainExitTimestampMonotonic",
    "InvocationID",
    "NRestarts",
    "Result",
    "ExecMainCode",
    "ExecMainStatus",
    "FragmentPath",
    "DropInPaths",
    "NeedDaemonReload",
    "EnvironmentFiles",
    "ExecStart",
    "ExecStartPre",
    "ExecStartPost",
    "ExecCondition",
    "User",
    "Group",
    "WorkingDirectory",
    "RootDirectory",
    "UMask",
    "Environment",
    "PassEnvironment",
    "UnsetEnvironment",
    "Type",
    "NotifyAccess",
    "Restart",
    "RestartUSec",
    "TimeoutStartUSec",
    "TimeoutStopUSec",
    "KillMode",
    "KillSignal",
    "SuccessExitStatus",
)
MONOTONIC_PROPERTIES = (
    "StateChangeTimestampMonotonic",
    "ActiveEnterTimestampMonotonic",
    "ActiveExitTimestampMonotonic",
    "InactiveEnterTimestampMonotonic",
    "InactiveExitTimestampMonotonic",
    "ExecMainStartTimestampMonotonic",
    "ExecMainExitTimestampMonotonic",
)


def fail(code):
    sys.stderr.write("Source service fingerprint probe failed\n")
    raise SystemExit(code)


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def read_stream_bounded(stream, maximum):
    chunks = []
    total = 0
    while True:
        chunk = stream.read(READ_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > maximum:
            fail(76)
        chunks.append(chunk)
    return b"".join(chunks)


def run_bounded(arguments, maximum):
    try:
        process = subprocess.Popen(
            arguments,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
        if process.stdout is None:
            fail(77)
        output = read_stream_bounded(process.stdout, maximum)
        status = process.wait()
    except (OSError, ValueError):
        fail(77)
    if status != 0:
        fail(77)
    return output


def read_identity_file(path, maximum, noatime):
    flags = os.O_RDONLY | os.O_CLOEXEC
    if noatime:
        noatime_flag = getattr(os, "O_NOATIME", None)
        if noatime_flag is None:
            fail(78)
        flags |= noatime_flag
    try:
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb", closefd=True) as handle:
            value = read_stream_bounded(handle, maximum)
    except OSError:
        fail(78)
    if not value:
        fail(78)
    return value


def canonical_snapshot(unit):
    output = run_bounded(["systemctl", "show", "--all", "--no-pager", unit], MAX_PROPERTY_BYTES)
    if b"\x00" in output or b"\r" in output:
        fail(79)
    try:
        text = output.decode("utf-8", "strict")
    except UnicodeDecodeError:
        fail(79)
    properties = {}
    for line in text.splitlines():
        if not line or "=" not in line:
            fail(79)
        key, value = line.split("=", 1)
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", key) or key in properties:
            fail(79)
        properties[key] = value
    if any(key not in properties for key in REQUIRED_PROPERTIES):
        fail(79)
    if (
        properties["LoadState"] != "loaded"
        or properties["ActiveState"] != "inactive"
        or properties["SubState"] != "dead"
        or properties["MainPID"] != "0"
        or properties["ControlPID"] != "0"
        or properties["ExecMainPID"] != "0"
        or properties["NeedDaemonReload"] != "no"
    ):
        fail(80)
    if any(not properties[key].isdigit() for key in MONOTONIC_PROPERTIES):
        fail(79)
    if not properties["NRestarts"].isdigit():
        fail(79)
    invocation_id = properties["InvocationID"]
    if invocation_id and not re.fullmatch(r"[a-f0-9]{32}", invocation_id):
        fail(79)
    canonical = "".join(key + "=" + properties[key] + "\n" for key in sorted(properties)).encode("utf-8")
    if len(canonical) > MAX_PROPERTY_BYTES:
        fail(76)
    return properties, canonical


def decode_systemd_word(raw):
    if len(raw) >= 2 and raw[0] == '"' and raw[-1] == '"':
        raw = raw[1:-1]
    output = bytearray()
    index = 0
    encoded = raw.encode("utf-8")
    while index < len(encoded):
        value = encoded[index]
        if value != 92:
            output.append(value)
            index += 1
            continue
        if index + 3 < len(encoded) and encoded[index + 1] == 120:
            try:
                output.append(int(encoded[index + 2:index + 4].decode("ascii"), 16))
            except ValueError:
                fail(81)
            index += 4
            continue
        if index + 1 >= len(encoded):
            fail(81)
        escaped = encoded[index + 1]
        translations = {92: 92, 34: 34, 115: 32, 116: 9}
        if escaped not in translations:
            fail(81)
        output.append(translations[escaped])
        index += 2
    try:
        decoded = output.decode("utf-8", "strict")
    except UnicodeDecodeError:
        fail(81)
    if (
        not decoded.startswith("/")
        or "\x00" in decoded
        or "\n" in decoded
        or "\r" in decoded
        or len(output) > MAX_PATH_BYTES
    ):
        fail(81)
    return decoded


def split_systemd_words(value):
    if not value:
        return []
    token = re.compile(r'"(?:\\.|[^"\\])*"|(?:\\.|[^\s"\\])+')
    words = []
    position = 0
    for match in token.finditer(value):
        if value[position:match.start()].strip():
            fail(81)
        words.append(decode_systemd_word(match.group(0)))
        position = match.end()
    if value[position:].strip():
        fail(81)
    return words


def parse_environment_files(value):
    if not value:
        return []
    path_token = r'(?P<path>"(?:\\.|[^"\\])*"|(?:\\.|[^\s;}])+)'
    struct_pattern = re.compile(
        r'\{\s*path=' + path_token + r'\s*;\s*ignore_errors=(?P<ignore>yes|no)\s*\}'
    )
    classic_pattern = re.compile(
        path_token + r'\s+\(ignore_errors=(?P<ignore>yes|no)\)'
    )
    pattern = struct_pattern if value.lstrip().startswith("{") else classic_pattern
    entries = []
    position = 0
    for match in pattern.finditer(value):
        if value[position:match.start()].strip():
            fail(81)
        raw_path = match.group("path")
        ignore_errors = match.group("ignore") == "yes"
        ignored_prefix = raw_path.startswith("-/") or raw_path.startswith('"-/')
        if raw_path.startswith("-/"):
            raw_path = raw_path[1:]
        elif raw_path.startswith('"-/'):
            raw_path = '"' + raw_path[2:]
        if ignored_prefix and not ignore_errors:
            fail(81)
        entries.append((decode_systemd_word(raw_path), ignore_errors))
        position = match.end()
    if not entries or value[position:].strip():
        fail(81)
    return entries


def read_definition_file(path, remaining):
    if remaining < 0:
        fail(82)
    noatime_flag = getattr(os, "O_NOATIME", None)
    if noatime_flag is None:
        fail(82)
    flags = os.O_RDONLY | os.O_CLOEXEC | noatime_flag
    try:
        before = os.stat(path, follow_symlinks=True)
        if not stat.S_ISREG(before.st_mode):
            fail(82)
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb", closefd=True) as handle:
            opened = os.fstat(handle.fileno())
            if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                fail(82)
            value = read_stream_bounded(handle, min(MAX_DEFINITION_FILE_BYTES, remaining))
            after = os.fstat(handle.fileno())
        final = os.stat(path, follow_symlinks=True)
    except OSError:
        fail(82)
    stable_fields = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_size", "st_mtime_ns", "st_ctime_ns")
    if any(getattr(before, field) != getattr(after, field) for field in stable_fields):
        fail(82)
    if any(getattr(before, field) != getattr(final, field) for field in stable_fields):
        fail(82)
    return value


def add_definition_record(digest, category, path, state, content):
    path_bytes = path.encode("utf-8")
    digest.update(category.encode("ascii") + b"\x00")
    digest.update(str(len(path_bytes)).encode("ascii") + b"\x00" + path_bytes + b"\x00")
    digest.update(state.encode("ascii") + b"\x00")
    digest.update(str(len(content)).encode("ascii") + b"\x00" + content + b"\x00")


def collect_execution_definition(properties, canonical_properties):
    digest = hashlib.sha256()
    digest.update(b"comis-production-execution-definition-v1\x00")
    digest.update(str(len(canonical_properties)).encode("ascii") + b"\x00")
    digest.update(canonical_properties)
    definition_paths = []
    fragment = properties["FragmentPath"]
    if not fragment:
        fail(83)
    definition_paths.append(("fragment", decode_systemd_word(fragment)))
    definition_paths.extend(("drop-in", path) for path in split_systemd_words(properties["DropInPaths"]))
    environment_entries = parse_environment_files(properties["EnvironmentFiles"])
    if len(definition_paths) + len(environment_entries) > MAX_DEFINITION_FILES:
        fail(83)
    file_count = 0
    unit_definition_bytes = 0
    environment_bytes = 0
    seen = set()
    for category, path in definition_paths:
        identity = (category, path)
        if identity in seen:
            fail(83)
        seen.add(identity)
        file_count += 1
        if file_count > MAX_DEFINITION_FILES:
            fail(83)
        remaining = MAX_UNIT_DEFINITION_BYTES - unit_definition_bytes
        content = read_definition_file(path, min(MAX_DEFINITION_FILE_BYTES, remaining))
        unit_definition_bytes += len(content)
        if unit_definition_bytes > MAX_UNIT_DEFINITION_BYTES:
            fail(83)
        add_definition_record(digest, category, path, "present", content)
    for pattern, ignore_errors in environment_entries:
        try:
            matches = []
            for path in glob.iglob(pattern, recursive=False):
                matches.append(path)
                if len(matches) + file_count > MAX_DEFINITION_FILES:
                    fail(83)
            matches.sort()
        except (OSError, ValueError):
            fail(83)
        if not matches:
            file_count += 1
            if file_count > MAX_DEFINITION_FILES:
                fail(83)
            marker = b"ignore" if ignore_errors else b"required"
            add_definition_record(digest, "environment", pattern, "missing", marker)
            continue
        for path in matches:
            file_count += 1
            if file_count > MAX_DEFINITION_FILES:
                fail(83)
            if len(path.encode("utf-8")) > MAX_PATH_BYTES or not path.startswith("/"):
                fail(83)
            remaining = MAX_ENVIRONMENT_BYTES - environment_bytes
            content = read_definition_file(path, min(MAX_DEFINITION_FILE_BYTES, remaining))
            environment_bytes += len(content)
            if environment_bytes > MAX_ENVIRONMENT_BYTES:
                fail(83)
            add_definition_record(digest, "environment", path, "present", content)
    return digest.hexdigest()


if len(sys.argv) != 4 or os.geteuid() != 0:
    fail(70)
expected_machine = sys.argv[1]
service = sys.argv[2]
role = sys.argv[3]
if (
    not SHA256.fullmatch(expected_machine)
    or not SERVICE.fullmatch(service)
    or NON_SERVICE_SUFFIX.search(service)
    or role not in ("source", "target")
):
    fail(70)
unit = service if service.endswith(".service") else service + ".service"

machine_before = sha256_bytes(read_identity_file("/etc/machine-id", 4096, True))
boot_before = sha256_bytes(read_identity_file("/proc/sys/kernel/random/boot_id", 4096, False))
if machine_before != expected_machine:
    fail(71)

properties_before, snapshot_before = canonical_snapshot(unit)
definition_before = collect_execution_definition(properties_before, snapshot_before)
properties_middle, snapshot_middle = canonical_snapshot(unit)
definition_middle = collect_execution_definition(properties_middle, snapshot_middle)
properties_after, snapshot_after = canonical_snapshot(unit)
definition_after = collect_execution_definition(properties_after, snapshot_after)
properties_final, snapshot_final = canonical_snapshot(unit)

machine_after = sha256_bytes(read_identity_file("/etc/machine-id", 4096, True))
boot_after = sha256_bytes(read_identity_file("/proc/sys/kernel/random/boot_id", 4096, False))
if (
    machine_before != machine_after
    or boot_before != boot_after
    or snapshot_before != snapshot_middle
    or snapshot_before != snapshot_after
    or snapshot_before != snapshot_final
    or definition_before != definition_middle
    or definition_before != definition_after
):
    fail(84)

property_digest = sha256_bytes(snapshot_before)
unit_digest = sha256_bytes(unit.encode("utf-8"))
combined = hashlib.sha256()
combined.update(b"comis-production-service-fingerprint-v1\x00")
combined.update(role.encode("ascii") + b"\x00")
for value in (machine_before, boot_before, unit_digest, property_digest, definition_before):
    combined.update(value.encode("ascii") + b"\x00")
report = {
    "schema": "comis-production-service-fingerprint",
    "schemaVersion": 1,
    "role": role,
    "machineIdSha256": machine_before,
    "bootIdSha256": boot_before,
    "unitSha256": unit_digest,
    "propertySnapshotSha256": property_digest,
    "executionDefinitionSha256": definition_before,
    "fingerprintSha256": combined.hexdigest(),
    "loadState": "loaded",
    "activeState": "inactive",
    "subState": "dead",
    "mainPid": 0,
    "controlPid": 0,
    "execMainPid": 0,
    "stabilityMethod": "bounded_double_scan",
    "stable": True,
}
encoded = json.dumps(report, sort_keys=True, separators=(",", ":"))
if len(encoded.encode("utf-8")) > 1536:
    fail(85)
sys.stdout.write("COMIS_PRODUCTION_SERVICE_FINGERPRINT_V1_BEGIN\n")
sys.stdout.write(encoded + "\n")
sys.stdout.write("COMIS_PRODUCTION_SERVICE_FINGERPRINT_V1_END\n")
`;

function unsafeInput(
  field: "host" | "port" | "role" | "machineIdSha256" | "service",
): Result<never, ProductionServiceFingerprintError> {
  return err({
    kind: "unsafe_input",
    field,
    message: `Service fingerprint ${field} is unsafe`,
  });
}

function isSafeHost(host: string): boolean {
  if (host.length === 0 || host.length > 255 || !HOST_CHARACTERS_RE.test(host)) return false;
  const parts = host.split("@");
  if (parts.length > 2) return false;
  if (parts.length === 2 && parts[0] === "") return false;
  const endpoint = parts.length === 2 ? parts[1] : parts[0];
  return endpoint !== undefined && /^[A-Za-z0-9]/u.test(endpoint);
}

function normalizedUnit(service: string): string {
  return service.endsWith(".service") ? service : `${service}.service`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function combinedFingerprint(value: {
  readonly role: "source" | "target";
  readonly machineIdSha256: string;
  readonly bootIdSha256: string;
  readonly unitSha256: string;
  readonly propertySnapshotSha256: string;
  readonly executionDefinitionSha256: string;
}): string {
  const hash = createHash("sha256");
  hash.update("comis-production-service-fingerprint-v1\0", "utf8");
  hash.update(value.role, "utf8");
  hash.update("\0", "utf8");
  for (const field of [
    value.machineIdSha256,
    value.bootIdSha256,
    value.unitSha256,
    value.propertySnapshotSha256,
    value.executionDefinitionSha256,
  ]) {
    hash.update(field, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

export function computeProductionServiceRecoveryDigest(
  value: ProductionServiceFingerprint,
): Result<string, ProductionServiceFingerprintError> {
  if (
    value.schema !== "comis-production-service-fingerprint" ||
    value.schemaVersion !== 1 ||
    (value.role !== "source" && value.role !== "target") ||
    ![
      value.machineIdSha256,
      value.bootIdSha256,
      value.unitSha256,
      value.propertySnapshotSha256,
      value.executionDefinitionSha256,
      value.fingerprintSha256,
    ].every((field) => typeof field === "string" && SHA256_RE.test(field)) ||
    value.fingerprintSha256 !== combinedFingerprint(value) ||
    value.loadState !== "loaded" ||
    value.activeState !== "inactive" ||
    value.subState !== "dead" ||
    value.mainPid !== 0 ||
    value.controlPid !== 0 ||
    value.execMainPid !== 0 ||
    value.stabilityMethod !== "bounded_double_scan" ||
    value.stable !== true
  ) {
    return err({
      kind: "malformed_fingerprint",
      message: "Service fingerprint cannot authorize crash recovery",
    });
  }
  const hash = createHash("sha256");
  hash.update("comis-production-service-recovery-v1\0", "utf8");
  for (const field of [
    value.role,
    value.machineIdSha256,
    value.unitSha256,
    value.executionDefinitionSha256,
  ]) {
    hash.update(field, "utf8");
    hash.update("\0", "utf8");
  }
  return ok(hash.digest("hex"));
}

export function buildProductionServiceFingerprintInvocation(
  input: ProductionServiceFingerprintInput,
): Result<ProductionRemoteInvocation, ProductionServiceFingerprintError> {
  if (!isSafeHost(input.host)) return unsafeInput("host");
  if (input.role !== "source" && input.role !== "target") return unsafeInput("role");
  if (
    input.port !== undefined &&
    (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535)
  ) {
    return unsafeInput("port");
  }
  if (
    typeof input.expectedMachineIdSha256 !== "string" ||
    !SHA256_RE.test(input.expectedMachineIdSha256)
  ) {
    return unsafeInput("machineIdSha256");
  }
  if (
    typeof input.service !== "string" ||
    !SERVICE_RE.test(input.service) ||
    input.service.includes("..") ||
    NON_SERVICE_SUFFIX_RE.test(input.service)
  ) {
    return unsafeInput("service");
  }
  return ok({
    label:
      input.role === "source"
        ? "fingerprint-source-service"
        : "fingerprint-target-service",
    host: input.host,
    ...(input.port !== undefined ? { port: input.port } : {}),
    args: [
      "/usr/bin/sudo",
      "/usr/bin/env",
      "-i",
      "PATH=/usr/bin:/bin",
      "LC_ALL=C",
      "TZ=Etc/UTC",
      "/usr/bin/python3",
      "-I",
      "-S",
      "-B",
      "-",
      input.expectedMachineIdSha256,
      input.service,
      input.role,
    ],
    stdin: SERVICE_FINGERPRINT_SCRIPT,
    stdoutLimitBytes: MAX_ENVELOPE_BYTES,
    timeoutMs: 30_000,
  });
}

function malformed(): Result<never, ProductionServiceFingerprintError> {
  return err({
    kind: "malformed_fingerprint",
    message: "Service fingerprint envelope is invalid",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === FINGERPRINT_KEYS.length &&
    keys.every((key) => FINGERPRINT_KEYS.includes(key as (typeof FINGERPRINT_KEYS)[number]))
  );
}

export function parseProductionServiceFingerprint(
  raw: string,
): Result<ProductionServiceFingerprint, ProductionServiceFingerprintError> {
  if (
    Buffer.byteLength(raw, "utf8") > MAX_ENVELOPE_BYTES ||
    raw.includes("\0") ||
    raw.includes("\r") ||
    !raw.endsWith("\n")
  ) {
    return malformed();
  }
  const normalized = raw.slice(0, -1);
  const lines = normalized.split("\n");
  if (
    lines.length !== 3 ||
    lines[0] !== PRODUCTION_SERVICE_FINGERPRINT_BEGIN ||
    lines[2] !== PRODUCTION_SERVICE_FINGERPRINT_END
  ) {
    return malformed();
  }
  const decoded = tryCatch(() => JSON.parse(lines[1] as string) as unknown);
  if (!decoded.ok || !isRecord(decoded.value) || !hasExactKeys(decoded.value)) {
    return malformed();
  }
  if (JSON.stringify(decoded.value, CANONICAL_FINGERPRINT_KEYS) !== lines[1]) return malformed();
  const value = decoded.value;
  const digests = [
    value.machineIdSha256,
    value.bootIdSha256,
    value.unitSha256,
    value.propertySnapshotSha256,
    value.executionDefinitionSha256,
    value.fingerprintSha256,
  ];
  if (
    value.schema !== "comis-production-service-fingerprint" ||
    value.schemaVersion !== 1 ||
    (value.role !== "source" && value.role !== "target") ||
    !digests.every((digest) => typeof digest === "string" && SHA256_RE.test(digest)) ||
    value.loadState !== "loaded" ||
    value.activeState !== "inactive" ||
    value.subState !== "dead" ||
    value.mainPid !== 0 ||
    value.controlPid !== 0 ||
    value.execMainPid !== 0 ||
    value.stabilityMethod !== "bounded_double_scan" ||
    value.stable !== true
  ) {
    return malformed();
  }
  const fingerprint = value as unknown as ProductionServiceFingerprint;
  if (fingerprint.fingerprintSha256 !== combinedFingerprint(fingerprint)) return malformed();
  return ok(fingerprint);
}

export async function executeProductionServiceFingerprint(
  input: ProductionServiceFingerprintInput,
  executor: ProductionRemoteExecutor,
): Promise<Result<ProductionServiceFingerprint, ProductionServiceFingerprintError>> {
  const invocation = buildProductionServiceFingerprintInvocation(input);
  if (!invocation.ok) return invocation;
  const remote = await executor.run(invocation.value);
  if (!remote.ok || remote.value.exitCode !== 0) {
    return err({
      kind: "remote_failure",
      stage: invocation.value.label as
        | "fingerprint-source-service"
        | "fingerprint-target-service",
      message: "Service fingerprint probe failed",
      outcome: remote.ok
        ? { kind: "remote_exit", exitCode: remote.value.exitCode }
        : { kind: "transport_failure" },
    });
  }
  const parsed = parseProductionServiceFingerprint(remote.value.stdout);
  if (!parsed.ok) return parsed;
  if (parsed.value.role !== input.role) {
    return err({
      kind: "binding_mismatch",
      field: "role",
      message: "Service fingerprint role binding does not match",
    });
  }
  if (parsed.value.machineIdSha256 !== input.expectedMachineIdSha256) {
    return err({
      kind: "binding_mismatch",
      field: "machineIdSha256",
      message: "Service fingerprint machine binding does not match",
    });
  }
  if (parsed.value.unitSha256 !== sha256(normalizedUnit(input.service))) {
    return err({
      kind: "binding_mismatch",
      field: "unitSha256",
      message: "Service fingerprint unit binding does not match",
    });
  }
  return parsed;
}

export function compareProductionServiceFingerprints(
  before: ProductionServiceFingerprint,
  after: ProductionServiceFingerprint,
): Result<ProductionServiceFingerprintComparison, ProductionServiceFingerprintError> {
  const comparisons: readonly (readonly [ProductionServiceFingerprintMismatchField, boolean])[] = [
    ["machineIdSha256", before.machineIdSha256 === after.machineIdSha256],
    ["role", before.role === after.role],
    ["bootIdSha256", before.bootIdSha256 === after.bootIdSha256],
    ["unitSha256", before.unitSha256 === after.unitSha256],
    ["propertySnapshotSha256", before.propertySnapshotSha256 === after.propertySnapshotSha256],
    [
      "executionDefinitionSha256",
      before.executionDefinitionSha256 === after.executionDefinitionSha256,
    ],
    ["fingerprintSha256", before.fingerprintSha256 === after.fingerprintSha256],
    ["loadState", before.loadState === after.loadState],
    ["activeState", before.activeState === after.activeState],
    ["subState", before.subState === after.subState],
    ["mainPid", before.mainPid === after.mainPid],
    ["controlPid", before.controlPid === after.controlPid],
    ["execMainPid", before.execMainPid === after.execMainPid],
    ["stabilityMethod", before.stabilityMethod === after.stabilityMethod],
    ["stable", before.stable === after.stable],
  ];
  for (const [field, equal] of comparisons) {
    if (!equal) {
      return err({
        kind: "fingerprint_mismatch",
        field,
        message: `Service fingerprint changed at ${field}`,
      });
    }
  }
  return ok({
    exact: true,
    machineIdSha256: before.machineIdSha256,
    bootIdSha256: before.bootIdSha256,
    fingerprintSha256: before.fingerprintSha256,
  });
}
