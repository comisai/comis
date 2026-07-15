// SPDX-License-Identifier: Apache-2.0
import { basename, dirname, isAbsolute } from "node:path";

import { err, ok, type Result } from "@comis/shared";

import type {
  ProductionRemoteExecutor,
  ProductionRemoteInvocation,
} from "./production-bootstrap.js";
import type { ProductionHostProfile, ProductionReplayProfile } from "./production-profile.js";

export const RUNTIME_FACTS_BEGIN = "COMIS_RUNTIME_ATTESTATION_V1_BEGIN";
export const RUNTIME_FACTS_END = "COMIS_RUNTIME_ATTESTATION_V1_END";

const MAX_FACTS_BYTES = 4096;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const FACT_FIELDS = ["digestSha256", "entryCount", "bytes", "packageRoot", "version"] as const;
type RuntimeFactField = (typeof FACT_FIELDS)[number];
type RuntimeIdentityField = Exclude<RuntimeFactField, "packageRoot">;

export interface RuntimeArtifactAttestation {
  readonly digestSha256: string;
  readonly entryCount: number;
  /** Sum of regular-file content bytes. Symlink target bytes are represented only in the digest. */
  readonly bytes: number;
  /** Canonical package location discovered from systemd. */
  readonly packageRoot: string;
  readonly version: string;
}

export interface RuntimeArtifactMismatchError {
  readonly kind: "runtime_mismatch";
  readonly field: RuntimeIdentityField;
  readonly message: string;
}

export type ProductionRuntimeError =
  | {
      readonly kind: "malformed_facts";
      readonly field: RuntimeFactField | "envelope";
      readonly message: string;
    }
  | RuntimeArtifactMismatchError;

export type RuntimeArtifactAttestationStage = "runtime-attest-source" | "runtime-attest-target";

export type RuntimeArtifactAttestationError =
  | {
      readonly kind: "remote_failure";
      readonly stage: RuntimeArtifactAttestationStage;
      readonly message: string;
    }
  | {
      readonly kind: "runtime_facts";
      readonly stage: RuntimeArtifactAttestationStage;
      readonly field: RuntimeFactField | "envelope";
      readonly message: string;
    }
  | RuntimeArtifactMismatchError;

export interface RuntimeArtifactAttestationPlan {
  readonly source: ProductionRemoteInvocation;
  readonly target: ProductionRemoteInvocation;
}

export interface RuntimeArtifactAttestationReport {
  readonly source: RuntimeArtifactAttestation;
  readonly target: RuntimeArtifactAttestation;
}

function malformed(
  field: RuntimeFactField | "envelope",
  message: string,
): Result<never, ProductionRuntimeError> {
  return err({ kind: "malformed_facts", field, message });
}

function parseSafeInteger(
  raw: string,
  field: "entryCount" | "bytes",
): Result<number, ProductionRuntimeError> {
  if (!/^[0-9]+$/u.test(raw)) return malformed(field, `${field} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return malformed(field, `${field} must be a positive safe integer`);
  }
  return ok(value);
}

function isPinnedVersion(value: string): boolean {
  if (value.length === 0 || value.length > 128) return false;
  const dash = value.indexOf("-");
  const core = dash === -1 ? value : value.slice(0, dash);
  const suffix = dash === -1 ? "" : value.slice(dash + 1);
  const parts = core.split(".");
  if (parts.length !== 3 || parts.some((part) => part === "")) return false;
  for (const part of parts) {
    for (const character of part) {
      if (character < "0" || character > "9") return false;
    }
  }
  if (dash !== -1 && suffix === "") return false;
  for (const character of suffix) {
    const alphaNumeric =
      (character >= "0" && character <= "9") ||
      (character >= "A" && character <= "Z") ||
      (character >= "a" && character <= "z");
    if (!alphaNumeric && character !== "." && character !== "-") return false;
  }
  return true;
}

export function parseRuntimeArtifactFacts(
  raw: string,
): Result<RuntimeArtifactAttestation, ProductionRuntimeError> {
  if (Buffer.byteLength(raw, "utf8") > MAX_FACTS_BYTES) {
    return malformed("envelope", "Runtime artifact facts exceed the 4096-byte limit");
  }
  if (raw.includes("\r") || raw.includes("\0")) {
    return malformed("envelope", "Runtime artifact facts contain unsupported control bytes");
  }

  const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const lines = normalized.split("\n");
  if (lines.length !== FACT_FIELDS.length + 2) {
    return malformed("envelope", "Runtime artifact facts have an unexpected line count");
  }
  if (lines[0] !== RUNTIME_FACTS_BEGIN || lines[lines.length - 1] !== RUNTIME_FACTS_END) {
    return malformed("envelope", "Runtime artifact facts are missing their exact envelope");
  }

  const allowed = new Set<string>(FACT_FIELDS);
  const parsed = new Map<RuntimeFactField, string>();
  for (const line of lines.slice(1, -1)) {
    const separator = line.indexOf("=");
    const key = line.slice(0, separator) as RuntimeFactField;
    if (separator <= 0 || !allowed.has(key)) {
      return malformed("envelope", "Runtime artifact facts contain an unknown field");
    }
    if (parsed.has(key)) return malformed(key, `${key} appears more than once`);
    parsed.set(key, line.slice(separator + 1));
  }

  for (const field of FACT_FIELDS) {
    const value = parsed.get(field);
    if (value === undefined || value === "") return malformed(field, `${field} is missing`);
  }

  const digestSha256 = parsed.get("digestSha256") as string;
  const rawEntryCount = parsed.get("entryCount") as string;
  const rawBytes = parsed.get("bytes") as string;
  const packageRoot = parsed.get("packageRoot") as string;
  const version = parsed.get("version") as string;

  if (!SHA256_RE.test(digestSha256)) {
    return malformed("digestSha256", "digestSha256 must be a lowercase SHA-256 digest");
  }
  const entryCount = parseSafeInteger(rawEntryCount, "entryCount");
  if (!entryCount.ok) return entryCount;
  const bytes = parseSafeInteger(rawBytes, "bytes");
  if (!bytes.ok) return bytes;
  if (
    !isAbsolute(packageRoot) ||
    basename(packageRoot) !== "comisai" ||
    basename(dirname(packageRoot)) !== "node_modules" ||
    /[\n\r\0]/u.test(packageRoot)
  ) {
    return malformed(
      "packageRoot",
      "packageRoot must be an absolute node_modules/comisai package path",
    );
  }
  if (!isPinnedVersion(version)) {
    return malformed("version", "version must be a pinned semantic version");
  }

  return ok({
    digestSha256,
    entryCount: entryCount.value,
    bytes: bytes.value,
    packageRoot,
    version,
  });
}

export function compareRuntimeArtifacts(
  source: RuntimeArtifactAttestation,
  target: RuntimeArtifactAttestation,
): Result<void, RuntimeArtifactMismatchError> {
  function mismatch(field: RuntimeIdentityField): Result<void, RuntimeArtifactMismatchError> {
    return err({
      kind: "runtime_mismatch",
      field,
      message: `Target runtime ${field} does not match the production source`,
    });
  }
  if (source.digestSha256 !== target.digestSha256) return mismatch("digestSha256");
  if (source.entryCount !== target.entryCount) return mismatch("entryCount");
  if (source.bytes !== target.bytes) return mismatch("bytes");
  if (source.version !== target.version) return mismatch("version");
  return ok(undefined);
}

function buildRuntimeProbeInvocation(
  host: ProductionHostProfile,
  stage: RuntimeArtifactAttestationStage,
  stdin: string,
): ProductionRemoteInvocation {
  return {
    label: stage,
    host: host.ssh,
    ...(host.sshPort !== undefined ? { port: host.sshPort } : {}),
    args: ["sudo", "bash", "-s", "--", host.service],
    stdin,
  };
}

export function buildRuntimeArtifactAttestationPlan(
  profile: ProductionReplayProfile,
): RuntimeArtifactAttestationPlan {
  const stdin = buildRuntimeArtifactProbeScript();
  return {
    source: buildRuntimeProbeInvocation(profile.source, "runtime-attest-source", stdin),
    target: buildRuntimeProbeInvocation(profile.target, "runtime-attest-target", stdin),
  };
}

async function executeRuntimeProbe(
  executor: ProductionRemoteExecutor,
  invocation: ProductionRemoteInvocation,
  stage: RuntimeArtifactAttestationStage,
): Promise<Result<RuntimeArtifactAttestation, RuntimeArtifactAttestationError>> {
  const remote = await executor.run(invocation);
  if (!remote.ok || remote.value.exitCode !== 0) {
    return err({
      kind: "remote_failure",
      stage,
      message: `Runtime artifact probe failed during ${stage}`,
    });
  }
  const facts = parseRuntimeArtifactFacts(remote.value.stdout);
  if (!facts.ok) {
    return err({
      kind: "runtime_facts",
      stage,
      field: facts.error.field,
      message: `Runtime artifact facts failed validation during ${stage}`,
    });
  }
  return ok(facts.value);
}

export async function inspectRuntimeArtifactAttestations(
  profile: ProductionReplayProfile,
  executor: ProductionRemoteExecutor,
): Promise<Result<RuntimeArtifactAttestationReport, RuntimeArtifactAttestationError>> {
  const plan = buildRuntimeArtifactAttestationPlan(profile);
  const [source, target] = await Promise.all([
    executeRuntimeProbe(executor, plan.source, "runtime-attest-source"),
    executeRuntimeProbe(executor, plan.target, "runtime-attest-target"),
  ]);
  if (!source.ok) return source;
  if (!target.ok) return target;
  return ok({ source: source.value, target: target.value });
}

export async function executeRuntimeArtifactAttestation(
  profile: ProductionReplayProfile,
  executor: ProductionRemoteExecutor,
): Promise<Result<RuntimeArtifactAttestationReport, RuntimeArtifactAttestationError>> {
  const report = await inspectRuntimeArtifactAttestations(profile, executor);
  if (!report.ok) return report;
  const comparison = compareRuntimeArtifacts(report.value.source, report.value.target);
  if (!comparison.ok) return comparison;
  return report;
}

const NODE_SCANNER = String.raw`
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2];
if (!root || root.includes("\n") || root.includes("\r") || root.includes("\0")) {
  throw new Error("Invalid package root");
}

const entries = [];
function walk(absoluteDir, relativeDir) {
  for (const name of fs.readdirSync(absoluteDir)) {
    const absolutePath = path.join(absoluteDir, name);
    const relativePath = relativeDir === "" ? name : relativeDir + "/" + name;
    const stat = fs.lstatSync(absolutePath);
    if (stat.isDirectory()) {
      walk(absolutePath, relativePath);
    } else if (stat.isFile()) {
      entries.push({ kind: "file", absolutePath, relativePath });
    } else if (stat.isSymbolicLink()) {
      entries.push({ kind: "symlink", absolutePath, relativePath });
    } else {
      throw new Error("Unsupported runtime artifact type");
    }
  }
}
walk(root, "");
entries.sort((left, right) =>
  Buffer.compare(Buffer.from(left.relativePath, "utf8"), Buffer.from(right.relativePath, "utf8")),
);

const hash = createHash("sha256");
hash.update(Buffer.from("comis-runtime-artifact-v1\0", "utf8"));
function updateField(value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(data.length));
  hash.update(length);
  hash.update(data);
}
function updateUint64(value) {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(value);
  hash.update(encoded);
}

(async () => {
  let bytes = 0n;
  for (const entry of entries) {
    const stat = fs.lstatSync(entry.absolutePath);
    const mode = (stat.mode & 0o7777).toString(8).padStart(4, "0");
    if (entry.kind === "file") {
      hash.update(Buffer.from("F", "utf8"));
      updateField(entry.relativePath);
      updateField(mode);
      const expectedBytes = BigInt(stat.size);
      updateUint64(expectedBytes);
      let observedBytes = 0n;
      for await (const chunk of fs.createReadStream(entry.absolutePath)) {
        observedBytes += BigInt(chunk.length);
        hash.update(chunk);
      }
      if (observedBytes !== expectedBytes) throw new Error("Runtime file changed during attestation");
      bytes += observedBytes;
    } else {
      hash.update(Buffer.from("L", "utf8"));
      updateField(entry.relativePath);
      updateField(mode);
      updateField(fs.readlinkSync(entry.absolutePath));
    }
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const version = typeof manifest.version === "string" ? manifest.version : "";
  if (version.length > 128 || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Runtime package has no pinned semantic version");
  }
  process.stdout.write([
    "COMIS_RUNTIME_ATTESTATION_V1_BEGIN",
    "digestSha256=" + hash.digest("hex"),
    "entryCount=" + entries.length,
    "bytes=" + bytes.toString(),
    "packageRoot=" + root,
    "version=" + version,
    "COMIS_RUNTIME_ATTESTATION_V1_END",
    "",
  ].join("\n"));
})().catch((error) => {
  void error;
  process.stderr.write("Runtime artifact attestation failed\n");
  process.exitCode = 1;
});
`;

/**
 * Build the read-only program sent to a host over SSH.
 *
 * The service name is argv[1]. Its systemd ExecStart is the authority for both
 * the Node executable and the installed `comisai` package root. The program
 * emits a bounded, content-free attestation envelope only after hashing every
 * regular file and symlink below that root.
 */
export function buildRuntimeArtifactProbeScript(): string {
  return [
    "set -u",
    'service="${1:?service name is required}"',
    'exec_start="$(systemctl show "$service" --property=ExecStart --value 2>/dev/null)"',
    '[ -n "$exec_start" ] || { printf "%s\\n" "Comis service ExecStart is unavailable" >&2; exit 64; }',
    'node_path="$(printf "%s\\n" "$exec_start" | sed -n "s/^[{ ]*path=\\([^ ;]*\\).*/\\1/p")"',
    'daemon_path="$(printf "%s\\n" "$exec_start" | grep -oE "/[^ ;{}]+/node_modules/@comis/daemon/dist/[A-Za-z0-9._-]+\\.js" | tail -1)"',
    '[ -n "$node_path" ] && [ -x "$node_path" ] || { printf "%s\\n" "Comis Node executable is unavailable" >&2; exit 65; }',
    '[ -n "$daemon_path" ] || { printf "%s\\n" "Comis daemon path is unavailable" >&2; exit 66; }',
    'package_root="${daemon_path%%/node_modules/@comis/daemon/dist/*}"',
    'package_root="$(readlink -f "$package_root")"',
    '[ -d "$package_root" ] && [ -r "$package_root/package.json" ] || { printf "%s\\n" "Comis package root is unreadable" >&2; exit 67; }',
    '"$node_path" - "$package_root" <<\'COMIS_RUNTIME_NODE\'',
    NODE_SCANNER.trimStart(),
    "COMIS_RUNTIME_NODE",
    "",
  ].join("\n");
}
