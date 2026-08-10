// SPDX-License-Identifier: Apache-2.0
/**
 * Static contract for the generated capability-service protocol bundle.
 *
 * The bundle is intentionally independent from the npm umbrella: external
 * services consume release artifacts whose bytes and digest are pinned by the
 * deployment, while the monorepo consumes the Zod source schemas directly.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { MAX_MANAGED_RUN_REPORT_BYTES } from "../../packages/core/src/domain/managed-run-content.js";
import { CAPABILITY_SERVICE_BUNDLE_DIGEST } from "../../packages/capability-service-sdk/src/constants.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const SDK_ROOT = resolve(REPO_ROOT, "packages/capability-service-sdk");
const PROTOCOL_ROOT = resolve(SDK_ROOT, "protocol");

const EXPECTED_METHODS = [
  "capabilityServices.handshake",
  "capabilityServices.health",
  "managedRuns.abandon",
  "managedRuns.activate",
  "managedRuns.report",
  "managedRuns.terminalEvent",
] as const;

const EXPECTED_FIXTURE_CLASSES = [
  "altered-replay",
  "boundary-size",
  "digest-mismatch",
  "invalid",
  "unknown-field",
  "valid",
  "version-mismatch",
] as const;

interface ProtocolManifest {
  readonly protocolId: string;
  readonly bundleDigest: string;
  readonly methods: readonly string[];
  readonly errorKinds: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly mcpMeta: {
    readonly callContextKey: string;
    readonly managedRunResultKey: string;
  };
  readonly methodCatalog: ReadonlyArray<{
    readonly method: string;
    readonly direction: string;
    readonly callerClass: string;
    readonly requiredServiceScope: string | null;
    readonly classification: string;
    readonly maxRequestBytes: number;
    readonly maxResponseBytes: number;
    readonly semanticInvariants: readonly string[];
    readonly requestSchema: string;
    readonly responseSchema: string;
  }>;
  readonly generator: { readonly command: string; readonly package: string; readonly version: string };
  readonly fixtureDigestToken: string;
  readonly artifacts: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
}

interface ProtocolFixtureStep {
  readonly target: string;
  readonly schemaExpectation?: "accept" | "reject";
  readonly payload: unknown;
}

interface ProtocolFixture {
  readonly class: string;
  readonly steps: readonly ProtocolFixtureStep[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function materializeDigest(value: unknown, token: string, digest: string): unknown {
  if (value === token) return digest;
  if (Array.isArray(value)) {
    return value.map((entry) => materializeDigest(entry, token, digest));
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      materializeDigest(entry, token, digest),
    ]),
  );
}

function requestMethod(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const method = (payload as Readonly<Record<string, unknown>>)["method"];
  return typeof method === "string" ? method : undefined;
}

describe("capability-service protocol bundle contract", () => {
  it("keeps the external SDK private and outside the npm umbrella", () => {
    expect(existsSync(resolve(SDK_ROOT, "package.json"))).toBe(true);
    const sdk = readJson<{ private?: boolean; files?: string[] }>(resolve(SDK_ROOT, "package.json"));
    const umbrella = readJson<{ bundledDependencies?: string[] }>(
      resolve(REPO_ROOT, "packages/comis/package.json"),
    );

    expect(sdk.private).toBe(true);
    expect(sdk.files).toContain("protocol");
    expect(umbrella.bundledDependencies).not.toContain("@comis/capability-service-sdk");
  });

  it("exposes deterministic generation and drift-check commands", () => {
    const root = readJson<{ scripts?: Record<string, string> }>(resolve(REPO_ROOT, "package.json"));

    expect(root.scripts?.["capability-protocol:generate"]).toBe(
      "tsx packages/capability-service-sdk/scripts/generate-protocol.ts",
    );
    expect(root.scripts?.["capability-protocol:check"]).toBe(
      "tsx packages/capability-service-sdk/scripts/generate-protocol.ts --check",
    );
    expect(root.scripts?.["validate"]).toContain("pnpm capability-protocol:check");
  });

  it("pins the protocol identity, method catalog, errors, and limits", () => {
    const manifest = readJson<ProtocolManifest>(resolve(PROTOCOL_ROOT, "manifest.json"));

    expect(manifest.protocolId).toBe("comis.capability-service/1");
    expect(CAPABILITY_SERVICE_BUNDLE_DIGEST).toBe(manifest.bundleDigest);
    expect(manifest.methods).toEqual(EXPECTED_METHODS);
    expect(manifest.errorKinds).toEqual([
      "bundle_digest_mismatch",
      "deadline_exceeded",
      "internal_error",
      "invalid_params",
      "invalid_request",
      "method_not_found",
      "precondition_failed",
      "protocol_mismatch",
      "rate_limited",
      "replay_conflict",
      "size_limit_exceeded",
      "unauthorized_instance",
    ]);
    expect(manifest.limits).toEqual({
      maxEvidenceBytes: 1_048_576,
      maxInFlightRequests: 32,
      maxLineBytes: 65_536,
      maxReportBytes: 16_384,
      maxRequestBytes: 65_536,
      maxResponseBytes: 65_536,
      reportRetentionDays: 30,
    });
    expect(manifest.limits.maxReportBytes).toBe(MAX_MANAGED_RUN_REPORT_BYTES);
    expect(manifest.generator.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.mcpMeta).toEqual({
      callContextKey: "comis.callContext",
      managedRunResultKey: "comis.managedRun",
    });
    expect(manifest.methodCatalog.map((entry) => entry.method)).toEqual(EXPECTED_METHODS);
    for (const entry of manifest.methodCatalog) {
      expect(entry).toMatchObject({
        direction: expect.stringMatching(/^(bidirectional|comis-to-service|service-to-comis)$/),
        callerClass: expect.stringMatching(/^(both|capability-service|comis-daemon)$/),
        classification: expect.stringMatching(/^(mutation|read)$/),
        maxRequestBytes: manifest.limits.maxRequestBytes,
        maxResponseBytes: manifest.limits.maxResponseBytes,
      });
      expect(entry.semanticInvariants.length).toBeGreaterThan(0);
    }
    expect(
      manifest.methodCatalog.find((entry) => entry.method === "managedRuns.report")
        ?.semanticInvariants,
    ).toContain("utf8-report-content-bytes-at-most-max-report-bytes");
    expect(
      manifest.methodCatalog.find((entry) => entry.method === "managedRuns.terminalEvent"),
    ).toMatchObject({
      direction: "comis-to-service",
      callerClass: "comis-daemon",
      classification: "mutation",
      requiredServiceScope: null,
      semanticInvariants: expect.arrayContaining([
        "terminal-run-workspace-lease-must-match",
        "transition-carries-identifiers-only",
      ]),
    });
  });

  it("pins content-free terminal transitions to the owning managed run and lease", () => {
    const valid = readJson<{
      steps: Array<{ target: string; payload: Record<string, unknown> }>;
    }>(resolve(PROTOCOL_ROOT, "fixtures/valid.json"));
    const terminalEvent = valid.steps.find(
      (step) => step.target === "request" && step.payload["method"] === "managedRuns.terminalEvent",
    );
    const terminalEventResponse = valid.steps.find(
      (step) => step.target === "terminal-event-response",
    );
    const params = terminalEvent?.payload["params"] as Record<string, unknown> | undefined;
    const result = terminalEventResponse?.payload["result"] as Record<string, unknown> | undefined;

    expect(Object.keys(params ?? {}).sort()).toEqual([
      "managedRunId",
      "operationId",
      "terminalSessionId",
      "transition",
      "workspaceLeaseId",
    ]);
    expect(params).toMatchObject({
      managedRunId: expect.any(String),
      terminalSessionId: expect.any(String),
      transition: "created",
      workspaceLeaseId: expect.any(String),
    });
    expect(result).toEqual({
      managedRunId: params?.["managedRunId"],
      terminalSessionId: params?.["terminalSessionId"],
      transition: params?.["transition"],
    });
  });

  it("pins activation workspace atomicity and closed abandonment disposition", () => {
    const manifest = readJson<ProtocolManifest>(resolve(PROTOCOL_ROOT, "manifest.json"));
    const valid = readJson<{
      steps: Array<{ target: string; payload: Record<string, unknown> }>;
    }>(resolve(PROTOCOL_ROOT, "fixtures/valid.json"));
    const prepared = valid.steps.find((step) => step.target === "mcp-managed-run-result");
    const activate = valid.steps.find(
      (step) => step.target === "request" && step.payload["method"] === "managedRuns.activate",
    );
    const abandon = valid.steps.find(
      (step) => step.target === "request" && step.payload["method"] === "managedRuns.abandon",
    );
    const abandonResponse = valid.steps.find((step) => step.target === "abandon-response");
    const activateParams = activate?.payload["params"] as Record<string, unknown> | undefined;
    const abandonParams = abandon?.payload["params"] as Record<string, unknown> | undefined;
    const abandonResult = abandonResponse?.payload["result"] as Record<string, unknown> | undefined;

    expect(
      manifest.methodCatalog.find((entry) => entry.method === "managedRuns.activate")
        ?.semanticInvariants,
    ).toContain("present-iff-the-preparation-requested-a-workspace");
    expect(prepared?.payload).toMatchObject({
      requestedWorkspace: { rootHint: expect.stringMatching(/^\//u) },
    });
    expect(activateParams).toMatchObject({ workspaceLeaseId: expect.any(String) });
    expect(abandonParams).toMatchObject({ disposition: "preserve" });
    expect(abandonResult).toMatchObject({
      state: "abandoned",
      disposition: "preserve",
      terminalTransition: "unbound_preparation_abandoned",
    });
  });

  it("hashes every artifact and derives the overall digest from ordered path-hash pairs", () => {
    const manifest = readJson<ProtocolManifest>(resolve(PROTOCOL_ROOT, "manifest.json"));
    const paths = manifest.artifacts.map((artifact) => artifact.path);

    expect(paths).toEqual([...paths].sort());
    for (const artifact of manifest.artifacts) {
      const content = readFileSync(resolve(PROTOCOL_ROOT, artifact.path), "utf8");
      expect(artifact.sha256, artifact.path).toBe(sha256(content));
    }

    const digestInput = manifest.artifacts
      .map((artifact) => `${artifact.path}\0${artifact.sha256}\n`)
      .join("");
    expect(manifest.bundleDigest).toBe(sha256(digestInput));
  });

  it("ships strict request and response schemas for every method", () => {
    const manifest = readJson<ProtocolManifest>(resolve(PROTOCOL_ROOT, "manifest.json"));
    const artifactPaths = new Set(manifest.artifacts.map((artifact) => artifact.path));

    for (const method of EXPECTED_METHODS) {
      const basename = method.split(".")[1];
      expect(artifactPaths).toContain(`schemas/${basename}.request.schema.json`);
      expect(artifactPaths).toContain(`schemas/${basename}.response.schema.json`);
    }
    expect(artifactPaths).toContain("schemas/error-response.schema.json");
    expect(artifactPaths).toContain("schemas/external-run-ref.schema.json");
    expect(artifactPaths).toContain("schemas/mcp-call-context.schema.json");
    expect(artifactPaths).toContain("schemas/mcp-managed-run-result.schema.json");
    expect(artifactPaths).toContain("schemas/service-instance-id.schema.json");
  });

  it("pins host-owned report authority and the private MCP extension shapes", () => {
    const valid = readJson<{
      steps: Array<{ target: string; payload: Record<string, unknown> }>;
    }>(resolve(PROTOCOL_ROOT, "fixtures/valid.json"));
    const prepared = valid.steps.find((step) => step.target === "mcp-managed-run-result");
    const context = valid.steps.find((step) => step.target === "mcp-call-context");
    const report = valid.steps.find(
      (step) => step.target === "request" && step.payload["method"] === "managedRuns.report",
    );
    const reportParams = report?.payload["params"] as Record<string, unknown> | undefined;

    expect(Object.keys(prepared?.payload ?? {}).sort()).toEqual([
      "expiresAt",
      "externalRunRef",
      "registrationNonce",
      "requestedAttachment",
      "requestedWorkspace",
      "state",
    ]);
    expect(Object.keys(context?.payload ?? {}).sort()).toEqual([
      "agentId",
      "conversationRef",
      "operationId",
      "rootRunId",
      "serviceInstanceId",
      "traceId",
      "workspacePolicyHash",
    ]);
    expect(reportParams).toMatchObject({
      managedRunId: expect.any(String),
      serviceReportId: expect.any(String),
      kind: "progress",
    });
    expect(reportParams).not.toHaveProperty("sequence");
    expect(reportParams).not.toHaveProperty("state");
  });

  it("includes every required conformance fixture class", () => {
    const manifest = readJson<ProtocolManifest>(resolve(PROTOCOL_ROOT, "manifest.json"));
    const fixtureArtifacts = manifest.artifacts.filter((artifact) =>
      artifact.path.startsWith("fixtures/"),
    );
    const fixtureClasses = fixtureArtifacts.map((artifact) =>
      readJson<{ class: string }>(resolve(PROTOCOL_ROOT, artifact.path)).class,
    );

    expect([...new Set(fixtureClasses)].sort()).toEqual(EXPECTED_FIXTURE_CLASSES);
  });

  it("matches every fixture's structural outcome against the emitted JSON Schemas", () => {
    const manifest = readJson<ProtocolManifest>(resolve(PROTOCOL_ROOT, "manifest.json"));
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    const validators = new Map<string, ValidateFunction>();
    for (const artifact of manifest.artifacts) {
      if (!artifact.path.startsWith("schemas/")) continue;
      validators.set(
        artifact.path,
        ajv.compile(readJson(resolve(PROTOCOL_ROOT, artifact.path))),
      );
    }
    const responseSchemas: Readonly<Record<string, string>> = {
      "abandon-response": "schemas/abandon.response.schema.json",
      "activate-response": "schemas/activate.response.schema.json",
      "error-response": "schemas/error-response.schema.json",
      "handshake-response": "schemas/handshake.response.schema.json",
      "health-response": "schemas/health.response.schema.json",
      "mcp-call-context": "schemas/mcp-call-context.schema.json",
      "mcp-managed-run-result": "schemas/mcp-managed-run-result.schema.json",
      "report-response": "schemas/report.response.schema.json",
      "terminal-event-response": "schemas/terminalEvent.response.schema.json",
    };

    for (const artifact of manifest.artifacts) {
      if (!artifact.path.startsWith("fixtures/")) continue;
      const fixture = readJson<ProtocolFixture>(resolve(PROTOCOL_ROOT, artifact.path));
      for (const [index, step] of fixture.steps.entries()) {
        expect(step.schemaExpectation, `${artifact.path} step ${index}`).toBeDefined();
        const payload = materializeDigest(
          step.payload,
          manifest.fixtureDigestToken,
          manifest.bundleDigest,
        );
        const method = requestMethod(payload);
        const schemaPath = method
          ? manifest.methodCatalog.find((entry) => entry.method === method)?.requestSchema
          : responseSchemas[step.target];
        expect(schemaPath, `${artifact.path} step ${index} schema`).toBeDefined();
        const validator = schemaPath ? validators.get(schemaPath) : undefined;
        expect(validator, `${artifact.path} step ${index} validator`).toBeDefined();
        const accepted = validator?.(payload) ?? false;
        expect(
          accepted,
          `${artifact.path} step ${index}: ${JSON.stringify(validator?.errors ?? [])}`,
        ).toBe(step.schemaExpectation === "accept");
      }
    }
  });
});
