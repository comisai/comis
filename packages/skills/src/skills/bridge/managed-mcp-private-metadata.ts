// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  ResponseLocalePolicySchema,
  createConversationRef,
  parseFormattedSessionKey,
  sanitizeLogString,
  tryGetContext,
  type AgentCapability,
  type CapabilityServiceScope,
  type ComisLogger,
  type ManagedRunOwnerScope,
  type ManagedRunPreparedGroupStart,
  type ManagedRunPreparedStart,
  type ManagedRunRecord,
  type PlannedManagedToolBinding,
  type RequestContext,
  type ResponseLocalePolicy,
  type SessionKey,
} from "@comis/core";
import {
  CAPABILITY_SERVICE_LIMITS,
  MCP_CAPABILITY_CALL_CONTEXT_KEY,
  MCP_MANAGED_RUN_RESULT_KEY,
  McpCapabilityCallContextSchema,
  McpManagedRunGroupResultSchema,
  McpManagedRunResultSchema,
  type McpCapabilityCallContext,
  type McpManagedRunResult,
} from "@comis/capability-service-sdk";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import type { McpPrivateMeta } from "../integrations/mcp-client/index.js";
import type {
  McpPrivateMetadataBridge,
  McpPrivateMetadataCall,
} from "./mcp-tool-bridge.js";

export interface ManagedMcpActiveDefinition {
  readonly serviceDefinitionId: string;
  readonly mcpServerName: string;
  readonly managedToolBindings: readonly Readonly<PlannedManagedToolBinding>[];
}

export interface ManagedMcpActiveInstance {
  readonly serviceDefinitionId: string;
  readonly serviceInstanceId: string;
  readonly mcpServerName: string;
  readonly allowedAgents: readonly string[];
  readonly allowedWorkspaceRoots: readonly string[];
  readonly activeScopes: readonly CapabilityServiceScope[];
  readonly state: "active" | "failed";
}

export interface ManagedMcpActiveView {
  readonly viewHash: string;
  readonly definitions: readonly ManagedMcpActiveDefinition[];
  readonly instances: readonly ManagedMcpActiveInstance[];
}

export interface ManagedMcpActivationAuthority {
  readonly tenantId: string;
  readonly agentId: string;
  readonly principalId: string;
  readonly conversationRef: ManagedRunRecord["conversationRef"];
  readonly turnScope: ManagedRunRecord["turnScope"];
  readonly deliveryOrigin: ManagedRunRecord["deliveryOrigin"];
  readonly traceId: string;
  readonly trustLevel: ManagedRunRecord["trustLevel"];
  readonly responseLocalePolicy: ResponseLocalePolicy;
  readonly workspacePolicyHash: string;
  readonly rootRunId: string;
  readonly initiationSource: "user_request";
  readonly capturedAgentCapabilities: readonly AgentCapability[];
  readonly capturedToolIds: readonly string[];
  readonly capturedCapabilityViewHash: string;
}

export interface ManagedMcpActivationInput {
  readonly operationId: string;
  readonly serviceInstanceId: string;
  readonly prepared: ManagedRunPreparedStart;
  readonly authority: ManagedMcpActivationAuthority;
}

export interface ManagedMcpGroupActivationInput {
  readonly operationId: string;
  readonly serviceInstanceId: string;
  readonly prepared: ManagedRunPreparedGroupStart;
  readonly authority: ManagedMcpActivationAuthority;
}

export type ManagedMcpActivationOutcome =
  | { readonly kind: "activated" }
  | { readonly kind: "identical_replay" }
  | { readonly kind: "activation_unknown" }
  | { readonly kind: "rejected" };

export interface ManagedMcpPrivateMetadataDeps {
  readonly agentId: string;
  /** Immutable capability-service view captured while assembling this turn. */
  readonly activeView: ManagedMcpActiveView;
  readonly capturedAgentCapabilities: readonly AgentCapability[];
  /** Resolves only after the complete model-visible tool surface is assembled. */
  readonly getCapturedToolIds: () => readonly string[] | undefined;
  readonly nowMs: () => number;
  readonly resolveRootRunId: (
    agentId: string,
    sessionKey: SessionKey,
  ) => Result<string, Error>;
  readonly getManagedRunByExternalRef: (
    scope: ManagedRunOwnerScope,
    serviceInstanceId: string,
    externalRunRef: string,
  ) => Promise<Result<ManagedRunRecord | undefined, Error>>;
  readonly activatePrepared: (
    input: ManagedMcpActivationInput,
  ) => Promise<Result<ManagedMcpActivationOutcome, Error>>;
  readonly activatePreparedGroup: (
    input: ManagedMcpGroupActivationInput,
  ) => Promise<Result<ManagedMcpActivationOutcome, Error>>;
  readonly logger: ComisLogger;
}

interface BoundTool {
  readonly binding: Readonly<PlannedManagedToolBinding>;
  readonly serviceInstanceId: string;
  readonly activeScopes: readonly CapabilityServiceScope[];
}

interface CapturedCall {
  readonly requestContext: RequestContext;
  readonly callContext: McpCapabilityCallContext;
  readonly binding: Readonly<PlannedManagedToolBinding>;
  readonly activeScopes: readonly CapabilityServiceScope[];
  readonly authority: ManagedMcpActivationAuthority;
}

const COMMANDABLE_RUN_STATUSES = new Set<ManagedRunRecord["status"]>([
  "active",
  "waiting",
  "paused",
  "candidate_complete",
]);

const DESTRUCTIVE_COMMAND_RUN_STATUSES = new Set<ManagedRunRecord["status"]>([
  "unknown",
  "succeeded",
  "failed",
  "cancelled",
]);

function runCommandAllowedForStatus(
  binding: Readonly<PlannedManagedToolBinding>,
  status: ManagedRunRecord["status"],
): boolean {
  return COMMANDABLE_RUN_STATUSES.has(status)
    || (
      binding.actionClassification === "destructive"
      && DESTRUCTIVE_COMMAND_RUN_STATUSES.has(status)
    );
}

function callKey(input: McpPrivateMetadataCall): string {
  return JSON.stringify([input.qualifiedName, input.toolCallId]);
}

function operationId(input: McpPrivateMetadataCall, traceId: string): string {
  const digest = createHash("sha256")
    .update(`${traceId}\0${input.qualifiedName}\0${input.toolCallId}`, "utf8")
    .digest("hex");
  return `mcp-${digest.slice(0, 48)}`;
}

function exactBinding(
  deps: ManagedMcpPrivateMetadataDeps,
  input: McpPrivateMetadataCall,
): Result<BoundTool | undefined, Error> {
  const definitions = deps.activeView.definitions.filter(
    (definition) => definition.mcpServerName === input.serverName
      && definition.managedToolBindings.some((binding) => binding.toolName === input.toolName),
  );
  if (definitions.length === 0) return ok(undefined);
  if (definitions.length !== 1) {
    return err(new Error("managed MCP tool binding is ambiguous"));
  }
  const definition = definitions[0];
  const binding = definition?.managedToolBindings.find(
    (candidate) => candidate.toolName === input.toolName,
  );
  if (definition === undefined || binding === undefined) return ok(undefined);
  const instances = deps.activeView.instances.filter(
    (instance) => instance.serviceDefinitionId === definition.serviceDefinitionId
      && instance.mcpServerName === input.serverName
      && instance.state === "active"
      && instance.allowedAgents.includes(deps.agentId),
  );
  if (instances.length !== 1 || instances[0] === undefined) {
    return err(new Error("managed MCP tool has no unique active authorized service instance"));
  }
  return ok({
    binding,
    serviceInstanceId: instances[0].serviceInstanceId,
    activeScopes: instances[0].activeScopes,
  });
}

function rejectCall(
  deps: ManagedMcpPrivateMetadataDeps,
  input: McpPrivateMetadataCall,
  message: string,
): Result<never, Error> {
  deps.logger.warn({
    serverName: input.serverName,
    toolName: input.toolName,
    rejectionReason: sanitizeLogString(message),
    errorKind: "validation" as const,
    hint: "Inspect the operator-owned managedToolBindings entry and the active turn authority before retrying the tool call",
  }, "Managed MCP private metadata rejected");
  return err(new Error(message));
}

function sortedUnique<T extends string>(values: readonly T[]): Result<readonly T[], Error> {
  if (new Set(values).size !== values.length) {
    return err(new Error("captured authority values must be unique"));
  }
  return ok(Object.freeze([...values].sort((left, right) => left.localeCompare(right))));
}

function privateMetaWithinLimit(meta: McpPrivateMeta | undefined): boolean {
  if (meta === undefined) return true;
  const serialized = tryCatch(() => JSON.stringify(meta));
  return serialized.ok
    && serialized.value !== undefined
    && Buffer.byteLength(serialized.value, "utf8") <= CAPABILITY_SERVICE_LIMITS.maxResponseBytes;
}

function ownEnumerableValue(
  record: Readonly<Record<string, unknown>>,
  key: string,
): Result<unknown, Error> {
  const entries = tryCatch(() => Object.entries(record));
  if (!entries.ok) return err(entries.error);
  for (const [candidate, value] of entries.value) {
    if (candidate === key) return ok(value);
  }
  return ok(undefined);
}

async function invoke<T>(
  operation: () => Promise<Result<T, Error>>,
): Promise<Result<T, Error>> {
  const started = tryCatch(operation);
  if (!started.ok) return err(started.error);
  const settled = await fromPromise(started.value);
  return settled.ok ? settled.value : err(settled.error);
}

function preparedMember(
  input: McpManagedRunResult,
  expiresAtMs: number,
): ManagedRunPreparedStart {
  return {
    state: input.state,
    externalRunRef: input.externalRunRef,
    registrationNonce: input.registrationNonce,
    expiresAtMs,
    ...(input.displayLabel === undefined ? {} : { displayLabel: input.displayLabel }),
    ...(input.requestedWorkspace === undefined
      ? {}
      : { requestedWorkspace: input.requestedWorkspace }),
    ...(input.requestedAttachment === undefined
      ? {}
      : { requestedAttachment: input.requestedAttachment }),
  };
}

function preparationScopesAllowed(
  activeScopes: readonly CapabilityServiceScope[],
  members: readonly McpManagedRunResult[],
): Result<void, Error> {
  if (
    members.some((member) => member.requestedWorkspace !== undefined)
    && !activeScopes.includes("workspace_lease")
  ) return err(new Error("managed-run workspace request lacks workspace lease scope"));
  if (
    members.some((member) => member.requestedAttachment !== undefined)
    && !activeScopes.includes("execution_attachment")
  ) return err(new Error("managed-run attachment request lacks execution attachment scope"));
  return ok(undefined);
}

async function resolveRunHandle(
  deps: ManagedMcpPrivateMetadataDeps,
  input: McpPrivateMetadataCall,
  bound: BoundTool,
  scope: ManagedRunOwnerScope,
): Promise<Result<string | undefined, Error>> {
  if (bound.binding.behavior !== "run_command") return ok(undefined);
  const argument = bound.binding.runHandleArgument;
  const params = input.params;
  const handleResult = argument === undefined
    || typeof params !== "object"
    || params === null
    || Array.isArray(params)
    ? ok(undefined)
    : ownEnumerableValue(params, argument);
  if (!handleResult.ok) return err(handleResult.error);
  const handle = handleResult.value;
  if (
    typeof handle !== "string"
    || handle.length === 0
    || handle.length > 256
  ) {
    return err(new Error("managed-run handle argument is missing or invalid"));
  }
  const loaded = await invoke(() => deps.getManagedRunByExternalRef(
    scope,
    bound.serviceInstanceId,
    handle,
  ));
  if (!loaded.ok) return loaded;
  const record = loaded.value;
  if (
    record === undefined
    || record.serviceInstanceId !== bound.serviceInstanceId
    || record.tenantId !== scope.tenantId
    || record.agentId !== scope.agentId
    || record.principalId !== scope.principalId
    || record.conversationRef !== scope.conversationRef
    || !runCommandAllowedForStatus(bound.binding, record.status)
  ) {
    return err(new Error("managed-run handle is unavailable in the active owner scope"));
  }
  return ok(record.managedRunId);
}

function liveContextAuthority(
  deps: ManagedMcpPrivateMetadataDeps,
  input: McpPrivateMetadataCall,
  context: RequestContext,
): Result<{
  readonly scope: ManagedRunOwnerScope;
  readonly authority: Omit<ManagedMcpActivationAuthority, "rootRunId">;
}, Error> {
  const turnScope = context.turnScope;
  const deliveryOrigin = context.deliveryOrigin;
  const workspacePolicyHash = context.workspacePolicyHash;
  const responseLocalePolicy = ResponseLocalePolicySchema.safeParse(context.responseLocalePolicy);
  if (
    context.agentId !== deps.agentId
    || turnScope === undefined
    || deliveryOrigin === undefined
    || workspacePolicyHash === undefined
    || !responseLocalePolicy.success
  ) {
    return rejectCall(deps, input, "managed MCP tool requires a complete active turn authority");
  }
  const conversationRef = createConversationRef(turnScope.conversation);
  if (!conversationRef.ok) return err(conversationRef.error);
  const capabilities = sortedUnique(deps.capturedAgentCapabilities);
  const currentToolIds = deps.getCapturedToolIds();
  const tools = currentToolIds === undefined
    ? err(new Error("model-visible tool ceiling is not assembled"))
    : sortedUnique(currentToolIds);
  if (!capabilities.ok) return capabilities;
  if (!tools.ok) return tools;
  const scope: ManagedRunOwnerScope = {
    kind: "owner",
    tenantId: context.tenantId,
    agentId: deps.agentId,
    principalId: turnScope.principal.principalId,
    conversationRef: conversationRef.value,
  };
  return ok({
    scope,
    authority: {
      tenantId: context.tenantId,
      agentId: deps.agentId,
      principalId: turnScope.principal.principalId,
      conversationRef: conversationRef.value,
      turnScope,
      deliveryOrigin,
      traceId: context.traceId,
      trustLevel: context.trustLevel,
      responseLocalePolicy: Object.freeze({ ...responseLocalePolicy.data }),
      workspacePolicyHash,
      initiationSource: "user_request",
      capturedAgentCapabilities: capabilities.value,
      capturedToolIds: tools.value,
      capturedCapabilityViewHash: deps.activeView.viewHash,
    },
  });
}

/** Create the host-only MCP metadata boundary for one immutable turn preparation. */
export function createManagedMcpPrivateMetadataBridge(
  deps: ManagedMcpPrivateMetadataDeps,
): McpPrivateMetadataBridge {
  const capturedCalls = new Map<string, CapturedCall>();

  function resolveRegistrationMetadata(
    input: Omit<McpPrivateMetadataCall, "toolCallId" | "params">,
  ): {
    readonly actionClassification: "read" | "mutate" | "destructive";
    readonly invocationSideEffects: readonly string[];
  } | undefined {
    const bound = exactBinding(deps, { ...input, toolCallId: "registration", params: {} });
    if (!bound.ok) {
      return Object.freeze({ actionClassification: "destructive", invocationSideEffects: [] });
    }
    if (bound.value === undefined) return undefined;
    return Object.freeze({
      actionClassification: bound.value.binding.actionClassification,
      invocationSideEffects: Object.freeze([...bound.value.binding.invocationSideEffects]),
    });
  }

  async function createRequestMeta(
    input: McpPrivateMetadataCall,
  ): Promise<Result<McpPrivateMeta | undefined, Error>> {
    const bound = exactBinding(deps, input);
    if (!bound.ok) return rejectCall(deps, input, bound.error.message);
    if (bound.value === undefined) return ok(undefined);
    if (
      bound.value.binding.behavior === "prepare_run_group"
      && !bound.value.activeScopes.includes("managed_run_group")
    ) {
      return rejectCall(deps, input, "managed-run group preparation lacks managed run group scope");
    }
    const context = tryGetContext();
    if (context === undefined) {
      return rejectCall(deps, input, "managed MCP tool requires an active request context");
    }
    const contextAuthority = liveContextAuthority(deps, input, context);
    if (!contextAuthority.ok) return contextAuthority;
    let rootRunId = context.rootRunId;
    if (rootRunId === undefined) {
      if (context.sessionKey === undefined) {
        return rejectCall(deps, input, "managed MCP tool requires an exact session root");
      }
      const sessionKey = parseFormattedSessionKey(context.sessionKey);
      if (sessionKey === undefined) {
        return rejectCall(deps, input, "managed MCP session identity is invalid");
      }
      const resolvedRoot = deps.resolveRootRunId(deps.agentId, sessionKey);
      if (!resolvedRoot.ok) return rejectCall(deps, input, resolvedRoot.error.message);
      rootRunId = resolvedRoot.value;
    }
    const managedRunId = await resolveRunHandle(
      deps,
      input,
      bound.value,
      contextAuthority.value.scope,
    );
    if (!managedRunId.ok) return rejectCall(deps, input, managedRunId.error.message);
    const parsedCallContext = McpCapabilityCallContextSchema.safeParse({
      operationId: operationId(input, context.traceId),
      serviceInstanceId: bound.value.serviceInstanceId,
      agentId: deps.agentId,
      conversationRef: contextAuthority.value.scope.conversationRef,
      workspacePolicyHash: context.workspacePolicyHash,
      rootRunId,
      traceId: context.traceId,
      ...(managedRunId.value === undefined ? {} : { managedRunId: managedRunId.value }),
    });
    if (!parsedCallContext.success) {
      return rejectCall(deps, input, "host call context failed strict validation");
    }
    const key = callKey(input);
    if (capturedCalls.has(key)) {
      return rejectCall(deps, input, "managed MCP tool-call identity was reused concurrently");
    }
    capturedCalls.set(key, Object.freeze({
      requestContext: context,
      callContext: parsedCallContext.data,
      binding: bound.value.binding,
      activeScopes: bound.value.activeScopes,
      authority: Object.freeze({
        ...contextAuthority.value.authority,
        rootRunId,
      }),
    }));
    return ok(Object.freeze({
      [MCP_CAPABILITY_CALL_CONTEXT_KEY]: parsedCallContext.data,
    }));
  }

  async function acceptResultMeta(
    input: McpPrivateMetadataCall & { readonly meta: McpPrivateMeta | undefined },
  ): Promise<Result<void, Error>> {
    const key = callKey(input);
    const captured = capturedCalls.get(key);
    capturedCalls.delete(key);
    const hasPreparedExtension = input.meta !== undefined
      && Object.prototype.hasOwnProperty.call(input.meta, MCP_MANAGED_RUN_RESULT_KEY);
    if (!privateMetaWithinLimit(input.meta)) {
      return rejectCall(deps, input, "MCP private result metadata exceeds its byte limit");
    }
    if (captured === undefined) {
      return hasPreparedExtension
        ? rejectCall(deps, input, "unbound MCP tool returned managed-run metadata")
        : ok(undefined);
    }
    const activeContext = tryGetContext();
    if (
      activeContext !== captured.requestContext
      || activeContext.workspacePolicyHash !== captured.callContext.workspacePolicyHash
      || activeContext.agentId !== captured.callContext.agentId
      || activeContext.traceId !== captured.callContext.traceId
    ) {
      return rejectCall(deps, input, "managed MCP result no longer owns the active turn policy");
    }
    if (
      captured.binding.behavior !== "prepare_run"
      && captured.binding.behavior !== "prepare_run_group"
    ) {
      return hasPreparedExtension
        ? rejectCall(deps, input, "non-starter MCP tool returned managed-run metadata")
        : ok(undefined);
    }
    if (!hasPreparedExtension || input.meta === undefined) {
      return rejectCall(deps, input, "managed-run starter omitted its private prepared result");
    }
    const preparedResult = ownEnumerableValue(input.meta, MCP_MANAGED_RUN_RESULT_KEY);
    if (!preparedResult.ok) {
      return rejectCall(deps, input, "managed-run prepared result could not be read safely");
    }
    if (captured.binding.behavior === "prepare_run_group") {
      const parsedGroup = McpManagedRunGroupResultSchema.safeParse(preparedResult.value);
      if (!parsedGroup.success) {
        return rejectCall(deps, input, "managed-run group prepared result failed strict validation");
      }
      const scopes = preparationScopesAllowed(captured.activeScopes, parsedGroup.data.members);
      if (!scopes.ok) return rejectCall(deps, input, scopes.error.message);
      const expiresAtMs = Date.parse(parsedGroup.data.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= deps.nowMs()) {
        return rejectCall(deps, input, "managed-run group preparation is expired");
      }
      const activated = await invoke(() => deps.activatePreparedGroup({
        operationId: captured.callContext.operationId,
        serviceInstanceId: captured.callContext.serviceInstanceId,
        prepared: {
          state: parsedGroup.data.state,
          registrationNonce: parsedGroup.data.registrationNonce,
          expiresAtMs,
          ...(parsedGroup.data.displayLabel === undefined
            ? {}
            : { displayLabel: parsedGroup.data.displayLabel }),
          members: parsedGroup.data.members.map((member) => preparedMember(member, expiresAtMs)),
        },
        authority: captured.authority,
      }));
      if (!activated.ok) return rejectCall(deps, input, activated.error.message);
      return activated.value.kind === "activated" || activated.value.kind === "identical_replay"
        ? ok(undefined)
        : rejectCall(deps, input, `managed-run group activation did not complete: ${activated.value.kind}`);
    }

    const parsed = McpManagedRunResultSchema.safeParse(preparedResult.value);
    if (!parsed.success) {
      return rejectCall(deps, input, "managed-run prepared result failed strict validation");
    }
    const scopes = preparationScopesAllowed(captured.activeScopes, [parsed.data]);
    if (!scopes.ok) return rejectCall(deps, input, scopes.error.message);
    const expiresAtMs = Date.parse(parsed.data.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= deps.nowMs()) {
      return rejectCall(deps, input, "managed-run preparation is expired");
    }
    const activated = await invoke(() => deps.activatePrepared({
      operationId: captured.callContext.operationId,
      serviceInstanceId: captured.callContext.serviceInstanceId,
      prepared: preparedMember(parsed.data, expiresAtMs),
      authority: captured.authority,
    }));
    if (!activated.ok) return rejectCall(deps, input, activated.error.message);
    return activated.value.kind === "activated" || activated.value.kind === "identical_replay"
      ? ok(undefined)
      : rejectCall(deps, input, `managed-run activation did not complete: ${activated.value.kind}`);
  }

  function discardCall(input: McpPrivateMetadataCall): void {
    capturedCalls.delete(callKey(input));
  }

  return Object.freeze({ resolveRegistrationMetadata, createRequestMeta, acceptResultMeta, discardCall });
}
