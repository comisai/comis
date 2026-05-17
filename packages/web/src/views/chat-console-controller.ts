// SPDX-License-Identifier: Apache-2.0
/**
 * Chat console controller (Phase 44 / WEB-DECOMP-01).
 *
 * Owns RPC orchestration for the chat console view. Unlike the
 * controller-as-snapshot-source pattern used by setup-wizard and skills,
 * the chat console controller is a thin RPC façade — the view still owns
 * its @state for messages/sessions/streaming because most state mutations
 * are driven by SSE notifications and DOM-coupled interactions (scroll,
 * focus, recording). The controller's job is to keep `rpcClient.call`
 * calls out of `chat-console.ts` so the boundary test passes.
 *
 * @module
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../api/rpc-client.js";
import type { ConnectionStatus } from "../api/types/common-types.js";

export interface SessionListEntry {
  sessionKey: string;
  agentId: string;
  channelId: string;
  kind: "dm" | "group" | "sub-agent";
  messageCount?: number;
  updatedAt: number;
}

export interface ChatHistoryMessage {
  id?: string;
  role: "user" | "assistant" | "error" | "system" | "tool";
  content: string;
  timestamp?: number;
  toolCalls?: unknown[];
}

export interface PipelineSnapshot {
  tokensLoaded?: number;
  tokensEvicted?: number;
  tokensMasked?: number;
  budgetUtilization?: number;
}

export interface ChatConsoleController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** Fetch the user's dm session list. */
  listSessions(): Promise<SessionListEntry[]>;
  /** Fetch chat history for a session. */
  loadSessionHistory(sessionKey: string): Promise<ChatHistoryMessage[]>;
  /** Fetch the most recent pipeline snapshot for an agent. */
  loadLatestPipelineSnapshot(agentId: string): Promise<PipelineSnapshot | null>;
  /** Transcribe audio (returns the transcription text). */
  transcribeAudio(base64: string, format: string): Promise<string>;
  /** Reset the current session (clears history daemon-side). */
  resetSession(sessionKey: string): Promise<void>;
  /** Export a session as JSONL data string. */
  exportSession(sessionKey: string): Promise<string>;
  /** Compact the current session context. */
  compactSession(sessionKey: string): Promise<void>;
  /** RPC client passthrough for notification subscriptions (view manages SSE wiring). */
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  /** Status of the underlying RPC client. */
  readonly status: ConnectionStatus;
  /** Subscribe to status changes (used by the view to gate initial load). */
  onStatusChange(handler: (status: ConnectionStatus) => void): () => void;
}

export function createChatConsoleController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): ChatConsoleController {
  const controller: ChatConsoleController = {
    hostConnected(): void { /* no-op; view drives loading via status check */ },
    hostDisconnected(): void { /* no-op; view manages its own listeners */ },

    async listSessions(): Promise<SessionListEntry[]> {
      const result = await rpcClient.call<{ sessions: SessionListEntry[] }>(
        "session.list",
        { kind: "dm" },
      );
      return result?.sessions ?? [];
    },

    async loadSessionHistory(sessionKey: string): Promise<ChatHistoryMessage[]> {
      const result = await rpcClient.call<{ messages: ChatHistoryMessage[] }>(
        "session.history",
        { session_key: sessionKey },
      );
      return result?.messages ?? [];
    },

    async loadLatestPipelineSnapshot(agentId: string): Promise<PipelineSnapshot | null> {
      const result = await rpcClient.call<{ snapshots: PipelineSnapshot[] }>(
        "obs.context.pipeline",
        { agentId, limit: 1 },
      );
      return result?.snapshots?.[0] ?? null;
    },

    async transcribeAudio(base64: string, format: string): Promise<string> {
      const result = await rpcClient.call<{ text: string }>(
        "audio.transcribe",
        { audio: base64, format },
      );
      return result?.text ?? "";
    },

    async resetSession(sessionKey: string): Promise<void> {
      await rpcClient.call("session.reset", { session_key: sessionKey });
    },

    async exportSession(sessionKey: string): Promise<string> {
      const result = await rpcClient.call<{ data: string }>(
        "session.export",
        { session_key: sessionKey },
      );
      return result?.data ?? "";
    },

    async compactSession(sessionKey: string): Promise<void> {
      await rpcClient.call("session.compact", { session_key: sessionKey });
    },

    onNotification(handler) {
      return rpcClient.onNotification(handler);
    },

    get status() {
      return rpcClient.status;
    },

    onStatusChange(handler) {
      return rpcClient.onStatusChange(handler);
    },
  };

  host.addController(controller);
  return controller;
}
