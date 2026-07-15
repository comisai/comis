// SPDX-License-Identifier: Apache-2.0
import { basename, dirname, isAbsolute } from "node:path";

import { err, ok, type Result } from "@comis/shared";

import {
  TARGET_REPLAY_QUARANTINE_SHA256,
  type ProductionRemoteExecutor,
  type ProductionRemoteInvocation,
} from "./production-bootstrap.js";
import type {
  ProductionHostProfile,
  ProductionReplayProfile,
} from "./production-profile.js";

export const RUNTIME_FACTS_BEGIN = "COMIS_RUNTIME_ATTESTATION_V1_BEGIN";
export const RUNTIME_FACTS_END = "COMIS_RUNTIME_ATTESTATION_V1_END";

const MAX_FACTS_BYTES = 4096;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const FACT_FIELDS = [
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
type RuntimeFactField = (typeof FACT_FIELDS)[number];
type RuntimeIdentityField = Exclude<RuntimeFactField, "packageRoot">;

export type RuntimeCapabilityRequirement = "required" | "declared_unsupported";
export type RuntimeCapabilityStatus = "available" | "unavailable";
export type RuntimeLauncherKind = "systemd" | "unsupported";
export type RuntimeConfinementKind = "source" | "target_quarantine";

export interface RuntimeParityRequirements {
  readonly launcher: RuntimeCapabilityRequirement;
  readonly browser: RuntimeCapabilityRequirement;
  readonly media: RuntimeCapabilityRequirement;
  readonly nativeTools: RuntimeCapabilityRequirement;
}

export const STRICT_RUNTIME_PARITY_REQUIREMENTS: RuntimeParityRequirements = {
  launcher: "required",
  browser: "required",
  media: "required",
  nativeTools: "required",
};

export type RuntimeLauncherDeclaration =
  | { readonly kind: "systemd" }
  | {
      readonly kind: "declared_unsupported";
      readonly nodePath: string;
      readonly packageRoot: string;
    };

export interface RuntimeArtifactAttestationOptions {
  readonly requirements: RuntimeParityRequirements;
  readonly sourceLauncher: RuntimeLauncherDeclaration;
  readonly targetLauncher: RuntimeLauncherDeclaration;
}

export const SYSTEMD_STRICT_RUNTIME_ATTESTATION: RuntimeArtifactAttestationOptions = {
  requirements: STRICT_RUNTIME_PARITY_REQUIREMENTS,
  sourceLauncher: { kind: "systemd" },
  targetLauncher: { kind: "systemd" },
};

export interface RuntimeArtifactAttestation {
  readonly digestSha256: string;
  readonly entryCount: number;
  /** Sum of regular-file content bytes. Symlink target bytes are represented only in the digest. */
  readonly bytes: number;
  /** Canonical package location discovered from the declared launcher authority. */
  readonly packageRoot: string;
  readonly version: string;
  readonly osId: string;
  readonly osVersion: string;
  readonly architecture: string;
  readonly kernelRelease: string;
  readonly libcKind: "glibc" | "musl" | "darwin" | "other" | "unknown";
  readonly libcVersion: string;
  readonly nodeVersion: string;
  readonly nodeAbi: string;
  readonly timezone: string;
  readonly tzdataSha256: string;
  readonly launcherKind: RuntimeLauncherKind;
  /** Systemd application-launch semantics with target-only replay settings removed. */
  readonly applicationLauncherSha256: string;
  /** Orthogonal role attestation: production source or canonical confined replay target. */
  readonly confinementKind: RuntimeConfinementKind;
  readonly confinementSha256: string;
  readonly browserStatus: RuntimeCapabilityStatus;
  readonly browserSha256: string;
  readonly mediaStatus: RuntimeCapabilityStatus;
  readonly mediaSha256: string;
  readonly nativeToolsStatus: RuntimeCapabilityStatus;
  readonly nativeToolsSha256: string;
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

function isSafeFactToken(value: string, maximumLength = 256): boolean {
  return (
    value.length > 0 &&
    value.length <= maximumLength &&
    /^[A-Za-z0-9._+:/@-]+$/u.test(value)
  );
}

function validateDigestIdentity(
  status: RuntimeCapabilityStatus | RuntimeLauncherKind,
  digest: string,
  field:
    | "applicationLauncherSha256"
    | "browserSha256"
    | "mediaSha256"
    | "nativeToolsSha256",
  availableValue: "available" | "systemd",
): Result<string, ProductionRuntimeError> {
  if (status === availableValue && SHA256_RE.test(digest)) return ok(digest);
  if (status !== availableValue && digest === "none") return ok(digest);
  return malformed(field, `${field} does not match its capability status`);
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
  const osId = parsed.get("osId") as string;
  const osVersion = parsed.get("osVersion") as string;
  const architecture = parsed.get("architecture") as string;
  const kernelRelease = parsed.get("kernelRelease") as string;
  const libcKind = parsed.get("libcKind") as RuntimeArtifactAttestation["libcKind"];
  const libcVersion = parsed.get("libcVersion") as string;
  const nodeVersion = parsed.get("nodeVersion") as string;
  const nodeAbi = parsed.get("nodeAbi") as string;
  const timezone = parsed.get("timezone") as string;
  const tzdataSha256 = parsed.get("tzdataSha256") as string;
  const launcherKind = parsed.get("launcherKind") as RuntimeLauncherKind;
  const applicationLauncherSha256 = parsed.get("applicationLauncherSha256") as string;
  const confinementKind = parsed.get("confinementKind") as RuntimeConfinementKind;
  const confinementSha256 = parsed.get("confinementSha256") as string;
  const browserStatus = parsed.get("browserStatus") as RuntimeCapabilityStatus;
  const browserSha256 = parsed.get("browserSha256") as string;
  const mediaStatus = parsed.get("mediaStatus") as RuntimeCapabilityStatus;
  const mediaSha256 = parsed.get("mediaSha256") as string;
  const nativeToolsStatus = parsed.get("nativeToolsStatus") as RuntimeCapabilityStatus;
  const nativeToolsSha256 = parsed.get("nativeToolsSha256") as string;

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
  for (const [field, value] of [
    ["osId", osId],
    ["osVersion", osVersion],
    ["architecture", architecture],
    ["kernelRelease", kernelRelease],
    ["libcVersion", libcVersion],
    ["nodeVersion", nodeVersion],
    ["nodeAbi", nodeAbi],
    ["timezone", timezone],
  ] as const) {
    if (!isSafeFactToken(value)) return malformed(field, `${field} is not a safe fact token`);
  }
  if (!["glibc", "musl", "darwin", "other", "unknown"].includes(libcKind)) {
    return malformed("libcKind", "libcKind is not recognized");
  }
  if (!SHA256_RE.test(tzdataSha256)) {
    return malformed("tzdataSha256", "tzdataSha256 must be a lowercase SHA-256 digest");
  }
  if (launcherKind !== "systemd" && launcherKind !== "unsupported") {
    return malformed("launcherKind", "launcherKind is not recognized");
  }
  const launcherIdentity = validateDigestIdentity(
    launcherKind,
    applicationLauncherSha256,
    "applicationLauncherSha256",
    "systemd",
  );
  if (!launcherIdentity.ok) return launcherIdentity;
  if (confinementKind !== "source" && confinementKind !== "target_quarantine") {
    return malformed("confinementKind", "confinementKind is not recognized");
  }
  if (
    (confinementKind === "source" && confinementSha256 !== "none") ||
    (confinementKind === "target_quarantine" && !SHA256_RE.test(confinementSha256))
  ) {
    return malformed("confinementSha256", "confinementSha256 does not match confinementKind");
  }
  for (const [statusField, digestField, status, digest] of [
    ["browserStatus", "browserSha256", browserStatus, browserSha256],
    ["mediaStatus", "mediaSha256", mediaStatus, mediaSha256],
    ["nativeToolsStatus", "nativeToolsSha256", nativeToolsStatus, nativeToolsSha256],
  ] as const) {
    if (status !== "available" && status !== "unavailable") {
      return malformed(statusField, `${statusField} is not recognized`);
    }
    const identity = validateDigestIdentity(status, digest, digestField, "available");
    if (!identity.ok) return identity;
  }

  return ok({
    digestSha256,
    entryCount: entryCount.value,
    bytes: bytes.value,
    packageRoot,
    version,
    osId,
    osVersion,
    architecture,
    kernelRelease,
    libcKind,
    libcVersion,
    nodeVersion,
    nodeAbi,
    timezone,
    tzdataSha256,
    launcherKind,
    applicationLauncherSha256,
    confinementKind,
    confinementSha256,
    browserStatus,
    browserSha256,
    mediaStatus,
    mediaSha256,
    nativeToolsStatus,
    nativeToolsSha256,
  });
}

function runtimeMismatch(field: RuntimeIdentityField): Result<void, RuntimeArtifactMismatchError> {
  return err({
    kind: "runtime_mismatch",
    field,
    message: `Target runtime ${field} does not match the production source`,
  });
}

/** Compare only the package bytes that the runtime clone transaction can change. */
export function compareRuntimePackageArtifacts(
  source: RuntimeArtifactAttestation,
  target: RuntimeArtifactAttestation,
): Result<void, RuntimeArtifactMismatchError> {
  if (
    !SHA256_RE.test(source.digestSha256) ||
    !SHA256_RE.test(target.digestSha256) ||
    source.digestSha256 !== target.digestSha256
  ) {
    return runtimeMismatch("digestSha256");
  }
  if (
    !Number.isSafeInteger(source.entryCount) ||
    !Number.isSafeInteger(target.entryCount) ||
    source.entryCount <= 0 ||
    target.entryCount <= 0 ||
    source.entryCount !== target.entryCount
  ) {
    return runtimeMismatch("entryCount");
  }
  if (
    !Number.isSafeInteger(source.bytes) ||
    !Number.isSafeInteger(target.bytes) ||
    source.bytes <= 0 ||
    target.bytes <= 0 ||
    source.bytes !== target.bytes
  ) {
    return runtimeMismatch("bytes");
  }
  if (
    !isPinnedVersion(source.version) ||
    !isPinnedVersion(target.version) ||
    source.version !== target.version
  ) {
    return runtimeMismatch("version");
  }
  return ok(undefined);
}

export function compareRuntimeArtifacts(
  source: RuntimeArtifactAttestation,
  target: RuntimeArtifactAttestation,
  requirements: RuntimeParityRequirements = STRICT_RUNTIME_PARITY_REQUIREMENTS,
): Result<void, RuntimeArtifactMismatchError> {
  const packageComparison = compareRuntimePackageArtifacts(source, target);
  if (!packageComparison.ok) return packageComparison;
  for (const field of [
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
  ] as const) {
    if (source[field] === "unknown" || source[field] !== target[field]) {
      return runtimeMismatch(field);
    }
  }
  if (!SHA256_RE.test(source.tzdataSha256) || !SHA256_RE.test(target.tzdataSha256)) {
    return runtimeMismatch("tzdataSha256");
  }
  for (const [requirement, field] of [
    [requirements.launcher, "launcherKind"],
    [requirements.browser, "browserStatus"],
    [requirements.media, "mediaStatus"],
    [requirements.nativeTools, "nativeToolsStatus"],
  ] as const) {
    if (requirement !== "required" && requirement !== "declared_unsupported") {
      return runtimeMismatch(field);
    }
  }
  if (requirements.launcher === "required") {
    if (source.launcherKind !== "systemd" || target.launcherKind !== "systemd") {
      return runtimeMismatch("launcherKind");
    }
    if (
      !SHA256_RE.test(source.applicationLauncherSha256) ||
      !SHA256_RE.test(target.applicationLauncherSha256) ||
      source.applicationLauncherSha256 !== target.applicationLauncherSha256
    ) {
      return runtimeMismatch("applicationLauncherSha256");
    }
  }
  if (source.confinementKind !== "source" || source.confinementSha256 !== "none") {
    return runtimeMismatch("confinementKind");
  }
  if (target.confinementKind !== "target_quarantine") {
    return runtimeMismatch("confinementKind");
  }
  if (target.confinementSha256 !== TARGET_REPLAY_QUARANTINE_SHA256) {
    return runtimeMismatch("confinementSha256");
  }
  for (const [requirement, statusField, digestField] of [
    [requirements.browser, "browserStatus", "browserSha256"],
    [requirements.media, "mediaStatus", "mediaSha256"],
    [requirements.nativeTools, "nativeToolsStatus", "nativeToolsSha256"],
  ] as const) {
    if (requirement === "declared_unsupported") continue;
    if (source[statusField] !== "available" || target[statusField] !== "available") {
      return runtimeMismatch(statusField);
    }
    if (
      !SHA256_RE.test(source[digestField]) ||
      !SHA256_RE.test(target[digestField]) ||
      source[digestField] !== target[digestField]
    ) {
      return runtimeMismatch(digestField);
    }
  }
  return ok(undefined);
}

function buildRuntimeProbeInvocation(
  host: ProductionHostProfile,
  stage: RuntimeArtifactAttestationStage,
  stdin: string,
  launcher: RuntimeLauncherDeclaration,
): ProductionRemoteInvocation {
  const launcherArgs =
    launcher.kind === "systemd"
      ? []
      : ["declared_unsupported", launcher.nodePath, launcher.packageRoot];
  const confinementKind = stage === "runtime-attest-source" ? "source" : "target_quarantine";
  return {
    label: stage,
    host: host.ssh,
    ...(host.sshPort !== undefined ? { port: host.sshPort } : {}),
    args: ["sudo", "bash", "-s", "--", host.service, confinementKind, ...launcherArgs],
    stdin,
  };
}

export function buildRuntimeArtifactAttestationPlan(
  profile: ProductionReplayProfile,
  options: RuntimeArtifactAttestationOptions = SYSTEMD_STRICT_RUNTIME_ATTESTATION,
): RuntimeArtifactAttestationPlan {
  const stdin = buildRuntimeArtifactProbeScript();
  return {
    source: buildRuntimeProbeInvocation(
      profile.source,
      "runtime-attest-source",
      stdin,
      options.sourceLauncher,
    ),
    target: buildRuntimeProbeInvocation(
      profile.target,
      "runtime-attest-target",
      stdin,
      options.targetLauncher,
    ),
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
  options: RuntimeArtifactAttestationOptions = SYSTEMD_STRICT_RUNTIME_ATTESTATION,
): Promise<Result<RuntimeArtifactAttestationReport, RuntimeArtifactAttestationError>> {
  const plan = buildRuntimeArtifactAttestationPlan(profile, options);
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
  options: RuntimeArtifactAttestationOptions = SYSTEMD_STRICT_RUNTIME_ATTESTATION,
): Promise<Result<RuntimeArtifactAttestationReport, RuntimeArtifactAttestationError>> {
  const report = await inspectRuntimeArtifactAttestations(profile, executor, options);
  if (!report.ok) return report;
  const comparison = compareRuntimeArtifacts(
    report.value.source,
    report.value.target,
    options.requirements,
  );
  if (!comparison.ok) return comparison;
  return report;
}

const APPLICATION_LAUNCHER_SCANNER = String.raw`
const { createHash } = require("node:crypto");
const fs = require("node:fs");

const [nodePath, packageRoot, daemonPath, confinementKind] = process.argv.slice(2);
const rawFacts = fs.readFileSync(3, "utf8");
for (const value of [nodePath, packageRoot, daemonPath, confinementKind, rawFacts]) {
  if (!value || value.includes("\0")) throw new Error("Invalid application launcher fact");
}
if (confinementKind !== "source" && confinementKind !== "target_quarantine") {
  throw new Error("Invalid application launcher confinement kind");
}
const daemonRelative = daemonPath.startsWith(packageRoot + "/")
  ? daemonPath.slice(packageRoot.length)
  : "";
const sourceEntrypoints = new Set([
  "/node_modules/@comis/daemon/dist/daemon.js",
  "/node_modules/@comis/daemon/dist/daemon-entrypoint.js",
]);
const trustedEntrypoint = "/node_modules/@comis/daemon/dist/daemon-entrypoint.js";
if (
  (confinementKind === "source" && !sourceEntrypoints.has(daemonRelative)) ||
  (confinementKind === "target_quarantine" && daemonRelative !== trustedEntrypoint)
) {
  throw new Error("Invalid Comis daemon entrypoint");
}

function stripReplayEnvironment(line) {
  const environmentPrefix = "Environment" + "=";
  if (confinementKind !== "target_quarantine" || !line.startsWith(environmentPrefix)) {
    return line;
  }
  const retained = line
    .slice(environmentPrefix.length)
    .split(" ")
    .filter((token) => {
      const unquoted = token.replace(/^"|"$/g, "");
      return unquoted !== "COMIS_REPLAY_TARGET=1" &&
        unquoted !== "COMIS_REPLAY_RUNTIME_DIR=/run/comis-replay";
    });
  return environmentPrefix + retained.join(" ");
}

const normalizedFacts = rawFacts
  .split("\n")
  .map(stripReplayEnvironment)
  .join("\n")
  .split(daemonPath)
  .join("<COMIS_DAEMON_ENTRYPOINT>")
  .split(nodePath)
  .join("<NODE_EXECUTABLE>")
  .split(packageRoot)
  .join("<PACKAGE_ROOT>");
const nodeExecutable = fs.realpathSync(nodePath);
const nodeSha256 = createHash("sha256").update(fs.readFileSync(nodeExecutable)).digest("hex");
const material = [
  "comis-application-launcher",
  nodeSha256,
  "role-normalized-daemon-entrypoint",
  normalizedFacts,
].join("\0");
process.stdout.write(createHash("sha256").update(material, "utf8").digest("hex"));
`;

const NODE_SCANNER = String.raw`
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2];
if (!root || root.includes("\n") || root.includes("\r") || root.includes("\0")) {
  throw new Error("Invalid package root");
}
const semanticFieldNames = [
  "osId",
  "osVersion",
  "architecture",
  "kernelRelease",
  "libcKind",
  "libcVersion",
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
];
const semanticFacts = new Map();
for (const [index, name] of semanticFieldNames.entries()) {
  const value = process.argv[index + 3];
  if (!value || value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error("Invalid runtime semantic fact");
  }
  semanticFacts.set(name, value);
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
    "osId=" + semanticFacts.get("osId"),
    "osVersion=" + semanticFacts.get("osVersion"),
    "architecture=" + semanticFacts.get("architecture"),
    "kernelRelease=" + semanticFacts.get("kernelRelease"),
    "libcKind=" + semanticFacts.get("libcKind"),
    "libcVersion=" + semanticFacts.get("libcVersion"),
    "nodeVersion=" + process.versions.node,
    "nodeAbi=" + (process.versions.modules || "unknown"),
    "timezone=" + semanticFacts.get("timezone"),
    "tzdataSha256=" + semanticFacts.get("tzdataSha256"),
    "launcherKind=" + semanticFacts.get("launcherKind"),
    "applicationLauncherSha256=" + semanticFacts.get("applicationLauncherSha256"),
    "confinementKind=" + semanticFacts.get("confinementKind"),
    "confinementSha256=" + semanticFacts.get("confinementSha256"),
    "browserStatus=" + semanticFacts.get("browserStatus"),
    "browserSha256=" + semanticFacts.get("browserSha256"),
    "mediaStatus=" + semanticFacts.get("mediaStatus"),
    "mediaSha256=" + semanticFacts.get("mediaSha256"),
    "nativeToolsStatus=" + semanticFacts.get("nativeToolsStatus"),
    "nativeToolsSha256=" + semanticFacts.get("nativeToolsSha256"),
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
 * The service name is argv[1] and its source/target confinement role is argv[2].
 * By default systemd ExecStart is the authority for the Node executable and
 * installed package root. A caller that explicitly
 * declares the launcher unsupported must supply both absolute paths. The
 * program emits a bounded, content-free attestation envelope only after hashing
 * the package tree, application-launch semantics, host runtime, capabilities,
 * and the target-only canonical confinement identity.
 */
export function buildRuntimeArtifactProbeScript(): string {
  return [
    "set -u",
    "set -f",
    "LC_ALL=C",
    "export LC_ALL",
    'service="${1:?service name is required}"',
    'confinement_declaration="${2:?confinement declaration is required}"',
    'launcher_declaration="${3:-systemd}"',
    "launcher_kind=unsupported",
    "application_launcher_sha=none",
    "confinement_kind=source",
    "confinement_sha=none",
    "node_path=",
    "package_root=",
    'case "$launcher_declaration" in',
    "  systemd)",
    '    exec_start="$(systemctl show "$service" --property=ExecStart --value 2>/dev/null)"',
    '    [ -n "$exec_start" ] || { printf "%s\\n" "Comis service ExecStart is unavailable" >&2; exit 64; }',
    '    node_path="$(printf "%s\\n" "$exec_start" | sed -n "s/^[{ ]*path=\\([^ ;]*\\).*/\\1/p")"',
    '    launcher_argv="$(printf "%s\\n" "$exec_start" | sed -n "s/.*argv\\[\\]=\\([^;]*\\) ;.*/\\1/p")"',
    '    [ -n "$launcher_argv" ] || { printf "%s\\n" "Comis daemon arguments are unavailable" >&2; exit 66; }',
    '    set -- $launcher_argv',
    '    [ "$#" -ge 2 ] && [ "$1" = "$node_path" ] || { printf "%s\\n" "Comis daemon executable arguments are invalid" >&2; exit 66; }',
    '    shift',
    '    while [ "$#" -gt 1 ]; do case "$1" in --*) ;; *) printf "%s\\n" "Comis daemon executable arguments are invalid" >&2; exit 66 ;; esac; shift; done',
    '    daemon_path="$1"',
    '    case "$confinement_declaration:$daemon_path" in source:*/node_modules/@comis/daemon/dist/daemon.js|source:*/node_modules/@comis/daemon/dist/daemon-entrypoint.js|target_quarantine:*/node_modules/@comis/daemon/dist/daemon-entrypoint.js) ;; *) printf "%s\\n" "Comis daemon entrypoint is invalid" >&2; exit 66 ;; esac',
    '    package_root="${daemon_path%%/node_modules/@comis/daemon/dist/*}"',
    '    application_launcher_facts="$(systemctl show "$service" --no-pager --property=ExecStart,ExecStartPre,ExecStartPost,ExecCondition,User,Group,WorkingDirectory,RootDirectory,Environment,EnvironmentFiles,PassEnvironment,UnsetEnvironment,Type,NotifyAccess,Restart,RestartUSec,TimeoutStartUSec,TimeoutStopUSec,KillMode,KillSignal,SuccessExitStatus 2>/dev/null)"',
    '    [ -n "$application_launcher_facts" ] || { printf "%s\\n" "Comis application launcher facts are unavailable" >&2; exit 68; }',
    '    application_launcher_sha="$("$node_path" - "$node_path" "$package_root" "$daemon_path" "$confinement_declaration" 3<<<"$application_launcher_facts" <<\'COMIS_APPLICATION_LAUNCHER_NODE\'',
    APPLICATION_LAUNCHER_SCANNER.trimStart(),
    "COMIS_APPLICATION_LAUNCHER_NODE",
    ')"',
    '    case "$application_launcher_sha" in ""|*[!a-f0-9]*) printf "%s\\n" "Comis application launcher identity is unavailable" >&2; exit 68 ;; esac',
    "    launcher_kind=systemd",
    "    ;;",
    "  declared_unsupported)",
    '    node_path="${4:-}"',
    '    package_root="${5:-}"',
    '    case "$node_path" in /*) ;; *) printf "%s\\n" "Explicit Node path must be absolute" >&2; exit 65 ;; esac',
    '    case "$package_root" in /*) ;; *) printf "%s\\n" "Explicit package root must be absolute" >&2; exit 67 ;; esac',
    "    ;;",
    "  *) printf '%s\\n' 'Runtime launcher declaration is not recognized' >&2; exit 64 ;;",
    "esac",
    '[ -n "$node_path" ] && [ -x "$node_path" ] || { printf "%s\\n" "Comis Node executable is unavailable" >&2; exit 65; }',
    'package_root="$(readlink -f "$package_root")"',
    '[ -d "$package_root" ] && [ -r "$package_root/package.json" ] || { printf "%s\\n" "Comis package root is unreadable" >&2; exit 67; }',
    'case "$service" in *.service) unit="$service" ;; *) unit="$service.service" ;; esac',
    'case "$confinement_declaration" in',
    "  source)",
    "    confinement_kind=source",
    "    confinement_sha=none",
    "    ;;",
    "  target_quarantine)",
    '    [ "$launcher_kind" = systemd ] || { printf "%s\\n" "Replay confinement requires a systemd launcher" >&2; exit 70; }',
    '    quarantine="/etc/systemd/system/$unit.d/90-comis-replay-quarantine.conf"',
    '    [ -f "$quarantine" ] && [ ! -L "$quarantine" ] || { printf "%s\\n" "Replay quarantine is unavailable" >&2; exit 70; }',
    '    [ "$(stat -c \'%u:%g:%a\' "$quarantine" 2>/dev/null || true)" = 0:0:644 ] || { printf "%s\\n" "Replay quarantine ownership is invalid" >&2; exit 70; }',
    '    confinement_sha="$(sha256sum "$quarantine" 2>/dev/null | awk \'{print $1}\')"',
    `    [ "$confinement_sha" = ${TARGET_REPLAY_QUARANTINE_SHA256} ] || { printf "%s\\n" "Replay quarantine policy identity is invalid" >&2; exit 70; }`,
    '    systemctl is-active --quiet "$unit" 2>/dev/null && { printf "%s\\n" "Replay target service is active" >&2; exit 70; }',
    '    systemctl is-enabled --quiet "$unit" 2>/dev/null && { printf "%s\\n" "Replay target service is enabled" >&2; exit 70; }',
    '    drop_in_paths="$(systemctl show "$unit" --property=DropInPaths --value 2>/dev/null)"',
    "    quarantine_seen=0",
    "    last_drop_in=",
    '    for drop_in in $drop_in_paths; do last_drop_in="$drop_in"; if [ "$drop_in" = "$quarantine" ]; then quarantine_seen=1; fi; done',
    '    [ "$quarantine_seen" -eq 1 ] && [ "$last_drop_in" = "$quarantine" ] || { printf "%s\\n" "Replay quarantine is not the final effective drop-in" >&2; exit 70; }',
    '    require_effective_property() { property="$1"; expected="$2"; actual="$(systemctl show "$unit" --property="$property" --value 2>/dev/null)"; [ "$actual" = "$expected" ] || { printf "%s\\n" "Replay quarantine effective property is invalid" >&2; exit 70; }; }',
    '    require_effective_property PrivateNetwork yes',
    '    require_effective_property PrivateDevices yes',
    '    require_effective_property PrivateTmp yes',
    '    require_effective_property ProtectSystem strict',
    '    require_effective_property ProtectHome read-only',
    '    require_effective_property NoNewPrivileges yes',
    '    require_effective_property ProtectKernelTunables yes',
    '    require_effective_property ProtectControlGroups yes',
    '    require_effective_property RestrictAddressFamilies AF_UNIX',
    '    require_effective_property SocketBindDeny any',
    '    require_effective_property CapabilityBoundingSet ""',
    '    require_effective_property AmbientCapabilities ""',
    '    require_effective_property RestrictNamespaces yes',
    '    require_effective_property ReadWritePaths /run/comis-replay',
    '    require_effective_property UMask 0077',
    "    confinement_kind=target_quarantine",
    "    ;;",
    "  *) printf '%s\\n' 'Runtime confinement declaration is not recognized' >&2; exit 70 ;;",
    "esac",
    "os_id=unknown",
    "os_version=unknown",
    "if [ -r /etc/os-release ]; then",
    "  ID=",
    "  VERSION_ID=",
    "  . /etc/os-release",
    '  if [ -n "$ID" ]; then os_id="$ID"; fi',
    '  if [ -n "$VERSION_ID" ]; then os_version="$VERSION_ID"; fi',
    'elif [ "$(uname -s 2>/dev/null || true)" = Darwin ]; then',
    "  os_id=darwin",
    '  os_version="$(sw_vers -productVersion 2>/dev/null || true)"',
    "fi",
    'architecture="$(uname -m 2>/dev/null || true)"',
    'kernel_release="$(uname -r 2>/dev/null || true)"',
    'if [ -z "$architecture" ]; then architecture=unknown; fi',
    'if [ -z "$kernel_release" ]; then kernel_release=unknown; fi',
    "libc_kind=unknown",
    "libc_version=unknown",
    'gnu_libc="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"',
    'case "$gnu_libc" in',
    "  'glibc '*) libc_kind=glibc; libc_version=\"${gnu_libc#glibc }\" ;;",
    "  *)",
    '    if [ "$(uname -s 2>/dev/null || true)" = Darwin ]; then',
    "      libc_kind=darwin",
    '      libc_version="$(sw_vers -productVersion 2>/dev/null || true)"',
    "    else",
    '      ldd_output="$(ldd --version 2>&1 | head -n 4 || true)"',
    '      case "$ldd_output" in',
    "        *musl*) libc_kind=musl; libc_version=\"$(printf '%s\\n' \"$ldd_output\" | sed -n 's/.*Version \\([0-9][0-9.]*\\).*/\\1/p' | head -n 1)\" ;;",
    "        '') ;;",
    "        *) libc_kind=other; libc_version=\"$(printf '%s' \"$ldd_output\" | sha256sum | awk '{print $1}')\" ;;",
    "      esac",
    "    fi",
    "    ;;",
    "esac",
    'if [ -z "$libc_version" ]; then libc_version=unknown; fi',
    'timezone="$(timedatectl show --property=Timezone --value 2>/dev/null || true)"',
    'if [ -z "$timezone" ] && [ -r /etc/timezone ]; then timezone="$(head -n 1 /etc/timezone 2>/dev/null || true)"; fi',
    'if [ -z "$timezone" ]; then',
    '  localtime_target="$(readlink /etc/localtime 2>/dev/null || true)"',
    '  case "$localtime_target" in */zoneinfo/*) timezone="${localtime_target##*/zoneinfo/}" ;; esac',
    "fi",
    'if [ -z "$timezone" ]; then timezone=unknown; fi',
    "tzdata_path=/usr/share/zoneinfo/tzdata.zi",
    'if [ ! -r "$tzdata_path" ]; then tzdata_path=/etc/localtime; fi',
    'tzdata_sha="$(sha256sum "$tzdata_path" 2>/dev/null | awk \'{print $1}\')"',
    'case "$tzdata_sha" in ""|*[!a-f0-9]*) printf "%s\\n" "Timezone identity is unavailable" >&2; exit 69 ;; esac',
    "binary_identity() {",
    '  identity_name="$1"',
    '  identity_version_arg="${2:---version}"',
    '  identity_path="$(command -v "$identity_name" 2>/dev/null || true)"',
    '  [ -n "$identity_path" ] || return 1',
    '  identity_path="$(readlink -f "$identity_path" 2>/dev/null || printf "%s" "$identity_path")"',
    '  identity_sha="$(sha256sum "$identity_path" 2>/dev/null | awk \'{print $1}\')"',
    '  case "$identity_sha" in ""|*[!a-f0-9]*) return 1 ;; esac',
    "  identity_version=version-probe-unavailable",
    '  if command -v timeout >/dev/null 2>&1; then identity_version="$(timeout 5 "$identity_path" "$identity_version_arg" 2>&1 | head -c 4096 || true)"; fi',
    '  identity_version_sha="$(printf "%s" "$identity_version" | sha256sum | awk \'{print $1}\')"',
    '  printf "%s:%s:%s\\n" "$identity_name" "$identity_sha" "$identity_version_sha"',
    "}",
    "browser_name=",
    "for candidate in chromium chromium-browser google-chrome google-chrome-stable; do",
    '  if command -v "$candidate" >/dev/null 2>&1; then browser_name="$candidate"; break; fi',
    "done",
    "browser_status=unavailable",
    "browser_sha=none",
    'if [ -n "$browser_name" ]; then',
    '  browser_material="$(binary_identity "$browser_name" --version 2>/dev/null || true)"',
    '  xvfb_material="$(binary_identity Xvfb -version 2>/dev/null || printf "%s" "Xvfb:none")"',
    '  if [ -n "$browser_material" ]; then browser_status=available; browser_sha="$(printf "browser-v1\\n%s\\n%s\\n" "$browser_material" "$xvfb_material" | sha256sum | awk \'{print $1}\')"; fi',
    "fi",
    "media_status=unavailable",
    "media_sha=none",
    'ffmpeg_material="$(binary_identity ffmpeg -version 2>/dev/null || true)"',
    'ffprobe_material="$(binary_identity ffprobe -version 2>/dev/null || true)"',
    'if [ -n "$ffmpeg_material" ] && [ -n "$ffprobe_material" ]; then media_status=available; media_sha="$(printf "media-v1\\n%s\\n%s\\n" "$ffmpeg_material" "$ffprobe_material" | sha256sum | awk \'{print $1}\')"; fi',
    "native_tools_status=available",
    "native_tools_material=",
    "for native_tool in bash tar rsync curl bwrap zstd tmux git; do",
    "  native_version_arg=--version",
    '  if [ "$native_tool" = tmux ]; then native_version_arg=-V; fi',
    '  native_identity="$(binary_identity "$native_tool" "$native_version_arg" 2>/dev/null || true)"',
    '  if [ -z "$native_identity" ]; then native_tools_status=unavailable; break; fi',
    '  native_tools_material="${native_tools_material}${native_identity}\n"',
    "done",
    "native_tools_sha=none",
    'if [ "$native_tools_status" = available ]; then native_tools_sha="$(printf "native-tools-v1\\n%s" "$native_tools_material" | sha256sum | awk \'{print $1}\')"; fi',
    '"$node_path" - "$package_root" "$os_id" "$os_version" "$architecture" "$kernel_release" "$libc_kind" "$libc_version" "$timezone" "$tzdata_sha" "$launcher_kind" "$application_launcher_sha" "$confinement_kind" "$confinement_sha" "$browser_status" "$browser_sha" "$media_status" "$media_sha" "$native_tools_status" "$native_tools_sha" <<\'COMIS_RUNTIME_NODE\'',
    NODE_SCANNER.trimStart(),
    "COMIS_RUNTIME_NODE",
    "",
  ].join("\n");
}
