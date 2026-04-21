// SPDX-License-Identifier: Apache-2.0
/**
 * Lit ReactiveController for periodic RPC polling.
 *
 * Fetches agent, channel, and session counts via JSON-RPC at a
 * configurable interval. Designed for sidebar badge count display.
 *
 * Polling failures are non-fatal -- badges show stale data until
 * the next successful poll. No errors are thrown.
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../api/rpc-client.js";

/** Badge count data returned by polling. */
export interface BadgeCounts {
  agents: number;
  channels: number;
  sessions: number;
  /** Raw agent IDs for command palette search. */
  agentIds: string[];
  /** Raw session entries for command palette search. */
  sessionEntries: Array<{ sessionKey: string; agentId: string }>;
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
    this._poll();
    this._timer = setInterval(() => this._poll(), this._intervalMs);
  }

  hostDisconnected(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  private async _poll(): Promise<void> {
    try {
      const [agentResult, channelResult, sessionResult] = await Promise.all([
        this._rpcClient.call<{ agents: string[] }>("agent.list"),
        this._rpcClient.call<{ channels: unknown[] }>("channel.list"),
        this._rpcClient.call<{ sessions: Array<{ sessionKey: string; agentId: string }>; total: number }>("session.list", {}),
      ]);

      this._onData({
        agents: agentResult.agents.length,
        channels: channelResult.channels.length,
        sessions: sessionResult.total,
        agentIds: agentResult.agents,
        sessionEntries: sessionResult.sessions?.slice(0, 20) ?? [],
      });
      this._host.requestUpdate();
    } catch {
      // Polling failure is non-fatal -- badge shows stale data
    }
  }
}
