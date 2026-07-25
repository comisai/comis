// SPDX-License-Identifier: Apache-2.0
/**
 * Channel resolver for proactive notifications with 4-level fallback.
 * Resolution order:
 *   1. Explicit complete endpoint, or coordinates backed by a tracked endpoint
 *   2. Platform match backed by the most recent endpoint on that platform
 *   3. Configured primary channel backed by a tracked endpoint
 *   4. Most recent tracked endpoint across all platforms
 * Returns a Result with the resolved channel or a "no_channel" error
 * listing which levels were attempted.
 */
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import type { ChannelEndpoint } from "@comis/core";

export interface ResolvedChannel {
  channelType: string;
  channelId: string;
  endpoint: ChannelEndpoint;
  resolution: "explicit" | "platform_match" | "primary_channel" | "recent_session";
}

export interface ChannelResolverDeps {
  /** Set of active adapter channel types (e.g., "telegram", "discord"). */
  activeAdapterTypes: Pick<ReadonlySet<string>, "has">;
  getRecentSessionEndpoint: (
    agentId: string,
    channelType: string,
  ) => ChannelEndpoint | undefined;
  getMostRecentSessionEndpoint: (agentId: string) => ChannelEndpoint | undefined;
  findSessionEndpoint: (
    agentId: string,
    channelType: string,
    conversationId: string,
  ) => ChannelEndpoint | undefined;
}

export interface ResolveChannelOpts {
  agentId: string;
  channelType?: string;
  channelId?: string;
  destinationEndpoint?: ChannelEndpoint;
  primaryChannel?: { channelType: string; channelId: string };
}

function endpointsEqual(left: ChannelEndpoint, right: ChannelEndpoint): boolean {
  return left.channelType === right.channelType
    && left.channelInstanceId === right.channelInstanceId
    && left.conversationId === right.conversationId
    && left.threadId === right.threadId
    && left.conversationKind === right.conversationKind;
}

export function resolveNotificationChannel(
  deps: ChannelResolverDeps,
  opts: ResolveChannelOpts,
): Result<ResolvedChannel, { reason: "no_channel"; attempted: string[] }> {
  const attempted: string[] = [];

  if (opts.destinationEndpoint !== undefined) {
    const claimedEndpoint = opts.destinationEndpoint;
    const endpoint = deps.findSessionEndpoint(
      opts.agentId,
      claimedEndpoint.channelType,
      claimedEndpoint.conversationId,
    );
    if (
      endpoint === undefined
      || !endpointsEqual(endpoint, claimedEndpoint)
      || !deps.activeAdapterTypes.has(endpoint.channelType)
      || (opts.channelType !== undefined && opts.channelType !== endpoint.channelType)
      || (opts.channelId !== undefined && opts.channelId !== endpoint.conversationId)
    ) {
      return err({ reason: "no_channel" as const, attempted: ["destination_endpoint"] });
    }
    return ok({
      channelType: endpoint.channelType,
      channelId: endpoint.conversationId,
      endpoint,
      resolution: "explicit",
    });
  }

  if (opts.channelType && opts.channelId) {
    const endpoint = deps.findSessionEndpoint(opts.agentId, opts.channelType, opts.channelId);
    if (endpoint && deps.activeAdapterTypes.has(endpoint.channelType)) {
      return ok({
        channelType: endpoint.channelType,
        channelId: endpoint.conversationId,
        endpoint,
        resolution: "explicit",
      });
    }
    return err({ reason: "no_channel" as const, attempted: ["explicit_endpoint"] });
  }
  attempted.push("explicit");

  if (opts.channelType && deps.activeAdapterTypes.has(opts.channelType)) {
    const endpoint = deps.getRecentSessionEndpoint(opts.agentId, opts.channelType);
    if (endpoint) {
      return ok({
        channelType: endpoint.channelType,
        channelId: endpoint.conversationId,
        endpoint,
        resolution: "platform_match",
      });
    }
  }
  attempted.push("platform_match");

  if (opts.primaryChannel) {
    const endpoint = deps.findSessionEndpoint(
      opts.agentId,
      opts.primaryChannel.channelType,
      opts.primaryChannel.channelId,
    );
    if (endpoint && deps.activeAdapterTypes.has(endpoint.channelType)) {
      return ok({
        channelType: endpoint.channelType,
        channelId: endpoint.conversationId,
        endpoint,
        resolution: "primary_channel",
      });
    }
  }
  attempted.push("primary_channel");

  const recent = deps.getMostRecentSessionEndpoint(opts.agentId);
  if (recent && deps.activeAdapterTypes.has(recent.channelType)) {
    return ok({
      channelType: recent.channelType,
      channelId: recent.conversationId,
      endpoint: recent,
      resolution: "recent_session",
    });
  }
  attempted.push("recent_session");

  return err({ reason: "no_channel" as const, attempted });
}
