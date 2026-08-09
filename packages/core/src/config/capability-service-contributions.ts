// SPDX-License-Identifier: Apache-2.0
import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import { err, ok, type Result } from "@comis/shared";
import {
  registerContributionSections,
  type ContributionSectionRegistration,
  type SectionRegistryEntry,
  type SectionRegistrationError,
} from "./section-registry.js";

export const CAPABILITY_SERVICE_CONTROL_PROTOCOL = "comis.capability-service/1" as const;

const CONTRIBUTION_ID_SEGMENT_PATTERN = /^[a-z][a-z0-9]*$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u;
const SECRET_REF_PATTERN = /^secret:\/\/[A-Za-z0-9][A-Za-z0-9/._~-]{0,255}$/u;

function isContributionId(value: string): boolean {
  if (value.length > 256) return false;
  const segments = value.split(/[.-]/u);
  return segments.length >= 2 && segments.every((segment) => CONTRIBUTION_ID_SEGMENT_PATTERN.test(segment));
}

export const CapabilityServiceScopeSchema = z.enum(["health", "report"]);

export const CapabilityServiceDefinitionSchema = z.strictObject({
  serviceDefinitionId: z.string().refine(isContributionId),
  protocolId: z.literal(CAPABILITY_SERVICE_CONTROL_PROTOCOL),
  mcpServerName: z.string().regex(OPAQUE_ID_PATTERN),
  requestedScopes: z.array(CapabilityServiceScopeSchema).min(1).max(2),
  dependsOn: z.array(z.string().refine(isContributionId)).max(32),
}).superRefine((value, ctx) => {
  if (new Set(value.requestedScopes).size !== value.requestedScopes.length) {
    ctx.addIssue({
      code: "custom",
      path: ["requestedScopes"],
      message: "requested capability-service scopes must be unique",
    });
  }
  if (new Set(value.dependsOn).size !== value.dependsOn.length) {
    ctx.addIssue({
      code: "custom",
      path: ["dependsOn"],
      message: "capability-service definition dependencies must be unique",
    });
  }
  if (value.dependsOn.includes(value.serviceDefinitionId)) {
    ctx.addIssue({
      code: "custom",
      path: ["dependsOn"],
      message: "a capability-service definition cannot depend on itself",
    });
  }
});

const CapabilityServiceControlConfigSchema = z.strictObject({
  transport: z.literal("unix"),
  socketPath: z.string().min(1).max(4_096).superRefine((path, ctx) => {
    if (!isAbsolute(path) || normalize(path) !== path) {
      ctx.addIssue({
        code: "custom",
        message: "capability-service socketPath must be absolute and normalized",
      });
    }
  }),
  credentialRef: z.string().regex(SECRET_REF_PATTERN),
});

export const CapabilityServiceInstanceConfigSchema = z.strictObject({
  serviceInstanceId: z.string().regex(OPAQUE_ID_PATTERN),
  serviceDefinitionId: z.string().refine(isContributionId),
  enabled: z.boolean(),
  mcpServerName: z.string().regex(OPAQUE_ID_PATTERN),
  control: CapabilityServiceControlConfigSchema,
  allowedAgents: z.array(z.string().regex(OPAQUE_ID_PATTERN)).min(1).max(256),
}).superRefine((value, ctx) => {
  if (new Set(value.allowedAgents).size !== value.allowedAgents.length) {
    ctx.addIssue({
      code: "custom",
      path: ["allowedAgents"],
      message: "capability-service allowedAgents must be unique",
    });
  }
});

export type CapabilityServiceScope = z.infer<typeof CapabilityServiceScopeSchema>;
export type CapabilityServiceDefinition = z.infer<typeof CapabilityServiceDefinitionSchema>;
export type CapabilityServiceInstanceConfig = z.infer<
  typeof CapabilityServiceInstanceConfigSchema
>;

export interface CapabilityServiceContributionSection {
  readonly namespace: string;
  readonly schema: z.ZodType;
  readonly schemaSerializable: boolean;
  readonly fieldMetadataVisible: boolean;
}

/** Trusted linked declaration. It intentionally has no activator, port, credential, or handle. */
export interface CapabilityServiceContributionRegistration {
  readonly contributionId: string;
  readonly configSections: readonly CapabilityServiceContributionSection[];
  readonly serviceDefinitions: readonly CapabilityServiceDefinition[];
}

export type PlannedCapabilityServiceDefinition = Omit<
  CapabilityServiceDefinition,
  "requestedScopes" | "dependsOn"
> & {
  readonly contributionId: string;
  readonly requestedScopes: readonly CapabilityServiceScope[];
  readonly dependsOn: readonly string[];
};

export type PlannedCapabilityServiceInstance = Omit<
  CapabilityServiceInstanceConfig,
  "control" | "allowedAgents"
> & {
  readonly contributionId: string;
  readonly control: Readonly<CapabilityServiceInstanceConfig["control"]>;
  readonly allowedAgents: readonly string[];
};

export interface CapabilityServiceActivationPlan {
  readonly configSections: Readonly<Record<string, SectionRegistryEntry>>;
  readonly orderedDefinitions: readonly PlannedCapabilityServiceDefinition[];
  readonly configuredInstances: readonly PlannedCapabilityServiceInstance[];
  readonly orderedInstances: readonly PlannedCapabilityServiceInstance[];
}

export type CapabilityServicePlanError =
  | { readonly kind: "invalid_contribution"; readonly contributionId: string }
  | { readonly kind: "duplicate_contribution"; readonly contributionId: string }
  | { readonly kind: "config_section_registration"; readonly error: SectionRegistrationError }
  | { readonly kind: "duplicate_service_definition"; readonly serviceDefinitionId: string }
  | { readonly kind: "duplicate_mcp_owner"; readonly mcpServerName: string }
  | { readonly kind: "unknown_definition_dependency"; readonly serviceDefinitionId: string; readonly dependencyId: string }
  | { readonly kind: "definition_dependency_cycle" }
  | { readonly kind: "invalid_service_instance"; readonly index: number }
  | { readonly kind: "duplicate_service_instance"; readonly serviceInstanceId: string }
  | { readonly kind: "unknown_service_definition"; readonly serviceDefinitionId: string }
  | { readonly kind: "mcp_owner_mismatch"; readonly serviceInstanceId: string };

function freezeDefinition(
  contributionId: string,
  definition: CapabilityServiceDefinition,
): PlannedCapabilityServiceDefinition {
  return Object.freeze({
    ...definition,
    contributionId,
    requestedScopes: Object.freeze([...definition.requestedScopes]),
    dependsOn: Object.freeze([...definition.dependsOn]),
  });
}

function freezeInstance(
  contributionId: string,
  instance: CapabilityServiceInstanceConfig,
): PlannedCapabilityServiceInstance {
  return Object.freeze({
    ...instance,
    contributionId,
    control: Object.freeze({ ...instance.control }),
    allowedAgents: Object.freeze([...instance.allowedAgents]),
  });
}

function definitionOrder(
  definitions: readonly PlannedCapabilityServiceDefinition[],
): Result<readonly PlannedCapabilityServiceDefinition[], CapabilityServicePlanError> {
  const byId = new Map(definitions.map((definition) => [definition.serviceDefinitionId, definition]));
  for (const definition of definitions) {
    for (const dependencyId of definition.dependsOn) {
      if (!byId.has(dependencyId)) {
        return err({
          kind: "unknown_definition_dependency",
          serviceDefinitionId: definition.serviceDefinitionId,
          dependencyId,
        });
      }
    }
  }

  const remaining = new Map(byId);
  const ordered: PlannedCapabilityServiceDefinition[] = [];
  const completed = new Set<string>();
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((definition) => definition.dependsOn.every((dependency) => completed.has(dependency)))
      .sort((left, right) => left.contributionId.localeCompare(right.contributionId)
        || left.serviceDefinitionId.localeCompare(right.serviceDefinitionId));
    if (ready.length === 0) return err({ kind: "definition_dependency_cycle" });
    for (const definition of ready) {
      remaining.delete(definition.serviceDefinitionId);
      completed.add(definition.serviceDefinitionId);
      ordered.push(definition);
    }
  }
  return ok(Object.freeze(ordered));
}

/** Validate and stage a complete inactive contribution topology without publishing runtime state. */
export function buildCapabilityServiceActivationPlan(
  contributions: readonly CapabilityServiceContributionRegistration[],
  instanceInputs: readonly CapabilityServiceInstanceConfig[],
): Result<CapabilityServiceActivationPlan, CapabilityServicePlanError> {
  const contributionIds = new Set<string>();
  const sectionRegistrations: ContributionSectionRegistration[] = [];
  const definitions: PlannedCapabilityServiceDefinition[] = [];
  const definitionIds = new Set<string>();
  const mcpOwners = new Set<string>();

  for (const contribution of contributions) {
    if (!isContributionId(contribution.contributionId)) {
      return err({ kind: "invalid_contribution", contributionId: contribution.contributionId });
    }
    if (contributionIds.has(contribution.contributionId)) {
      return err({ kind: "duplicate_contribution", contributionId: contribution.contributionId });
    }
    contributionIds.add(contribution.contributionId);
    for (const section of contribution.configSections) {
      sectionRegistrations.push({ ...section, contributionId: contribution.contributionId });
    }
    for (const definitionInput of contribution.serviceDefinitions) {
      const parsed = CapabilityServiceDefinitionSchema.safeParse(definitionInput);
      if (!parsed.success) {
        return err({ kind: "invalid_contribution", contributionId: contribution.contributionId });
      }
      if (definitionIds.has(parsed.data.serviceDefinitionId)) {
        return err({
          kind: "duplicate_service_definition",
          serviceDefinitionId: parsed.data.serviceDefinitionId,
        });
      }
      if (mcpOwners.has(parsed.data.mcpServerName)) {
        return err({ kind: "duplicate_mcp_owner", mcpServerName: parsed.data.mcpServerName });
      }
      definitionIds.add(parsed.data.serviceDefinitionId);
      mcpOwners.add(parsed.data.mcpServerName);
      definitions.push(freezeDefinition(contribution.contributionId, parsed.data));
    }
  }

  const sections = registerContributionSections(sectionRegistrations);
  if (!sections.ok) return err({ kind: "config_section_registration", error: sections.error });
  const orderedDefinitions = definitionOrder(definitions);
  if (!orderedDefinitions.ok) return orderedDefinitions;
  const definitionById = new Map(
    orderedDefinitions.value.map((definition) => [definition.serviceDefinitionId, definition]),
  );
  const definitionRank = new Map(
    orderedDefinitions.value.map((definition, index) => [definition.serviceDefinitionId, index]),
  );
  const instanceIds = new Set<string>();
  const configuredInstances: PlannedCapabilityServiceInstance[] = [];
  for (const [index, instanceInput] of instanceInputs.entries()) {
    const parsed = CapabilityServiceInstanceConfigSchema.safeParse(instanceInput);
    if (!parsed.success) return err({ kind: "invalid_service_instance", index });
    if (instanceIds.has(parsed.data.serviceInstanceId)) {
      return err({ kind: "duplicate_service_instance", serviceInstanceId: parsed.data.serviceInstanceId });
    }
    instanceIds.add(parsed.data.serviceInstanceId);
    const definition = definitionById.get(parsed.data.serviceDefinitionId);
    if (definition === undefined) {
      return err({
        kind: "unknown_service_definition",
        serviceDefinitionId: parsed.data.serviceDefinitionId,
      });
    }
    if (definition.mcpServerName !== parsed.data.mcpServerName) {
      return err({ kind: "mcp_owner_mismatch", serviceInstanceId: parsed.data.serviceInstanceId });
    }
    configuredInstances.push(freezeInstance(definition.contributionId, parsed.data));
  }

  const orderedInstances = configuredInstances
    .filter((instance) => instance.enabled)
    .sort((left, right) => (
      (definitionRank.get(left.serviceDefinitionId) ?? -1)
      - (definitionRank.get(right.serviceDefinitionId) ?? -1)
    ) || left.contributionId.localeCompare(right.contributionId)
      || left.serviceDefinitionId.localeCompare(right.serviceDefinitionId)
      || left.serviceInstanceId.localeCompare(right.serviceInstanceId));

  return ok(Object.freeze({
    configSections: sections.value,
    orderedDefinitions: orderedDefinitions.value,
    configuredInstances: Object.freeze(configuredInstances),
    orderedInstances: Object.freeze(orderedInstances),
  }));
}
