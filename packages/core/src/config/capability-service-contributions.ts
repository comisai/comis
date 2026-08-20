// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { err, ok, type Result } from "@comis/shared";
import {
  registerContributionSections,
  type ContributionSectionRegistration,
  type SectionRegistryEntry,
  type SectionRegistrationError,
} from "./section-registry.js";
import {
  CapabilityServiceInstanceConfigSchema,
  CapabilityServiceLimitsSchema,
  type CapabilityServiceInstanceConfig,
  type CapabilityServiceLimits,
} from "./capability-service-instance-schema.js";

export { CapabilityServiceInstanceConfigSchema, CapabilityServiceLimitsSchema } from "./capability-service-instance-schema.js";
export type { CapabilityServiceInstanceConfig, CapabilityServiceLimits } from "./capability-service-instance-schema.js";

export const CAPABILITY_SERVICE_CONTROL_PROTOCOL = "comis.capability-service/1" as const;

const CONTRIBUTION_ID_SEGMENT_PATTERN = /^[a-z][a-z0-9]*$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u;

function isContributionId(value: string): boolean {
  if (value.length > 256) return false;
  const segments = value.split(/[.-]/u);
  return segments.length >= 2 && segments.every((segment) => CONTRIBUTION_ID_SEGMENT_PATTERN.test(segment));
}

export const CapabilityServiceScopeSchema = z.enum([
  "health",
  "attention_response",
  "evidence",
  "report",
  "workspace_lease",
  "terminal_events",
  "execution_attachment",
  // Grouping grants a read over runs the instance already owns. It deliberately
  // does not appear in the root allowlist table below: a group is a projection
  // of member runs, so it needs no filesystem authority of its own.
  "managed_run_group",
  // A service may consume only the exact destructive-operation approval the
  // host bound to one of its already-owned managed runs.
  "approval_receipt",
]);

export const CapabilityServiceEvidencePolicySchema = z.strictObject({
  kind: z.string().regex(OPAQUE_ID_PATTERN),
  verificationLevel: z.literal("adapter_verified"),
  use: z.enum(["outcome", "delivery_reference", "delivery_attachment"]),
});

export const ManagedToolBehaviorSchema = z.enum([
  "prepare_run",
  "prepare_run_group",
  "run_command",
  "read_only",
]);

export const ManagedToolActionClassificationSchema = z.enum([
  "read",
  "mutate",
  "destructive",
]);

export const ManagedToolBindingSchema = z.strictObject({
  toolName: z.string().regex(OPAQUE_ID_PATTERN),
  behavior: ManagedToolBehaviorSchema,
  runHandleArgument: z.string().regex(OPAQUE_ID_PATTERN).optional(),
  actionClassification: ManagedToolActionClassificationSchema,
  invocationSideEffects: z.array(z.string().regex(OPAQUE_ID_PATTERN)).max(32),
}).superRefine((binding, context) => {
  if (binding.behavior === "run_command" && binding.runHandleArgument === undefined) {
    context.addIssue({
      code: "custom",
      path: ["runHandleArgument"],
      message: "run-command bindings require an exact model-visible run-handle argument",
    });
  }
  if (binding.behavior !== "run_command" && binding.runHandleArgument !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["runHandleArgument"],
      message: "only run-command bindings may declare a run-handle argument",
    });
  }
  if (new Set(binding.invocationSideEffects).size !== binding.invocationSideEffects.length) {
    context.addIssue({
      code: "custom",
      path: ["invocationSideEffects"],
      message: "managed-tool side effects must be unique",
    });
  }
});

export const CapabilityServiceDefinitionSchema = z.strictObject({
  serviceDefinitionId: z.string().refine(isContributionId),
  protocolId: z.literal(CAPABILITY_SERVICE_CONTROL_PROTOCOL),
  mcpServerName: z.string().regex(OPAQUE_ID_PATTERN),
  managedToolBindings: z.array(ManagedToolBindingSchema).max(128),
  requestedScopes: z.array(CapabilityServiceScopeSchema).min(1).max(9),
  evidencePolicies: z.array(CapabilityServiceEvidencePolicySchema).max(32),
  dependsOn: z.array(z.string().refine(isContributionId)).max(32),
  limits: CapabilityServiceLimitsSchema.optional(),
}).superRefine((value, ctx) => {
  if (new Set(value.requestedScopes).size !== value.requestedScopes.length) {
    ctx.addIssue({
      code: "custom",
      path: ["requestedScopes"],
      message: "requested capability-service scopes must be unique",
    });
  }
  if (new Set(value.evidencePolicies.map((policy) => policy.kind)).size
    !== value.evidencePolicies.length) {
    ctx.addIssue({
      code: "custom",
      path: ["evidencePolicies"],
      message: "capability-service evidence kinds must be unique",
    });
  }
  if (value.evidencePolicies.length > 0 && !value.requestedScopes.includes("evidence")) {
    ctx.addIssue({
      code: "custom",
      path: ["evidencePolicies"],
      message: "configured verifier evidence requires the evidence service scope",
    });
  }
  if (new Set(value.dependsOn).size !== value.dependsOn.length) {
    ctx.addIssue({
      code: "custom",
      path: ["dependsOn"],
      message: "capability-service definition dependencies must be unique",
    });
  }
  if (new Set(value.managedToolBindings.map((binding) => binding.toolName)).size
    !== value.managedToolBindings.length) {
    ctx.addIssue({
      code: "custom",
      path: ["managedToolBindings"],
      message: "managed-tool names must be unique within a service definition",
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

export type CapabilityServiceScope = z.infer<typeof CapabilityServiceScopeSchema>;
export type CapabilityServiceEvidencePolicy = z.infer<
  typeof CapabilityServiceEvidencePolicySchema
>;
export type ManagedToolBehavior = z.infer<typeof ManagedToolBehaviorSchema>;
export type ManagedToolActionClassification = z.infer<
  typeof ManagedToolActionClassificationSchema
>;
export type ManagedToolBinding = z.infer<typeof ManagedToolBindingSchema>;
export type PlannedManagedToolBinding = Omit<ManagedToolBinding, "invocationSideEffects"> & {
  readonly invocationSideEffects: readonly string[];
};
export type CapabilityServiceDefinition = z.infer<typeof CapabilityServiceDefinitionSchema>;

/**
 * The effective self-declared bounds for one instance: each field is the
 * instance override if present, else the definition's value, else undefined
 * (fall back to the global protocol ceiling at the enforcement site). Never
 * loosens a bound — the schema already caps each field at the protocol ceiling.
 */
export function resolveEffectiveCapabilityServiceLimits(
  definitionLimits: CapabilityServiceLimits | undefined,
  instanceLimits: CapabilityServiceLimits | undefined,
): CapabilityServiceLimits {
  const maxReportBytes = instanceLimits?.maxReportBytes ?? definitionLimits?.maxReportBytes;
  const maxEvidenceBytes = instanceLimits?.maxEvidenceBytes ?? definitionLimits?.maxEvidenceBytes;
  const maxConcurrentRuns = instanceLimits?.maxConcurrentRuns ?? definitionLimits?.maxConcurrentRuns;
  const maxReportsPerMinute = instanceLimits?.maxReportsPerMinute ?? definitionLimits?.maxReportsPerMinute;
  return Object.freeze({
    ...(maxReportBytes === undefined ? {} : { maxReportBytes }),
    ...(maxEvidenceBytes === undefined ? {} : { maxEvidenceBytes }),
    ...(maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns }),
    ...(maxReportsPerMinute === undefined ? {} : { maxReportsPerMinute }),
  });
}

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
  "managedToolBindings" | "requestedScopes" | "evidencePolicies" | "dependsOn"
> & {
  readonly contributionId: string;
  readonly managedToolBindings: readonly Readonly<PlannedManagedToolBinding>[];
  readonly requestedScopes: readonly CapabilityServiceScope[];
  readonly evidencePolicies: readonly Readonly<CapabilityServiceEvidencePolicy>[];
  readonly dependsOn: readonly string[];
};

export type PlannedCapabilityServiceInstance = Omit<
  CapabilityServiceInstanceConfig,
  "control" | "allowedAgents" | "allowedWorkspaceRoots" | "allowedRuntimeRoots"
> & {
  readonly contributionId: string;
  readonly control: Readonly<CapabilityServiceInstanceConfig["control"]>;
  readonly allowedAgents: readonly string[];
  readonly allowedWorkspaceRoots: readonly string[];
  readonly allowedRuntimeRoots: readonly string[];
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
  | { readonly kind: "mcp_owner_mismatch"; readonly serviceInstanceId: string }
  | {
    readonly kind: "scope_root_mismatch";
    readonly serviceInstanceId: string;
    readonly scope: CapabilityServiceScope;
    readonly reason: "root_without_scope" | "scope_without_root";
  };

function freezeDefinition(
  contributionId: string,
  definition: CapabilityServiceDefinition,
): PlannedCapabilityServiceDefinition {
  return Object.freeze({
    ...definition,
    contributionId,
    managedToolBindings: Object.freeze(definition.managedToolBindings.map((binding) => Object.freeze({
      ...binding,
      invocationSideEffects: Object.freeze([...binding.invocationSideEffects].sort()),
    }))),
    requestedScopes: Object.freeze([...definition.requestedScopes].sort()),
    evidencePolicies: Object.freeze(definition.evidencePolicies
      .map((policy) => Object.freeze({ ...policy }))
      .sort((left, right) => left.kind.localeCompare(right.kind))),
    dependsOn: Object.freeze([...definition.dependsOn].sort()),
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
    allowedAgents: Object.freeze([...instance.allowedAgents].sort()),
    allowedWorkspaceRoots: Object.freeze([...instance.allowedWorkspaceRoots].sort()),
    allowedRuntimeRoots: Object.freeze([...instance.allowedRuntimeRoots].sort()),
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
/** Each executor scope and the approved roots it is the only consumer of. */
const SCOPE_ROOT_PAIRINGS: ReadonlyArray<{
  readonly scope: CapabilityServiceScope;
  readonly roots: (instance: CapabilityServiceInstanceConfig) => readonly string[];
}> = [
  { scope: "workspace_lease", roots: (instance) => instance.allowedWorkspaceRoots },
  { scope: "execution_attachment", roots: (instance) => instance.allowedRuntimeRoots },
];

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
    // An approved root and the scope that consumes it must agree in both
    // directions. A root without its scope is authority nothing can use and
    // nothing revokes; a scope without its root is a capability that fails on
    // first use instead of at configuration time.
    for (const pairing of SCOPE_ROOT_PAIRINGS) {
      const declared = definition.requestedScopes.includes(pairing.scope);
      const configured = pairing.roots(parsed.data).length > 0;
      if (declared === configured) continue;
      return err({
        kind: "scope_root_mismatch",
        serviceInstanceId: parsed.data.serviceInstanceId,
        scope: pairing.scope,
        reason: configured ? "root_without_scope" : "scope_without_root",
      });
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
