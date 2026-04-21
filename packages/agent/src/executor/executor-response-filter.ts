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
import { formatChecklistForInjection } from "../planner/checklist-formatter.js";
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

/**
 * When the final assistant message is thinking-only or a
 * silent token (NO_REPLY, HEARTBEAT_OK) but text was emitted in earlier
 * turns, walk backward through session messages to find the last assistant
 * message that contained visible text blocks.
 *
 * Two-pass strategy:
 * 1. Backward walk skipping tool-call turns — finds the most recent
 *    standalone response (text-only, no toolCall/tool_use blocks).
 * 2. Forward walk from userMessageIndex including tool-call turns — finds
 *    the earliest pre-tool commentary, which is typically the framing
 *    response (e.g. "I'm going to build..."), not a late step annotation
 *    (e.g. "Step 4/4: sanity-testing...").
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
      /* eslint-disable @typescript-eslint/no-explicit-any */

      // Pass 1: backward walk — prefer the most recent standalone response
      // (assistant turns that have text but NO tool call blocks)
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

      // Pass 2: forward walk — fall back to the earliest pre-tool commentary.
      // Walking forward prefers the framing/introduction message over late
      // step annotations (e.g. "I'm going to build..." over "Step 4/4: ...").
      for (let i = lowerBound; i < messages.length; i++) {
        const msg = messages[i]; // eslint-disable-line security/detect-object-injection
        if (msg?.role === "assistant" && Array.isArray(msg.content)) {
          const recovered = extractVisibleText(msg.content);
          if (recovered) {
            logger.info(
              {
                hint: "Final assistant message was empty or silent-token-only; recovered pre-tool commentary from earlier turn",
                errorKind: "transient" as ErrorKind,
                turnIndex: i,
                recoveredLength: recovered.length,
                recoveryPass: "pre-tool-commentary",
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
      nudged: false,
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

// ---------------------------------------------------------------------------
// SEP completeness nudge (extracted from execute() success path)
// ---------------------------------------------------------------------------

/**
 * Generate a completeness nudge when the LLM stopped but steps remain.
 * Returns the nudge text or undefined if no nudge is needed.
 */
export function generateCompletenessNudge(params: {
  plan: ExecutionPlan;
  verificationNudge: boolean;
}): string | undefined {
  const { plan, verificationNudge } = params;

  if (!plan.active || plan.nudged) return undefined;

  const remaining = plan.steps.filter(
    s => s.status === "pending" || s.status === "in_progress",
  );

  if (remaining.length > 0 && plan.completedCount > 0) {
    const checklist = formatChecklistForInjection(plan, verificationNudge);
    return checklist
      ? `${checklist}\n\nPlease continue with the remaining steps. If any step is no longer needed, explain why.`
      : `You indicated completion but ${remaining.length} step(s) remain:\n${remaining.map(s => `- ${s.description}`).join("\n")}\nPlease continue. If these steps are no longer needed, explain why.`;
  }

  return undefined;
}
