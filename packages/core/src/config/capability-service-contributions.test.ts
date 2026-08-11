// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CAPABILITY_SERVICE_CONTROL_PROTOCOL,
  CapabilityServiceInstanceConfigSchema,
  buildCapabilityServiceActivationPlan,
  type CapabilityServiceContributionRegistration,
  type CapabilityServiceDefinition,
  type CapabilityServiceInstanceConfig,
} from "./capability-service-contributions.js";

function makeContribution(
  overrides: Partial<CapabilityServiceContributionRegistration> = {},
): CapabilityServiceContributionRegistration {
  return {
    contributionId: "example.analysis",
    configSections: [],
    serviceDefinitions: [{
      serviceDefinitionId: "example.analysis-service",
      protocolId: CAPABILITY_SERVICE_CONTROL_PROTOCOL,
      mcpServerName: "example-analysis",
      managedToolBindings: [{
        toolName: "prepare_analysis",
        behavior: "prepare_run",
        actionClassification: "mutate",
        invocationSideEffects: ["deferred_work"],
      }],
      requestedScopes: ["health", "report"],
      evidencePolicies: [],
      dependsOn: [],
    }],
    ...overrides,
  };
}

function makeInstance(
  overrides: Partial<CapabilityServiceInstanceConfig> = {},
): CapabilityServiceInstanceConfig {
  return {
    serviceInstanceId: "analysis-local",
    serviceDefinitionId: "example.analysis-service",
    enabled: true,
    mcpServerName: "example-analysis",
    control: {
      transport: "unix",
      socketPath: "/tmp/comis-test-analysis.sock",
      credentialRef: "secret://capability-services/analysis-local",
    },
    allowedAgents: ["agent_a"],
    allowedWorkspaceRoots: [],
    allowedRuntimeRoots: [],
    ...overrides,
  };
}

describe("capability-service contribution planning", () => {
  it("publishes frozen verifier evidence policies only with evidence scope", () => {
    const definition = {
      ...makeContribution().serviceDefinitions[0]!,
      requestedScopes: ["health", "evidence", "report"],
      evidencePolicies: [
        { kind: "candidate_bundle", verificationLevel: "adapter_verified", use: "outcome" },
        { kind: "delivery_reference", verificationLevel: "adapter_verified", use: "delivery_reference" },
        { kind: "report_artifact", verificationLevel: "adapter_verified", use: "delivery_attachment" },
      ],
    } as unknown as CapabilityServiceDefinition;
    const contribution = makeContribution({ serviceDefinitions: [definition] });

    const result = buildCapabilityServiceActivationPlan([contribution], [makeInstance()]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.orderedDefinitions[0]?.evidencePolicies).toEqual(definition.evidencePolicies);
    expect(Object.isFrozen(result.value.orderedDefinitions[0]?.evidencePolicies)).toBe(true);
    expect(Object.isFrozen(result.value.orderedDefinitions[0]?.evidencePolicies[0])).toBe(true);

    const missingScope = makeContribution({
      serviceDefinitions: [{ ...definition, requestedScopes: ["health", "report"] }],
    });
    const duplicateKind = makeContribution({
      serviceDefinitions: [{
        ...definition,
        evidencePolicies: [definition.evidencePolicies[0]!, definition.evidencePolicies[0]!],
      }],
    });
    expect(buildCapabilityServiceActivationPlan([missingScope], [makeInstance()]).ok).toBe(false);
    expect(buildCapabilityServiceActivationPlan([duplicateKind], [makeInstance()]).ok).toBe(false);
  });

  it("accepts every ratified capability-service scope together", () => {
    const contribution = makeContribution({
      serviceDefinitions: [{
        ...makeContribution().serviceDefinitions[0]!,
        requestedScopes: [
          "health",
          "report",
          "workspace_lease",
          "terminal_events",
          "execution_attachment",
        ],
      }],
    });

    expect(buildCapabilityServiceActivationPlan([contribution], [makeInstance()]).ok).toBe(true);
  });

  it("builds one deterministic inactive plan without granting runtime authority", () => {
    const contribution = makeContribution({
      configSections: [{
        namespace: "analysisService",
        schema: z.strictObject({ enabled: z.boolean().default(true) }),
        schemaSerializable: true,
        fieldMetadataVisible: true,
      }],
    });

    const result = buildCapabilityServiceActivationPlan([contribution], [makeInstance()]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.orderedDefinitions.map((entry) => entry.serviceDefinitionId)).toEqual([
      "example.analysis-service",
    ]);
    expect(result.value.orderedInstances.map((entry) => entry.serviceInstanceId)).toEqual([
      "analysis-local",
    ]);
    expect(result.value.configSections.analysisService?.owner).toEqual({
      kind: "contribution",
      contributionId: "example.analysis",
    });
    expect(result.value).not.toHaveProperty("activate");
    expect(result.value).not.toHaveProperty("credentialRef");
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.orderedDefinitions)).toBe(true);
    expect(Object.isFrozen(result.value.orderedDefinitions[0]?.managedToolBindings)).toBe(true);
    expect(Object.isFrozen(
      result.value.orderedDefinitions[0]?.managedToolBindings[0]?.invocationSideEffects,
    )).toBe(true);
    expect(Object.isFrozen(result.value.orderedInstances)).toBe(true);
  });

  it("validates exact managed-tool bindings and run-handle ownership", () => {
    const validRunCommand = makeContribution({
      serviceDefinitions: [{
        serviceDefinitionId: "example.analysis-service",
        protocolId: CAPABILITY_SERVICE_CONTROL_PROTOCOL,
        mcpServerName: "example-analysis",
        managedToolBindings: [{
          toolName: "send_command",
          behavior: "run_command",
          runHandleArgument: "managed_run",
          actionClassification: "mutate",
          invocationSideEffects: ["external_mutation"],
        }],
        requestedScopes: ["health"],
        evidencePolicies: [],
        dependsOn: [],
      }],
    });
    const missingRunHandle = makeContribution({
      serviceDefinitions: [{
        ...validRunCommand.serviceDefinitions[0]!,
        managedToolBindings: [{
          toolName: "send_command",
          behavior: "run_command",
          actionClassification: "mutate",
          invocationSideEffects: [],
        }],
      }],
    });
    const duplicateExactTool = makeContribution({
      serviceDefinitions: [{
        ...validRunCommand.serviceDefinitions[0]!,
        managedToolBindings: [
          validRunCommand.serviceDefinitions[0]!.managedToolBindings[0]!,
          validRunCommand.serviceDefinitions[0]!.managedToolBindings[0]!,
        ],
      }],
    });

    expect(buildCapabilityServiceActivationPlan([validRunCommand], [makeInstance()]).ok).toBe(true);
    expect(buildCapabilityServiceActivationPlan([missingRunHandle], [makeInstance()]))
      .toMatchObject({ ok: false, error: { kind: "invalid_contribution" } });
    expect(buildCapabilityServiceActivationPlan([duplicateExactTool], [makeInstance()]))
      .toMatchObject({ ok: false, error: { kind: "invalid_contribution" } });
  });

  it("sorts dependencies before dependents with lexical identifier tie breaks", () => {
    const result = buildCapabilityServiceActivationPlan([
      makeContribution({
        contributionId: "example.worker",
        serviceDefinitions: [{
          serviceDefinitionId: "example.worker-service",
          protocolId: CAPABILITY_SERVICE_CONTROL_PROTOCOL,
          mcpServerName: "worker-service",
          managedToolBindings: [],
          requestedScopes: ["health"],
          evidencePolicies: [],
          dependsOn: ["example.base-service"],
        }],
      }),
      makeContribution({
        contributionId: "example.base",
        serviceDefinitions: [{
          serviceDefinitionId: "example.base-service",
          protocolId: CAPABILITY_SERVICE_CONTROL_PROTOCOL,
          mcpServerName: "base-service",
          managedToolBindings: [],
          requestedScopes: ["health"],
          evidencePolicies: [],
          dependsOn: [],
        }],
      }),
    ], [
      makeInstance({
        serviceInstanceId: "worker-z",
        serviceDefinitionId: "example.worker-service",
        mcpServerName: "worker-service",
      }),
      makeInstance({
        serviceInstanceId: "base-z",
        serviceDefinitionId: "example.base-service",
        mcpServerName: "base-service",
      }),
      makeInstance({
        serviceInstanceId: "base-a",
        serviceDefinitionId: "example.base-service",
        mcpServerName: "base-service",
      }),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.orderedDefinitions.map((entry) => entry.serviceDefinitionId)).toEqual([
      "example.base-service",
      "example.worker-service",
    ]);
    expect(result.value.orderedInstances.map((entry) => entry.serviceInstanceId)).toEqual([
      "base-a",
      "base-z",
      "worker-z",
    ]);
  });

  it.each([
    ["duplicate contribution", [makeContribution(), makeContribution()], [makeInstance()]],
    ["duplicate definition", [
      makeContribution(),
      makeContribution({ contributionId: "example.second" }),
    ], [makeInstance()]],
    ["duplicate MCP ownership", [
      makeContribution(),
      makeContribution({
        contributionId: "example.second",
        serviceDefinitions: [{
          serviceDefinitionId: "example.second-service",
          protocolId: CAPABILITY_SERVICE_CONTROL_PROTOCOL,
          mcpServerName: "example-analysis",
          managedToolBindings: [],
          requestedScopes: ["health"],
          evidencePolicies: [],
          dependsOn: [],
        }],
      }),
    ], [makeInstance()]],
    ["unknown definition dependency", [makeContribution({
      serviceDefinitions: [{
        serviceDefinitionId: "example.analysis-service",
        protocolId: CAPABILITY_SERVICE_CONTROL_PROTOCOL,
        mcpServerName: "example-analysis",
        managedToolBindings: [],
        requestedScopes: ["health"],
        evidencePolicies: [],
        dependsOn: ["example.missing-service"],
      }],
    })], [makeInstance()]],
    ["dependency cycle", [makeContribution({
      serviceDefinitions: [
        {
          serviceDefinitionId: "example.analysis-service",
          protocolId: CAPABILITY_SERVICE_CONTROL_PROTOCOL,
          mcpServerName: "example-analysis",
          managedToolBindings: [],
          requestedScopes: ["health"],
          evidencePolicies: [],
          dependsOn: ["example.second-service"],
        },
        {
          serviceDefinitionId: "example.second-service",
          protocolId: CAPABILITY_SERVICE_CONTROL_PROTOCOL,
          mcpServerName: "example-second",
          managedToolBindings: [],
          requestedScopes: ["health"],
          evidencePolicies: [],
          dependsOn: ["example.analysis-service"],
        },
      ],
    })], [makeInstance()]],
  ])("rejects %s without exposing a partial plan", (_label, contributions, instances) => {
    const result = buildCapabilityServiceActivationPlan(contributions, instances);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBeTypeOf("string");
  });

  it("rejects an instance whose definition identity or MCP ownership does not match", () => {
    const unknown = buildCapabilityServiceActivationPlan(
      [makeContribution()],
      [makeInstance({ serviceDefinitionId: "example.unknown-service" })],
    );
    const mismatchedServer = buildCapabilityServiceActivationPlan(
      [makeContribution()],
      [makeInstance({ mcpServerName: "other-server" })],
    );

    expect(unknown).toMatchObject({ ok: false, error: { kind: "unknown_service_definition" } });
    expect(mismatchedServer).toMatchObject({ ok: false, error: { kind: "mcp_owner_mismatch" } });
  });

  it("omits disabled instances while retaining their validated operator configuration", () => {
    const result = buildCapabilityServiceActivationPlan(
      [makeContribution()],
      [makeInstance({ enabled: false })],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.orderedInstances).toEqual([]);
  });

  it("rejects unsafe or noncanonical Unix control paths through the strict config schema", () => {
    expect(CapabilityServiceInstanceConfigSchema.safeParse(makeInstance({
      control: {
        transport: "unix",
        socketPath: "relative/service.sock",
        credentialRef: "secret://capability-services/analysis-local",
      },
    })).success).toBe(false);
    expect(CapabilityServiceInstanceConfigSchema.safeParse(makeInstance({
      control: {
        transport: "unix",
        socketPath: "/tmp/../tmp/service.sock",
        credentialRef: "secret://capability-services/analysis-local",
      },
    })).success).toBe(false);
  });

  it("rejects unknown config fields and protocol identities before planning", () => {
    const unknownField = CapabilityServiceInstanceConfigSchema.safeParse({
      ...makeInstance(),
      token: "not-allowed",
    });
    const mismatchedProtocol = makeContribution({
      serviceDefinitions: [{
        serviceDefinitionId: "example.analysis-service",
        protocolId: "comis.capability-service/2" as typeof CAPABILITY_SERVICE_CONTROL_PROTOCOL,
        mcpServerName: "example-analysis",
        managedToolBindings: [],
        requestedScopes: ["health"],
        evidencePolicies: [],
        dependsOn: [],
      }],
    });

    expect(unknownField.success).toBe(false);
    expect(buildCapabilityServiceActivationPlan([mismatchedProtocol], [makeInstance()]))
      .toMatchObject({ ok: false, error: { kind: "invalid_contribution" } });
  });
});
