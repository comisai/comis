// SPDX-License-Identifier: Apache-2.0
/** Public graph-coordinator request and lifecycle contracts. */

import type {
  AgentCapability,
  DeliveryOrigin,
  DurableRunRecord,
  GraphStatus,
  ResolvedTurnScope,
} from "@comis/core";
import type { Result } from "@comis/shared";
import type { GraphExecutionSnapshot } from "./graph-state-machine.js";

export interface GraphRunParams {
  graph: import("@comis/core").ValidatedGraph;
  callerSessionKey?: string;
  callerAgentId?: string;
  /** Canonical caller authority injected by the trusted RPC boundary. */
  callerTurnScope?: ResolvedTurnScope;
  /** Authenticated capability ceiling supplied by the RPC boundary. */
  callerCaps?: readonly AgentCapability[];
  /** Authenticated lease authorizing this graph submission. */
  callerLeaseId?: string;
  /** Authenticated tree root supplied by the RPC boundary. */
  callerRootRunId?: string;
  /** Authenticated delivery origin supplied by the RPC boundary. */
  callerDeliveryOrigin?: DeliveryOrigin;
  announceChannelType?: string;
  announceChannelId?: string;
  /** Send per-node completion progress messages to the channel. */
  nodeProgress?: boolean;
}

export interface GraphRunSummary {
  graphId: string;
  label?: string;
  status: GraphStatus;
  startedAt: number;
  completedAt?: number;
}

export interface GraphCoordinator {
  run(params: GraphRunParams): Promise<Result<string, string>>;
  getStatus(graphId: string): GraphExecutionSnapshot | undefined;
  cancel(graphId: string): boolean;
  listGraphs(recentMinutes?: number): GraphRunSummary[];
  shutdown(): Promise<void>;
  getConcurrencyStats(): {
    globalActiveSubAgents: number;
    maxGlobalSubAgents: number;
    queueDepth: number;
  };
  notifyNodeFailed(graphId: string, nodeId: string, runId: string, error: string): void;
  resumeGraph(
    record: DurableRunRecord,
    authority?: { leaseId: string; bearer: string },
  ): Promise<Result<void, Error>>;
}
