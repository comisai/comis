// SPDX-License-Identifier: Apache-2.0
/** Deterministic generator for the release-pinned capability-service bundle. */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z, type ZodType } from "zod";
import {
  BUNDLE_DIGEST_FIXTURE_TOKEN,
  CAPABILITY_SERVICE_ERROR_DEFINITIONS,
  CAPABILITY_SERVICE_ERROR_KINDS,
  CAPABILITY_SERVICE_LIMITS,
  CAPABILITY_SERVICE_METHODS,
  CAPABILITY_SERVICE_PROTOCOL_ID,
  CapabilityAbandonRequestSchema,
  CapabilityAbandonResponseSchema,
  CapabilityActivateRequestSchema,
  CapabilityActivateResponseSchema,
  CapabilityHandshakeRequestSchema,
  CapabilityHandshakeResponseSchema,
  CapabilityHealthRequestSchema,
  CapabilityHealthResponseSchema,
  CapabilityReportRequestSchema,
  CapabilityReportResponseSchema,
  CapabilityServiceErrorResponseSchema,
  McpCapabilityCallContextSchema,
  McpManagedRunResultSchema,
  PROTOCOL_FIXTURE_SCENARIOS,
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
    method: "capability.abandon",
    caller: "comis",
    operationIdRequired: true,
    sideEffect: "prepared-run-state",
    requestSchema: "schemas/abandon.request.schema.json",
    responseSchema: "schemas/abandon.response.schema.json",
  },
  {
    method: "capability.activate",
    caller: "comis",
    operationIdRequired: true,
    sideEffect: "managed-run-state",
    requestSchema: "schemas/activate.request.schema.json",
    responseSchema: "schemas/activate.response.schema.json",
  },
  {
    method: "capability.handshake",
    caller: "service",
    operationIdRequired: true,
    sideEffect: "connection-state",
    requestSchema: "schemas/handshake.request.schema.json",
    responseSchema: "schemas/handshake.response.schema.json",
  },
  {
    method: "capability.health",
    caller: "either",
    operationIdRequired: true,
    sideEffect: "none",
    requestSchema: "schemas/health.request.schema.json",
    responseSchema: "schemas/health.response.schema.json",
  },
  {
    method: "capability.report",
    caller: "service",
    operationIdRequired: true,
    sideEffect: "report-store",
    requestSchema: "schemas/report.request.schema.json",
    responseSchema: "schemas/report.response.schema.json",
  },
] as const;

const SCHEMAS: ReadonlyArray<{ readonly path: string; readonly schema: ZodType }> = [
  { path: "schemas/abandon.request.schema.json", schema: CapabilityAbandonRequestSchema },
  { path: "schemas/abandon.response.schema.json", schema: CapabilityAbandonResponseSchema },
  { path: "schemas/activate.request.schema.json", schema: CapabilityActivateRequestSchema },
  { path: "schemas/activate.response.schema.json", schema: CapabilityActivateResponseSchema },
  { path: "schemas/error-response.schema.json", schema: CapabilityServiceErrorResponseSchema },
  { path: "schemas/handshake.request.schema.json", schema: CapabilityHandshakeRequestSchema },
  { path: "schemas/handshake.response.schema.json", schema: CapabilityHandshakeResponseSchema },
  { path: "schemas/health.request.schema.json", schema: CapabilityHealthRequestSchema },
  { path: "schemas/health.response.schema.json", schema: CapabilityHealthResponseSchema },
  { path: "schemas/mcp-call-context.schema.json", schema: McpCapabilityCallContextSchema },
  { path: "schemas/mcp-managed-run-result.schema.json", schema: McpManagedRunResultSchema },
  { path: "schemas/report.request.schema.json", schema: CapabilityReportRequestSchema },
  { path: "schemas/report.response.schema.json", schema: CapabilityReportResponseSchema },
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
    },
    limits: CAPABILITY_SERVICE_LIMITS,
    methodCatalog: METHOD_CATALOG,
    methods: CAPABILITY_SERVICE_METHODS,
    protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
  };
  files.set("manifest.json", serializeJson(manifest));
  return { files, bundleDigest };
}

function collectJsonFiles(root: string, current: string = root): string[] {
  if (!existsSync(current)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = resolve(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsonFiles(root, absolute));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(relative(root, absolute));
    }
  }
  return files.sort();
}

export function writeProtocolBundle(bundle: GeneratedBundle = createProtocolBundle()): void {
  const schemasRoot = resolve(PROTOCOL_ROOT, "schemas");
  const fixturesRoot = resolve(PROTOCOL_ROOT, "fixtures");
  rmSync(schemasRoot, { recursive: true, force: true });
  rmSync(fixturesRoot, { recursive: true, force: true });
  mkdirSync(schemasRoot, { recursive: true });
  mkdirSync(fixturesRoot, { recursive: true });
  for (const [path, content] of bundle.files) {
    const output = resolve(PROTOCOL_ROOT, path);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, content);
  }
}

export function findProtocolBundleDrift(
  bundle: GeneratedBundle = createProtocolBundle(),
): string[] {
  const expectedPaths = [...bundle.files.keys()].sort();
  const actualPaths = collectJsonFiles(PROTOCOL_ROOT);
  const drift = new Set<string>();
  for (const path of new Set([...expectedPaths, ...actualPaths])) {
    const expected = bundle.files.get(path);
    const absolute = resolve(PROTOCOL_ROOT, path);
    if (expected === undefined || !existsSync(absolute)) {
      drift.add(path);
      continue;
    }
    if (readFileSync(absolute, "utf8") !== expected) drift.add(path);
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
