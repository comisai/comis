// SPDX-License-Identifier: Apache-2.0
/**
 * Response filtering and post-processing for PiExecutor.
 *
 * Extracted from pi-executor.ts execute() to consolidate the 3 nearly
 * identical OutputGuard scanning blocks into a single reusable function,
 * and isolate SEP plan extraction, budget-driven continuation, output
 * escalation, and EMPTY-FINAL recovery into focused helpers.
 *
 * Consumers:
 * - pi-executor.ts: calls these functions in the success/error/catch paths
 *
 * @module
 */

import {
  type SessionKey,
  type TypedEventBus,
  type OutputGuardPort,
} from "@comis/core";
import type { ComisLogger, ErrorKind } from "@comis/infra";
import type { ExecutionPlan } from "../planner/types.js";
import { extractPlanFromResponse } from "../planner/plan-extractor.js";
import { stripReasoningTagsFromText } from "../response-filter/reasoning-tags.js";
import { isVisibleTextBlock } from "./phase-filter.js";

// ---------------------------------------------------------------------------
// Unified OutputGuard scanning (replaces 3 near-identical blocks)
// ---------------------------------------------------------------------------

/** Context parameter for OutputGuard scanning to differentiate the 3 call sites. */
export type OutputGuardContext = "success" | "error" | "exception";

/** Result of scanning with OutputGuard. */
export interface OutputGuardScanResult {
  /** The (possibly sanitized) response text. */
  response: string;
  /** Whether critical findings were blocked/redacted. */
  blocked: boolean;
}

/**
 * Unified OutputGuard scanning helper. Replaces the 3 near-identical
 * scanning blocks in pi-executor.ts execute() (success path, error path,
 * catch block). The only differences between the 3 blocks are:
 * - The warn log message ("LLM response redacted" vs "Error response redacted")
 * - The metadata.context field (absent, "error_response", "exception_response")
 */
export function scanWithOutputGuard(params: {
  outputGuard: OutputGuardPort;
  response: string;
  context: OutputGuardContext;
  canaryToken?: string;
  agentId: string;
  tenantId: string;
  sessionKey: SessionKey;
  eventBus: TypedEventBus;
  logger: ComisLogger;
}): OutputGuardScanResult {
  const { outputGuard, response, context, canaryToken, agentId, tenantId, eventBus, logger } = params;

  const guardResult = outputGuard.scan(response, { canaryToken });
  if (!guardResult.ok) {
    return { response, blocked: false };
  }

  // Use sanitized version when critical findings present
  let finalResponse = response;
  if (guardResult.value.blocked) {
    finalResponse = guardResult.value.sanitized;
    const warnMsg = context === "success"
      ? "LLM response redacted"
      : "Error response redacted";
    logger.warn(
      {
        findings: guardResult.value.findings.length,
        hint: context === "success"
          ? "OutputGuard blocked critical findings in LLM response"
          : context === "error"
            ? "OutputGuard blocked critical findings in error response"
            : "OutputGuard blocked critical findings in error response",
        errorKind: "validation" as ErrorKind,
      },
      warnMsg,
    );
  }

  // INFO for findings (even non-blocking), DEBUG for clean
  if (guardResult.value.findings.length > 0) {
    logger.info(
      {
        findingTypes: guardResult.value.findings.map(f => f.type),
        severities: [...new Set(guardResult.value.findings.map(f => f.severity))],
        action: guardResult.value.blocked ? "redacted" : "detected",
      },
      "OutputGuard findings",
    );
    // Emit audit:event for output guard findings
    const metadata: Record<string, unknown> = {
      findingTypes: guardResult.value.findings.map(f => f.type),
      severities: [...new Set(guardResult.value.findings.map(f => f.severity))],
      action: guardResult.value.blocked ? "redacted" : "detected",
      findingCount: guardResult.value.findings.length,
    };
    // Add context metadata for error/exception paths
    if (context === "error") {
      metadata.context = "error_response";
    } else if (context === "exception") {
      metadata.context = "exception_response";
    }
    eventBus.emit("audit:event", {
      timestamp: Date.now(),
      agentId,
      tenantId,
      actionType: "output_guard",
      classification: "security",
      outcome: guardResult.value.blocked ? "denied" : "success",
      metadata,
    });
  }
  // Clean scan (no findings) is a non-event -- suppressed

  return { response: finalResponse, blocked: guardResult.value.blocked };
}

// ---------------------------------------------------------------------------
// EMPTY-FINAL recovery (extracted from execute() success path)
// ---------------------------------------------------------------------------

/** Silent tokens that indicate the final message has no visible content. */
const SILENT_FINAL_TOKENS = ["NO_REPLY", "HEARTBEAT_OK"];

/** Tool names whose successful invocation means the agent already delivered
 *  content to the user through a side-channel. When one of these tools was
 *  called during the execution, a silent final token (NO_REPLY) is intentional
 *  and recovery must be suppressed to avoid leaking internal narration. */
const DELIVERY_TOOL_NAMES = ["message", "notify"];

/**
 * When the final assistant message is thinking-only or a
 * silent token (NO_REPLY, HEARTBEAT_OK) but text was emitted in earlier
 * turns, recover a meaningful user-visible response.
 *
 * Two-pass strategy (gated):
 * 1. **Tool-call synthesis** (primary) — if ≥1 prior assistant turn within the
 *    current execution window contains tool-call blocks, synthesize a
 *    structured `[comis: tool-call summary recovered ...]` reply listing each
 *    tool + primary identifying argument. This avoids surfacing earlier
 *    planning prose ("let me plan this out before building...") AS the final
 *    reply when the work was actually completed via tools.
 * 2. **Standalone walk-backward** (fallback) — when zero prior tool calls were
 *    collected (pure-conversational case), preserve the original behavior of
 *    walking backward through messages to find the most recent assistant turn
 *    with visible text-only content (no tool calls).
 *
 * The synthesis-gate (a single early-return — see `tool-call-synthesis-gate`
 * comment below) ensures the standalone walk only fires when no tool calls
 * were observed; this keeps the pass selection mutually exclusive.
 *
 * Suppressed when a delivery tool (`message`, `notify`) was used — the agent
 * already delivered content via side-channel and the silent final token is
 * intentional.
 *
 * Returns the recovered text, or the original response if no recovery needed.
 */
export function recoverEmptyFinalResponse(params: {
  extractedResponse: string;
  textEmitted: boolean;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  messages: any[];
  /* eslint-enable @typescript-eslint/no-explicit-any */
  logger: ComisLogger;
  /** Index of the last user message — backward walk stops here to prevent
   *  cross-execution recovery (leaking text from a previous execution). */
  userMessageIndex?: number;
}): string {
  const { extractedResponse, textEmitted, messages, logger, userMessageIndex } = params;
  const lowerBound = userMessageIndex ?? 0;

  const isSilentFinalToken = SILENT_FINAL_TOKENS.includes(extractedResponse.trim());
  if ((extractedResponse === "" || isSilentFinalToken) && textEmitted) {
    if (Array.isArray(messages)) {
      // Guard: if the agent already delivered content via a delivery tool
      // (message, notify), the silent final token is intentional — skip
      // recovery to avoid leaking internal narration (e.g. "Now let me
      // generate the chart:" surfaced as a user-visible message).
      if (isSilentFinalToken && hasDeliveryToolCall(messages, lowerBound)) {
        logger.debug(
          {
            hint: "Silent final token after delivery tool call — recovery suppressed",
            extractedResponse,
          },
          "Skipping empty-response recovery (delivery tool used)",
        );
        return extractedResponse;
      }
      /* eslint-disable @typescript-eslint/no-explicit-any */

      // Collect tool-call summaries from prior assistant turns within the
      // current execution window (lowerBound .. messages.length).
      //
      // Note: blocks with non-string `name` are still summarized (the helper
      // renders them as "unknown_tool") but are NOT added to `toolNamesSet`.
      // Consequence: a batch of purely malformed blocks emits `toolNames: []`
      // in the INFO log while `toolCallCount` reflects the bullet count. This
      // is intentional — `toolNames` is a deduplicated set of well-typed
      // identifiers for log aggregation, not a per-bullet identifier list.
      const toolCallSummaries: string[] = [];
      const toolNamesSet = new Set<string>();
      for (let i = lowerBound; i < messages.length; i++) {
        const msg = messages[i]; // eslint-disable-line security/detect-object-injection
        if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (block?.type === "toolCall" || block?.type === "tool_use") {
            toolCallSummaries.push(summarizeToolCall(block));
            // Only well-typed names enter the set — malformed blocks are still
            // summarized as "unknown_tool" but excluded from toolNames.
            if (typeof block?.name === "string") toolNamesSet.add(block.name);
          }
        }
      }

      // Synthesis-only-when-tool-calls contract (grep anchor: "tool-call-synthesis-gate"):
      // Returning here is the ONE place that prevents the `standalone` walk-backward
      // (below) from ever firing alongside synthesis. Do not add code paths
      // that fall through to standalone after toolCallSummaries are non-empty.
      if (toolCallSummaries.length > 0) {
        const bullets = toolCallSummaries.map(s => `  • ${s}`).join("\n");
        const synthesis =
          `[comis: tool-call summary recovered from successful operations — the assistant's final message was empty]\n` +
          `Completed ${toolCallSummaries.length} tool call${toolCallSummaries.length === 1 ? "" : "s"} in this batch:\n` +
          `${bullets}\n` +
          `The work was done; the assistant did not summarize. Please ask "what did you do?" if details are needed.`;

        logger.info(
          {
            module: "agent.executor.empty-turn-recovery",
            recoveryPass: "tool-call-synthesis",
            toolCallCount: toolCallSummaries.length,
            toolNames: [...toolNamesSet],
            synthesisLength: synthesis.length,
            hint: "Final assistant message was empty after tool batch; synthesized completion summary from tool-call history.",
          },
          "Empty-turn recovery: synthesized from tool-call history",
        );
        return synthesis; // tool-call-synthesis-gate — see comment above.
      }

      // Standalone walk-backward (pure-conversational fallback): reachable
      // ONLY when toolCallSummaries.length === 0, guaranteed by the early-
      // return above. Do NOT wrap in an additional conditional — the single
      // gate above is the contract anchor.
      for (let i = messages.length - 1; i >= lowerBound; i--) {
        const msg = messages[i]; // eslint-disable-line security/detect-object-injection
        if (msg?.role === "assistant" && Array.isArray(msg.content)) {
          const hasToolCall = msg.content.some(
            (b: any) => b?.type === "toolCall" || b?.type === "tool_use",
          );
          if (hasToolCall) continue;

          const recovered = extractVisibleText(msg.content);
          if (recovered) {
            logger.info(
              {
                hint: "Final assistant message was empty or silent-token-only; recovered text from earlier turn",
                errorKind: "transient" as ErrorKind,
                turnIndex: i,
                recoveredLength: recovered.length,
                recoveryPass: "standalone",
              },
              "recovered visible text from earlier turn",
            );
            return recovered;
          }
        }
      }

      /* eslint-enable @typescript-eslint/no-explicit-any */
    }
  }

  return extractedResponse;
}

/** Extract joined visible text from content blocks, or undefined if none found.
 *  Strips reasoning tags (<think>/<thinking>) before checking visibility — a text
 *  block whose content is entirely thinking tags is not visible to the user. */
/* eslint-disable @typescript-eslint/no-explicit-any */
function extractVisibleText(content: any[]): string | undefined {
  const textBlocks = content.filter(
    (b: any) =>
      isVisibleTextBlock(b) &&
      b.text.trim() !== "" &&
      !SILENT_FINAL_TOKENS.includes(b.text.trim()),
  );
  if (textBlocks.length > 0) {
    const joined = textBlocks.map((b: any) => b.text).join("\n");
    // Strip reasoning tags before checking visibility — a text block whose
    // content is entirely <think>...</think> is not visible to the user and
    // must not be treated as recovered text.
    const visible = stripReasoningTagsFromText(joined, { mode: "preserve", trim: "both" }).trim();
    return visible || undefined;
  }
  return undefined;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Check whether any assistant turn (from lowerBound onward) contains a tool
 *  call to a delivery tool (message, notify). These tools send content to the
 *  user through a side-channel, so a subsequent NO_REPLY is intentional. */
/* eslint-disable @typescript-eslint/no-explicit-any */
function hasDeliveryToolCall(messages: any[], lowerBound: number): boolean {
  for (let i = lowerBound; i < messages.length; i++) {
    const msg = messages[i]; // eslint-disable-line security/detect-object-injection
    if (msg?.role === "assistant" && Array.isArray(msg.content)) {
      const hasDelivery = msg.content.some(
        (b: any) =>
          (b?.type === "toolCall" || b?.type === "tool_use") &&
          DELIVERY_TOOL_NAMES.includes(b?.name),
      );
      if (hasDelivery) return true;
    }
  }
  return false;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Summarize a single tool-call content block as `toolName({primary_arg: "value"})`.
 *  Reads `name` from the block, and `input` (Anthropic native) or `arguments`
 *  (internal mapped convention) for args. Returns bare tool name on malformed
 *  input — never throws. */
/* eslint-disable @typescript-eslint/no-explicit-any */
function summarizeToolCall(call: any): string {
  const name = typeof call?.name === "string" ? call.name : "unknown_tool";
  // Both Anthropic native (`input`) and internal mapped (`arguments`) shapes.
  const args: Record<string, unknown> | undefined =
    (call?.input && typeof call.input === "object" ? call.input : undefined) ??
    (call?.arguments && typeof call.arguments === "object" ? call.arguments : undefined);

  if (!args) return name;

  switch (name) {
    case "agents_manage": {
      const action = typeof args.action === "string" ? args.action : undefined;
      const agentId = typeof args.agent_id === "string" ? args.agent_id : undefined;
      if (action && agentId) return `agents_manage.${action}({agent_id: "${agentId}"})`;
      if (action) return `agents_manage.${action}`;
      return "agents_manage";
    }
    case "write":
    case "edit":
    case "read": {
      const p = typeof args.path === "string" ? args.path : undefined;
      return p ? `${name}({path: "${p}"})` : name;
    }
    case "gateway": {
      const action = typeof args.action === "string" ? args.action : undefined;
      const section = typeof args.section === "string" ? args.section : undefined;
      if (action && section) return `gateway({action: "${action}", section: "${section}"})`;
      if (action) return `gateway({action: "${action}"})`;
      return "gateway";
    }
    case "exec": {
      const cmd = typeof args.command === "string" ? args.command : undefined;
      if (cmd) {
        const preview = cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd;
        return `exec({command: "${preview}"})`;
      }
      return "exec";
    }
    case "pipeline": {
      const pname = typeof args.name === "string" ? args.name : undefined;
      return pname ? `pipeline({name: "${pname}"})` : "pipeline";
    }
    case "sessions_spawn": {
      const agentId = typeof args.agent_id === "string" ? args.agent_id : undefined;
      return agentId ? `sessions_spawn({agent_id: "${agentId}"})` : "sessions_spawn";
    }
    case "message":
    case "notify": {
      const action = typeof args.action === "string" ? args.action : undefined;
      return action ? `${name}({action: "${action}"})` : name;
    }
    default:
      return name;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// SEP plan extraction (extracted from execute() success path)
// ---------------------------------------------------------------------------

/**
 * Extract a structured execution plan from the first LLM response.
 * Returns the plan if extraction succeeded, undefined otherwise.
 */
export function extractExecutionPlan(params: {
  response: string;
  messageText: string;
  maxSteps: number;
  minSteps: number;
  executionStartMs: number;
  agentId: string | undefined;
  formattedKey: string;
  eventBus: TypedEventBus;
  logger: ComisLogger;
}): ExecutionPlan | undefined {
  const { response, messageText, maxSteps, minSteps, executionStartMs, agentId, formattedKey, eventBus, logger } = params;

  const steps = extractPlanFromResponse(response, maxSteps);
  if (steps && steps.length >= minSteps) {
    const plan: ExecutionPlan = {
      active: true,
      request: messageText.slice(0, 200),
      steps,
      completedCount: 0,
      createdAtMs: Date.now(),
    };
    logger.info(
      { agentId, stepCount: steps.length, durationMs: Date.now() - executionStartMs },
      "SEP plan extracted",
    );
    eventBus.emit("sep:plan_extracted", {
      agentId: agentId ?? "default",
      sessionKey: formattedKey,
      stepCount: steps.length,
      timestamp: Date.now(),
    });
    return plan;
  }
  return undefined;
}

