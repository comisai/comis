// SPDX-License-Identifier: Apache-2.0
/** Deterministic generator for the release-pinned capability-service bundle. */
import { createHash } from "node:crypto";
import {
  globSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z, type ZodType } from "zod";
import {
  BUNDLE_DIGEST_FIXTURE_TOKEN,
  CAPABILITY_SERVICE_ERROR_DEFINITIONS,
  CAPABILITY_SERVICE_ERROR_KINDS,
  CAPABILITY_SERVICE_GENERATOR_VERSION,
  CAPABILITY_SERVICE_LIMITS,
  CAPABILITY_SERVICE_METHODS,
  CAPABILITY_SERVICE_PROTOCOL_ID,
  CapabilityAbandonRequestSchema,
  CapabilityAbandonResponseSchema,
  CapabilityActivateRequestSchema,
  CapabilityActivateResponseSchema,
  CapabilityCancelRequestSchema,
  CapabilityCancelResponseSchema,
  CapabilityGroupAbandonRequestSchema,
  CapabilityGroupAbandonResponseSchema,
  CapabilityGroupActivateRequestSchema,
  CapabilityGroupActivateResponseSchema,
  CapabilityGroupGetHostRollupRequestSchema,
  CapabilityGroupGetHostRollupResponseSchema,
  CapabilityHandshakeRequestSchema,
  CapabilityHandshakeResponseSchema,
  CapabilityHealthRequestSchema,
  CapabilityHealthResponseSchema,
  CapabilityHeartbeatRequestSchema,
  CapabilityHeartbeatResponseSchema,
  CapabilityPutEvidenceRequestSchema,
  CapabilityPutEvidenceResponseSchema,
  CapabilityReceiveAttentionResponseRequestSchema,
  CapabilityReceiveAttentionResponseResponseSchema,
  CapabilityReleaseRequestSchema,
  CapabilityReleaseResponseSchema,
  CapabilityReportRequestSchema,
  CapabilityReportResponseSchema,
  CapabilityTerminalEventRequestSchema,
  CapabilityTerminalEventResponseSchema,
  CapabilityServiceErrorResponseSchema,
  ExternalRunRefSchema,
  MCP_CAPABILITY_CALL_CONTEXT_KEY,
  MCP_MANAGED_RUN_RESULT_KEY,
  McpCapabilityCallContextSchema,
  McpManagedRunResultSchema,
  PROTOCOL_FIXTURE_SCENARIOS,
  ServiceInstanceIdSchema,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(here, "..");
export const PROTOCOL_ROOT = resolve(SDK_ROOT, "protocol");

interface ArtifactEntry {
  readonly path: string;
  readonly sha256: string;
}

interface GeneratedBundle {
  readonly files: ReadonlyMap<string, string>;
  readonly bundleDigest: string;
}

const METHOD_CATALOG = [
  {
    method: "capabilityServices.handshake",
    direction: "service-to-comis",
    callerClass: "capability-service",
    requiredServiceScope: null,
    classification: "mutation",
    operationIdRequired: true,
    maxRequestBytes: CAPABILITY_SERVICE_LIMITS.maxRequestBytes,
    maxResponseBytes: CAPABILITY_SERVICE_LIMITS.maxResponseBytes,
    semanticInvariants: [
      "exact-protocol-identifier",
      "exact-bundle-digest",
      "requested-scopes-must-be-active",
    ],
    requestSchema: "schemas/handshake.request.schema.json",
    responseSchema: "schemas/handshake.response.schema.json",
  },
  {
    method: "capabilityServices.health",
    direction: "bidirectional",
    callerClass: "both",
    requiredServiceScope: "health",
    classification: "read",
    operationIdRequired: true,
    maxRequestBytes: CAPABILITY_SERVICE_LIMITS.maxRequestBytes,
    maxResponseBytes: CAPABILITY_SERVICE_LIMITS.maxResponseBytes,
    semanticInvariants: ["exact-protocol-identifier", "exact-bundle-digest"],
    requestSchema: "schemas/health.request.schema.json",
    responseSchema: "schemas/health.response.schema.json",
  },
  {
    method: "managedRunGroups.abandon",
    direction: "comis-to-service",
    callerClass: "comis-daemon",
    requiredServiceScope: "managed_run_group",
    classification: "mutation",
    operationIdRequired: true,
    maxRequestBytes: CAPABILITY_SERVICE_LIMITS.maxRequestBytes,
    maxResponseBytes: CAPABILITY_SERVICE_LIMITS.maxResponseBytes,
    semanticInvariants: [
      "operation-id-must-match-envelope-id",
      "identical-replay-returns-original-result",
      "altered-replay-is-rejected",
      "response-names-every-member-exactly-once",
      "partial-reap-reports-per-member-outcomes-not-one-group-result",
    ],
    requestSchema: "schemas/groupAbandon.request.schema.json",
    responseSchema: "schemas/groupAbandon.response.schema.json",
  },
  {
    method: "managedRunGroups.activate",
    direction: "comis-to-service",
    callerClass: "comis-daemon",
    requiredServiceScope: "managed_run_group",
    classification: "mutation",
    operationIdRequired: true,
    maxRequestBytes: CAPABILITY_SERVICE_LIMITS.maxRequestBytes,
    maxResponseBytes: CAPABILITY_SERVICE_LIMITS.maxResponseBytes,
    semanticInvariants: [
      "operation-id-must-match-envelope-id",
      "identical-replay-returns-original-result",
      "altered-replay-is-rejected",
      "response-names-every-member-exactly-once",
      "partial-activation-reports-per-member-outcomes-not-one-group-result",
      "members-share-one-host-scope",
    ],
    requestSchema: "schemas/groupActivate.request.schema.json",
    responseSchema: "schemas/groupActivate.response.schema.json",
  },
  {
    method: "managedRunGroups.getHostRollup",
    direction: "service-to-comis",
    callerClass: "capability-service",
    requiredServiceScope: "managed_run_group",
    classification: "read",
    operationIdRequired: true,
    maxRequestBytes: CAPABILITY_SERVICE_LIMITS.maxRequestBytes,
    maxResponseBytes: CAPABILITY_SERVICE_LIMITS.maxResponseBytes,
    semanticInvariants: [
      "operation-id-must-match-envelope-id",
      "owning-service-instance-only",
      "counts-are-derived-from-member-run-facts",
      "roll-up-carries-no-domain-workflow-vocabulary",
    ],
    requestSchema: "schemas/groupGetHostRollup.request.schema.json",
    responseSchema: "schemas/groupGetHostRollup.response.schema.json",
  },
  {
    method: "managedRuns.abandon",
    direction: "comis-to-service",
    callerClass: "comis-daemon",
    requiredServiceScope: null,
    classification: "mutation",
    operationIdRequired: true,
    maxRequestBytes: CAPABILITY_SERVICE_LIMITS.maxRequestBytes,
    maxResponseBytes: CAPABILITY_SERVICE_LIMITS.maxResponseBytes,
    semanticInvariants: [
      "operation-id-must-match-envelope-id",
      "identical-replay-returns-original-result",
      "altered-replay-is-rejected",
      "disposition-defines-unbound-preparation-cleanup",
      "response-confirms-unbound-preparation-terminal-transition",
    ],
    requestSchema: "schemas/abandon.request.schema.json",
    responseSchema: "schemas/abandon.response.schema.json",
  },
  {
    method: "managedRuns.activate",
    direction: "comis-to-service",
    callerClass: "comis-daemon",
    requiredServiceScope: null,
    classification: "mutation",
    operationIdRequired: true,
    maxRequestBytes: CAPABILITY_SERVICE_LIMITS.maxRequestBytes,
    maxResponseBytes: CAPABILITY_SERVICE_LIMITS.maxResponseBytes,
    semanticInvariants: [
      "operation-id-must-match-envelope-id",
      "identical-replay-returns-original-result",
      "altered-replay-is-rejected",
      "present-iff-the-preparation-requested-a-workspace",
      "attachment-fields-present-iff-the-preparation-requested-an-attachment",
    ],
    requestSchema: "schemas/activate.request.schema.json",
    responseSchema: "schemas/activate.response.schema.json",
  },
  {
    method: "managedRuns.cancel",
    direction: "comis-to-service",
    callerClass: "comis-daemon",
    requiredServiceScope: null,
    classification: "mutation",
    operationIdRequired: true,
    maxRequestBytes: CAPABILITY_SERVICE_LIMITS.maxRequestBytes,
    maxResponseBytes: CAPABILITY_SERVICE_LIMITS.maxResponseBytes,
    semanticInvariants: [
      "operation-id-must-match-envelope-id",
      "identical-replay-returns-original-result",
      "altered-replay-is-rejected",
      "cancellation-is-idempotent-for-an-already-terminal-run",
      "host-names-the-reason-and-never-the-service-disposition",
    ],
    requestSchema: "schemas/cancel.request.schema.json",
    responseSchema: "schemas/cancel.response.schema.json",
  },
  {
    method: "managedRuns.heartbeat",
    direction: "service-to-comis",
    callerClass: "capability-service",
    requiredServiceScope: "health",
    classification: "mutation",
    operationIdRequired: true,
    maxRequestBytes: CAPABILITY_SERVICE_LIMITS.maxRequestBytes,
    maxResponseBytes: CAPABILITY_SERVICE_LIMITS.maxResponseBytes,
    semanticInvariants: [
      "operation-id-must-match-envelope-id",
      "owning-service-instance-only",
      "observation-time-advances-strictly-forward",
      "terminal-run-refuses-further-liveness",
      "liveness-carries-no-run-state",
    ],
    requestSchema: "schemas/heartbeat.request.schema.json",
    responseSchema: "schemas/heartbeat.response.schema.json",
  },
  {
    method: "managedRuns.putEvidence",
    direction: "service-to-comis",
    callerClass: "capability-service",
    requiredServiceScope: "evidence",
    classification: "mutation",
    operationIdRequired: true,
    maxRequestBytes: CAPABILITY_SERVICE_LIMITS.maxRequestBytes,
    maxResponseBytes: CAPABILITY_SERVICE_LIMITS.maxResponseBytes,
    semanticInvariants: [
      "operation-id-must-match-envelope-id",
      "evidence-ref-identical-replay-returns-original-result",
      "evidence-ref-altered-replay-is-rejected",
      "content-hash-must-match-decoded-private-body",
      "adapter-verification-requires-configured-kind",
      "host-verification-is-reserved",
    ],
    requestSchema: "schemas/putEvidence.request.schema.json",
    responseSchema: "schemas/putEvidence.response.schema.json",
  },
  {
    method: "managedRuns.receiveAttentionResponse",
    direction: "service-to-comis",
    callerClass: "capability-service",
    requiredServiceScope: "attention_response",
    classification: "mutation",
    operationIdRequired: true,
    maxRequestBytes: CAPABILITY_SERVICE_LIMITS.maxRequestBytes,
    maxResponseBytes: CAPABILITY_SERVICE_LIMITS.maxResponseBytes,
    semanticInvariants: [
      "operation-id-must-match-envelope-id",
      "owning-service-instance-only",
      "external-key-must-name-an-open-attention-request",
      "private-response-remains-content-store-confined-until-delivery",
      "identical-receive-replay-returns-the-original-response",
    ],
    requestSchema: "schemas/receiveAttentionResponse.request.schema.json",
    responseSchema: "schemas/receiveAttentionResponse.response.schema.json",
  },
  {
    method: "managedRuns.release",
    direction: "service-to-comis",
    callerClass: "capability-service",
    requiredServiceScope: "workspace_lease",
    classification: "mutation",
    operationIdRequired: true,
    maxRequestBytes: CAPABILITY_SERVICE_LIMITS.maxRequestBytes,
    maxResponseBytes: CAPABILITY_SERVICE_LIMITS.maxResponseBytes,
    semanticInvariants: [
      "operation-id-must-match-envelope-id",
      "identical-replay-returns-original-result",
      "altered-replay-is-rejected",
      "owning-service-instance-only",
      "managed-run-workspace-lease-must-match",
      "terminal-and-attachment-revocation-precedes-lease-release",
      "release-time-is-idempotency-bound",
    ],
    requestSchema: "schemas/release.request.schema.json",
    responseSchema: "schemas/release.response.schema.json",
  },
  {
    method: "managedRuns.report",
    direction: "service-to-comis",
    callerClass: "capability-service",
    requiredServiceScope: "report",
    classification: "mutation",
    operationIdRequired: true,
    maxRequestBytes: CAPABILITY_SERVICE_LIMITS.maxRequestBytes,
    maxResponseBytes: CAPABILITY_SERVICE_LIMITS.maxResponseBytes,
    semanticInvariants: [
      "operation-id-must-match-envelope-id",
      "utf8-report-content-bytes-at-most-max-report-bytes",
      "service-report-id-identical-replay-returns-original-sequence",
      "service-report-id-altered-replay-is-rejected",
    ],
    requestSchema: "schemas/report.request.schema.json",
    responseSchema: "schemas/report.response.schema.json",
  },
  {
    method: "managedRuns.terminalEvent",
    direction: "comis-to-service",
    callerClass: "comis-daemon",
    requiredServiceScope: null,
    classification: "mutation",
    operationIdRequired: true,
    maxRequestBytes: CAPABILITY_SERVICE_LIMITS.maxRequestBytes,
    maxResponseBytes: CAPABILITY_SERVICE_LIMITS.maxResponseBytes,
    semanticInvariants: [
      "operation-id-must-match-envelope-id",
      "identical-replay-returns-original-result",
      "altered-replay-is-rejected",
      "terminal-run-workspace-lease-must-match",
      "owning-service-instance-only",
      "transition-carries-identifiers-only",
    ],
    requestSchema: "schemas/terminalEvent.request.schema.json",
    responseSchema: "schemas/terminalEvent.response.schema.json",
  },
] as const;

const SCHEMAS: ReadonlyArray<{ readonly path: string; readonly schema: ZodType }> = [
  { path: "schemas/abandon.request.schema.json", schema: CapabilityAbandonRequestSchema },
  { path: "schemas/abandon.response.schema.json", schema: CapabilityAbandonResponseSchema },
  { path: "schemas/activate.request.schema.json", schema: CapabilityActivateRequestSchema },
  { path: "schemas/activate.response.schema.json", schema: CapabilityActivateResponseSchema },
  { path: "schemas/cancel.request.schema.json", schema: CapabilityCancelRequestSchema },
  { path: "schemas/cancel.response.schema.json", schema: CapabilityCancelResponseSchema },
  { path: "schemas/error-response.schema.json", schema: CapabilityServiceErrorResponseSchema },
  { path: "schemas/groupAbandon.request.schema.json", schema: CapabilityGroupAbandonRequestSchema },
  { path: "schemas/groupAbandon.response.schema.json", schema: CapabilityGroupAbandonResponseSchema },
  { path: "schemas/groupActivate.request.schema.json", schema: CapabilityGroupActivateRequestSchema },
  { path: "schemas/groupActivate.response.schema.json", schema: CapabilityGroupActivateResponseSchema },
  { path: "schemas/groupGetHostRollup.request.schema.json", schema: CapabilityGroupGetHostRollupRequestSchema },
  { path: "schemas/groupGetHostRollup.response.schema.json", schema: CapabilityGroupGetHostRollupResponseSchema },
  { path: "schemas/external-run-ref.schema.json", schema: ExternalRunRefSchema },
  { path: "schemas/handshake.request.schema.json", schema: CapabilityHandshakeRequestSchema },
  { path: "schemas/handshake.response.schema.json", schema: CapabilityHandshakeResponseSchema },
  { path: "schemas/health.request.schema.json", schema: CapabilityHealthRequestSchema },
  { path: "schemas/health.response.schema.json", schema: CapabilityHealthResponseSchema },
  { path: "schemas/heartbeat.request.schema.json", schema: CapabilityHeartbeatRequestSchema },
  { path: "schemas/heartbeat.response.schema.json", schema: CapabilityHeartbeatResponseSchema },
  { path: "schemas/mcp-call-context.schema.json", schema: McpCapabilityCallContextSchema },
  { path: "schemas/mcp-managed-run-result.schema.json", schema: McpManagedRunResultSchema },
  { path: "schemas/putEvidence.request.schema.json", schema: CapabilityPutEvidenceRequestSchema },
  { path: "schemas/putEvidence.response.schema.json", schema: CapabilityPutEvidenceResponseSchema },
  { path: "schemas/receiveAttentionResponse.request.schema.json", schema: CapabilityReceiveAttentionResponseRequestSchema },
  { path: "schemas/receiveAttentionResponse.response.schema.json", schema: CapabilityReceiveAttentionResponseResponseSchema },
  { path: "schemas/release.request.schema.json", schema: CapabilityReleaseRequestSchema },
  { path: "schemas/release.response.schema.json", schema: CapabilityReleaseResponseSchema },
  { path: "schemas/report.request.schema.json", schema: CapabilityReportRequestSchema },
  { path: "schemas/report.response.schema.json", schema: CapabilityReportResponseSchema },
  { path: "schemas/terminalEvent.request.schema.json", schema: CapabilityTerminalEventRequestSchema },
  { path: "schemas/terminalEvent.response.schema.json", schema: CapabilityTerminalEventResponseSchema },
  { path: "schemas/service-instance-id.schema.json", schema: ServiceInstanceIdSchema },
];

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function schemaDocument(path: string, schema: ZodType): unknown {
  const name = path.replace(/^schemas\//, "").replace(/\.schema\.json$/, "");
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-7",
    unrepresentable: "throw",
    reused: "inline",
  });
  return {
    $id: `https://schemas.comis.ai/capability-service/${name}.schema.json`,
    ...jsonSchema,
  };
}

function createArtifactFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const { path, schema } of SCHEMAS) {
    files.set(path, serializeJson(schemaDocument(path, schema)));
  }
  for (const scenario of PROTOCOL_FIXTURE_SCENARIOS) {
    files.set(`fixtures/${scenario.class}.json`, serializeJson(scenario));
  }
  return files;
}

function artifactEntries(files: ReadonlyMap<string, string>): ArtifactEntry[] {
  return [...files.entries()]
    .map(([path, content]) => ({ path, sha256: sha256(content) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function calculateBundleDigest(artifacts: readonly ArtifactEntry[]): string {
  const digestInput = artifacts
    .map((artifact) => `${artifact.path}\0${artifact.sha256}\n`)
    .join("");
  return sha256(digestInput);
}

export function createProtocolBundle(): GeneratedBundle {
  const files = createArtifactFiles();
  const artifacts = artifactEntries(files);
  const bundleDigest = calculateBundleDigest(artifacts);
  const manifest = {
    artifacts,
    bundleDigest,
    bundleDigestAlgorithm: "sha256 over lexically ordered path, NUL, hash, newline records",
    errorKinds: CAPABILITY_SERVICE_ERROR_KINDS,
    errors: CAPABILITY_SERVICE_ERROR_DEFINITIONS,
    fixtureDigestToken: BUNDLE_DIGEST_FIXTURE_TOKEN,
    generator: {
      command: "pnpm capability-protocol:generate",
      package: "@comis/capability-service-sdk",
      version: CAPABILITY_SERVICE_GENERATOR_VERSION,
    },
    limits: CAPABILITY_SERVICE_LIMITS,
    mcpMeta: {
      callContextKey: MCP_CAPABILITY_CALL_CONTEXT_KEY,
      managedRunResultKey: MCP_MANAGED_RUN_RESULT_KEY,
    },
    methodCatalog: METHOD_CATALOG,
    methods: CAPABILITY_SERVICE_METHODS,
    protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
  };
  files.set("manifest.json", serializeJson(manifest));
  return { files, bundleDigest };
}

function resolveProtocolArtifactPath(path: string): string {
  if (path.length === 0 || path.includes("\0") || isAbsolute(path)) {
    throw new Error("protocol artifact path must be a non-empty relative path");
  }
  const absolute = resolve(PROTOCOL_ROOT, path);
  const confined = relative(PROTOCOL_ROOT, absolute);
  if (
    confined.length === 0
    || confined === ".."
    || confined.startsWith(`..${sep}`)
    || isAbsolute(confined)
  ) {
    throw new Error("protocol artifact path must remain inside the protocol bundle");
  }
  return absolute;
}

function writeProtocolArtifact(path: string, content: string): void {
  const output = resolveProtocolArtifactPath(path);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolveProtocolArtifactPath proves the output remains inside PROTOCOL_ROOT
  mkdirSync(dirname(output), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolveProtocolArtifactPath proves the output remains inside PROTOCOL_ROOT
  writeFileSync(output, content);
}

function readProtocolArtifact(path: string): string {
  const input = resolveProtocolArtifactPath(path);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolveProtocolArtifactPath proves the input remains inside PROTOCOL_ROOT
  return readFileSync(input, "utf8");
}

function collectJsonFiles(): string[] {
  return globSync("**/*.json", { cwd: PROTOCOL_ROOT }).sort();
}

export function writeProtocolBundle(bundle: GeneratedBundle = createProtocolBundle()): void {
  const schemasRoot = resolve(PROTOCOL_ROOT, "schemas");
  const fixturesRoot = resolve(PROTOCOL_ROOT, "fixtures");
  rmSync(schemasRoot, { recursive: true, force: true });
  rmSync(fixturesRoot, { recursive: true, force: true });
  mkdirSync(schemasRoot, { recursive: true });
  mkdirSync(fixturesRoot, { recursive: true });
  for (const [path, content] of bundle.files) {
    writeProtocolArtifact(path, content);
  }
}

export function findProtocolBundleDrift(
  bundle: GeneratedBundle = createProtocolBundle(),
): string[] {
  const expectedPaths = [...bundle.files.keys()].sort();
  const actualPaths = collectJsonFiles();
  const actualPathSet = new Set(actualPaths);
  const drift = new Set<string>();
  for (const path of new Set([...expectedPaths, ...actualPaths])) {
    const expected = bundle.files.get(path);
    if (expected === undefined || !actualPathSet.has(path)) {
      drift.add(path);
      continue;
    }
    if (readProtocolArtifact(path) !== expected) drift.add(path);
  }
  return [...drift].sort();
}

function main(): void {
  const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--check");
  if (unknownArgs.length > 0) {
    console.error(`Unknown generator arguments: ${unknownArgs.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const bundle = createProtocolBundle();
  if (process.argv.includes("--check")) {
    const drift = findProtocolBundleDrift(bundle);
    if (drift.length > 0) {
      console.error(
        `Capability-service protocol bundle drifted: ${drift.join(", ")}. ` +
          "Run pnpm capability-protocol:generate and commit the generated artifacts.",
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `Capability-service protocol bundle matches ${bundle.bundleDigest} ` +
        `(${bundle.files.size - 1} artifacts).`,
    );
    return;
  }

  writeProtocolBundle(bundle);
  console.log(
    `Generated capability-service protocol bundle ${bundle.bundleDigest} ` +
      `(${bundle.files.size - 1} artifacts).`,
  );
}

const isMainModule = fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
if (isMainModule) main();
