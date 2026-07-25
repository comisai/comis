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
  type ClockPort,
} from "@comis/core";
import type { ComisLogger, ErrorKind } from "@comis/core";
import { isSilentResponse } from "@comis/shared";
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
  clock: ClockPort;
}): OutputGuardScanResult {
  const { outputGuard, response, context, canaryToken, agentId, tenantId, eventBus, logger, clock } = params;

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
    // Hint collapses error + exception into one message: both flow through
    // the same OutputGuard redaction with no operator-actionable difference.
    // If we ever need to distinguish them in dashboards, the metadata.context
    // field on the audit:event emit below already carries the split
    // ("error_response" vs "exception_response").
    const hint = context === "success"
      ? "OutputGuard blocked critical findings in LLM response"
      : "OutputGuard blocked critical findings in error response";
    logger.warn(
      {
        findings: guardResult.value.findings.length,
        hint,
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
      timestamp: clock.now(),
      agentId,
      tenantId,
      actionType: "output_guard",
      kind: "injection_detected",
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
 * When the final assistant message is empty but text was emitted in earlier
 * turns, recover a meaningful user-visible response.
 *
 * Recovery fires only when `extractedResponse === ""`. Silent tokens
 * (`NO_REPLY`, `HEARTBEAT_OK`) are explicit suppression signals and pass
 * through unchanged — the channel-layer filter
 * (`packages/channels/src/shared/response-filter.ts`) detects and suppresses
 * them downstream.
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

  if (extractedResponse === "" && textEmitted) {
    if (Array.isArray(messages)) {
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
            submodule: "executor.empty-turn-recovery",
            recoveryPass: "tool-call-synthesis",
            toolCallCount: toolCallSummaries.length,
            toolNames: [...toolNamesSet],
            synthesisLength: synthesis.length,
            hint: "Final assistant message was empty after tool batch; synthesized completion summary from tool-call history.",
          },
          "Empty-turn recovery: synthesized from tool-call history",
        );
        const artifacts = extractActionableArtifacts(messages, lowerBound);
        const artifactSuffix = artifacts.length > 0
          ? `\nUser actions: ${artifacts.join(" ")}`
          : "";
        return synthesis + artifactSuffix; // tool-call-synthesis-gate — see comment above.
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
      const key = typeof args.key === "string" ? args.key : undefined;
      if (action && section && key) return `gateway({action: "${action}", section: "${section}", key: "${key}"})`;
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
// surfaceDiscardedPreToolUrl — URL/short-code safety-net
// ---------------------------------------------------------------------------

/**
 * Regex constants for pre-tool URL/short-code surfacing.
 *
 * ORDERING IS LOAD-BEARING:
 * FRAMING_PROSE_RE must be checked BEFORE URL_RE/SHORT_CODE_RE.
 * A framing-prose block that happens to contain a URL must NOT be surfaced.
 */
const URL_RE = /https?:\/\/[^\s)>]+/;
// Short codes: alphanumeric token, 6-20 chars, MUST contain at least one digit.
// Requiring a digit prevents plain English words (e.g. "weather", "analysis")
// from matching — one-time codes, OTP tokens, and device pairing codes almost
// always contain at least one digit (e.g. "493021", "A1B2C3", "WDJB4-MJHT").
// The lookahead (?=\S*\d) enforces the digit requirement; the character class
// [A-Za-z0-9] then matches the full token.
const SHORT_CODE_RE = /\b(?=[A-Za-z0-9]{6,20}\b)(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6,20}\b/;
// Framing prose patterns — if text matches, the block is NEVER surfaced regardless
// of URL/code content. This guard fires first, before URL_RE or SHORT_CODE_RE.
const FRAMING_PROSE_RE = /^(I('m| will| am going to)[\s\S]|Let me|Step \d+\/\d+:)/i;

/**
 * Shared predicate for the URL/short-code surface helpers
 * (`surfaceDiscardedPreToolUrl` and `extractActionableArtifacts`).
 *
 * Encodes the per-text-block predicate chain — framing-prose guard FIRST, then
 * URL match, then short-code match — so the two call sites cannot drift apart.
 * A future addition (new framing pattern, new URL scheme like `mcp://`) lands
 * in one place and is automatically picked up by both consumers.
 *
 * Returns the matched candidate string, or `undefined` when the block is
 * framing prose OR contains no actionable URL/short-code.
 */
function findFirstActionableArtifact(text: string): string | undefined {
  if (FRAMING_PROSE_RE.test(text)) return undefined;
  const urlMatch = URL_RE.exec(text);
  if (urlMatch) return urlMatch[0];
  const codeMatch = SHORT_CODE_RE.exec(text);
  return codeMatch?.[0];
}

/**
 * Safety-net for discarded pre-tool auth links and one-time codes.
 *
 * When the LLM places a URL or short code in pre-tool text (e.g. "Visit
 * https://oauth.example.com/auth?code=XYZ to authorize") and that text is
 * absent from the final delivered response, this helper prepends only the
 * matched URL/code token to the final response so it reaches the user.
 *
 * Predicate order (CRITICAL — do not reorder):
 * 1. Sentinel guard: never modify NO_REPLY / HEARTBEAT_OK responses.
 * 2. Framing-prose exclusion: skip blocks matching FRAMING_PROSE_RE entirely
 *    (even if they contain a URL — prevents surfacing "I'm going to fetch
 *    https://example.com/docs" as a user-visible auth hint).
 * 3. URL / short-code detection: skip blocks with no URL or code candidate.
 * 4. Absence check (substring): skip candidates already present in the final
 *    response. See "Substring-dedupe semantics" below.
 *
 * ## Substring-dedupe semantics
 *
 * The Guard-4 absence check is a `String.prototype.includes` substring match.
 * If synthesis (in `recoverEmptyFinalResponse`) already added
 * `https://x.ai/device?code=ABC` to the response and a different pre-tool
 * block contains the shorter `https://x.ai/device` (no params), the shorter
 * URL is treated as already present (because it IS a substring of the
 * longer one) and NOT re-surfaced. This is the conservative direction:
 *
 * - SAFER on credentials: a query-param token (`?token=hf_…`) carried by
 *   one URL must NEVER be surfaced twice — duplicate surfacing widens the
 *   credential's exposure surface and can leak a token the user already
 *   saw in the final turn.
 * - LOSSIER on distinct-but-overlapping links: a prefix URL that happens
 *   to share a base path with a longer URL in the response is suppressed
 *   even though it carries different params. This is acceptable because
 *   the longer URL almost always covers the user's action (it's the more
 *   specific one).
 *
 * If a future change tightens this to a whole-token match (split on
 * whitespace), it MUST add a regression test for the prefix-overlap case
 * to prove no credential is double-surfaced. The current substring check
 * errs toward suppression, which is the load-bearing safety property.
 *
 * ## Egress ordering
 *
 * The call site in output-escalation.ts:processSuccessPath MUST run BEFORE
 * the OutputGuard scan so the surfaced URL is part of the content the egress
 * firewall scans — any credential in a URL query parameter
 * (e.g. `?token=hf_…`) is redacted before channel delivery. Placing this
 * call AFTER the OutputGuard scan would be an egress regression.
 *
 * Only the matched URL/code token (not the full prose block) is surfaced.
 */
export function surfaceDiscardedPreToolUrl(
  response: string,
  messages: unknown[],
  userMessageIndex: number,
  logger: ComisLogger,
): string {
  // Guard 1: never modify sentinel responses
  if (!response || isSilentResponse(response)) return response;

  const lowerBound = userMessageIndex ?? 0;
  if (!Array.isArray(messages)) return response;

  for (let i = lowerBound; i < messages.length; i++) {
    const msg = messages[i] as Record<string, unknown>; // eslint-disable-line security/detect-object-injection
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of (msg.content as unknown[])) {
      const b = block as Record<string, unknown>;
      // Only look at text blocks
      if (b?.type !== "text" || typeof b.text !== "string") continue;
      const text = b.text as string;
      // Guards 2+3 (framing-prose first, then URL/code): unified via the
      // findFirstActionableArtifact helper so this site and
      // extractActionableArtifacts cannot drift apart on regex/predicate edits.
      const candidate = findFirstActionableArtifact(text);
      if (!candidate) continue;
      // Guard 4: is the candidate absent from the final response?
      if (response.includes(candidate)) continue;
      // Surface: prepend candidate (just the URL/code token, not the full prose block)
      logger.info(
        { surfacedUrl: candidate, submodule: "executor-response-filter.surfaceDiscardedPreToolUrl" },
        "Surfaced discarded pre-tool URL",
      );
      return candidate + "\n" + response;
    }
  }
  return response;
}

// ---------------------------------------------------------------------------
// extractActionableArtifacts — URL/code extraction for synthesis branch
// ---------------------------------------------------------------------------

/**
 * Scan assistant text blocks in the window [lowerBound, messages.length) for
 * URLs or short codes that should be surfaced to the user via the synthesis
 * branch of `recoverEmptyFinalResponse`.
 *
 * Predicate order (mirrors surfaceDiscardedPreToolUrl — do not reorder):
 * 1. Only assistant text blocks are considered.
 * 2. Framing prose (FRAMING_PROSE_RE) is skipped entirely — prevents
 *    "I'm going to fetch https://example.com" from leaking.
 * 3. URL_RE is tried first; SHORT_CODE_RE is tried only when no URL matches.
 * 4. At most 3 distinct candidates are collected.
 *
 * Module-private — not exported. Called only from the synthesis branch of
 * recoverEmptyFinalResponse, before the gate return.
 */
function extractActionableArtifacts(
  messages: unknown[],
  lowerBound: number,
): string[] {
  const hits: string[] = [];
  if (!Array.isArray(messages)) return hits;
  for (let i = lowerBound; i < messages.length; i++) {
    const msg = messages[i] as Record<string, unknown>; // eslint-disable-line security/detect-object-injection
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of (msg.content as unknown[])) {
      const b = block as Record<string, unknown>;
      if (b?.type !== "text" || typeof b.text !== "string") continue;
      const text = b.text as string;
      // Framing-prose guard + URL/short-code match: unified with
      // surfaceDiscardedPreToolUrl via findFirstActionableArtifact so the two
      // sites cannot drift on regex/predicate edits.
      const candidate = findFirstActionableArtifact(text);
      if (candidate && hits.length < 3 && !hits.includes(candidate)) {
        hits.push(candidate);
      }
    }
  }
  return hits;
}

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
  clock: ClockPort;
}): ExecutionPlan | undefined {
  const { response, messageText, maxSteps, minSteps, executionStartMs, agentId, formattedKey, eventBus, logger, clock } = params;

  const steps = extractPlanFromResponse(response, maxSteps);
  if (steps && steps.length >= minSteps) {
    const plan: ExecutionPlan = {
      active: true,
      request: messageText.slice(0, 200),
      steps,
      completedCount: 0,
      createdAtMs: clock.now(),
    };
    logger.info(
      { agentId, stepCount: steps.length, durationMs: clock.now() - executionStartMs },
      "SEP plan extracted",
    );
    eventBus.emit("sep:plan_extracted", {
      agentId: agentId ?? "default",
      sessionKey: formattedKey,
      stepCount: steps.length,
      timestamp: clock.now(),
    });
    return plan;
  }
  return undefined;
}
