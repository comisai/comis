/**
 * Session domain types.
 *
 * Interfaces for session info, search results, and message
 * data from the session management RPC endpoints.
 */

/** Session info from session.status RPC */
export interface SessionInfo {
  readonly key: string;
  readonly agentId: string;
  readonly channelType: string;
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

/** Session content search result from session.search RPC */
export interface SessionSearchResult {
  readonly sessionKey: string;
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
