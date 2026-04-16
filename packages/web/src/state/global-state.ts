/**
 * Reactive global application state for the Comis web console.
 *
 * Provides a framework-agnostic reactive state store with subscribe/getSnapshot/update
 * pattern compatible with React's useSyncExternalStore and Lit's reactive controllers.
 *
 * No external dependencies. Pure JavaScript reactive pattern.
 */

import type { ConnectionStatus, AgentInfo, ChannelInfo, SystemHealth } from "../api/types/index.js";

/** Snapshot of the full global state (immutable) */
export interface GlobalStateSnapshot {
  readonly connectionStatus: ConnectionStatus;
  readonly pendingApprovals: number;
  readonly errorCount: number;
  readonly agentCount: number;
  readonly channelCount: number;
  readonly sessionCount: number;
  readonly systemHealth: SystemHealth | null;
  readonly activeAgents: AgentInfo[];
  readonly activeChannels: ChannelInfo[];
}

/**
 * Reactive global state interface.
 *
 * Tracks connection status, pending approvals, system health,
 * active agents, and active channels. Any consumer can subscribe
 * to state changes and receive notification on updates.
 */
export interface GlobalState {
  /** Current connection status */
  readonly connectionStatus: ConnectionStatus;
  /** Number of pending approval requests */
  readonly pendingApprovals: number;
  /** Count of errors observed */
  readonly errorCount: number;
  /** Number of active agents (polling-driven badge count) */
  readonly agentCount: number;
  /** Number of active channels (polling-driven badge count) */
  readonly channelCount: number;
  /** Number of active sessions (polling-driven badge count) */
  readonly sessionCount: number;
  /** System health metrics (null until first fetch) */
  readonly systemHealth: SystemHealth | null;
  /** Currently active agents */
  readonly activeAgents: AgentInfo[];
  /** Currently active channels */
  readonly activeChannels: ChannelInfo[];
  /** Subscribe to any state change. Returns an unsubscribe function. */
  subscribe(handler: () => void): () => void;
  /** Return a frozen snapshot of the current state. */
  getSnapshot(): GlobalStateSnapshot;
  /** Merge partial state into current state and notify all subscribers. */
  update(partial: Partial<GlobalStateSnapshot>): void;
}

/**
 * Create a reactive global state store.
 *
 * @returns A GlobalState instance with default values
 */
export function createGlobalState(): GlobalState {
  const state: GlobalStateSnapshot = {
    connectionStatus: "disconnected",
    pendingApprovals: 0,
    errorCount: 0,
    agentCount: 0,
    channelCount: 0,
    sessionCount: 0,
    systemHealth: null,
    activeAgents: [],
    activeChannels: [],
  };

  // Mutable copy for internal updates
  let current: GlobalStateSnapshot = { ...state };

  const subscribers = new Set<() => void>();

  function notifyAll(): void {
    for (const handler of subscribers) {
      handler();
    }
  }

  return {
    get connectionStatus(): ConnectionStatus {
      return current.connectionStatus;
    },
    get pendingApprovals(): number {
      return current.pendingApprovals;
    },
    get errorCount(): number {
      return current.errorCount;
    },
    get agentCount(): number {
      return current.agentCount;
    },
    get channelCount(): number {
      return current.channelCount;
    },
    get sessionCount(): number {
      return current.sessionCount;
    },
    get systemHealth(): SystemHealth | null {
      return current.systemHealth;
    },
    get activeAgents(): AgentInfo[] {
      return current.activeAgents;
    },
    get activeChannels(): ChannelInfo[] {
      return current.activeChannels;
    },

    subscribe(handler: () => void): () => void {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },

    getSnapshot(): GlobalStateSnapshot {
      return Object.freeze({ ...current });
    },

    update(partial: Partial<GlobalStateSnapshot>): void {
      current = { ...current, ...partial };
      notifyAll();
    },
  };
}
