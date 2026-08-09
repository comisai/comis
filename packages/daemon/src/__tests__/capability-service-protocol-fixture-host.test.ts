// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITY_SERVICE_LIMITS,
  ProtocolFixtureScenarioSchema,
  type ProtocolFixtureScenario,
  type ProtocolFixtureStep,
} from "@comis/capability-service-sdk";
import { describe, expect, it } from "vitest";
import { createCapabilityServiceProtocolFixtureHost } from "./capability-service-protocol-fixture-host.js";

const here = dirname(fileURLToPath(import.meta.url));
const PROTOCOL_ROOT = resolve(here, "../../../capability-service-sdk/protocol");
const manifest = JSON.parse(
  readFileSync(resolve(PROTOCOL_ROOT, "manifest.json"), "utf8"),
) as { bundleDigest: string };

function loadScenarios(): ProtocolFixtureScenario[] {
  return readdirSync(resolve(PROTOCOL_ROOT, "fixtures"))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const parsed = JSON.parse(
        readFileSync(resolve(PROTOCOL_ROOT, "fixtures", name), "utf8"),
      ) as unknown;
      return ProtocolFixtureScenarioSchema.parse(parsed);
    });
}

function firstStep(
  scenarios: readonly ProtocolFixtureScenario[],
  fixtureClass: ProtocolFixtureScenario["class"],
): ProtocolFixtureStep {
  const scenario = scenarios.find((candidate) => candidate.class === fixtureClass);
  if (!scenario) throw new Error(`Missing ${fixtureClass} protocol fixture`);
  const step = scenario.steps[0];
  if (!step) throw new Error(`Empty ${fixtureClass} protocol fixture`);
  return step;
}

describe("daemon capability-service fixture host", () => {
  it("matches every committed fixture acceptance and rejection outcome", () => {
    const scenarios = loadScenarios();

    for (const scenario of scenarios) {
      const host = createCapabilityServiceProtocolFixtureHost({
        bundleDigest: manifest.bundleDigest,
      });
      for (const step of scenario.steps) {
        const result = host.validate(step);
        expect(result.ok, `${scenario.class}: ${scenario.name}`).toBe(
          step.expectation === "accept",
        );
        if (!result.ok) {
          expect(result.error.kind).toBe(step.expectedErrorKind);
        }
      }
    }
  });

  it("accepts an identical operation replay and rejects an altered replay", () => {
    const scenarios = loadScenarios();
    const scenario = scenarios.find((candidate) => candidate.class === "altered-replay");
    if (!scenario) throw new Error("Missing altered-replay protocol fixture");
    const original = scenario.steps[0];
    const altered = scenario.steps[1];
    if (!original || !altered) throw new Error("Incomplete altered-replay protocol fixture");
    const host = createCapabilityServiceProtocolFixtureHost({
      bundleDigest: manifest.bundleDigest,
    });

    expect(host.validate(original).ok).toBe(true);
    expect(host.validate(original).ok).toBe(true);
    const replay = host.validate(altered);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.kind).toBe("replay_conflict");
  });

  it("enforces the report limit in UTF-8 bytes rather than code points", () => {
    const scenarios = loadScenarios();
    const boundary = firstStep(scenarios, "boundary-size");
    const payload = structuredClone(boundary.payload) as {
      params: { summary: string };
    };
    payload.params.summary = "é".repeat(CAPABILITY_SERVICE_LIMITS.maxReportBytes);
    const host = createCapabilityServiceProtocolFixtureHost({
      bundleDigest: manifest.bundleDigest,
    });

    const result = host.validate({ ...boundary, payload });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("size_limit_exceeded");
  });

  it("enforces the report limit across all content fields", () => {
    const scenarios = loadScenarios();
    const boundary = firstStep(scenarios, "boundary-size");
    const payload = structuredClone(boundary.payload) as {
      params: { details?: string; summary: string };
    };
    payload.params.summary = "x".repeat(CAPABILITY_SERVICE_LIMITS.maxReportBytes / 2);
    payload.params.details = "y".repeat(CAPABILITY_SERVICE_LIMITS.maxReportBytes / 2 + 1);
    const host = createCapabilityServiceProtocolFixtureHost({
      bundleDigest: manifest.bundleDigest,
    });

    const result = host.validate({ ...boundary, payload });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("size_limit_exceeded");
  });

  it("enforces workspace lease presence against the prepared workspace request", () => {
    const workspaceHost = createCapabilityServiceProtocolFixtureHost({
      bundleDigest: manifest.bundleDigest,
    });
    expect(workspaceHost.validate({
      target: "mcp-managed-run-result",
      expectation: "accept",
      schemaExpectation: "accept",
      payload: {
        state: "prepared",
        externalRunRef: "external-run_workspace",
        registrationNonce: "registration-nonce_workspace",
        expiresAt: "2030-01-01T00:00:00.000Z",
        requestedWorkspace: { rootHint: "/approved/workspaces/task-a" },
      },
    }).ok).toBe(true);
    const missingLease = workspaceHost.validateRequest({
      jsonrpc: "2.0",
      id: "operation_activate_missing_lease",
      method: "managedRuns.activate",
      params: {
        operationId: "operation_activate_missing_lease",
        managedRunId: "managed-run_workspace",
        externalRunRef: "external-run_workspace",
        registrationNonce: "registration-nonce_workspace",
      },
    });
    expect(missingLease.ok).toBe(false);
    if (!missingLease.ok) expect(missingLease.error.kind).toBe("invalid_params");
    expect(workspaceHost.validateRequest({
      jsonrpc: "2.0",
      id: "operation_activate_workspace",
      method: "managedRuns.activate",
      params: {
        operationId: "operation_activate_workspace",
        managedRunId: "managed-run_workspace",
        externalRunRef: "external-run_workspace",
        registrationNonce: "registration-nonce_workspace",
        workspaceLeaseId: "workspace-lease_workspace",
      },
    }).ok).toBe(true);

    const workspaceLessHost = createCapabilityServiceProtocolFixtureHost({
      bundleDigest: manifest.bundleDigest,
    });
    expect(workspaceLessHost.validate({
      target: "mcp-managed-run-result",
      expectation: "accept",
      schemaExpectation: "accept",
      payload: {
        state: "prepared",
        externalRunRef: "external-run_without_workspace",
        registrationNonce: "registration-nonce_without_workspace",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    }).ok).toBe(true);
    const unexpectedLease = workspaceLessHost.validateRequest({
      jsonrpc: "2.0",
      id: "operation_activate_unexpected_lease",
      method: "managedRuns.activate",
      params: {
        operationId: "operation_activate_unexpected_lease",
        managedRunId: "managed-run_without_workspace",
        externalRunRef: "external-run_without_workspace",
        registrationNonce: "registration-nonce_without_workspace",
        workspaceLeaseId: "workspace-lease_unexpected",
      },
    });
    expect(unexpectedLease.ok).toBe(false);
    if (!unexpectedLease.ok) expect(unexpectedLease.error.kind).toBe("invalid_params");
  });
});
