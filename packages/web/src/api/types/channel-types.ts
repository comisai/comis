/**
 * Channel domain types.
 *
 * Interfaces for channel health state, connection info, observability
 * entries, and activity data used across channel views and components.
 */

/** Channel health state from the 8-state health machine */
export type ChannelHealthState =
  | "healthy"
  | "idle"
  | "stale"
  | "stuck"
  | "startup-grace"
  | "disconnected"
  | "errored"
  | "unknown";

/** Channel connection status returned by daemon */
export interface ChannelInfo {
  readonly type: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly status: ChannelHealthState;
  readonly uptime?: number;
  readonly connectionMode?: "socket" | "polling" | "webhook";
  readonly lastMessageAt?: number;
  readonly lastError?: string | null;
  readonly lastCheckedAt?: number;
  readonly startedAt?: number;
  readonly restartCount?: number;
  readonly maxRestartsPerHour?: number;
}

/** Extended channel info with observability metrics from daemon */
export interface ChannelDetailInfo extends ChannelInfo {
  readonly uptime: number;         // seconds since channel connected
  readonly messageCount: number;   // total messages processed
  readonly lastActivity: number;   // epoch ms of last message
  readonly botName?: string;       // platform-specific bot identifier (e.g. @bot_name)
}

/** Raw entry from obs.channels.all RPC response */
export interface ChannelObsEntry {
  readonly channelId: string;
  readonly channelType: string;
  readonly lastActiveAt: number;     // epoch ms
  readonly messagesSent: number;
  readonly messagesReceived: number;
}

/** Response shape from obs.channels.all RPC call */
export interface ChannelObsResponse {
  readonly channels: ChannelObsEntry[];
}

/** Response shape from obs.channels.stale RPC call */
export interface ChannelStaleResponse {
  readonly channels: ChannelObsEntry[];
}

/** Channel activity entry from obs.channels.all / obs.channels.get */
export interface ChannelActivity {
  readonly channelType: string;
  readonly channelId: string;
  readonly messagesSent: number;
  readonly messagesReceived: number;
  readonly lastActiveAt: number;
  readonly isStale: boolean;
}

/** Delivery queue status for a channel -- matches backend delivery.queue.status RPC response */
export interface DeliveryQueueStatus {
  readonly pending: number;
  readonly inFlight: number;
  readonly failed: number;
  readonly delivered: number;
  readonly expired: number;
}

/** Message returned by message.fetch RPC -- matches backend FetchedMessage from ChannelPort. */
export interface FetchedMessage {
  readonly id: string;
  readonly senderId: string;
  readonly text: string;
  readonly timestamp: number;
}

/** Platform capabilities for a channel type -- matches backend ChannelFeaturesSchema */
export interface PlatformCapabilities {
  readonly reactions: boolean;
  readonly editMessages: boolean;
  readonly deleteMessages: boolean;
  readonly fetchHistory: boolean;
  readonly attachments: boolean;
  readonly threads: boolean;
  readonly mentions: boolean;
  readonly formatting: readonly string[];
  readonly buttons: boolean;
  readonly cards: boolean;
  readonly effects: boolean;
}
