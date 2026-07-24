// SPDX-License-Identifier: Apache-2.0
/**
 * Lit ReactiveController for periodic RPC polling.
 *
 * Fetches agent, channel, and session counts via JSON-RPC at a
 * configurable interval. Designed for sidebar badge count display.
 *
 * Polling failures are non-fatal -- badges show stale data until the next
 * successful poll, while `lastError` exposes the failure to the host UI.
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../api/rpc-client.js";
import { systemClearInterval, systemSetInterval } from "@comis/core";
import { listSessionsAcrossAgents } from "../api/session-scope.js";

/** Badge count data returned by polling. */
export interface BadgeCounts {
  agents: number;
  channels: number;
  sessions: number;
  /** Raw agent IDs for command palette search. */
  agentIds: string[];
  /** Raw session entries for command palette search. */
  sessionEntries: Array<{ conversationRef: string; agentId: string }>;
}

/**
 * ReactiveController that polls the daemon for badge counts
 * on a regular interval.
 *
 * Usage:
 * ```ts
 * new PollingController(this, rpcClient, (counts) => {
 *   this.agentCount = counts.agents;
 *   this.channelCount = counts.channels;
 *   this.sessionCount = counts.sessions;
 * });
 * ```
 */
export class PollingController implements ReactiveController {
  private readonly _host: ReactiveControllerHost;
  private readonly _rpcClient: RpcClient;
  private readonly _onData: (data: BadgeCounts) => void;
  private readonly _intervalMs: number;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _lastError: Error | null = null;

  /** Most recent polling failure, cleared after a successful poll. */
  get lastError(): Error | null {
    return this._lastError;
  }

  constructor(
    host: ReactiveControllerHost,
    rpcClient: RpcClient,
    onData: (data: BadgeCounts) => void,
    intervalMs = 30_000,
  ) {
    this._host = host;
    this._rpcClient = rpcClient;
    this._onData = onData;
    this._intervalMs = intervalMs;
    this._host.addController(this);
  }

  hostConnected(): void {
    if (this._timer !== null) return;
    this._poll();
    this._timer = systemSetInterval(() => this._poll(), this._intervalMs);
  }

  hostDisconnected(): void {
    if (this._timer !== null) {
      systemClearInterval(this._timer);
      this._timer = null;
    }
  }

  private async _poll(): Promise<void> {
    try {
      const [agentResult, channelResult, sessions] = await Promise.all([
        this._rpcClient.call("agents.list", {}),
        this._rpcClient.call("channels.list", {}),
        listSessionsAcrossAgents(this._rpcClient),
      ]);

      this._lastError = null;
      this._onData({
        agents: agentResult.agents.length,
        channels: channelResult.channels.length,
        sessions: sessions.length,
        agentIds: agentResult.agents,
        sessionEntries: sessions.slice(0, 20),
      });
      this._host.requestUpdate();
    } catch (cause) {
      this._lastError = cause instanceof Error ? cause : new Error(String(cause));
      this._host.requestUpdate();
    }
  }
}
