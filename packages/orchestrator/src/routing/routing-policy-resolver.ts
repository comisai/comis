// SPDX-License-Identifier: Apache-2.0
import {
  ResolvedTurnScopeSchema,
  type ChannelEndpoint,
  type DmScopeConfig,
  type PrincipalScope,
  type ResolvedTurnScope,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";

export type DmScopeMode = DmScopeConfig["mode"];

export interface RoutingPolicyInput {
  tenantId: string;
  agentId: string;
  endpoint: ChannelEndpoint;
  principal: PrincipalScope;
  dmScopeMode: DmScopeMode;
}

export class RoutingPolicyError extends Error {
  readonly errorKind = "validation" as const;
}

export function resolveRoutingPolicy(
  input: RoutingPolicyInput,
): Result<ResolvedTurnScope, RoutingPolicyError> {
  const { tenantId, agentId, endpoint, principal, dmScopeMode } = input;
  if (!tenantId || !agentId) return err(new RoutingPolicyError("Routing policy requires tenant and agent identity"));

  let partition: ResolvedTurnScope["conversation"]["partition"];
  if (endpoint.conversationKind === "shared") {
    partition = { kind: "endpoint-conversation", endpoint };
  } else {
    switch (dmScopeMode) {
      case "main":
        partition = { kind: "agent" };
        break;
      case "per-peer":
        partition = { kind: "principal", principalId: principal.principalId };
        break;
      case "per-channel-peer":
        partition = {
          kind: "channel-principal",
          channelType: endpoint.channelType,
          principalId: principal.principalId,
        };
        break;
      case "per-account-channel-peer":
        partition = {
          kind: "endpoint-conversation-principal",
          endpoint,
          principalId: principal.principalId,
        };
        break;
      default: {
        const _exhaustive: never = dmScopeMode;
        return err(new RoutingPolicyError(`Unsupported direct-message scope mode: ${String(_exhaustive)}`));
      }
    }
  }

  const parsed = ResolvedTurnScopeSchema.safeParse({
    conversation: { tenantId, agentId, partition },
    principal,
    endpoint,
  });
  return parsed.success
    ? ok(parsed.data)
    : err(new RoutingPolicyError("Routing policy produced an invalid resolved turn scope"));
}
