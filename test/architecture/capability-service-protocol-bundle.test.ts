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
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const SDK_ROOT = resolve(REPO_ROOT, "packages/capability-service-sdk");
const PROTOCOL_ROOT = resolve(SDK_ROOT, "protocol");

const EXPECTED_METHODS = [
  "capability.abandon",
  "capability.activate",
  "capability.handshake",
  "capability.health",
  "capability.report",
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
  readonly artifacts: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
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
  });

  it("pins the protocol identity, method catalog, errors, and limits", () => {
    const manifest = readJson<ProtocolManifest>(resolve(PROTOCOL_ROOT, "manifest.json"));

    expect(manifest.protocolId).toBe("comis.capability-service/1");
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
      const basename = method.replace("capability.", "");
      expect(artifactPaths).toContain(`schemas/${basename}.request.schema.json`);
      expect(artifactPaths).toContain(`schemas/${basename}.response.schema.json`);
    }
    expect(artifactPaths).toContain("schemas/error-response.schema.json");
    expect(artifactPaths).toContain("schemas/mcp-call-context.schema.json");
    expect(artifactPaths).toContain("schemas/mcp-managed-run-result.schema.json");
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
});
