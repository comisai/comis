// SPDX-License-Identifier: Apache-2.0
/**
 * Cron scheduling tool: multi-action tool for managing scheduled jobs.
 *
 * Supports 8 actions: add, list, update, remove, status, runs, run, wake.
 * Destructive actions (remove) require confirmation via action gates.
 * All actions delegate to the scheduler backend via rpcCall indirection.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import {
  jsonResult,
  readEnumParam,
  readStringParam,
  readNumberParam,
  readBooleanParam,
  createActionGate,
} from "../tool-helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * RPC call function type used by all platform tools.
 *
 * Maps a namespaced method (e.g., "cron.add") to an in-process service call.
 */
export interface RpcCallMetadata {
  /** Stable identity of one logical outward operation, usually the tool-call id. */
  outwardOperationId?: string;
}

export type RpcCall = (
  method: string,
  params: Record<string, unknown>,
  metadata?: RpcCallMetadata,
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const CronToolParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("add"),
      Type.Literal("list"),
      Type.Literal("update"),
      Type.Literal("remove"),
      Type.Literal("status"),
      Type.Literal("runs"),
      Type.Literal("run"),
      Type.Literal("wake"),
    ],
    { description: "Cron scheduling action. Valid values: add (create new job), list (show all jobs), update (modify job config), remove (delete a job), status (scheduler health), runs (job execution history), run (trigger job now), wake (wake scheduler loop)" },
  ),
  // add params
  name: Type.Optional(Type.String({ description: "Human-readable job name (for add/update)" })),
  schedule_kind: Type.Optional(
    Type.Union([Type.Literal("cron"), Type.Literal("every"), Type.Literal("at"), Type.Literal("in")], {
      description: "Schedule type. Valid values: cron (recurring cron expression), every (repeat at fixed interval), at (one-shot at a specific datetime), in (one-shot a RELATIVE number of seconds from now). For a RELATIVE reminder like 'in 2 minutes' / 'in an hour', STRONGLY PREFER kind=in with schedule_in_seconds — it needs NO timezone and NO datetime math. Use 'at' only for an absolute clock time ('at 9am tomorrow').",
    }),
  ),
  schedule_expr: Type.Optional(
    Type.String({ description: "Cron expression (for schedule_kind=cron)" }),
  ),
  schedule_every_ms: Type.Optional(
    Type.Integer({ description: "Interval in milliseconds (for schedule_kind=every)" }),
  ),
  schedule_at: Type.Optional(
    Type.String({ description: "ISO 8601 datetime string for schedule_kind=at (a naive wall-clock like 2026-06-20T09:00:00 is interpreted in `timezone`, or UTC if none). Do NOT use this for relative reminders ('in N minutes') — use schedule_kind=in + schedule_in_seconds, which avoids timezone-conversion mistakes." }),
  ),
  schedule_in_seconds: Type.Optional(
    Type.Integer({ description: "Seconds from NOW for schedule_kind=in (e.g. 'in 2 minutes' → 120, 'in an hour' → 3600). Deterministic + timezone-free — the correct, reliable way to schedule any relative one-shot reminder." }),
  ),
  timezone: Type.Optional(Type.String({ description: "IANA timezone (e.g. America/Los_Angeles). REQUIRED for any time-of-day schedule (schedule_kind=cron or at) so it fires at the USER'S local wall-clock time, not the server's. Set it to the user's known timezone (from memory/USER.md); without it a naive time like 09:00 is interpreted in the server timezone (UTC). E.g. a Pacific user's 'remind me at 9am' must pass timezone=America/Los_Angeles." })),
  payload_kind: Type.Optional(
    Type.Union([Type.Literal("system_event"), Type.Literal("agent_turn")], {
      description: "Payload type. Valid values: system_event (cron/system triggers), agent_turn (agent-initiated runs)",
    }),
  ),
  payload_text: Type.Optional(Type.String({ description: "Payload text or message content" })),
  // session strategy params
  session_strategy: Type.Optional(
    Type.Union([Type.Literal("fresh"), Type.Literal("rolling"), Type.Literal("accumulate")], {
      description: "Session history strategy for recurring jobs. Valid values: fresh (new session each run; default and STRONGLY PREFERRED for cadences ≥ 10 minutes), rolling (keep last N turns; ONLY use when cadence < 5 minutes), accumulate (keep all history; rarely correct, leaks across runs). Rationale: cron uses a 5-minute prompt cache TTL, so any cadence longer than that wastes cache-write spend on rolling/accumulate — the cache is always cold by the next tick. Pick fresh unless cross-tick session memory is essential and cadence is < 5 minutes. Default: fresh",
    }),
  ),
  max_history_turns: Type.Optional(
    Type.Integer({ description: "Number of recent turns to keep for rolling strategy (default 3)" }),
  ),
  model: Type.Optional(Type.String({
    description: "Model to use when this cron job fires (e.g. gemini-2.5-flash). Only applies to agent_turn payload kind.",
  })),
  // wake-gate (monitoring) params — see the tool description for the verdict protocol
  wake_gate_script: Type.Optional(
    Type.String({
      description:
        "Optional pre-run gate script for a monitoring job (add/update). When set, the scheduler runs it before each fire and wakes the model ONLY if the script signals a change; otherwise the fire is skipped cheaply. The script prints its verdict on stdout — see this tool's description for the protocol and a worked example.",
    }),
  ),
  wake_gate_language: Type.Optional(
    Type.Union([Type.Literal("js"), Type.Literal("ts")], {
      description: "Language of wake_gate_script. Valid values: js, ts. Default: js.",
    }),
  ),
  // update/remove/runs/run params
  job_name: Type.Optional(
    Type.String({ description: "Job name (required for update, remove, runs, run)" }),
  ),
  enabled: Type.Optional(Type.Boolean({ description: "Enable or disable a job (for update)" })),
  // runs params
  limit: Type.Optional(
    Type.Integer({ description: "Maximum number of run history entries (default 20)" }),
  ),
  // run params
  mode: Type.Optional(
    Type.Union([Type.Literal("force"), Type.Literal("due")], {
      description: "Run mode (default: force). Valid values: force (ignore schedule, run now), due (run only if overdue)",
    }),
  ),
  // wake params
  source: Type.Optional(
    Type.String({
      description: "Audit trail source identifier for wake action (default: agent)",
    }),
  ),
  _confirmed: Type.Optional(
    Type.Boolean({
      description:
        "Set to true when re-calling a destructive action after user approval. " +
        "When a gated action returns requiresConfirmation, present the action to the user, " +
        "and after they approve, call the same action again with _confirmed: true.",
    }),
  ),
});

type CronToolParamsType = Static<typeof CronToolParams>;

const VALID_ACTIONS = ["add", "list", "update", "remove", "status", "runs", "run", "wake"] as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a cron scheduling tool with 8 actions.
 *
 * Destructive actions (remove) are gated via createActionGate and
 * return an explicit error when the action is classified as destructive.
 * The add action is classified as "mutate" (reversible) and auto-approved.
 *
 * @param rpcCall - RPC call function for delegating to the scheduler backend
 * @returns AgentTool implementing the cron scheduler interface
 */
export function createCronTool(rpcCall: RpcCall): AgentTool<typeof CronToolParams> {
  const addGate = createActionGate("cron.add");
  const removeGate = createActionGate("cron.remove");

  return {
    name: "cron",
    label: "Cron Scheduler",
    description:
      "Manage cron jobs, scheduled tasks, wake events. Write reminder text as user-facing message. " +
      "SCHEDULING RULE: for a RELATIVE reminder ('in 2 minutes', 'in an hour', 'remind me in 30 seconds', 'N minutes from now') you MUST use schedule_kind='in' with schedule_in_seconds = the number of seconds — do NOT compute an absolute datetime or timezone for a relative request (that is the #1 source of wrong-time reminders). Use schedule_kind='at' ONLY for an explicit clock time like 'at 9am tomorrow', and then always pass the user's timezone. " +
      "MONITORING (wake-gate): for a job that watches something, supply a wake_gate_script that fetches or greps the thing to watch and prints a JSON verdict on stdout — {\"wake\":false} when nothing changed (the fire is skipped cheaply), or {\"wake\":true,\"context\":\"what you found\"} otherwise. The model runs ONLY when the gate wakes it, so a quiet monitor costs almost nothing. Example: a wake_gate_script that fetches a CI status prints {\"wake\":false} while the build is green, else {\"wake\":true,\"context\":\"build #123 failed\"}; set wake_gate_language to js (default) or ts. This wake-gate is NOT the `wake` action — that action just wakes/replays the scheduler loop to re-check due jobs, it is not a pre-run gate.",
    parameters: CronToolParams,

    async execute(
      _toolCallId: string,
      params: CronToolParamsType,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const p = params as unknown as Record<string, unknown>;
        const action = readEnumParam(p, "action", VALID_ACTIONS);

        switch (action) {
          case "add": {
            const gate = addGate(p);
            if (gate.requiresConfirmation) {
              return jsonResult({
                requiresConfirmation: true,
                actionType: gate.actionType,
                hint: "Ask the user to confirm this cron job creation, then call again with _confirmed: true.",
              });
            }
            const result = await rpcCall("cron.add", {
              name: readStringParam(p, "name"),
              schedule_kind: readStringParam(p, "schedule_kind", false),
              schedule_expr: readStringParam(p, "schedule_expr", false),
              schedule_every_ms: readNumberParam(p, "schedule_every_ms", false),
              schedule_at: readStringParam(p, "schedule_at", false),
              schedule_in_seconds: readNumberParam(p, "schedule_in_seconds", false),
              timezone: readStringParam(p, "timezone", false),
              payload_kind: readStringParam(p, "payload_kind", false),
              payload_text: readStringParam(p, "payload_text", false),
              session_strategy: readStringParam(p, "session_strategy", false),
              max_history_turns: readNumberParam(p, "max_history_turns", false),
              model: readStringParam(p, "model", false),
              wake_gate_script: readStringParam(p, "wake_gate_script", false),
              wake_gate_language: readStringParam(p, "wake_gate_language", false),
            });
            return jsonResult(result);
          }

          case "list": {
            const result = await rpcCall("cron.list", {});
            return jsonResult(result);
          }

          case "update": {
            const jobName = readStringParam(p, "job_name");
            const enabled = readBooleanParam(p, "enabled", false);
            const name = readStringParam(p, "name", false);
            const result = await rpcCall("cron.update", {
              jobName,
              enabled,
              name,
              wake_gate_script: readStringParam(p, "wake_gate_script", false),
              wake_gate_language: readStringParam(p, "wake_gate_language", false),
            });
            return jsonResult(result);
          }

          case "remove": {
            const gate = removeGate(p);
            if (gate.requiresConfirmation) {
              return jsonResult({
                requiresConfirmation: true,
                actionType: gate.actionType,
                hint: "Ask the user to confirm this cron job removal, then call again with _confirmed: true.",
              });
            }
            const jobName = readStringParam(p, "job_name");
            const result = await rpcCall("cron.remove", { jobName });
            return jsonResult(result);
          }

          case "status": {
            const result = await rpcCall("cron.status", {});
            return jsonResult(result);
          }

          case "runs": {
            const jobName = readStringParam(p, "job_name");
            const limit = readNumberParam(p, "limit", false) ?? 20;
            const result = await rpcCall("cron.runs", { jobName, limit });
            return jsonResult(result);
          }

          case "run": {
            const jobName = readStringParam(p, "job_name");
            const mode = readStringParam(p, "mode", false) ?? "force";
            const result = await rpcCall("cron.run", { jobName, mode });
            return jsonResult(result);
          }

          case "wake": {
            const source = readStringParam(p, "source", false) ?? "agent";
            const result = await rpcCall("scheduler.wake", { source });
            return jsonResult(result);
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
