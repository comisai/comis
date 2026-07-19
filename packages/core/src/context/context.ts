// SPDX-License-Identifier: Apache-2.0
// @allow-throw: getContext() invariant: AsyncLocalStorage scope assertion. Caller chose getContext() (vs tryGetContext()) signaling they require the context; throw is the contract. Consumed by request-path code which runs under the channel/RPC dispatch boundary.
import { AsyncLocalStorage } from "node:async_hooks";
import { isProxy } from "node:util/types";
import { z } from "zod";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import { DeliveryOriginSchema } from "../domain/delivery-origin.js";
import type { DeliveryOrigin } from "../domain/delivery-origin.js";
import { formatSessionKey, parseSessionKey } from "../domain/session-key.js";
import type { SessionKey } from "../domain/session-key.js";
import { ResolvedTurnScopeSchema, createConversationRef } from "../domain/conversation-scope.js";
import type { ResolvedTurnScope } from "../domain/conversation-scope.js";

/**
 * User trust level for authorization decisions.
 *
 * This is SEPARATE from the memory TrustLevel ("system"/"learned"/"external")
 * which tracks data provenance. UserTrustLevel tracks authorization:
 * - "admin": Full access, can perform destructive operations
 * - "user": Standard access, most operations allowed
 * - "guest": Limited access, read-only operations
 */
export const UserTrustLevelSchema = z.enum(["admin", "user", "guest"]);

export type UserTrustLevel = z.infer<typeof UserTrustLevelSchema>;

/**
 * RequestContextSchema: Validated shape for request-scoped context.
 *
 * Propagated through the entire async call chain via AsyncLocalStorage.
 * Every inbound request (message, API call, scheduled task) runs within
 * a context that carries tenant, user, session, and trace identity.
 *
 * tenantId is injected explicitly by ingress from deployment configuration.
 * traceId is a UUID for distributed tracing / log correlation.
 * trustLevel defaults to "guest" so an unparsed or provisional request never
 * gains privileges before its authenticated sender mapping is resolved.
 *
 * userId/sessionKey/agentId are optional because they are not known at channel
 * ingress. The inbound pipeline fills them on the original context after agent
 * and session resolution, so execution, tools, and delivery inherit one scope.
 * Empty strings remain invalid; only undefined represents unresolved identity.
 */
export const RequestContextSchema = z.strictObject({
    tenantId: z.string().min(1),
    userId: z.string().min(1).optional(),
    sessionKey: z.string().min(1).optional(),
    /** Resolved agent id for the turn, filled by the inbound pipeline. */
    agentId: z.string().min(1).optional(),
    /** Validated endpoint, principal, and conversation authority for the turn. */
    turnScope: ResolvedTurnScopeSchema.optional(),
    /** Authenticated gateway client identity for request-scoped, client-targeted delivery. */
    clientId: z.string().min(1).optional(),
    traceId: z.guid(),
    startedAt: z.number().int().positive(),
    trustLevel: UserTrustLevelSchema.default("guest"),
    /** Content-free trust tier resolved from the raw channel sender at ingress. */
    senderTrustTier: z.string().min(1).optional(),
    /** True only when the operator explicitly named the raw sender in senderTrustMap. */
    senderTrustExplicit: z.boolean().optional(),
    /** False when this runtime-generated turn must not contribute outcome evidence to learning. */
    learningEligible: z.boolean().optional(),
    /** Per-session random delimiter for external content wrapping */
    contentDelimiter: z.string().min(16).optional(),
    /** Channel type for the originating request (e.g. "telegram", "discord"). Flows through AsyncLocalStorage for downstream delivery routing. */
    channelType: z.string().optional(),
    /** Immutable origin context for delivery routing. Captured at channel adapter entry point. */
    deliveryOrigin: DeliveryOriginSchema.optional(),
    /** Resolved model string ("provider:modelId") set by parent executor for sub-agent inheritance via ALS. */
    resolvedModel: z.string().optional(),
    /** Resolved reply language tag set by parent executor for sub-agent inheritance via ALS. */
    resolvedLanguage: z.string().optional(),
    /** Immutable operator-policy snapshot hash used by this turn and durable descendants. */
    workspacePolicyHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  });

export type RequestContext = z.infer<typeof RequestContextSchema>;

/** Turn identity resolved after channel ingress selects an agent and session. */
export interface ResolvedRequestContext {
  tenantId: string;
  userId: string;
  sessionKey: SessionKey;
  agentId: string;
  trustLevel: UserTrustLevel;
  senderTrustTier?: string;
  senderTrustExplicit?: boolean;
  learningEligible?: boolean;
  deliveryOrigin: DeliveryOrigin;
  turnScope?: ResolvedTurnScope;
}

/** Complete identity for a freshly-created synthetic request boundary. */
export interface ResolvedRequestContextSeed {
  tenantId: string;
  userId: string;
  sessionKey: SessionKey;
  agentId: string;
  clientId?: string;
  traceId: string;
  startedAt: number;
  trustLevel: UserTrustLevel;
  senderTrustTier?: string;
  senderTrustExplicit?: boolean;
  learningEligible?: boolean;
  contentDelimiter?: string;
  channelType?: string;
  deliveryOrigin?: DeliveryOrigin;
  resolvedModel?: string;
  resolvedLanguage?: string;
  workspacePolicyHash?: string;
  turnScope?: ResolvedTurnScope;
}

/**
 * The AsyncLocalStorage instance that holds RequestContext.
 * Module-level singleton -- shared across the entire process.
 */
const requestContextStorage = new AsyncLocalStorage<RequestContext>();

const resolvedContexts = new WeakSet<RequestContext>();

const lockedContextFields = [
  "tenantId",
  "userId",
  "sessionKey",
  "agentId",
  "turnScope",
  "clientId",
  "traceId",
  "startedAt",
  "trustLevel",
  "senderTrustTier",
  "senderTrustExplicit",
  "learningEligible",
  "contentDelimiter",
  "channelType",
  "deliveryOrigin",
] as const satisfies readonly (keyof RequestContext)[];

const mutableContextFields = [
  "resolvedModel",
  "resolvedLanguage",
  "workspacePolicyHash",
] as const satisfies readonly (keyof RequestContext)[];

interface ContextInspection {
  descriptors: ReadonlyMap<PropertyKey, PropertyDescriptor>;
  enumerableValues: Record<string, unknown>;
  extensible: boolean;
}

/** Inspect a context without invoking any property getter. */
function inspectContext(context: RequestContext): Result<ContextInspection, Error> {
  const inspected = tryCatch((): ContextInspection | undefined => {
    if (isProxy(context) || Object.getPrototypeOf(context) !== Object.prototype) {
      return undefined;
    }
    const descriptors = new Map<PropertyKey, PropertyDescriptor>();
    const enumerableEntries: Array<readonly [string, unknown]> = [];
    for (const field of Reflect.ownKeys(context)) {
      const descriptor = Object.getOwnPropertyDescriptor(context, field);
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      descriptors.set(field, descriptor);
      if (typeof field === "string" && descriptor.enumerable === true) {
        enumerableEntries.push([field, descriptor.value]);
      }
    }
    return {
      descriptors,
      enumerableValues: Object.fromEntries(enumerableEntries),
      extensible: Object.isExtensible(context),
    };
  });
  if (!inspected.ok || inspected.value === undefined) {
    return err(new Error("Inbound request context could not be inspected safely"));
  }
  return ok(inspected.value);
}

function inspectedValue(
  inspection: ContextInspection,
  field: keyof RequestContext,
): unknown {
  return inspection.descriptors.get(field)?.value;
}

function lockResolvedContext(
  context: RequestContext,
  inspection: ContextInspection,
  parsed: RequestContext,
): Result<RequestContext, Error> {
  const mutableResult = tryCatch(() => {
    if (!inspection.extensible) return false;
    for (const field of [...lockedContextFields, ...mutableContextFields]) {
      const descriptor = inspection.descriptors.get(field);
      if (
        descriptor !== undefined
        && (
          !("value" in descriptor)
          || descriptor.writable !== true
          || descriptor.configurable !== true
        )
      ) {
        return false;
      }
    }
    return true;
  });
  if (!mutableResult.ok || !mutableResult.value) {
    return err(new Error("Inbound request context is not safely mutable"));
  }

  const committed = tryCatch(() => {
    if (parsed.deliveryOrigin !== undefined) {
      Object.freeze(parsed.deliveryOrigin);
    }
    if (parsed.turnScope !== undefined) {
      const partition = parsed.turnScope.conversation.partition;
      if (partition.kind === "endpoint-conversation" || partition.kind === "endpoint-conversation-principal") {
        Object.freeze(partition.endpoint);
      }
      Object.freeze(partition);
      Object.freeze(parsed.turnScope.conversation);
      Object.freeze(parsed.turnScope.principal);
      Object.freeze(parsed.turnScope.endpoint);
      Object.freeze(parsed.turnScope);
    }
    const lockedValues: ReadonlyArray<readonly [keyof RequestContext, unknown]> = [
      ["tenantId", parsed.tenantId],
      ["userId", parsed.userId],
      ["sessionKey", parsed.sessionKey],
      ["agentId", parsed.agentId],
      ["turnScope", parsed.turnScope],
      ["clientId", parsed.clientId],
      ["traceId", parsed.traceId],
      ["startedAt", parsed.startedAt],
      ["trustLevel", parsed.trustLevel],
      ["senderTrustTier", parsed.senderTrustTier],
      ["senderTrustExplicit", parsed.senderTrustExplicit],
      ["learningEligible", parsed.learningEligible],
      ["contentDelimiter", parsed.contentDelimiter],
      ["channelType", parsed.channelType],
      ["deliveryOrigin", parsed.deliveryOrigin],
    ];
    const mutableValues: ReadonlyArray<readonly [keyof RequestContext, unknown]> = [
      ["resolvedModel", parsed.resolvedModel],
      ["resolvedLanguage", parsed.resolvedLanguage],
      ["workspacePolicyHash", parsed.workspacePolicyHash],
    ];
    const descriptors = Object.fromEntries([
      ...lockedValues.map(([field, value]) => [field, {
        value,
        enumerable: true,
        writable: false,
        configurable: false,
      }] as const),
      ...mutableValues.map(([field, value]) => [field, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      }] as const),
    ]) as PropertyDescriptorMap;
    Object.defineProperties(context, descriptors);
    resolvedContexts.add(context);
    return context;
  });
  return committed.ok
    ? ok(committed.value)
    : err(new Error("Inbound request context could not be committed safely"));
}

/**
 * Validate and lock a complete context before a synthetic request boundary
 * enters AsyncLocalStorage. Unlike channel ingress, these callers already know
 * the full principal and therefore must not expose a mutable authorization
 * object to downstream asynchronous work.
 */
export function createResolvedRequestContext(
  seed: ResolvedRequestContextSeed,
): Result<RequestContext, Error> {
  const captured = tryCatch(() => ({
    tenantId: seed.tenantId,
    userId: seed.userId,
    sessionKey: seed.sessionKey,
    agentId: seed.agentId,
    clientId: seed.clientId,
    traceId: seed.traceId,
    startedAt: seed.startedAt,
    trustLevel: seed.trustLevel,
    senderTrustTier: seed.senderTrustTier,
    senderTrustExplicit: seed.senderTrustExplicit,
    learningEligible: seed.learningEligible,
    contentDelimiter: seed.contentDelimiter,
    channelType: seed.channelType,
    deliveryOrigin: seed.deliveryOrigin,
    resolvedModel: seed.resolvedModel,
    resolvedLanguage: seed.resolvedLanguage,
    workspacePolicyHash: seed.workspacePolicyHash,
    turnScope: seed.turnScope,
  }));
  if (!captured.ok) {
    return err(new Error("Resolved request context could not be inspected safely"));
  }

  const sessionResult = tryCatch(() => parseSessionKey(captured.value.sessionKey));
  if (!sessionResult.ok || !sessionResult.value.ok) {
    return err(new Error("Resolved request session key failed validation"));
  }
  const sessionKey = sessionResult.value.value;
  if (
    sessionKey.tenantId !== captured.value.tenantId
    || sessionKey.userId !== captured.value.userId
    || (
      sessionKey.agentId !== undefined
      && sessionKey.agentId !== captured.value.agentId
    )
  ) {
    return err(new Error("Resolved request session identity is inconsistent"));
  }

  const originResult = captured.value.deliveryOrigin === undefined
    ? undefined
    : tryCatch(() => DeliveryOriginSchema.safeParse(captured.value.deliveryOrigin));
  if (
    originResult !== undefined
    && (!originResult.ok || !originResult.value.success)
  ) {
    return err(new Error("Resolved request delivery origin failed validation"));
  }
  const deliveryOrigin = originResult?.ok && originResult.value.success
    ? originResult.value.data
    : undefined;
  if (
    deliveryOrigin !== undefined
    && (
      deliveryOrigin.tenantId !== captured.value.tenantId
      || deliveryOrigin.userId !== captured.value.userId
      || (
        captured.value.channelType !== undefined
        && captured.value.channelType !== deliveryOrigin.channelType
      )
    )
  ) {
    return err(new Error("Resolved request delivery identity is inconsistent"));
  }

  const parsedResult = tryCatch(() => RequestContextSchema.safeParse({
    ...captured.value,
    sessionKey: formatSessionKey(sessionKey),
    channelType: captured.value.channelType ?? deliveryOrigin?.channelType,
    deliveryOrigin,
  }));
  if (!parsedResult.ok || !parsedResult.value.success) {
    return err(new Error("Resolved request context failed validation"));
  }
  const context = parsedResult.value.data;
  if (
    context.turnScope !== undefined
    && (
      context.turnScope.conversation.tenantId !== context.tenantId
      || context.turnScope.conversation.agentId !== context.agentId
    )
  ) {
    return err(new Error("Resolved turn scope is inconsistent with request identity"));
  }
  const inspectionResult = inspectContext(context);
  if (!inspectionResult.ok) return inspectionResult;
  return lockResolvedContext(context, inspectionResult.value, context);
}

/**
 * Get the current RequestContext from the async call chain.
 *
 * Throws a descriptive error if called outside of a runWithContext scope.
 * Use tryGetContext() for a non-throwing alternative.
 */
export function getContext(): RequestContext {
  const ctx = requestContextStorage.getStore();
  if (ctx === undefined) {
    throw new Error(
      "getContext() called outside of a request context scope. " +
        "Ensure this code runs within runWithContext(). " +
        "If context is optional, use tryGetContext() instead.",
    );
  }
  return ctx;
}

/**
 * Get the current RequestContext, or undefined if not in a context scope.
 *
 * Non-throwing alternative to getContext(). Useful for middleware or
 * logging that may run both inside and outside request scopes.
 */
export function tryGetContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

/**
 * Fill the unresolved fields on the existing inbound context without creating
 * a nested AsyncLocalStorage scope. Trace identity and ingress time are kept.
 */
export function enrichCurrentContext(
  enrichment: ResolvedRequestContext,
): Result<RequestContext, Error> {
  const context = requestContextStorage.getStore();
  if (context === undefined) {
    return err(new Error("Cannot enrich request context outside an inbound scope"));
  }

  // Reject proxies, foreign prototypes, and accessors before spreading or
  // reading a single context field. A rejected context must not get a chance to
  // run a getter with side effects.
  const inspectionResult = inspectContext(context);
  if (!inspectionResult.ok) return inspectionResult;
  const inspection = inspectionResult.value;

  const enrichmentResult = tryCatch(() => ({
    tenantId: enrichment.tenantId,
    userId: enrichment.userId,
    sessionKey: enrichment.sessionKey,
    agentId: enrichment.agentId,
    trustLevel: enrichment.trustLevel,
    senderTrustTier: enrichment.senderTrustTier,
    senderTrustExplicit: enrichment.senderTrustExplicit,
    learningEligible: enrichment.learningEligible,
    deliveryOrigin: enrichment.deliveryOrigin,
    turnScope: enrichment.turnScope,
  }));
  if (!enrichmentResult.ok) {
    return err(new Error("Resolved request context could not be inspected safely"));
  }
  const resolved = enrichmentResult.value;

  if (
    resolved.turnScope !== undefined
    && (
      resolved.turnScope.conversation.tenantId !== resolved.tenantId
      || resolved.turnScope.conversation.agentId !== resolved.agentId
    )
  ) {
    return err(new Error("Resolved turn scope is inconsistent with request identity"));
  }

  const sessionResult = tryCatch(() => parseSessionKey(resolved.sessionKey));
  if (!sessionResult.ok || !sessionResult.value.ok) {
    return err(new Error("Resolved request session key failed validation"));
  }
  const sessionKey = sessionResult.value.value;

  const originResult = tryCatch(() => DeliveryOriginSchema.safeParse(resolved.deliveryOrigin));
  if (!originResult.ok || !originResult.value.success) {
    return err(new Error("Resolved request delivery origin failed validation"));
  }
  const deliveryOrigin = originResult.value.data;

  if (
    sessionKey.tenantId !== resolved.tenantId
    || sessionKey.userId !== resolved.userId
    || (sessionKey.agentId !== undefined && sessionKey.agentId !== resolved.agentId)
  ) {
    return err(new Error("Resolved request session identity is inconsistent"));
  }
  if (
    deliveryOrigin.tenantId !== resolved.tenantId
    || deliveryOrigin.userId !== resolved.userId
  ) {
    return err(new Error("Resolved request delivery identity is inconsistent"));
  }

  const existingChannelType = inspectedValue(inspection, "channelType");
  if (
    existingChannelType !== undefined
    && existingChannelType !== deliveryOrigin.channelType
  ) {
    return err(new Error("Resolved request channel conflicts with delivery origin"));
  }
  const formattedSessionKey = formatSessionKey(sessionKey);
  const parsedResult = tryCatch(() => RequestContextSchema.safeParse({
    ...inspection.enumerableValues,
    tenantId: resolved.tenantId,
    userId: resolved.userId,
    sessionKey: formattedSessionKey,
    agentId: resolved.agentId,
    turnScope: resolved.turnScope,
    trustLevel: resolved.trustLevel,
    senderTrustTier: resolved.senderTrustTier,
    senderTrustExplicit: resolved.senderTrustExplicit,
    learningEligible: resolved.learningEligible,
    channelType: existingChannelType ?? deliveryOrigin.channelType,
    deliveryOrigin,
  }));
  if (!parsedResult.ok) {
    return err(new Error("Inbound request context could not be inspected safely"));
  }
  const parsed = parsedResult.value;
  if (!parsed.success) {
    return err(new Error("Resolved request context failed validation"));
  }
  const snapshot = {
    tenantId: inspectedValue(inspection, "tenantId"),
    userId: inspectedValue(inspection, "userId"),
    sessionKey: inspectedValue(inspection, "sessionKey"),
    agentId: inspectedValue(inspection, "agentId"),
    turnScope: inspectedValue(inspection, "turnScope"),
    clientId: inspectedValue(inspection, "clientId"),
    trustLevel: inspectedValue(inspection, "trustLevel"),
    learningEligible: inspectedValue(inspection, "learningEligible"),
    deliveryOrigin: inspectedValue(inspection, "deliveryOrigin"),
    authorizationAlreadyResolved: inspectedValue(inspection, "userId") !== undefined
      || inspectedValue(inspection, "clientId") !== undefined
      || inspectedValue(inspection, "agentId") !== undefined
      || inspectedValue(inspection, "turnScope") !== undefined
      || inspectedValue(inspection, "sessionKey") !== undefined
      || inspectedValue(inspection, "deliveryOrigin") !== undefined,
  };
  if (
    snapshot.authorizationAlreadyResolved
    && snapshot.tenantId !== parsed.data.tenantId
  ) {
    return err(new Error("Resolved request context conflicts with existing tenantId"));
  }
  if (snapshot.userId !== undefined && snapshot.userId !== parsed.data.userId) {
    return err(new Error("Resolved request context conflicts with existing userId"));
  }
  if (
    snapshot.sessionKey !== undefined
    && snapshot.sessionKey !== parsed.data.sessionKey
  ) {
    return err(new Error("Resolved request context conflicts with existing sessionKey"));
  }
  if (snapshot.agentId !== undefined && snapshot.agentId !== parsed.data.agentId) {
    return err(new Error("Resolved request context conflicts with existing agentId"));
  }
  if (
    snapshot.learningEligible !== undefined
    && snapshot.learningEligible !== parsed.data.learningEligible
  ) {
    return err(new Error("Resolved request context conflicts with existing learningEligible"));
  }
  if (snapshot.turnScope !== undefined) {
    const existingTurn = ResolvedTurnScopeSchema.safeParse(snapshot.turnScope);
    const resolvedTurn = parsed.data.turnScope;
    if (!existingTurn.success || resolvedTurn === undefined) {
      return err(new Error("Existing request turn scope failed validation"));
    }
    const existingRef = createConversationRef(existingTurn.data.conversation);
    const resolvedRef = createConversationRef(resolvedTurn.conversation);
    if (
      !existingRef.ok
      || !resolvedRef.ok
      || existingRef.value !== resolvedRef.value
      || existingTurn.data.principal.principalId !== resolvedTurn.principal.principalId
      || existingTurn.data.endpoint.channelType !== resolvedTurn.endpoint.channelType
      || existingTurn.data.endpoint.channelInstanceId !== resolvedTurn.endpoint.channelInstanceId
      || existingTurn.data.endpoint.conversationId !== resolvedTurn.endpoint.conversationId
      || existingTurn.data.endpoint.threadId !== resolvedTurn.endpoint.threadId
      || existingTurn.data.endpoint.conversationKind !== resolvedTurn.endpoint.conversationKind
    ) {
      return err(new Error("Resolved request context conflicts with existing turnScope"));
    }
  }
  const existingOriginResult = snapshot.deliveryOrigin === undefined
    ? undefined
    : tryCatch(() => DeliveryOriginSchema.safeParse(snapshot.deliveryOrigin));
  if (
    existingOriginResult !== undefined
    && (!existingOriginResult.ok || !existingOriginResult.value.success)
  ) {
    return err(new Error("Existing request delivery origin failed validation"));
  }
  const existingOrigin = existingOriginResult?.ok && existingOriginResult.value.success
    ? existingOriginResult.value.data
    : undefined;
  const resolvedOrigin = parsed.data.deliveryOrigin;
  if (
    existingOrigin !== undefined
    && resolvedOrigin !== undefined
    && (
      existingOrigin.channelType !== resolvedOrigin.channelType
      || existingOrigin.channelId !== resolvedOrigin.channelId
      || existingOrigin.userId !== resolvedOrigin.userId
      || existingOrigin.threadId !== resolvedOrigin.threadId
      || existingOrigin.tenantId !== resolvedOrigin.tenantId
    )
  ) {
    return err(new Error("Resolved request context conflicts with existing deliveryOrigin"));
  }
  if (
    snapshot.authorizationAlreadyResolved
    && snapshot.trustLevel !== parsed.data.trustLevel
  ) {
    return err(new Error("Resolved request context conflicts with existing trustLevel"));
  }
  if (resolvedContexts.has(context)) return ok(context);

  return lockResolvedContext(context, inspection, parsed.data);
}

/**
 * Run a function within a RequestContext scope.
 *
 * The context is available via getContext() / tryGetContext() throughout
 * the entire async call chain, including nested awaits, Promise.all,
 * setTimeout callbacks, etc.
 *
 * Nested calls create independent scopes (inner context shadows outer).
 */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestContextStorage.run(ctx, fn);
}
