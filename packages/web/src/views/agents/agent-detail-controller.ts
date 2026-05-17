// SPDX-License-Identifier: Apache-2.0
/**
 * Agent detail controller (Phase 44 / WEB-DECOMP-01 / Wave 6 / Task 1).
 *
 * Thin RPC façade — the agent-detail view retains @state for the
 * agent / billing / skills / heartbeat snapshots, the loadState +
 * error string, the action-pending flag, and the delete-confirm
 * dialog open flag because the existing two-column render +
 * SseController-driven debounced reload + ic-confirm-dialog
 * lifecycle all keep state on the view. The controller's job is
 * to keep `rpcClient.call(...)` out of `agent-detail.ts` so the
 * WEB-DECOMP-03 boundary test passes.
 *
 * Controller cap is 700L (tighter than the default 900) per
 * PATTERNS.md §S1 line 104 — agent-detail is a detail view with
 * a small RPC surface (5 methods spanning 6 call sites).
 *
 * @module
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../../api/rpc-client.js";
import type {
  AgentBilling,
  HeartbeatAgentStateDto,
} from "../../api/types/index.js";

/* ------------------------------------------------------------------ */
/*  RPC response shapes                                                */
/* ------------------------------------------------------------------ */

/** Raw daemon response from agents.get RPC — view's _mapToAgentDetail()
 *  maps this to the AgentDetail shape used by templates. */
export interface AgentGetRaw {
  agentId: string;
  config: Record<string, unknown>;
  suspended?: boolean;
}

/** Skill description returned by the skills.list RPC. */
export interface DiscoveredSkill {
  name: string;
  description: string;
  location: string;
  source?: "bundled" | "workspace" | "local";
  disableModelInvocation?: boolean;
}

export interface SkillsListResult {
  skills?: DiscoveredSkill[];
}

export interface HeartbeatStatesResult {
  agents?: HeartbeatAgentStateDto[];
}

/* ------------------------------------------------------------------ */
/*  Controller interface                                               */
/* ------------------------------------------------------------------ */

export interface AgentDetailController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** Fetch the agent record (agents.get). The view's
   *  _mapToAgentDetail() reshapes the raw payload. */
  getAgent(agentId: string): Promise<AgentGetRaw>;
  /** Fetch per-agent billing snapshot (obs.billing.byAgent). */
  getAgentBilling(agentId: string): Promise<AgentBilling>;
  /** List skills attached to the agent (skills.list). */
  listSkills(agentId: string): Promise<SkillsListResult>;
  /** Snapshot of heartbeat states for all agents
   *  (heartbeat.states) — the view filters by agentId. */
  getHeartbeatStates(): Promise<HeartbeatStatesResult>;
  /** Suspend the agent (agents.suspend). */
  suspendAgent(agentId: string): Promise<void>;
  /** Resume a suspended agent (agents.resume). */
  resumeAgent(agentId: string): Promise<void>;
  /** Delete the agent (agents.delete). */
  deleteAgent(agentId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createAgentDetailController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): AgentDetailController {
  const controller: AgentDetailController = {
    hostConnected(): void {
      /* no-op; the view drives loading via its own lifecycle */
    },
    hostDisconnected(): void {
      /* no-op; the view manages its own SSE / debounce teardown */
    },

    getAgent(agentId: string): Promise<AgentGetRaw> {
      return rpcClient.call<AgentGetRaw>("agents.get", { agentId });
    },

    getAgentBilling(agentId: string): Promise<AgentBilling> {
      return rpcClient.call<AgentBilling>("obs.billing.byAgent", { agentId });
    },

    listSkills(agentId: string): Promise<SkillsListResult> {
      return rpcClient.call<SkillsListResult>("skills.list", { agentId });
    },

    getHeartbeatStates(): Promise<HeartbeatStatesResult> {
      return rpcClient.call<HeartbeatStatesResult>("heartbeat.states", {});
    },

    async suspendAgent(agentId: string): Promise<void> {
      await rpcClient.call("agents.suspend", { agentId });
    },

    async resumeAgent(agentId: string): Promise<void> {
      await rpcClient.call("agents.resume", { agentId });
    },

    async deleteAgent(agentId: string): Promise<void> {
      await rpcClient.call("agents.delete", { agentId });
    },
  };

  host.addController(controller);
  return controller;
}
