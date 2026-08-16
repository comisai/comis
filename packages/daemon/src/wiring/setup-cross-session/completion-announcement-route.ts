// SPDX-License-Identifier: Apache-2.0

import {
  ChannelEndpointSchema,
  ConversationLocatorSchema,
  type ChannelEndpoint,
} from "@comis/core";
import type { CompletionAnnouncementSendRequest } from "@comis/orchestrator";

type ConversationPartition = import("@comis/core").ConversationLocator["conversationScope"]["partition"];

interface AnnouncementAdapterIdentity {
  readonly channelId: string;
  readonly channelType: string;
}

export type CompletionAnnouncementRouteValidation =
  | {
      valid: true;
      callerConversation: import("@comis/core").ConversationLocator;
      destinationEndpoint: ChannelEndpoint;
    }
  | {
      valid: false;
      failure: "allocation_blocked" | "operation_validation_blocked";
    };

function endpointsEqual(left: ChannelEndpoint, right: ChannelEndpoint): boolean {
  return left.channelType === right.channelType
    && left.channelInstanceId === right.channelInstanceId
    && left.conversationId === right.conversationId
    && left.threadId === right.threadId
    && left.conversationKind === right.conversationKind;
}

function partitionMatchesEndpoint(
  partition: ConversationPartition,
  endpoint: ChannelEndpoint,
): boolean {
  switch (partition.kind) {
    case "agent":
    case "principal":
      return endpoint.conversationKind === "direct";
    case "channel-principal":
      return endpoint.conversationKind === "direct"
        && partition.channelType === endpoint.channelType;
    case "endpoint-conversation":
      return endpoint.conversationKind === "shared"
        && endpointsEqual(partition.endpoint, endpoint);
    case "endpoint-conversation-principal":
      return endpoint.conversationKind === "direct"
        && endpointsEqual(partition.endpoint, endpoint);
    default: {
      const _exhaustive: never = partition;
      return _exhaustive;
    }
  }
}

export function validateCompletionAnnouncementRoute(
  request: CompletionAnnouncementSendRequest,
  adapter: AnnouncementAdapterIdentity | undefined,
): CompletionAnnouncementRouteValidation {
  const parsedCaller = ConversationLocatorSchema.safeParse(request.callerConversation);
  const parsedEndpoint = ChannelEndpointSchema.safeParse(request.destinationEndpoint);
  if (!parsedCaller.success || !parsedEndpoint.success) {
    return { valid: false, failure: "allocation_blocked" };
  }
  const callerConversation = parsedCaller.data;
  const destinationEndpoint = parsedEndpoint.data;
  const callerScope = callerConversation.conversationScope;
  const callerPartition = callerScope.partition;
  const partitionChannelType = callerPartition.kind === "channel-principal"
    ? callerPartition.channelType
    : callerPartition.kind === "endpoint-conversation"
      || callerPartition.kind === "endpoint-conversation-principal"
      ? callerPartition.endpoint.channelType
      : undefined;
  if (
    callerScope.agentId !== request.agentId
    || !partitionMatchesEndpoint(callerPartition, destinationEndpoint)
    || (partitionChannelType !== undefined && partitionChannelType !== destinationEndpoint.channelType)
    || destinationEndpoint.channelType !== request.channelType
    || destinationEndpoint.conversationId !== request.channelId
    || destinationEndpoint.threadId !== request.options?.threadId
    || (request.attachment !== undefined
      && (
        adapter?.channelType !== destinationEndpoint.channelType
        || adapter.channelId !== destinationEndpoint.channelInstanceId
      ))
  ) {
    return { valid: false, failure: "operation_validation_blocked" };
  }
  return { valid: true, callerConversation, destinationEndpoint };
}
