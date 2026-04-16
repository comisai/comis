/**
 * Channel resolver for proactive notifications with 4-level fallback.
 * Resolution order:
 *   1. Explicit channelType + channelId (caller-specified)
 *   2. Platform match (channelType only, look up channelId from recent sessions)
 *   3. Primary channel (from agent notification config)
 *   4. Most recent session (across all platforms)
 * Returns a Result with the resolved channel or a "no_channel" error
 * listing which levels were attempted.
 */
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";

export interface ResolvedChannel {
  channelType: string;
  channelId: string;
  resolution: "explicit" | "platform_match" | "primary_channel" | "recent_session";
}

export interface ChannelResolverDeps {
  /** Set of active adapter channel types (e.g., "telegram", "discord"). */
  activeAdapterTypes: ReadonlySet<string>;
  /** Lookup most recent session for agent on a specific platform. Returns channelId or undefined. */
  getRecentSessionChannel: (agentId: string, channelType: string) => string | undefined;
  /** Lookup most recent session for agent across all platforms. Returns {channelType, channelId} or undefined. */
  getMostRecentSession: (agentId: string) => { channelType: string; channelId: string } | undefined;
}

export interface ResolveChannelOpts {
  agentId: string;
  channelType?: string;
  channelId?: string;
  primaryChannel?: { channelType: string; channelId: string };
}

export function resolveNotificationChannel(
  deps: ChannelResolverDeps,
  opts: ResolveChannelOpts,
): Result<ResolvedChannel, { reason: "no_channel"; attempted: string[] }> {
  const attempted: string[] = [];

  // Level 1: Explicit channel
  if (opts.channelType && opts.channelId) {
    return ok({ channelType: opts.channelType, channelId: opts.channelId, resolution: "explicit" });
  }
  attempted.push("explicit");

  // Level 2: Platform match (channelType provided, look up channelId from sessions)
  if (opts.channelType && deps.activeAdapterTypes.has(opts.channelType)) {
    const channelId = deps.getRecentSessionChannel(opts.agentId, opts.channelType);
    if (channelId) {
      return ok({ channelType: opts.channelType, channelId, resolution: "platform_match" });
    }
  }
  attempted.push("platform_match");

  // Level 3: Primary channel from config
  if (opts.primaryChannel) {
    return ok({
      channelType: opts.primaryChannel.channelType,
      channelId: opts.primaryChannel.channelId,
      resolution: "primary_channel",
    });
  }
  attempted.push("primary_channel");

  // Level 4: Most recent session
  const recent = deps.getMostRecentSession(opts.agentId);
  if (recent) {
    return ok({ channelType: recent.channelType, channelId: recent.channelId, resolution: "recent_session" });
  }
  attempted.push("recent_session");

  return err({ reason: "no_channel" as const, attempted });
}
