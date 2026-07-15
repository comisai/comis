// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { posix } from "node:path";

import { err, ok, tryCatch, type Result } from "@comis/shared";

export const TOOLCHAIN_CONTRACT_SCHEMA =
  "comis-runtime-vault-toolchain-contract" as const;
export const TOOLCHAIN_CONTRACT_SCHEMA_VERSION = 1 as const;
export const TOOLCHAIN_SOURCE_ENVELOPE_BEGIN =
  "COMIS_RUNTIME_VAULT_TOOLCHAIN_SOURCE_V1_BEGIN";
export const TOOLCHAIN_SOURCE_ENVELOPE_END =
  "COMIS_RUNTIME_VAULT_TOOLCHAIN_SOURCE_V1_END";
export const TOOLCHAIN_TARGET_ENVELOPE_BEGIN =
  "COMIS_RUNTIME_VAULT_TOOLCHAIN_TARGET_V1_BEGIN";
export const TOOLCHAIN_TARGET_ENVELOPE_END =
  "COMIS_RUNTIME_VAULT_TOOLCHAIN_TARGET_V1_END";
export const TOOLCHAIN_MAX_ENVELOPE_BYTES = 32 * 1024;

export const TOOLCHAIN_ENVIRONMENT = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  TZ: "Etc/UTC",
} as const;

/** Every external executable used by the runtime-vault programs or this probe. */
export const TOOLCHAIN_HELPERS = {
  awk: "/usr/bin/awk",
  bash: "/usr/bin/bash",
  cat: "/usr/bin/cat",
  chmod: "/usr/bin/chmod",
  env: "/usr/bin/env",
  findmnt: "/usr/bin/findmnt",
  flock: "/usr/bin/flock",
  id: "/usr/bin/id",
  install: "/usr/bin/install",
  ln: "/usr/bin/ln",
  mkdir: "/usr/bin/mkdir",
  mount: "/usr/bin/mount",
  mv: "/usr/bin/mv",
  python3: "/usr/bin/python3",
  readlink: "/usr/bin/readlink",
  realpath: "/usr/bin/realpath",
  rm: "/usr/bin/rm",
  sed: "/usr/bin/sed",
  sha256sum: "/usr/bin/sha256sum",
  stat: "/usr/bin/stat",
  sudo: "/usr/bin/sudo",
  sync: "/usr/bin/sync",
  systemctl: "/usr/bin/systemctl",
  tar: "/usr/bin/tar",
  true: "/usr/bin/true",
  uname: "/usr/bin/uname",
  unshare: "/usr/bin/unshare",
  zstd: "/usr/bin/zstd",
} as const;

export type ToolchainToolName = keyof typeof TOOLCHAIN_HELPERS;
export type ToolchainRole = "source" | "target";

export const TOOLCHAIN_EXECUTION_CONTRACT_SCHEMA =
  "comis-runtime-vault-toolchain-execution" as const;
export const TOOLCHAIN_EXECUTION_CONTRACT_SCHEMA_VERSION = 1 as const;

/**
 * The only supported privilege + environment + shell prefix for runtime-vault
 * programs. Every executable in this prefix is also present in TOOLCHAIN_HELPERS,
 * so sudo's secure_path and an inherited caller environment cannot select a tool.
 */
export const TOOLCHAIN_ROOT_SCRIPT_PREFIX = [
  TOOLCHAIN_HELPERS.sudo,
  "--",
  TOOLCHAIN_HELPERS.env,
  "-i",
  `PATH=${TOOLCHAIN_ENVIRONMENT.PATH}`,
  `LC_ALL=${TOOLCHAIN_ENVIRONMENT.LC_ALL}`,
  `TZ=${TOOLCHAIN_ENVIRONMENT.TZ}`,
  TOOLCHAIN_HELPERS.bash,
  "--noprofile",
  "--norc",
] as const;

export const TOOLCHAIN_ROOT_SHELL_PREFIX = [
  ...TOOLCHAIN_ROOT_SCRIPT_PREFIX,
  "-s",
  "--",
] as const;

export const TOOLCHAIN_EXECUTION_CONTRACT_V1 = {
  schema: TOOLCHAIN_EXECUTION_CONTRACT_SCHEMA,
  schemaVersion: TOOLCHAIN_EXECUTION_CONTRACT_SCHEMA_VERSION,
  environment: TOOLCHAIN_ENVIRONMENT,
  helpers: TOOLCHAIN_HELPERS,
  rootShellPrefix: TOOLCHAIN_ROOT_SHELL_PREFIX,
  rootScriptPrefix: TOOLCHAIN_ROOT_SCRIPT_PREFIX,
} as const;

export const TOOLCHAIN_FEATURE_NAMES = [
  "absoluteSanitizedRootExecution",
  "absoluteScriptPathArchiveStdin",
  "awkFirstField",
  "bashStrictPipefail",
  "catExactBytes",
  "chmodModes",
  "corruptedZstdRejected",
  "findmntTargetAndOptions",
  "flockExclusivity",
  "flockRelease",
  "gnuTarZstdExactFlags",
  "gnuStatFormatsAndDereference",
  "hardLinkIdentity",
  "idRoot",
  "installRootDirectories",
  "mkdirModes",
  "mvAtomicReplace",
  "mvNoClobber",
  "noAtimeStableDescriptorReads",
  "knownSha256",
  "privateMountNamespace",
  "pythonAtLeast312",
  "pythonChmod",
  "pythonChown",
  "pythonDirFd",
  "pythonFsyncDirectory",
  "pythonFsyncFile",
  "pythonIsolatedMode",
  "pythonLchown",
  "pythonListxattr",
  "pythonODirectory",
  "pythonONofollow",
  "pythonSetxattrRoundTrip",
  "pythonStatvfs",
  "pythonStreamingTarExtraction",
  "pythonTarInfoReplace",
  "pythonTarfileDataFilter",
  "pythonUtime",
  "readlinkPhysical",
  "readOnlyBindMount",
  "realpathExistingPhysical",
  "realpathMissingCanonical",
  "recursiveAndFileRemoval",
  "renameat2NoReplace",
  "sedFieldExtraction",
  "sha256AwkPipeline",
  "syncDirectory",
  "syncFile",
  "systemctlObservationCommands",
  "tmpfsMount",
  "trueExitStatus",
  "unameLinux",
  "zstdPythonExtractionPipeline",
] as const;

export type ToolchainFeatureName = (typeof TOOLCHAIN_FEATURE_NAMES)[number];
export type ToolchainFeatureResultsV1 = Readonly<
  Record<ToolchainFeatureName, true>
>;

export interface ToolchainToolFactsV1 {
  readonly name: ToolchainToolName;
  readonly path: string;
  readonly resolvedPath: string;
  readonly ownerUid: 0;
  readonly ownerGid: 0;
  readonly modeOctal: string;
  readonly pathChainRootOwned: true;
  readonly pathChainNonWritable: true;
  readonly pathIdentitySha256: string;
  readonly binarySha256: string;
  readonly versionSha256: string;
}

export interface ToolchainToolV1 extends ToolchainToolFactsV1 {
  readonly toolDigestSha256: string;
}

export interface ToolchainContractV1 {
  readonly schema: typeof TOOLCHAIN_CONTRACT_SCHEMA;
  readonly schemaVersion: typeof TOOLCHAIN_CONTRACT_SCHEMA_VERSION;
  readonly schemaDigestSha256: string;
  readonly role: ToolchainRole;
  readonly machineIdSha256: string;
  readonly bootIdSha256: string;
  readonly kernelIdentitySha256: string;
  readonly probeProgramSha256: string;
  readonly environmentSha256: string;
  readonly executionContractSha256: string;
  readonly features: ToolchainFeatureResultsV1;
  readonly featureDigestSha256: string;
  readonly tools: readonly ToolchainToolV1[];
  readonly toolsDigestSha256: string;
  readonly toolchainRecoveryDigestSha256: string;
  readonly toolchainDigestSha256: string;
}

export interface CreateToolchainContractV1Input {
  readonly role: ToolchainRole;
  readonly machineIdSha256: string;
  readonly bootIdSha256: string;
  readonly kernelIdentitySha256: string;
  readonly tools: readonly ToolchainToolFactsV1[];
}

export interface ParseToolchainProbeOptions {
  readonly role?: ToolchainRole;
  readonly expectedMachineIdSha256?: string;
}

export type ToolchainContractError =
  | {
      readonly kind: "invalid_toolchain_probe_request";
      readonly field: string;
      readonly message: string;
    }
  | {
      readonly kind: "malformed_toolchain_contract";
      readonly field: string;
      readonly message: string;
    }
  | {
      readonly kind: "toolchain_stability_mismatch";
      readonly field: string;
      readonly message: string;
    }
  | {
      readonly kind: "toolchain_recovery_mismatch";
      readonly field: string;
      readonly message: string;
    }
  | {
      readonly kind: "toolchain_incompatible";
      readonly field: string;
      readonly message: string;
    };

const SHA256_RE = /^[a-f0-9]{64}$/u;
const MODE_RE = /^[0-7]{4}$/u;
const TOOL_FACT_FIELDS = [
  "name",
  "path",
  "resolvedPath",
  "ownerUid",
  "ownerGid",
  "modeOctal",
  "pathChainRootOwned",
  "pathChainNonWritable",
  "pathIdentitySha256",
  "binarySha256",
  "versionSha256",
] as const;
const TOOL_FIELDS = [...TOOL_FACT_FIELDS, "toolDigestSha256"] as const;
const CONTRACT_FIELDS = [
  "schema",
  "schemaVersion",
  "schemaDigestSha256",
  "role",
  "machineIdSha256",
  "bootIdSha256",
  "kernelIdentitySha256",
  "probeProgramSha256",
  "environmentSha256",
  "executionContractSha256",
  "features",
  "featureDigestSha256",
  "tools",
  "toolsDigestSha256",
  "toolchainRecoveryDigestSha256",
  "toolchainDigestSha256",
] as const;
const TOOL_NAMES = Object.keys(TOOLCHAIN_HELPERS) as ToolchainToolName[];

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return "null";
}

function canonicalDigest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function requiredFeatures(): ToolchainFeatureResultsV1 {
  return Object.fromEntries(
    TOOLCHAIN_FEATURE_NAMES.map((name) => [name, true]),
  ) as ToolchainFeatureResultsV1;
}

export const TOOLCHAIN_ENVIRONMENT_SHA256 = canonicalDigest(
  "comis-runtime-vault-toolchain-environment-v1",
  TOOLCHAIN_ENVIRONMENT,
);
export const TOOLCHAIN_EXECUTION_CONTRACT_SHA256 = canonicalDigest(
  "comis-runtime-vault-toolchain-execution-v1",
  TOOLCHAIN_EXECUTION_CONTRACT_V1,
);
export const TOOLCHAIN_FEATURE_CONTRACT_SHA256 = canonicalDigest(
  "comis-runtime-vault-toolchain-features-v1",
  requiredFeatures(),
);
export const TOOLCHAIN_CONTRACT_SCHEMA_SHA256 = canonicalDigest(
  "comis-runtime-vault-toolchain-schema-v1",
  {
    contractFields: CONTRACT_FIELDS,
    environment: TOOLCHAIN_ENVIRONMENT,
    executionContract: TOOLCHAIN_EXECUTION_CONTRACT_V1,
    features: TOOLCHAIN_FEATURE_NAMES,
    helpers: TOOLCHAIN_HELPERS,
    schema: TOOLCHAIN_CONTRACT_SCHEMA,
    schemaVersion: TOOLCHAIN_CONTRACT_SCHEMA_VERSION,
    toolFields: TOOL_FIELDS,
  },
);

function malformed(
  field: string,
  message: string,
): Result<never, ToolchainContractError> {
  return err({ kind: "malformed_toolchain_contract", field, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

function isSafeExecutionArgument(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > 4096 ||
    value.includes("\0")
  ) {
    return false;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code > 126) return false;
  }
  return true;
}

function isSafeAbsoluteScriptPath(value: unknown): value is string {
  return (
    isSafeExecutionArgument(value) &&
    value.length > 1 &&
    value.startsWith("/") &&
    !value.includes("\\") &&
    posix.normalize(value) === value
  );
}

export function buildToolchainRootShellCommand(
  args: readonly string[],
): Result<readonly string[], ToolchainContractError> {
  if (
    !Array.isArray(args) ||
    args.length > 64 ||
    !args.every(isSafeExecutionArgument)
  ) {
    return err({
      kind: "invalid_toolchain_probe_request",
      field: "args",
      message: "Runtime-vault shell arguments must be bounded printable strings",
    });
  }
  return ok([...TOOLCHAIN_ROOT_SHELL_PREFIX, ...args]);
}

export function buildToolchainRootScriptCommand(
  scriptPath: string,
  args: readonly string[],
): Result<readonly string[], ToolchainContractError> {
  if (
    !isSafeAbsoluteScriptPath(scriptPath) ||
    !Array.isArray(args) ||
    args.length > 64 ||
    !args.every(isSafeExecutionArgument)
  ) {
    return err({
      kind: "invalid_toolchain_probe_request",
      field: "scriptPath",
      message: "Runtime-vault script invocation must use a bounded absolute path and arguments",
    });
  }
  return ok([...TOOLCHAIN_ROOT_SCRIPT_PREFIX, scriptPath, ...args]);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function isCanonicalExecutablePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    !value.startsWith("/") ||
    value === "/" ||
    value.includes("\\") ||
    posix.normalize(value) !== value
  ) {
    return false;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 33 || code > 126) return false;
  }
  return true;
}

function isSecureExecutableMode(value: unknown): value is string {
  if (typeof value !== "string" || !MODE_RE.test(value)) return false;
  const mode = Number.parseInt(value, 8);
  return (mode & 0o022) === 0 && (mode & 0o111) !== 0;
}

function toolDigest(tool: ToolchainToolFactsV1): string {
  return canonicalDigest("comis-runtime-vault-toolchain-tool-v1", tool);
}

function toolsDigest(tools: readonly ToolchainToolV1[]): string {
  return canonicalDigest(
    "comis-runtime-vault-toolchain-tools-v1",
    tools.map((tool) => ({
      name: tool.name,
      toolDigestSha256: tool.toolDigestSha256,
    })),
  );
}

function unsignedContract(contract: ToolchainContractV1): Omit<
  ToolchainContractV1,
  "toolchainDigestSha256"
> {
  const { toolchainDigestSha256: _digest, ...unsigned } = contract;
  return unsigned;
}

function recoveryIdentity(contract: ToolchainContractV1): Omit<
  ToolchainContractV1,
  "bootIdSha256" | "toolchainRecoveryDigestSha256" | "toolchainDigestSha256"
> {
  const {
    bootIdSha256: _bootId,
    toolchainRecoveryDigestSha256: _recoveryDigest,
    toolchainDigestSha256: _fullDigest,
    ...identity
  } = contract;
  return identity;
}

/**
 * Recovery identity binds every non-derived attested field. bootIdSha256 is the
 * only attested fact excluded; the recovery and complete digests are omitted to
 * avoid self-reference. It is stable only when role, machine, kernel, schema,
 * probe, environment, execution, features, and complete tools remain identical.
 */
export function computeToolchainRecoveryDigest(
  contract: ToolchainContractV1,
): string {
  return canonicalDigest(
    "comis-runtime-vault-toolchain-recovery-v1",
    recoveryIdentity(contract),
  );
}

export function computeToolchainContractDigest(
  contract: ToolchainContractV1,
): string {
  return canonicalDigest(
    "comis-runtime-vault-toolchain-contract-v1",
    unsignedContract(contract),
  );
}

function validateToolFacts(
  value: unknown,
  expectedName: ToolchainToolName,
  includeDigest: false,
): Result<ToolchainToolFactsV1, ToolchainContractError>;
function validateToolFacts(
  value: unknown,
  expectedName: ToolchainToolName,
  includeDigest: true,
): Result<ToolchainToolV1, ToolchainContractError>;
function validateToolFacts(
  value: unknown,
  expectedName: ToolchainToolName,
  includeDigest: boolean,
): Result<ToolchainToolFactsV1 | ToolchainToolV1, ToolchainContractError> {
  const field = `tools.${expectedName}`;
  if (!isRecord(value) || !hasExactKeys(value, includeDigest ? TOOL_FIELDS : TOOL_FACT_FIELDS)) {
    return malformed(field, "Tool facts contain missing or unknown fields");
  }
  if (value.name !== expectedName || value.path !== TOOLCHAIN_HELPERS[expectedName]) {
    return malformed(field, "Tool name or canonical invocation path is invalid");
  }
  if (!isCanonicalExecutablePath(value.resolvedPath)) {
    return malformed(`${field}.resolvedPath`, "Resolved executable path is invalid");
  }
  if (
    value.ownerUid !== 0 ||
    value.ownerGid !== 0 ||
    value.pathChainRootOwned !== true ||
    value.pathChainNonWritable !== true ||
    !isSecureExecutableMode(value.modeOctal)
  ) {
    return malformed(field, "Executable ownership or path permissions are unsafe");
  }
  if (!isSha256(value.pathIdentitySha256)) {
    return malformed(`${field}.pathIdentitySha256`, "Tool digest is malformed");
  }
  if (!isSha256(value.binarySha256)) {
    return malformed(`${field}.binarySha256`, "Tool digest is malformed");
  }
  if (!isSha256(value.versionSha256)) {
    return malformed(`${field}.versionSha256`, "Tool digest is malformed");
  }
  const facts: ToolchainToolFactsV1 = {
    name: expectedName,
    path: TOOLCHAIN_HELPERS[expectedName],
    resolvedPath: value.resolvedPath,
    ownerUid: 0,
    ownerGid: 0,
    modeOctal: value.modeOctal,
    pathChainRootOwned: true,
    pathChainNonWritable: true,
    pathIdentitySha256: value.pathIdentitySha256,
    binarySha256: value.binarySha256,
    versionSha256: value.versionSha256,
  };
  if (!includeDigest) return ok(facts);
  if (
    !isSha256(value.toolDigestSha256) ||
    value.toolDigestSha256 !== toolDigest(facts)
  ) {
    return malformed(`${field}.toolDigestSha256`, "Derived tool digest is invalid");
  }
  return ok({ ...facts, toolDigestSha256: value.toolDigestSha256 });
}

function validateFeatures(
  value: unknown,
): Result<ToolchainFeatureResultsV1, ToolchainContractError> {
  if (!isRecord(value) || !hasExactKeys(value, TOOLCHAIN_FEATURE_NAMES)) {
    return malformed("features", "Feature results contain missing or unknown fields");
  }
  for (const name of TOOLCHAIN_FEATURE_NAMES) {
    if (value[name] !== true) {
      return malformed(`features.${name}`, "Every required toolchain feature must pass");
    }
  }
  return ok(requiredFeatures());
}

function validateContractValue(
  value: unknown,
): Result<ToolchainContractV1, ToolchainContractError> {
  if (!isRecord(value) || !hasExactKeys(value, CONTRACT_FIELDS)) {
    return malformed("envelope", "Contract contains missing or unknown fields");
  }
  if (
    value.schema !== TOOLCHAIN_CONTRACT_SCHEMA ||
    value.schemaVersion !== TOOLCHAIN_CONTRACT_SCHEMA_VERSION ||
    value.schemaDigestSha256 !== TOOLCHAIN_CONTRACT_SCHEMA_SHA256
  ) {
    return malformed("schema", "Toolchain contract schema identity is invalid");
  }
  if (value.role !== "source" && value.role !== "target") {
    return malformed("role", "Toolchain role must be source or target");
  }
  for (const field of [
    "machineIdSha256",
    "bootIdSha256",
    "kernelIdentitySha256",
  ] as const) {
    if (!isSha256(value[field])) {
      return malformed(field, `${field} must be a lowercase SHA-256 digest`);
    }
  }
  if (value.probeProgramSha256 !== TOOLCHAIN_PROBE_PROGRAM_SHA256) {
    return malformed("probeProgramSha256", "Probe program identity is not recognized");
  }
  if (value.environmentSha256 !== TOOLCHAIN_ENVIRONMENT_SHA256) {
    return malformed("environmentSha256", "Probe environment identity is not recognized");
  }
  if (value.executionContractSha256 !== TOOLCHAIN_EXECUTION_CONTRACT_SHA256) {
    return malformed(
      "executionContractSha256",
      "Runtime-vault execution contract identity is not recognized",
    );
  }
  const features = validateFeatures(value.features);
  if (!features.ok) return features;
  if (value.featureDigestSha256 !== TOOLCHAIN_FEATURE_CONTRACT_SHA256) {
    return malformed("featureDigestSha256", "Feature result digest is invalid");
  }
  if (!Array.isArray(value.tools) || value.tools.length !== TOOL_NAMES.length) {
    return malformed("tools", "Tool list has missing or additional entries");
  }
  const tools: ToolchainToolV1[] = [];
  for (const [index, name] of TOOL_NAMES.entries()) {
    const parsed = validateToolFacts(value.tools[index], name, true);
    if (!parsed.ok) return parsed;
    tools.push(parsed.value);
  }
  const expectedToolsDigest = toolsDigest(tools);
  if (value.toolsDigestSha256 !== expectedToolsDigest) {
    return malformed("toolsDigestSha256", "Aggregate tool digest is invalid");
  }
  const contract: ToolchainContractV1 = {
    schema: TOOLCHAIN_CONTRACT_SCHEMA,
    schemaVersion: TOOLCHAIN_CONTRACT_SCHEMA_VERSION,
    schemaDigestSha256: TOOLCHAIN_CONTRACT_SCHEMA_SHA256,
    role: value.role,
    machineIdSha256: value.machineIdSha256 as string,
    bootIdSha256: value.bootIdSha256 as string,
    kernelIdentitySha256: value.kernelIdentitySha256 as string,
    probeProgramSha256: TOOLCHAIN_PROBE_PROGRAM_SHA256,
    environmentSha256: TOOLCHAIN_ENVIRONMENT_SHA256,
    executionContractSha256: TOOLCHAIN_EXECUTION_CONTRACT_SHA256,
    features: features.value,
    featureDigestSha256: TOOLCHAIN_FEATURE_CONTRACT_SHA256,
    tools,
    toolsDigestSha256: expectedToolsDigest,
    toolchainRecoveryDigestSha256: isSha256(
      value.toolchainRecoveryDigestSha256,
    )
      ? value.toolchainRecoveryDigestSha256
      : "",
    toolchainDigestSha256: isSha256(value.toolchainDigestSha256)
      ? value.toolchainDigestSha256
      : "",
  };
  if (
    !isSha256(value.toolchainRecoveryDigestSha256) ||
    computeToolchainRecoveryDigest(contract) !==
      value.toolchainRecoveryDigestSha256
  ) {
    return malformed(
      "toolchainRecoveryDigestSha256",
      "Reboot recovery toolchain digest is invalid",
    );
  }
  if (
    !isSha256(value.toolchainDigestSha256) ||
    computeToolchainContractDigest(contract) !== value.toolchainDigestSha256
  ) {
    return malformed("toolchainDigestSha256", "Complete toolchain digest is invalid");
  }
  return ok(contract);
}

export function createToolchainContractV1(
  input: CreateToolchainContractV1Input,
): Result<ToolchainContractV1, ToolchainContractError> {
  if (!isRecord(input) || (input.role !== "source" && input.role !== "target")) {
    return malformed("role", "Toolchain role must be source or target");
  }
  for (const [field, value] of [
    ["machineIdSha256", input.machineIdSha256],
    ["bootIdSha256", input.bootIdSha256],
    ["kernelIdentitySha256", input.kernelIdentitySha256],
  ] as const) {
    if (!isSha256(value)) {
      return malformed(field, `${field} must be a lowercase SHA-256 digest`);
    }
  }
  if (!Array.isArray(input.tools) || input.tools.length !== TOOL_NAMES.length) {
    return malformed("tools", "Tool list has missing or additional entries");
  }
  const tools: ToolchainToolV1[] = [];
  for (const [index, name] of TOOL_NAMES.entries()) {
    const facts = validateToolFacts(input.tools[index], name, false);
    if (!facts.ok) return facts;
    tools.push({ ...facts.value, toolDigestSha256: toolDigest(facts.value) });
  }
  const aggregateToolsDigest = toolsDigest(tools);
  const partial = {
    schema: TOOLCHAIN_CONTRACT_SCHEMA,
    schemaVersion: TOOLCHAIN_CONTRACT_SCHEMA_VERSION,
    schemaDigestSha256: TOOLCHAIN_CONTRACT_SCHEMA_SHA256,
    role: input.role,
    machineIdSha256: input.machineIdSha256,
    bootIdSha256: input.bootIdSha256,
    kernelIdentitySha256: input.kernelIdentitySha256,
    probeProgramSha256: TOOLCHAIN_PROBE_PROGRAM_SHA256,
    environmentSha256: TOOLCHAIN_ENVIRONMENT_SHA256,
    executionContractSha256: TOOLCHAIN_EXECUTION_CONTRACT_SHA256,
    features: requiredFeatures(),
    featureDigestSha256: TOOLCHAIN_FEATURE_CONTRACT_SHA256,
    tools,
    toolsDigestSha256: aggregateToolsDigest,
  };
  const recoveryPlaceholder: ToolchainContractV1 = {
    ...partial,
    toolchainRecoveryDigestSha256: "",
    toolchainDigestSha256: "",
  };
  const recoveryDigest = computeToolchainRecoveryDigest(recoveryPlaceholder);
  const placeholder: ToolchainContractV1 = {
    ...partial,
    toolchainRecoveryDigestSha256: recoveryDigest,
    toolchainDigestSha256: "0".repeat(64),
  };
  return ok({
    ...partial,
    toolchainRecoveryDigestSha256: recoveryDigest,
    toolchainDigestSha256: computeToolchainContractDigest(placeholder),
  });
}

function envelopeMarkers(role: ToolchainRole): readonly [string, string] {
  return role === "source"
    ? [TOOLCHAIN_SOURCE_ENVELOPE_BEGIN, TOOLCHAIN_SOURCE_ENVELOPE_END]
    : [TOOLCHAIN_TARGET_ENVELOPE_BEGIN, TOOLCHAIN_TARGET_ENVELOPE_END];
}

export function serializeToolchainContract(
  value: ToolchainContractV1,
): Result<string, ToolchainContractError> {
  const validated = validateContractValue(value);
  if (!validated.ok) return validated;
  const [begin, end] = envelopeMarkers(validated.value.role);
  const serialized = `${begin}\n${canonicalJson(validated.value)}\n${end}\n`;
  if (Buffer.byteLength(serialized, "utf8") > TOOLCHAIN_MAX_ENVELOPE_BYTES) {
    return malformed("envelope", "Toolchain contract exceeds its byte limit");
  }
  return ok(serialized);
}

export function parseToolchainProbeOutput(
  raw: string,
  options: ParseToolchainProbeOptions = {},
): Result<ToolchainContractV1, ToolchainContractError> {
  if (!isRecord(options)) {
    return malformed("options", "Toolchain parser options must be an object");
  }
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") > TOOLCHAIN_MAX_ENVELOPE_BYTES ||
    !raw.endsWith("\n") ||
    raw.includes("\r") ||
    raw.includes("\0")
  ) {
    return malformed("envelope", "Toolchain output has an invalid bounded envelope");
  }
  const lines = raw.slice(0, -1).split("\n");
  if (lines.length !== 3) {
    return malformed("envelope", "Toolchain output must contain exactly three lines");
  }
  let envelopeRole: ToolchainRole;
  if (
    lines[0] === TOOLCHAIN_SOURCE_ENVELOPE_BEGIN &&
    lines[2] === TOOLCHAIN_SOURCE_ENVELOPE_END
  ) {
    envelopeRole = "source";
  } else if (
    lines[0] === TOOLCHAIN_TARGET_ENVELOPE_BEGIN &&
    lines[2] === TOOLCHAIN_TARGET_ENVELOPE_END
  ) {
    envelopeRole = "target";
  } else {
    return malformed("envelope", "Toolchain output has unknown or mismatched markers");
  }
  const parsedJson = tryCatch(() => JSON.parse(lines[1] as string) as unknown);
  if (!parsedJson.ok) return malformed("envelope", "Toolchain payload is not JSON");
  const validated = validateContractValue(parsedJson.value);
  if (!validated.ok) return validated;
  if (validated.value.role !== envelopeRole) {
    return malformed("role", "Envelope and payload roles do not match");
  }
  if (options.role !== undefined && options.role !== validated.value.role) {
    return malformed("role", "Toolchain output does not have the expected role");
  }
  if (
    options.expectedMachineIdSha256 !== undefined &&
    (!isSha256(options.expectedMachineIdSha256) ||
      options.expectedMachineIdSha256 !== validated.value.machineIdSha256)
  ) {
    return malformed("machineIdSha256", "Toolchain output does not match the machine pin");
  }
  const canonical = serializeToolchainContract(validated.value);
  if (!canonical.ok) return canonical;
  if (canonical.value !== raw) {
    return malformed(
      "envelope",
      "Toolchain output contains duplicate, reordered, or non-canonical fields",
    );
  }
  return validated;
}

export interface ToolchainStabilityReportV1 {
  readonly stable: true;
  readonly role: ToolchainRole;
  readonly machineIdSha256: string;
  readonly bootIdSha256: string;
  readonly toolchainDigestSha256: string;
}

/** Compare two samples of one role. This is not a source/target compatibility check. */
export function compareToolchainContracts(
  expected: ToolchainContractV1,
  actual: ToolchainContractV1,
): Result<ToolchainStabilityReportV1, ToolchainContractError> {
  const left = validateContractValue(expected);
  if (!left.ok) return left;
  const right = validateContractValue(actual);
  if (!right.ok) return right;
  for (const field of [
    "role",
    "machineIdSha256",
    "bootIdSha256",
    "kernelIdentitySha256",
    "schemaDigestSha256",
    "probeProgramSha256",
    "environmentSha256",
    "executionContractSha256",
    "featureDigestSha256",
    "toolsDigestSha256",
    "toolchainRecoveryDigestSha256",
    "toolchainDigestSha256",
  ] as const) {
    if (left.value[field] !== right.value[field]) {
      return err({
        kind: "toolchain_stability_mismatch",
        field,
        message: `Repeated ${left.value.role} toolchain sample is not stable`,
      });
    }
  }
  return ok({
    stable: true,
    role: left.value.role,
    machineIdSha256: left.value.machineIdSha256,
    bootIdSha256: left.value.bootIdSha256,
    toolchainDigestSha256: left.value.toolchainDigestSha256,
  });
}

export interface ToolchainRecoveryReportV1 {
  readonly recoverable: true;
  readonly role: ToolchainRole;
  readonly machineIdSha256: string;
  readonly previousBootIdSha256: string;
  readonly currentBootIdSha256: string;
  readonly toolchainRecoveryDigestSha256: string;
}

/**
 * Recovery requires equality of role, machine, kernel, schema, probe program,
 * environment, absolute execution contract, feature contract, and tool
 * inventory. Only bootIdSha256 and the boot-bound full digest are excluded.
 */
export function compareToolchainRecovery(
  expected: ToolchainContractV1,
  actual: ToolchainContractV1,
): Result<ToolchainRecoveryReportV1, ToolchainContractError> {
  const left = validateContractValue(expected);
  if (!left.ok) return left;
  const right = validateContractValue(actual);
  if (!right.ok) return right;
  for (const field of [
    "role",
    "machineIdSha256",
    "kernelIdentitySha256",
    "schema",
    "schemaVersion",
    "schemaDigestSha256",
    "probeProgramSha256",
    "environmentSha256",
    "executionContractSha256",
    "featureDigestSha256",
    "toolsDigestSha256",
    "toolchainRecoveryDigestSha256",
  ] as const) {
    if (left.value[field] !== right.value[field]) {
      return err({
        kind: "toolchain_recovery_mismatch",
        field,
        message: "Runtime-vault recovery toolchain identity changed across the reboot",
      });
    }
  }
  return ok({
    recoverable: true,
    role: left.value.role,
    machineIdSha256: left.value.machineIdSha256,
    previousBootIdSha256: left.value.bootIdSha256,
    currentBootIdSha256: right.value.bootIdSha256,
    toolchainRecoveryDigestSha256:
      left.value.toolchainRecoveryDigestSha256,
  });
}

export interface ToolchainCompatibilityReportV1 {
  readonly compatible: true;
  readonly schema: typeof TOOLCHAIN_CONTRACT_SCHEMA;
  readonly schemaVersion: typeof TOOLCHAIN_CONTRACT_SCHEMA_VERSION;
  readonly schemaDigestSha256: string;
  readonly probeProgramSha256: string;
  readonly environmentSha256: string;
  readonly executionContractSha256: string;
  readonly featureDigestSha256: string;
  readonly sourceMachineIdSha256: string;
  readonly targetMachineIdSha256: string;
  readonly sourceToolchainDigestSha256: string;
  readonly targetToolchainDigestSha256: string;
  readonly sourceToolchainRecoveryDigestSha256: string;
  readonly targetToolchainRecoveryDigestSha256: string;
}

/** Compare capabilities across roles without requiring equal binaries or versions. */
export function compareToolchainCompatibility(
  source: ToolchainContractV1,
  target: ToolchainContractV1,
): Result<ToolchainCompatibilityReportV1, ToolchainContractError> {
  const checkedSource = validateContractValue(source);
  if (!checkedSource.ok) return checkedSource;
  const checkedTarget = validateContractValue(target);
  if (!checkedTarget.ok) return checkedTarget;
  if (checkedSource.value.role !== "source" || checkedTarget.value.role !== "target") {
    return err({
      kind: "toolchain_incompatible",
      field: "role",
      message: "Compatibility requires a source contract followed by a target contract",
    });
  }
  if (checkedSource.value.machineIdSha256 === checkedTarget.value.machineIdSha256) {
    return err({
      kind: "toolchain_incompatible",
      field: "machineIdSha256",
      message: "Source and target toolchain contracts must identify different machines",
    });
  }
  for (const field of [
    "schemaDigestSha256",
    "probeProgramSha256",
    "environmentSha256",
    "executionContractSha256",
    "featureDigestSha256",
  ] as const) {
    if (checkedSource.value[field] !== checkedTarget.value[field]) {
      return err({
        kind: "toolchain_incompatible",
        field,
        message: "Source and target do not satisfy the same toolchain feature contract",
      });
    }
  }
  return ok({
    compatible: true,
    schema: TOOLCHAIN_CONTRACT_SCHEMA,
    schemaVersion: TOOLCHAIN_CONTRACT_SCHEMA_VERSION,
    schemaDigestSha256: checkedSource.value.schemaDigestSha256,
    probeProgramSha256: checkedSource.value.probeProgramSha256,
    environmentSha256: checkedSource.value.environmentSha256,
    executionContractSha256: checkedSource.value.executionContractSha256,
    featureDigestSha256: checkedSource.value.featureDigestSha256,
    sourceMachineIdSha256: checkedSource.value.machineIdSha256,
    targetMachineIdSha256: checkedTarget.value.machineIdSha256,
    sourceToolchainDigestSha256: checkedSource.value.toolchainDigestSha256,
    targetToolchainDigestSha256: checkedTarget.value.toolchainDigestSha256,
    sourceToolchainRecoveryDigestSha256:
      checkedSource.value.toolchainRecoveryDigestSha256,
    targetToolchainRecoveryDigestSha256:
      checkedTarget.value.toolchainRecoveryDigestSha256,
  });
}

const TOOLCHAIN_PROBE_PYTHON = String.raw`import ctypes
import errno
import hashlib
import json
import os
import stat
import subprocess
import sys
import tarfile

SCHEMA = ${JSON.stringify(TOOLCHAIN_CONTRACT_SCHEMA)}
SCHEMA_VERSION = ${TOOLCHAIN_CONTRACT_SCHEMA_VERSION}
SCHEMA_DIGEST_DOMAIN = "comis-runtime-vault-toolchain-schema-v1"
ENVIRONMENT_DIGEST_DOMAIN = "comis-runtime-vault-toolchain-environment-v1"
EXECUTION_DIGEST_DOMAIN = "comis-runtime-vault-toolchain-execution-v1"
FEATURE_DIGEST_DOMAIN = "comis-runtime-vault-toolchain-features-v1"
PATH_DIGEST_DOMAIN = "comis-runtime-vault-toolchain-path-v1"
TOOL_DIGEST_DOMAIN = "comis-runtime-vault-toolchain-tool-v1"
TOOLS_DIGEST_DOMAIN = "comis-runtime-vault-toolchain-tools-v1"
CONTRACT_DIGEST_DOMAIN = "comis-runtime-vault-toolchain-contract-v1"
RECOVERY_DIGEST_DOMAIN = "comis-runtime-vault-toolchain-recovery-v1"
SOURCE_BEGIN = ${JSON.stringify(TOOLCHAIN_SOURCE_ENVELOPE_BEGIN)}
SOURCE_END = ${JSON.stringify(TOOLCHAIN_SOURCE_ENVELOPE_END)}
TARGET_BEGIN = ${JSON.stringify(TOOLCHAIN_TARGET_ENVELOPE_BEGIN)}
TARGET_END = ${JSON.stringify(TOOLCHAIN_TARGET_ENVELOPE_END)}
MAX_ENVELOPE_BYTES = ${TOOLCHAIN_MAX_ENVELOPE_BYTES}
MAX_BINARY_BYTES = 512 * 1024 * 1024
MAX_COMMAND_BYTES = 64 * 1024
EXPECTED_ENV = ${JSON.stringify(TOOLCHAIN_ENVIRONMENT)}
HELPERS = ${JSON.stringify(TOOLCHAIN_HELPERS)}
EXECUTION_CONTRACT = ${JSON.stringify(TOOLCHAIN_EXECUTION_CONTRACT_V1)}
FEATURE_NAMES = ${JSON.stringify(TOOLCHAIN_FEATURE_NAMES)}
CONTRACT_FIELDS = ${JSON.stringify(CONTRACT_FIELDS)}
TOOL_FIELDS = ${JSON.stringify(TOOL_FIELDS)}
VERSION_ARGS = {
    "awk": ["-W", "version"],
    "bash": ["--version"],
    "cat": ["--version"],
    "chmod": ["--version"],
    "env": ["--version"],
    "findmnt": ["--version"],
    "flock": ["--version"],
    "id": ["--version"],
    "install": ["--version"],
    "ln": ["--version"],
    "mkdir": ["--version"],
    "mount": ["--version"],
    "mv": ["--version"],
    "python3": ["--version"],
    "readlink": ["--version"],
    "realpath": ["--version"],
    "rm": ["--version"],
    "sed": ["--version"],
    "sha256sum": ["--version"],
    "stat": ["--version"],
    "sync": ["--version"],
    "systemctl": ["--version"],
    "sudo": ["--version"],
    "tar": ["--version"],
    "true": ["--version"],
    "uname": ["--version"],
    "unshare": ["--version"],
    "zstd": ["--version"],
}
SHA256_RE = __import__("re").compile(r"^[a-f0-9]{64}$")


class ProbeFailure(Exception):
    pass


def require(condition):
    if not condition:
        raise ProbeFailure()


def pass_feature(features, name):
    require(name in FEATURE_NAMES and name not in features)
    features[name] = True


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def canonical_digest(domain, value):
    digest = hashlib.sha256()
    digest.update(domain.encode("ascii"))
    digest.update(b"\0")
    digest.update(canonical_json(value).encode("utf8"))
    return digest.hexdigest()


def run(command, input_bytes=None, expected=(0,), cwd=None, pass_fds=()):
    options = {
        "cwd": cwd,
        "env": EXPECTED_ENV,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "timeout": 15,
        "check": False,
        "pass_fds": pass_fds,
    }
    if input_bytes is None:
        options["stdin"] = subprocess.DEVNULL
    else:
        options["input"] = input_bytes
    completed = subprocess.run(command, **options)
    require(completed.returncode in expected)
    require(len(completed.stdout) + len(completed.stderr) <= MAX_COMMAND_BYTES)
    return completed


def raw_file_digest(path):
    require(hasattr(os, "O_NOATIME") and os.O_NOATIME != 0)
    digest = hashlib.sha256()
    total = 0
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NOATIME
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "rb", buffering=0, closefd=True) as source:
        before = os.fstat(source.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_gid == 0)
        require(stat.S_IMODE(before.st_mode) & 0o022 == 0)
        while True:
            chunk = source.read(64 * 1024)
            if chunk == b"":
                break
            total += len(chunk)
            require(total <= 4096)
            digest.update(chunk)
        after = os.fstat(source.fileno())
    require((before.st_dev, before.st_ino, before.st_mode, before.st_uid, before.st_gid,
             before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
            (after.st_dev, after.st_ino, after.st_mode, after.st_uid, after.st_gid,
             after.st_size, after.st_mtime_ns, after.st_ctime_ns))
    return digest.hexdigest()


def path_chain(path, visited=None):
    if visited is None:
        visited = set()
    require(path not in visited)
    visited.add(path)
    parts = path.split("/")[1:]
    current = "/"
    chain = []
    for part in [""] + parts:
        if part != "":
            current = os.path.join(current, part)
        value = os.lstat(current)
        require(value.st_uid == 0 and value.st_gid == 0)
        kind = "link" if stat.S_ISLNK(value.st_mode) else "directory" if stat.S_ISDIR(value.st_mode) else "file"
        if not stat.S_ISLNK(value.st_mode):
            require(stat.S_IMODE(value.st_mode) & 0o022 == 0)
        item = {
            "gid": value.st_gid,
            "kind": kind,
            "modeOctal": format(stat.S_IMODE(value.st_mode), "04o"),
            "path": current,
            "uid": value.st_uid,
        }
        if stat.S_ISLNK(value.st_mode):
            link_target = os.readlink(current)
            item["linkTarget"] = link_target
            target_path = os.path.normpath(
                link_target if link_target.startswith("/") else os.path.join(os.path.dirname(current), link_target)
            )
            require(target_path.startswith("/"))
            chain.extend(path_chain(target_path, visited))
        chain.append(item)
    return chain


def inspect_tool(name, path):
    require(path.startswith("/") and os.path.normpath(path) == path)
    invocation_chain = path_chain(path)
    resolved = os.path.realpath(path)
    require(resolved.startswith("/") and os.path.realpath(resolved) == resolved)
    resolved_chain = path_chain(resolved)
    value = os.stat(resolved, follow_symlinks=False)
    require(stat.S_ISREG(value.st_mode))
    require(value.st_uid == 0 and value.st_gid == 0)
    require(stat.S_IMODE(value.st_mode) & 0o022 == 0)
    require(stat.S_IMODE(value.st_mode) & 0o111 != 0)
    require(0 < value.st_size <= MAX_BINARY_BYTES)
    require(hasattr(os, "O_NOATIME") and os.O_NOATIME != 0)
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NOATIME
    descriptor = os.open(resolved, flags)
    try:
        before = os.fstat(descriptor)
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(descriptor, 64 * 1024)
            if chunk == b"":
                break
            total += len(chunk)
            require(total <= MAX_BINARY_BYTES)
            digest.update(chunk)
        after = os.fstat(descriptor)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns))
    finally:
        os.close(descriptor)
    version = run([path] + VERSION_ARGS[name])
    version_digest = hashlib.sha256(
        b"stdout\0" + version.stdout + b"\0stderr\0" + version.stderr
    ).hexdigest()
    facts = {
        "binarySha256": digest.hexdigest(),
        "modeOctal": format(stat.S_IMODE(value.st_mode), "04o"),
        "name": name,
        "ownerGid": 0,
        "ownerUid": 0,
        "path": path,
        "pathChainNonWritable": True,
        "pathChainRootOwned": True,
        "pathIdentitySha256": canonical_digest(
            PATH_DIGEST_DOMAIN,
            {"invocation": invocation_chain, "resolved": resolved_chain},
        ),
        "resolvedPath": resolved,
        "versionSha256": version_digest,
    }
    return {**facts, "toolDigestSha256": canonical_digest(TOOL_DIGEST_DOMAIN, facts)}


def verify_role_marker(role):
    marker = "/etc/comis/environment-role"
    if role == "source" and not os.path.lexists(marker):
        return
    value = os.lstat(marker)
    require(stat.S_ISREG(value.st_mode) and not stat.S_ISLNK(value.st_mode))
    require(value.st_uid == 0 and value.st_gid == 0 and stat.S_IMODE(value.st_mode) == 0o644)
    require(value.st_nlink == 1 and value.st_size <= 16)
    descriptor = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NOATIME)
    with os.fdopen(descriptor, "rb", closefd=True) as source:
        opened = os.fstat(source.fileno())
        require((opened.st_dev, opened.st_ino) == (value.st_dev, value.st_ino))
        content = source.read(17)
    require(content == (("production" if role == "source" else "test") + "\n").encode("ascii"))


def verify_mounts(mount, findmnt, source_root, bind_root, features):
    require(os.stat("/proc/self/ns/mnt").st_ino != os.stat("/proc/1/ns/mnt").st_ino)
    root_facts = run([findmnt, "--first-only", "--noheadings", "--raw", "--output", "TARGET,OPTIONS", "--target", "/"])
    root_fields = root_facts.stdout.decode("ascii").strip().split()
    require(len(root_fields) == 2 and root_fields[0] == "/")
    require({"ro", "noatime", "nodiratime", "nosuid", "nodev"}.issubset(set(root_fields[1].split(","))))
    pass_feature(features, "privateMountNamespace")
    tmp_before = os.lstat("/tmp")
    require(stat.S_ISDIR(tmp_before.st_mode) and not stat.S_ISLNK(tmp_before.st_mode))
    require(tmp_before.st_uid == 0 and tmp_before.st_gid == 0)
    run([mount, "-t", "tmpfs", "-o", "mode=0700,nosuid,nodev,noexec,size=16m", "comis-toolchain-contract", "/tmp"])
    tmp_facts = run([findmnt, "--first-only", "--noheadings", "--raw", "--output", "TARGET,FSTYPE,OPTIONS", "--target", "/tmp"])
    tmp_fields = tmp_facts.stdout.decode("ascii").strip().split()
    require(len(tmp_fields) == 3 and tmp_fields[0] == "/tmp" and tmp_fields[1] == "tmpfs")
    require({"rw", "nosuid", "nodev", "noexec"}.issubset(set(tmp_fields[2].split(","))))
    pass_feature(features, "tmpfsMount")
    os.mkdir("/tmp/comis-toolchain-contract", 0o700)
    os.mkdir(source_root, 0o700)
    os.mkdir(bind_root, 0o700)
    run([mount, "--bind", source_root, bind_root])
    run([mount, "-o", "remount,bind,ro,noatime,nodiratime,nosuid,nodev,noexec", bind_root])
    bind_facts = run([findmnt, "--first-only", "--noheadings", "--raw", "--output", "TARGET,OPTIONS", "--target", bind_root])
    bind_fields = bind_facts.stdout.decode("ascii").strip().split()
    require(len(bind_fields) == 2 and bind_fields[0] == bind_root)
    require({"ro", "noatime", "nodiratime", "nosuid", "nodev", "noexec"}.issubset(set(bind_fields[1].split(","))))
    try:
        descriptor = os.open(os.path.join(bind_root, "must-not-write"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError as error:
        require(error.errno in (errno.EROFS, errno.EACCES, errno.EPERM))
    else:
        os.close(descriptor)
        raise ProbeFailure()
    pass_feature(features, "readOnlyBindMount")
    pass_feature(features, "findmntTargetAndOptions")


def verify_tar_and_zstd(tar, zstd, python3, source_root, bind_root, scratch, features):
    tar_version = run([tar, "--version"])
    require(b"GNU tar" in tar_version.stdout)
    archive = os.path.join(scratch, "payload.tar.zst")
    created = run([
        tar,
        "--create",
        "--file=-",
        "--format=posix",
        "--zstd",
        "--numeric-owner",
        "--pax-option=delete=atime,delete=ctime",
        "--directory=" + bind_root,
        ".",
    ])
    require(created.stderr == b"" and len(created.stdout) > 0)
    with open(archive, "wb") as target:
        target.write(created.stdout)
    listing = run([tar, "--list", "--file=" + archive, "--zstd"])
    require(b"./payload.txt\n" in listing.stdout)
    pass_feature(features, "gnuTarZstdExactFlags")

    extract_root = os.path.join(scratch, "extracted")
    os.mkdir(extract_root, 0o700)
    extractor_path = os.path.join(scratch, "extractor.py")
    extractor_program = r'''import os
import stat
import sys
import tarfile

root = sys.argv[1]
with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as archive:
    archive.extractall(root, filter=tarfile.data_filter)
payload = os.path.join(root, "payload.txt")
value = os.lstat(payload)
if not stat.S_ISREG(value.st_mode) or open(payload, "rb").read() != b"runtime-vault-toolchain\n":
    raise SystemExit(1)
descriptor = os.open(payload, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
sys.stdout.write("extracted\n")
'''
    with open(extractor_path, "w", encoding="utf8") as target:
        target.write(extractor_program)
    os.chmod(extractor_path, 0o700)
    decoder = subprocess.Popen(
        [zstd, "-dc"],
        env=EXPECTED_ENV,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    require(decoder.stdin is not None and decoder.stdout is not None and decoder.stderr is not None)
    extractor = subprocess.Popen(
        [python3, "-I", "-S", "-B", extractor_path, extract_root],
        env=EXPECTED_ENV,
        stdin=decoder.stdout,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    decoder.stdout.close()
    decoder.stdin.write(created.stdout)
    decoder.stdin.close()
    extractor_stdout, extractor_stderr = extractor.communicate(timeout=15)
    decoder_stderr = decoder.stderr.read(MAX_COMMAND_BYTES + 1)
    require(decoder.wait(timeout=15) == 0 and extractor.returncode == 0)
    require(decoder_stderr == b"" and extractor_stderr == b"")
    require(extractor_stdout == b"extracted\n")
    require(open(os.path.join(extract_root, "payload.txt"), "rb").read() == b"runtime-vault-toolchain\n")
    pass_feature(features, "pythonStreamingTarExtraction")
    pass_feature(features, "zstdPythonExtractionPipeline")

    corrupt = os.path.join(scratch, "corrupt.zst")
    with open(corrupt, "wb") as target:
        target.write(b"not-a-zstd-frame")
    rejected = subprocess.run(
        [zstd, "-dc", corrupt],
        env=EXPECTED_ENV,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
    )
    require(rejected.returncode != 0 and rejected.stdout == b"")
    require(len(rejected.stderr) <= MAX_COMMAND_BYTES)
    pass_feature(features, "corruptedZstdRejected")


def verify_sync(sync, source_root, scratch, features):
    sync_file = os.path.join(source_root, "payload.txt")
    run([sync, "-f", sync_file])
    pass_feature(features, "syncFile")
    run([sync, "-f", scratch])
    pass_feature(features, "syncDirectory")


def verify_flock(flock, true_command, scratch, features):
    lock_path = os.path.join(scratch, "exclusive.lock")
    holder_descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    contender_descriptor = os.open(lock_path, os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        run([flock, "-n", str(holder_descriptor)], pass_fds=(holder_descriptor,))
        contender = run(
            [flock, "-n", str(contender_descriptor)],
            expected=(1,),
            pass_fds=(contender_descriptor,),
        )
        require(contender.returncode == 1)
        pathname_contender = run([flock, "-n", lock_path, true_command], expected=(1,))
        require(pathname_contender.returncode == 1)
        pass_feature(features, "flockExclusivity")
        os.close(holder_descriptor)
        holder_descriptor = -1
        run([flock, "-n", lock_path, true_command])
        run(
            [flock, "-n", str(contender_descriptor)],
            pass_fds=(contender_descriptor,),
        )
        pass_feature(features, "flockRelease")
    finally:
        if holder_descriptor >= 0:
            os.close(holder_descriptor)
        os.close(contender_descriptor)


def verify_sha256(sha256sum, awk, scratch, features):
    result = run([sha256sum], input_bytes=b"abc")
    require(result.stderr == b"")
    require(result.stdout == b"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  -\n")
    pass_feature(features, "knownSha256")
    sample = os.path.join(scratch, "sha-sample")
    with open(sample, "wb") as target:
        target.write(b"abc")
    file_digest = run([sha256sum, sample])
    first_field = run([awk, "{print $1}"], input_bytes=file_digest.stdout)
    require(first_field.stdout == b"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n")
    pass_feature(features, "awkFirstField")
    pass_feature(features, "sha256AwkPipeline")


def verify_realpath(realpath, scratch, features):
    physical = os.path.join(scratch, "physical")
    os.mkdir(physical, 0o700)
    leaf = os.path.join(physical, "leaf")
    with open(leaf, "wb") as target:
        target.write(b"leaf")
    realpath_link = os.path.join(scratch, "alias")
    os.symlink(physical, realpath_link)
    existing = run([realpath, "-e", "--", realpath_link + "/leaf"])
    require(existing.stdout == (leaf + "\n").encode("ascii"))
    pass_feature(features, "realpathExistingPhysical")
    missing_path = realpath_link + "/missing/../future"
    missing = run([realpath, "-m", "--", missing_path])
    require(missing.stdout == (os.path.join(physical, "future") + "\n").encode("ascii"))
    pass_feature(features, "realpathMissingCanonical")


def verify_script_path_shell(env, bash, scratch, features):
    script_path = os.path.join(scratch, "archive-receiver.sh")
    script = r'''set -euo pipefail
[ "$#" -eq 2 ]
[ "$1" = left ]
[ "$2" = right ]
IFS= read -r archive
[ "$archive" = archive-stream ]
[ "$PATH" = /usr/bin:/bin ]
[ "$LC_ALL" = C ]
[ "$TZ" = Etc/UTC ]
[[ ! -v HOME ]]
printf '%s\n' script-path-ok
'''
    with open(script_path, "w", encoding="ascii") as target:
        target.write(script)
    os.chmod(script_path, 0o700)
    result = run(
        [env, "-i", "PATH=/usr/bin:/bin", "LC_ALL=C", "TZ=Etc/UTC",
         bash, "--noprofile", "--norc", script_path, "left", "right"],
        input_bytes=b"archive-stream\n",
    )
    require(result.stdout == b"script-path-ok\n" and result.stderr == b"")
    pass_feature(features, "absoluteScriptPathArchiveStdin")


def verify_file_primitives(helpers, scratch, features):
    install = helpers["install"]
    mkdir = helpers["mkdir"]
    chmod = helpers["chmod"]
    cat = helpers["cat"]
    readlink = helpers["readlink"]
    ln = helpers["ln"]
    stat_command = helpers["stat"]
    mv = helpers["mv"]
    rm = helpers["rm"]
    sed = helpers["sed"]

    installed = os.path.join(scratch, "installed")
    run([install, "-d", "-m", "0700", "-o", "root", "-g", "root", installed])
    installed_value = os.lstat(installed)
    require(stat.S_ISDIR(installed_value.st_mode) and installed_value.st_uid == 0 and installed_value.st_gid == 0)
    require(stat.S_IMODE(installed_value.st_mode) == 0o700)
    pass_feature(features, "installRootDirectories")

    made = os.path.join(scratch, "made")
    run([mkdir, "-m", "0700", "--", made])
    require(stat.S_ISDIR(os.lstat(made).st_mode) and stat.S_IMODE(os.lstat(made).st_mode) == 0o700)
    pass_feature(features, "mkdirModes")

    payload = os.path.join(scratch, "file-primitives")
    with open(payload, "wb") as target:
        target.write(b"runtime-vault-file-primitives\n")
    run([chmod, "0400", payload])
    require(stat.S_IMODE(os.lstat(payload).st_mode) == 0o400)
    run([chmod, "0600", payload])
    require(stat.S_IMODE(os.lstat(payload).st_mode) == 0o600)
    pass_feature(features, "chmodModes")
    require(run([cat, "--", payload]).stdout == b"runtime-vault-file-primitives\n")
    pass_feature(features, "catExactBytes")

    canonical_link = os.path.join(scratch, "canonical-link")
    os.symlink(payload, canonical_link)
    require(run([readlink, "-f", "--", canonical_link]).stdout == (payload + "\n").encode("ascii"))
    pass_feature(features, "readlinkPhysical")

    hard_link = os.path.join(scratch, "hard-link")
    run([ln, "--", payload, hard_link])
    payload_value = os.stat(payload)
    link_value = os.stat(hard_link)
    require((payload_value.st_dev, payload_value.st_ino, payload_value.st_nlink) ==
            (link_value.st_dev, link_value.st_ino, 2))
    pass_feature(features, "hardLinkIdentity")

    stat_format = "%d:%i:%u:%g:%a:%h:%s"
    expected_stat = f"{payload_value.st_dev}:{payload_value.st_ino}:0:0:600:2:{payload_value.st_size}\n".encode("ascii")
    require(run([stat_command, "-c", stat_format, payload]).stdout == expected_stat)
    descriptor = os.open(payload, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        descriptor_path = "/proc/self/fd/" + str(descriptor)
        require(run(
            [stat_command, "-Lc", stat_format, descriptor_path],
            pass_fds=(descriptor,),
        ).stdout == expected_stat)
    finally:
        os.close(descriptor)
    pass_feature(features, "gnuStatFormatsAndDereference")

    move_source = os.path.join(scratch, "move-source")
    move_target = os.path.join(scratch, "move-target")
    with open(move_source, "wb") as target:
        target.write(b"source")
    with open(move_target, "wb") as target:
        target.write(b"target")
    collision = run(
        [mv, "--no-clobber", "--", move_source, move_target],
        expected=(1,),
    )
    require(collision.returncode == 1 and b"not replacing" in collision.stderr)
    require(open(move_source, "rb").read() == b"source" and open(move_target, "rb").read() == b"target")
    os.unlink(move_target)
    run([mv, "--no-clobber", "--", move_source, move_target])
    require(not os.path.lexists(move_source) and open(move_target, "rb").read() == b"source")
    pass_feature(features, "mvNoClobber")

    replacement = os.path.join(scratch, "replacement")
    with open(replacement, "wb") as target:
        target.write(b"replacement")
    run([mv, "--", replacement, move_target])
    require(not os.path.lexists(replacement) and open(move_target, "rb").read() == b"replacement")
    pass_feature(features, "mvAtomicReplace")

    run([rm, "-f", "--", move_target])
    require(not os.path.lexists(move_target))
    recursive = os.path.join(scratch, "recursive")
    os.makedirs(os.path.join(recursive, "nested"), mode=0o700)
    with open(os.path.join(recursive, "nested", "file"), "wb") as target:
        target.write(b"remove")
    run([rm, "-rf", "--", recursive])
    require(not os.path.lexists(recursive))
    pass_feature(features, "recursiveAndFileRemoval")

    facts = b"digestSha256=abc\nentryCount=1\n"
    extracted = run([sed, "-n", "s/^digestSha256=//p"], input_bytes=facts)
    require(extracted.stdout == b"abc\n")
    pass_feature(features, "sedFieldExtraction")


def verify_host_observation_primitives(helpers, features):
    require(run([helpers["id"], "-u"]).stdout == b"0\n")
    pass_feature(features, "idRoot")
    require(run([helpers["uname"], "-s"]).stdout == b"Linux\n")
    pass_feature(features, "unameLinux")
    run([helpers["true"]])
    pass_feature(features, "trueExitStatus")
    strict = run(
        [helpers["bash"], "--noprofile", "--norc", "-c", "set -euo pipefail; false | true"],
        expected=(1,),
    )
    require(strict.returncode == 1)
    pass_feature(features, "bashStrictPipefail")


def verify_python_features(source_root, features):
    require(sys.version_info >= (3, 12))
    pass_feature(features, "pythonAtLeast312")
    require(sys.flags.isolated == 1 and sys.flags.no_site == 1 and sys.flags.dont_write_bytecode == 1)
    pass_feature(features, "pythonIsolatedMode")
    require(callable(tarfile.data_filter))
    filtered = tarfile.data_filter(tarfile.TarInfo("entry"), source_root)
    require(filtered is not None and filtered.name == "entry")
    pass_feature(features, "pythonTarfileDataFilter")
    replaced = tarfile.TarInfo("entry").replace(mode=0o600)
    require(replaced.mode == 0o600)
    pass_feature(features, "pythonTarInfoReplace")
    require(callable(os.listxattr))
    require(isinstance(os.listxattr(source_root, follow_symlinks=False), list))
    pass_feature(features, "pythonListxattr")
    require(os.open in os.supports_dir_fd and os.utime in os.supports_dir_fd)
    pass_feature(features, "pythonDirFd")
    require(hasattr(os, "O_NOFOLLOW") and os.O_NOFOLLOW != 0)
    pass_feature(features, "pythonONofollow")
    require(hasattr(os, "O_DIRECTORY") and os.O_DIRECTORY != 0)
    pass_feature(features, "pythonODirectory")
    payload_path = os.path.join(source_root, "payload.txt")
    os.setxattr(payload_path, "user.comis-toolchain-contract", b"present", follow_symlinks=False)
    require("user.comis-toolchain-contract" in os.listxattr(payload_path, follow_symlinks=False))
    require(os.getxattr(payload_path, "user.comis-toolchain-contract", follow_symlinks=False) == b"present")
    os.removexattr(payload_path, "user.comis-toolchain-contract", follow_symlinks=False)
    require("user.comis-toolchain-contract" not in os.listxattr(payload_path, follow_symlinks=False))
    pass_feature(features, "pythonSetxattrRoundTrip")
    directory = os.open(source_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        payload = os.open("payload.txt", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        try:
            os.fsync(payload)
        finally:
            os.close(payload)
        pass_feature(features, "pythonFsyncFile")
        os.utime("payload.txt", ns=(1_000_000_000, 1_000_000_000), dir_fd=directory, follow_symlinks=False)
        require(os.stat("payload.txt", dir_fd=directory, follow_symlinks=False).st_mtime_ns == 1_000_000_000)
        pass_feature(features, "pythonUtime")
        os.fsync(directory)
        pass_feature(features, "pythonFsyncDirectory")
    finally:
        os.close(directory)
    os.chmod(payload_path, 0o600, follow_symlinks=False)
    require(stat.S_IMODE(os.lstat(payload_path).st_mode) == 0o600)
    pass_feature(features, "pythonChmod")
    os.chown(payload_path, 0, 0, follow_symlinks=False)
    require(os.lstat(payload_path).st_uid == 0 and os.lstat(payload_path).st_gid == 0)
    pass_feature(features, "pythonChown")
    link = os.path.join(source_root, "ownership-link")
    os.symlink("payload.txt", link)
    require(callable(os.lchown))
    os.lchown(link, os.geteuid(), os.getegid())
    require(stat.S_ISLNK(os.lstat(link).st_mode))
    pass_feature(features, "pythonLchown")
    filesystem = os.statvfs(source_root)
    require(filesystem.f_bsize > 0 and filesystem.f_frsize > 0 and filesystem.f_bavail >= 0)
    pass_feature(features, "pythonStatvfs")


def verify_renameat2(scratch, features):
    AT_FDCWD = -100
    RENAME_NOREPLACE = 1
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    require(renameat2 is not None)
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    source = os.path.join(scratch, "rename-source")
    target = os.path.join(scratch, "rename-target")
    with open(source, "wb") as output:
        output.write(b"source")
    with open(target, "wb") as output:
        output.write(b"target")
    ctypes.set_errno(0)
    result = renameat2(AT_FDCWD, os.fsencode(source), AT_FDCWD, os.fsencode(target), RENAME_NOREPLACE)
    require(result == -1 and ctypes.get_errno() == errno.EEXIST)
    require(os.path.exists(source) and open(target, "rb").read() == b"target")
    os.unlink(target)
    ctypes.set_errno(0)
    result = renameat2(AT_FDCWD, os.fsencode(source), AT_FDCWD, os.fsencode(target), RENAME_NOREPLACE)
    require(result == 0 and not os.path.exists(source) and open(target, "rb").read() == b"source")
    pass_feature(features, "renameat2NoReplace")


def main():
    require(len(sys.argv) == 5)
    features = {}
    role, expected_machine, probe_program_digest, expected_environment_digest = sys.argv[1:]
    require(role in ("source", "target"))
    require(SHA256_RE.fullmatch(expected_machine) is not None)
    require(SHA256_RE.fullmatch(probe_program_digest) is not None)
    require(os.geteuid() == 0 and sys.platform == "linux")
    require(dict(os.environ) == EXPECTED_ENV)
    environment_digest = canonical_digest(ENVIRONMENT_DIGEST_DOMAIN, EXPECTED_ENV)
    require(environment_digest == expected_environment_digest)
    execution_contract_digest = canonical_digest(EXECUTION_DIGEST_DOMAIN, EXECUTION_CONTRACT)
    require(execution_contract_digest == ${JSON.stringify(TOOLCHAIN_EXECUTION_CONTRACT_SHA256)})
    pass_feature(features, "absoluteSanitizedRootExecution")
    pass_feature(features, "systemctlObservationCommands")
    machine_digest = raw_file_digest("/etc/machine-id")
    require(machine_digest == expected_machine)
    boot_digest = raw_file_digest("/proc/sys/kernel/random/boot_id")
    kernel_digest = raw_file_digest("/proc/sys/kernel/osrelease")
    scratch = "/tmp/comis-toolchain-contract"
    source_root = scratch + "/source"
    bind_root = scratch + "/read-only"
    verify_mounts(HELPERS["mount"], HELPERS["findmnt"], source_root, bind_root, features)
    verify_role_marker(role)
    tools = [inspect_tool(name, HELPERS[name]) for name in sorted(HELPERS)]
    pass_feature(features, "noAtimeStableDescriptorReads")
    with open(os.path.join(source_root, "payload.txt"), "wb") as target:
        target.write(b"runtime-vault-toolchain\n")
    verify_tar_and_zstd(
        HELPERS["tar"], HELPERS["zstd"], HELPERS["python3"],
        source_root, bind_root, scratch, features,
    )
    verify_sync(HELPERS["sync"], source_root, scratch, features)
    verify_flock(HELPERS["flock"], HELPERS["true"], scratch, features)
    verify_sha256(HELPERS["sha256sum"], HELPERS["awk"], scratch, features)
    verify_realpath(HELPERS["realpath"], scratch, features)
    verify_script_path_shell(HELPERS["env"], HELPERS["bash"], scratch, features)
    verify_file_primitives(HELPERS, scratch, features)
    verify_host_observation_primitives(HELPERS, features)
    verify_python_features(source_root, features)
    verify_renameat2(scratch, features)

    require(set(features) == set(FEATURE_NAMES))
    features = {name: features[name] for name in FEATURE_NAMES}
    feature_digest = canonical_digest(FEATURE_DIGEST_DOMAIN, features)
    schema_digest = canonical_digest(
        SCHEMA_DIGEST_DOMAIN,
        {
            "contractFields": CONTRACT_FIELDS,
            "environment": EXPECTED_ENV,
            "executionContract": EXECUTION_CONTRACT,
            "features": FEATURE_NAMES,
            "helpers": HELPERS,
            "schema": SCHEMA,
            "schemaVersion": SCHEMA_VERSION,
            "toolFields": TOOL_FIELDS,
        },
    )
    tools_digest = canonical_digest(
        TOOLS_DIGEST_DOMAIN,
        [{"name": tool["name"], "toolDigestSha256": tool["toolDigestSha256"]} for tool in tools],
    )
    contract = {
        "bootIdSha256": boot_digest,
        "environmentSha256": environment_digest,
        "executionContractSha256": execution_contract_digest,
        "featureDigestSha256": feature_digest,
        "features": features,
        "kernelIdentitySha256": kernel_digest,
        "machineIdSha256": machine_digest,
        "probeProgramSha256": probe_program_digest,
        "role": role,
        "schema": SCHEMA,
        "schemaDigestSha256": schema_digest,
        "schemaVersion": SCHEMA_VERSION,
        "tools": tools,
        "toolsDigestSha256": tools_digest,
    }
    recovery_identity = {key: value for key, value in contract.items() if key != "bootIdSha256"}
    contract["toolchainRecoveryDigestSha256"] = canonical_digest(
        RECOVERY_DIGEST_DOMAIN,
        recovery_identity,
    )
    contract["toolchainDigestSha256"] = canonical_digest(CONTRACT_DIGEST_DOMAIN, contract)
    begin, end = (SOURCE_BEGIN, SOURCE_END) if role == "source" else (TARGET_BEGIN, TARGET_END)
    output = begin + "\n" + canonical_json(contract) + "\n" + end + "\n"
    require(len(output.encode("utf8")) <= MAX_ENVELOPE_BYTES)
    sys.stdout.write(output)


try:
    main()
except BaseException:
    sys.stderr.write("toolchain-probe-failed\n")
    raise SystemExit(70)
`;

export const TOOLCHAIN_PROBE_PROGRAM_SHA256 = createHash("sha256")
  .update(TOOLCHAIN_PROBE_PYTHON)
  .digest("hex");

export function buildToolchainProbeProgram(
  role: ToolchainRole,
  expectedMachineIdSha256: string,
): Result<string, ToolchainContractError> {
  if (role !== "source" && role !== "target") {
    return err({
      kind: "invalid_toolchain_probe_request",
      field: "role",
      message: "Toolchain probe role must be source or target",
    });
  }
  if (!isSha256(expectedMachineIdSha256)) {
    return err({
      kind: "invalid_toolchain_probe_request",
      field: "expectedMachineIdSha256",
      message: "Toolchain probe machine pin must be a lowercase SHA-256 digest",
    });
  }
  return ok(String.raw`set -euo pipefail
exec /usr/bin/sudo -- /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C TZ=Etc/UTC \
  /usr/bin/bash --noprofile --norc -s -- \
  ${role} ${expectedMachineIdSha256} ${TOOLCHAIN_PROBE_PROGRAM_SHA256} ${TOOLCHAIN_ENVIRONMENT_SHA256} \
  <<'COMIS_TOOLCHAIN_ROOT_SHELL_V1'
set -euo pipefail
systemd_version="$(/usr/bin/systemctl show --property=Version --value)"
[ -n "$systemd_version" ]
[ "$(/usr/bin/systemctl show systemd-journald.service --property=LoadState --value)" = loaded ]
case "$(/usr/bin/systemctl is-active systemd-journald.service)" in
  active|reloading|activating) ;;
  *) exit 70 ;;
esac
case "$(/usr/bin/systemctl is-enabled systemd-journald.service)" in
  enabled|enabled-runtime|linked|linked-runtime|alias|static|indirect|generated|transient) ;;
  *) exit 70 ;;
esac
exec /usr/bin/unshare --mount --propagation private \
  /usr/bin/bash --noprofile --norc -c '
set -euo pipefail
/usr/bin/mount --make-rprivate /
/usr/bin/mount --bind / /
/usr/bin/mount -o remount,bind,ro,noatime,nodiratime,nosuid,nodev /
exec /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C TZ=Etc/UTC \
  /usr/bin/python3 -I -S -B - "$@"
' comis-toolchain-probe \
  "$@" <<'COMIS_TOOLCHAIN_PROBE_PYTHON_V1'
${TOOLCHAIN_PROBE_PYTHON}
COMIS_TOOLCHAIN_PROBE_PYTHON_V1
COMIS_TOOLCHAIN_ROOT_SHELL_V1
`);
}
