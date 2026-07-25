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
  throwToolError,
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
  /** In-process tool cancellation propagated to long-running read-only RPCs. */
  signal?: AbortSignal;
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
    { description: "Cron scheduling action. Valid values: add (create new job), list (show all jobs), update (modify job config), remove (delete a job), status (scheduler health), runs (job execution history), run (trigger job now), wake (request typed heartbeat coordinator admission)" },
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
    Type.Union([Type.Literal("heartbeat_event"), Type.Literal("delivery"), Type.Literal("agent_turn")], {
      description: "Payload type. Valid values: heartbeat_event (enqueue an agent heartbeat event), delivery (deliver exact text), agent_turn (run the agent)",
    }),
  ),
  payload_text: Type.Optional(Type.String({ description: "Payload text or message content" })),
  wake_mode: Type.Optional(
    Type.Union([Type.Literal("now"), Type.Literal("next-heartbeat")], {
      description: "Heartbeat-event timing. Valid values: now or next-heartbeat. Default: now.",
    }),
  ),
  // session strategy params
  session_strategy: Type.Optional(
    Type.Union([Type.Literal("fresh"), Type.Literal("rolling")], {
      description: "Bounded session history strategy for agent-turn jobs. Valid values: fresh (new session each run; default) or rolling (keep up to max_history_turns).",
    }),
  ),
  max_history_turns: Type.Optional(
    Type.Integer({ description: "Number of recent turns to keep for rolling strategy (default 3)" }),
  ),
  model: Type.Optional(Type.String({
    description: "Model to use when this cron job fires (e.g. gemini-2.5-flash). Only applies to agent_turn payload kind.",
  })),
  continuation_mode: Type.Optional(
    Type.Union([
      Type.Literal("none"),
      Type.Literal("heartbeat_excerpt"),
      Type.Literal("origin_history"),
    ], { description: "Post-run continuation mode for agent-turn jobs. Default: none." }),
  ),
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
  wake_gate_timeout_seconds: Type.Optional(
    Type.Integer({ description: "Wake-gate timeout in seconds. Default: 30." }),
  ),
  // update/remove/runs/run params
  job_name: Type.Optional(
    Type.String({ description: "Job name (required for update, remove, runs, run)" }),
  ),
  paused: Type.Optional(Type.Boolean({ description: "Pause or resume future occurrences (for update)" })),
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
  wake_target: Type.Optional(
    Type.Union([Type.Literal("agent"), Type.Literal("monitoring")], {
      description: "Typed scheduler wake target. Default: agent.",
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
const VALID_SCHEDULE_KINDS = ["cron", "every", "at", "in"] as const;
const VALID_PAYLOAD_KINDS = ["heartbeat_event", "delivery", "agent_turn"] as const;
const VALID_SESSION_STRATEGIES = ["fresh", "rolling"] as const;
const VALID_CONTINUATION_MODES = ["none", "heartbeat_excerpt", "origin_history"] as const;
const VALID_WAKE_MODES = ["now", "next-heartbeat"] as const;
const VALID_WAKE_TARGETS = ["agent", "monitoring"] as const;

function readOptionalEnumParam<T extends string>(
  params: Record<string, unknown>,
  key: string,
  validValues: readonly T[],
): T | undefined {
  if (readStringParam(params, key, false) === undefined) return undefined;
  return readEnumParam(params, key, validValues);
}

function buildSchedule(params: Record<string, unknown>): Record<string, unknown> {
  const kind = readEnumParam(params, "schedule_kind", VALID_SCHEDULE_KINDS);
  const timezone = readStringParam(params, "timezone", false);
  switch (kind) {
    case "cron":
      return {
        kind,
        expr: readStringParam(params, "schedule_expr"),
        ...(timezone === undefined ? {} : { tz: timezone }),
      };
    case "every":
      return { kind, everyMs: readNumberParam(params, "schedule_every_ms") };
    case "at":
      return {
        kind,
        at: readStringParam(params, "schedule_at"),
        ...(timezone === undefined ? {} : { tz: timezone }),
      };
    case "in":
      return { kind, seconds: readNumberParam(params, "schedule_in_seconds") };
  }
}

function buildPayload(params: Record<string, unknown>): Record<string, unknown> {
  const kind = readEnumParam(params, "payload_kind", VALID_PAYLOAD_KINDS);
  const text = readStringParam(params, "payload_text");
  switch (kind) {
    case "heartbeat_event":
      return {
        kind,
        text,
        wakeMode: readOptionalEnumParam(params, "wake_mode", VALID_WAKE_MODES) ?? "now",
      };
    case "delivery":
      return { kind, text };
    case "agent_turn": {
      const model = readStringParam(params, "model", false);
      return { kind, message: text, ...(model === undefined ? {} : { model }) };
    }
  }
}

function buildSessionPolicy(params: Record<string, unknown>): Record<string, unknown> {
  const strategy = readOptionalEnumParam(
    params,
    "session_strategy",
    VALID_SESSION_STRATEGIES,
  ) ?? "fresh";
  if (strategy === "fresh") return { strategy };
  return {
    strategy,
    maxHistoryTurns: readNumberParam(params, "max_history_turns"),
  };
}

function buildWakeGate(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const script = readStringParam(params, "wake_gate_script", false);
  if (script === undefined) return undefined;
  return {
    script,
    language: readOptionalEnumParam(params, "wake_gate_language", ["js", "ts"] as const) ?? "js",
    timeoutSeconds: readNumberParam(params, "wake_gate_timeout_seconds", false) ?? 30,
  };
}

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
      "DELIVERY AUTHORITY: the runtime binds agent_turn and delivery jobs to the trusted originating conversation. Omitting target fields does not disable delivery; this tool cannot create an unbound agent_turn or delivery job. Add/update results do not echo that trusted target, so never claim the job is unbound from an omitted parameter. " +
      "SCHEDULING RULE: for a RELATIVE reminder ('in 2 minutes', 'in an hour', 'remind me in 30 seconds', 'N minutes from now') you MUST use schedule_kind='in' with schedule_in_seconds = the number of seconds — do NOT compute an absolute datetime or timezone for a relative request (that is the #1 source of wrong-time reminders). Use schedule_kind='at' ONLY for an explicit clock time like 'at 9am tomorrow', and then always pass the user's timezone. " +
      "MONITORING (wake-gate): for a job that watches something, supply a wake_gate_script that fetches or greps the thing to watch and prints a JSON verdict on stdout — {\"wake\":false} when nothing changed (the fire is skipped cheaply), or {\"wake\":true,\"context\":\"what you found\"} otherwise. The model runs ONLY when the gate wakes it, so a quiet monitor costs almost nothing. Example: a wake_gate_script that fetches a CI status prints {\"wake\":false} while the build is green, else {\"wake\":true,\"context\":\"build #123 failed\"}; set wake_gate_language to js (default) or ts. This wake-gate is NOT the `wake` action — that action requests typed heartbeat coordinator admission for the selected target; it is not a pre-run gate.",
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
            const payload = buildPayload(p);
            const isAgentTurn = payload.kind === "agent_turn";
            const wakeGate = buildWakeGate(p);
            if (!isAgentTurn && wakeGate !== undefined) {
              throwToolError(
                "invalid_value",
                "wake_gate_script is valid only for agent_turn payloads",
                { param: "wake_gate_script", hint: "Use payload_kind=agent_turn or omit wake_gate_script" },
              );
            }
            const continuationMode = readOptionalEnumParam(
              p,
              "continuation_mode",
              VALID_CONTINUATION_MODES,
            ) ?? "none";
            const result = await rpcCall("cron.add", {
              name: readStringParam(p, "name"),
              schedule: buildSchedule(p),
              payload,
              ...(isAgentTurn
                ? {
                    sessionPolicy: buildSessionPolicy(p),
                    continuationMode,
                    ...(wakeGate === undefined ? {} : { wakeGate }),
                  }
                : {}),
            });
            return jsonResult(result);
          }

          case "list": {
            const result = await rpcCall("cron.list", {});
            return jsonResult(result);
          }

          case "update": {
            const jobName = readStringParam(p, "job_name");
            const name = readStringParam(p, "name", false);
            const paused = readBooleanParam(p, "paused", false);
            const scheduleKind = readStringParam(p, "schedule_kind", false);
            const payloadKind = readStringParam(p, "payload_kind", false);
            const wakeGate = buildWakeGate(p);
            const result = await rpcCall("cron.update", {
              jobName,
              ...(name === undefined ? {} : { name }),
              ...(paused === undefined ? {} : { paused }),
              ...(scheduleKind === undefined ? {} : { schedule: buildSchedule(p) }),
              ...(payloadKind === undefined ? {} : { payload: buildPayload(p) }),
              ...(wakeGate === undefined ? {} : { wakeGate }),
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
            const target = readOptionalEnumParam(p, "wake_target", VALID_WAKE_TARGETS) ?? "agent";
            const result = await rpcCall("scheduler.wake", { target });
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
