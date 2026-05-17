// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduler controller.
 *
 * Thin RPC façade — the scheduler view retains @state for jobs / heartbeat /
 * editor / SSE-driven execution feed because the view's existing test suite
 * relies on direct state assertions and DOM-driven editor flow with the
 * ic-cron-editor sub-component. The controller's job is to keep
 * `rpcClient.call(...)` out of `scheduler.ts`. Each method mirrors a source
 * view RPC invocation 1:1 (same method name, same args, same response
 * shape). Errors propagate verbatim (callers handle).
 *
 * The view continues to access `rpcClient.onStatusChange(...)` directly for
 * reconnect-triggered reloads — the boundary regex only matches `.call(...)`,
 * not status subscriptions.
 *
 * The embedded `ic-cron-editor` sub-component's @property bindings remain on
 * the view verbatim.
 *
 * @module
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../api/rpc-client.js";

/* ------------------------------------------------------------------ */
/*  RPC response shapes                                                */
/* ------------------------------------------------------------------ */

export interface CronListResult {
  jobs?: unknown[];
}

export type CronListResponse = CronListResult | unknown[];

export interface CronStatusResult {
  running: boolean;
  jobCount: number;
}

export interface HeartbeatStatesResult {
  agents?: unknown[];
}

export interface CronAddResult {
  jobId: string;
}

/* ------------------------------------------------------------------ */
/*  Controller interface                                               */
/* ------------------------------------------------------------------ */

export interface SchedulerController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** List cron jobs (cron.list); response shape varies by daemon version. */
  listJobs(agentId?: string): Promise<CronListResponse>;
  /** Read a config section (config.read). */
  readConfig(section: string): Promise<Record<string, unknown>>;
  /** Get cron runtime status for an agent (cron.status). */
  getStatus(agentId: string): Promise<CronStatusResult>;
  /** Get heartbeat states for all agents (heartbeat.states). */
  getHeartbeatStates(): Promise<HeartbeatStatesResult>;
  /** Add a new cron job (cron.add). */
  addJob(agentId: string, jobInput: Record<string, unknown>): Promise<CronAddResult>;
  /** Update an existing cron job (cron.update). */
  updateJob(jobId: string, agentId: string, jobInput: Record<string, unknown>): Promise<void>;
  /** Remove a cron job (cron.remove). */
  removeJob(jobId: string, agentId: string): Promise<void>;
  /** Set a single config key (config.set). */
  setConfig(section: string, path: string, value: unknown): Promise<void>;
  /** Manually trigger a cron job (cron.run). */
  runJob(jobName: string, agentId: string): Promise<void>;
  /** Manually trigger an agent's heartbeat (heartbeat.trigger). */
  triggerHeartbeat(agentId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createSchedulerController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): SchedulerController {
  const controller: SchedulerController = {
    hostConnected(): void {
      /* no-op; the view drives loading via its own lifecycle */
    },
    hostDisconnected(): void {
      /* no-op; the view manages its own listeners */
    },

    listJobs(agentId?: string): Promise<CronListResponse> {
      return rpcClient.call<CronListResponse>("cron.list", {
        _agentId: agentId || undefined,
      });
    },

    readConfig(section: string): Promise<Record<string, unknown>> {
      return rpcClient.call<Record<string, unknown>>("config.read", { section });
    },

    getStatus(agentId: string): Promise<CronStatusResult> {
      return rpcClient.call<CronStatusResult>("cron.status", {
        _agentId: agentId || undefined,
      });
    },

    getHeartbeatStates(): Promise<HeartbeatStatesResult> {
      return rpcClient.call<HeartbeatStatesResult>("heartbeat.states", {});
    },

    addJob(
      agentId: string,
      jobInput: Record<string, unknown>,
    ): Promise<CronAddResult> {
      return rpcClient.call<CronAddResult>("cron.add", {
        ...jobInput,
        _agentId: agentId || undefined,
        _deliveryTarget: jobInput.deliveryTarget,
      });
    },

    async updateJob(
      jobId: string,
      agentId: string,
      jobInput: Record<string, unknown>,
    ): Promise<void> {
      // Spread jobInput FIRST so the positional jobId / _agentId arguments
      // win over any same-named keys an upstream caller may have included
      // in jobInput (defensive sanitization -- matches addJob's order).
      await rpcClient.call("cron.update", {
        ...jobInput,
        jobId,
        _agentId: agentId || undefined,
      });
    },

    async removeJob(jobId: string, agentId: string): Promise<void> {
      await rpcClient.call("cron.remove", {
        jobId,
        _agentId: agentId || undefined,
      });
    },

    async setConfig(section: string, path: string, value: unknown): Promise<void> {
      await rpcClient.call("config.set", { section, path, value });
    },

    async runJob(jobName: string, agentId: string): Promise<void> {
      await rpcClient.call("cron.run", {
        jobName,
        _agentId: agentId || undefined,
      });
    },

    async triggerHeartbeat(agentId: string): Promise<void> {
      await rpcClient.call("heartbeat.trigger", { agentId: agentId || undefined });
    },
  };

  host.addController(controller);
  return controller;
}
