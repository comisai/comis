// SPDX-License-Identifier: Apache-2.0
// @allow-throw: the capability socket is an authentication boundary; invalid
// lease principals throw here and the socket wrapper converts them to a fixed
// error response for the jailed client.
import { randomUUID } from "node:crypto";
import {
  createResolvedRequestContext,
  parseFormattedSessionKey,
  runWithContext,
  stripInternalFields,
  systemNowMs,
  type ComisLogger,
  type RequestContext,
} from "@comis/core";
import type { LeaseInfo } from "@comis/infra";
import { err, ok, type Result } from "@comis/shared";

interface LeaseRequestPrincipal {
  context: RequestContext;
  callerSessionKey: string;
  callerChannelType?: string;
  callerChannelId?: string;
  deliveryTarget?: {
    channelId: string;
    userId: string;
    tenantId: string;
    channelType?: string;
  };
}

interface DispatchValidatedLeaseRpcDeps {
  lease: LeaseInfo;
  params: Record<string, unknown>;
  /** Server-controlled public fields, such as cron's forced agentId. */
  trustedPublicParams?: Record<string, unknown>;
  /** Server-allocated outward sequence, when this call performs delivery. */
  outwardStepIndex?: number;
  /** Caller-created logical operation identity validated by the socket boundary. */
  outwardOperationId?: string;
  /** Session spawning requires the immutable requester route for announcements. */
  requireDeliveryOrigin?: boolean;
  dispatch: (params: Record<string, unknown>) => Promise<unknown>;
  logger?: Pick<ComisLogger, "warn">;
}

/**
 * Reconstruct the complete principal for a jailed `session.spawn` from the
 * validated, server-held lease. A formatted session cannot recover its channel
 * type, so the independently captured delivery origin is required and must
 * agree with the session's tenant/user ownership before entering ALS. Its
 * channel and thread remain an independent return route for child sessions.
 */
function resolveLeaseRequestPrincipal(
  lease: LeaseInfo,
  requireDeliveryOrigin = false,
): Result<LeaseRequestPrincipal, Error> {
  const sessionKey = parseFormattedSessionKey(lease.sessionKey);
  const deliveryOrigin = lease.deliveryOrigin;
  if (
    sessionKey === undefined
    || (requireDeliveryOrigin && deliveryOrigin === undefined)
    || (deliveryOrigin !== undefined && (
      deliveryOrigin.tenantId !== sessionKey.tenantId
      || deliveryOrigin.userId !== sessionKey.userId
    ))
  ) {
    return err(new Error("capability lease principal invalid"));
  }

  const context = createResolvedRequestContext({
    tenantId: sessionKey.tenantId,
    userId: sessionKey.userId,
    sessionKey: { ...sessionKey, agentId: lease.agentId },
    agentId: lease.agentId,
    traceId: randomUUID(),
    startedAt: systemNowMs(),
    trustLevel: lease.trustLevel,
    ...(deliveryOrigin !== undefined
      ? { channelType: deliveryOrigin.channelType, deliveryOrigin }
      : {}),
  });
  if (!context.ok) {
    return err(new Error("capability lease principal invalid"));
  }

  return ok({
    context: context.value,
    callerSessionKey: lease.sessionKey,
    ...(deliveryOrigin !== undefined
      ? {
          callerChannelType: deliveryOrigin.channelType,
          callerChannelId: deliveryOrigin.channelId,
          deliveryTarget: {
            channelId: deliveryOrigin.channelId,
            userId: deliveryOrigin.userId,
            tenantId: deliveryOrigin.tenantId,
            channelType: deliveryOrigin.channelType,
          },
        }
      : {}),
  });
}

/**
 * Run any lease-authorized operation inside the same locked principal that an
 * inbound framework request would carry.
 */
export async function runWithValidatedLeaseContext<T>(
  lease: LeaseInfo,
  operation: () => Promise<T>,
  logger?: Pick<ComisLogger, "warn">,
): Promise<T> {
  const principal = resolveLeaseRequestPrincipal(lease);
  if (!principal.ok) {
    logger?.warn(
      {
        errorKind: "auth" as const,
        hint: "Reject the jailed call and verify the lease was minted from a resolved request session and matching delivery origin",
      },
      "Capability lease principal rejected",
    );
    throw principal.error;
  }
  return runWithContext(principal.value.context, operation);
}

/**
 * Strip attacker-controlled internal fields, inject only validated lease facts,
 * and dispatch inside the reconstructed request principal.
 */
export async function dispatchValidatedLeaseRpc(
  deps: DispatchValidatedLeaseRpcDeps,
): Promise<unknown> {
  const principal = resolveLeaseRequestPrincipal(
    deps.lease,
    deps.requireDeliveryOrigin === true,
  );
  if (!principal.ok) {
    deps.logger?.warn(
      {
        errorKind: "auth" as const,
        hint: "Reject the jailed RPC and verify the lease was minted from a resolved request session and matching delivery origin",
      },
      "Capability lease RPC principal rejected",
    );
    throw principal.error;
  }

  const lease = deps.lease;
  const trustedParams = {
    ...stripInternalFields(deps.params),
    ...deps.trustedPublicParams,
    _agentId: lease.agentId,
    _capabilities: lease.caps,
    _rootRunId: lease.rootRunId,
    _leaseId: lease.leaseId,
    _trustLevel: lease.trustLevel,
    _tenantId: principal.value.context.tenantId,
    _userId: principal.value.context.userId,
    _sessionKey: lease.sessionKey,
    _callerSessionKey: principal.value.callerSessionKey,
    ...(lease.parentLeaseId !== undefined ? { _parentLeaseId: lease.parentLeaseId } : {}),
    ...(lease.checkpointId !== undefined ? { _checkpointId: lease.checkpointId } : {}),
    ...(principal.value.callerChannelType !== undefined
      ? { _callerChannelType: principal.value.callerChannelType }
      : {}),
    ...(principal.value.callerChannelId !== undefined
      ? { _callerChannelId: principal.value.callerChannelId }
      : {}),
    ...(principal.value.deliveryTarget !== undefined
      ? { _deliveryTarget: principal.value.deliveryTarget }
      : {}),
    ...(deps.outwardStepIndex !== undefined
      ? { _outwardStepIndex: deps.outwardStepIndex }
      : {}),
    ...(deps.outwardOperationId !== undefined
      ? { _outwardOperationId: deps.outwardOperationId }
      : {}),
  };
  return runWithContext(principal.value.context, () => deps.dispatch(trustedParams));
}
