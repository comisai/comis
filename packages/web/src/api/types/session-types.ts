// SPDX-License-Identifier: Apache-2.0
/**
 * Session domain types.
 *
 * Interfaces for session info, search results, and message
 * data from the session management RPC endpoints.
 */

import type { WebRpcMethodMap } from "../contracts.generated.js";

export type SessionChannelEndpoint = NonNullable<
  WebRpcMethodMap["session.list"]["result"]["sessions"][number]["endpoint"]
>;

/** Session info from session.status RPC */
export interface SessionInfo {
  readonly key: string;
  readonly agentId: string;
  readonly channelType: string;
  readonly endpoint?: SessionChannelEndpoint;
  readonly messageCount: number;
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: number;
  readonly compactions: number;
  readonly resetCount: number;
  readonly createdAt: number;
  readonly lastActiveAt: number;
  readonly label?: string;
}

/**
 * Narrow row type for the `session.list` RPC response.
 *
 * Distinct from `SessionInfo`, which covers the richer `session.status` and
 * `session.history` response shapes.
 */
export interface SessionListItem {
  readonly conversationRef: string;
  readonly agentId: string;
  readonly kind: string;
  readonly endpoint?: SessionChannelEndpoint;
  readonly messageCount: number;
  readonly totalTokens: number;
  readonly updatedAt: number;
  readonly createdAt: number;
}

/** Session content search result from session.search RPC */
export interface SessionSearchResult {
  readonly conversationRef: string;
  readonly agentId: string;
  readonly channelType: string;
  readonly snippet: string;
  readonly score: number;
  readonly timestamp: number;
}

/** Session message from session.history RPC */
export interface SessionMessage {
  readonly role: "user" | "assistant" | "system" | "tool";
  readonly content: string;
  readonly timestamp: number;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly tokenCount?: number;
}
