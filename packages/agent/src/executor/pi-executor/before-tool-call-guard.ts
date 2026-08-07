// SPDX-License-Identifier: Apache-2.0
/**
 * createBeforeToolCallGuard — proactive tool-call safety guard.
 *
 * Takes typed safety dependencies plus optional request-evidence guards. It
 * does not follow the
 * closure-extraction `state` first-param contract because it operates
 * at the top level of the executor.
 *
 * @module
 */

import type { ExecutionBudgetWindow } from "../../budget/budget-guard.js";
import type { StepCounter } from "../step-counter.js";
import type { CircuitBreaker } from "../../safety/circuit-breaker.js";
import type { ToolRetryBreaker } from "../../safety/tool-retry-breaker.js";
import type { MessageSendLimiter } from "../../safety/message-send-limiter.js";
import type { TurnLoopDetector } from "../turn-loop-detector.js";
import { tryCatch } from "@comis/shared";
import { isCompletionClaim } from "../critic-isolation.js";
import { enforceCitationEvidence } from "../citation-evidence.js";
import {
  promptSkillReadVerdict,
  type PromptSkillReadPolicy,
} from "./prompt-skill-read-guard.js";
import {
  outboundRecipientAuthorityVerdict,
  type OutboundRecipientEvidence,
} from "../outbound-recipient-authority.js";

const TECHNICAL_TOKEN_PATTERN = /[A-Za-z][A-Za-z0-9._:/-]*/g;

export interface OutboundCompletionEvidence extends OutboundRecipientEvidence {
  readonly requestMutationToolNames: ReadonlySet<string>;
  readonly currentSuccessfulMutationCount: () => number;
  readonly onBlocked: () => void;
  /** Whether this execution has current or inherited research evidence. */
  readonly citationEvidenceEnabled?: () => boolean;
  /** Exact successful-fetch URL digests eligible for outbound citation. */
  readonly allowedCitationDigests?: () => readonly string[];
  readonly onCitationBlocked?: () => void;
}

function visibleMessageDelivery(context: unknown): string | undefined {
  if (context === null || typeof context !== "object") return undefined;
  const call = context as { toolCall?: { name?: string }; args?: unknown };
  if (call.toolCall?.name !== "message") return undefined;
  if (call.args === null || typeof call.args !== "object") return undefined;

  const args = call.args as {
    action?: unknown;
    caption?: unknown;
    text?: unknown;
  };
  const visible = args.action === "attach"
    ? args.caption
    : args.action === "send" || args.action === "reply" || args.action === "edit"
      ? args.text
      : undefined;
  return typeof visible === "string" ? visible : undefined;
}

function outboundCompletionEvidenceVerdict(
  context: unknown,
  evidence?: OutboundCompletionEvidence,
): { block: true; reason: string } | undefined {
  if (
    evidence === undefined
    || evidence.requestMutationToolNames.size === 0
    || evidence.currentSuccessfulMutationCount() > 0
  ) {
    return undefined;
  }

  const visibleDelivery = visibleMessageDelivery(context);
  if (visibleDelivery === undefined || !isCompletionClaim(visibleDelivery)) {
    return undefined;
  }

  evidence.onBlocked();
  return {
    block: true,
    reason:
      "Completion delivery blocked: this request matched mutating tools, but no "
      + "successful current-turn mutation has completed. Use a matching mutation "
      + "tool, verify the result, and then retry the message.",
  };
}

function outboundCitationEvidenceVerdict(
  context: unknown,
  evidence?: OutboundCompletionEvidence,
): { block: true; reason: string } | undefined {
  if (
    evidence?.citationEvidenceEnabled?.() !== true
    || evidence.allowedCitationDigests === undefined
  ) {
    return undefined;
  }
  const visibleDelivery = visibleMessageDelivery(context);
  if (visibleDelivery === undefined) return undefined;
  const guarded = enforceCitationEvidence({
    response: visibleDelivery,
    allowedUrlDigests: evidence.allowedCitationDigests(),
    enabled: true,
  });
  if (!guarded.corrected) return undefined;
  evidence.onCitationBlocked?.();
  return {
    block: true,
    reason:
      "Citation delivery blocked: one or more source URLs lack an exact successful "
      + "web_fetch receipt. Retry using only the exact fetched URLs.",
  };
}

function explicitModelTargets(
  sourceText: string,
  knownProviderIdentifiers?: ReadonlySet<string>,
): { models: string[]; providers: string[] } {
  const candidates = sourceText.match(TECHNICAL_TOKEN_PATTERN) ?? [];
  const providers = candidates.filter(
    (candidate) => knownProviderIdentifiers?.has(candidate.toLowerCase()) === true,
  );
  const models = candidates.filter((candidate) => {
    if (knownProviderIdentifiers?.has(candidate.toLowerCase()) === true) {
      return false;
    }
    const hasDigit = /\d/.test(candidate);
    const hasSeparator = /[._:/-]/.test(candidate);
    const compactModelId = /^[A-Za-z]{1,8}\d[A-Za-z0-9]*$/.test(candidate);
    return (hasDigit && hasSeparator) || compactModelId;
  });
  return {
    models: [...new Set(models)],
    providers: [...new Set(providers)],
  };
}

function readMutationConfig(args: unknown): Record<string, unknown> | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const params = args as { action?: unknown; config?: unknown };
  if (params.action !== "update") return undefined;
  if (params.config !== null && typeof params.config === "object") {
    return params.config as Record<string, unknown>;
  }
  if (typeof params.config !== "string") return undefined;
  const parsed = tryCatch(
    () => JSON.parse(params.config as string) as unknown,
  );
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object") {
    return undefined;
  }
  return parsed.value as Record<string, unknown>;
}

function exactBindingRetryInstruction(
  requestedProvider: string | undefined,
  requestedModel: string | undefined,
): string {
  if (requestedProvider !== undefined && requestedModel !== undefined) {
    return (
      ` Retry exactly with config.provider=${JSON.stringify(requestedProvider)} and ` +
      `config.model=${JSON.stringify(requestedModel)}.`
    );
  }
  if (requestedProvider !== undefined) {
    return ` Retry exactly with config.provider=${JSON.stringify(requestedProvider)}.`;
  }
  if (requestedModel !== undefined) {
    return ` Retry exactly with config.model=${JSON.stringify(requestedModel)}.`;
  }
  return "";
}

function explicitModelMutationVerdict(
  sourceText: string | undefined,
  context: unknown,
  knownProviderIdentifiers?: ReadonlySet<string>,
): { block: true; reason: string } | undefined {
  if (!sourceText || context === null || typeof context !== "object") return undefined;
  const call = context as { toolCall?: { name?: string }; args?: unknown };
  if (call.toolCall?.name !== "agents_manage") return undefined;
  const config = readMutationConfig(call.args);
  const proposedModel = config?.model;
  if (typeof proposedModel !== "string") return undefined;

  const targets = explicitModelTargets(sourceText, knownProviderIdentifiers);
  if (targets.models.length > 1) {
    return {
      block: true,
      reason:
        `The request contains multiple explicit model identifiers (${targets.models.join(", ")}). ` +
        "Do not infer which one to persist; ask the user to name one exact model identifier.",
    };
  }
  if (targets.providers.length > 1) {
    return {
      block: true,
      reason:
        `The request contains multiple explicit provider identifiers (${targets.providers.join(", ")}). ` +
        "Do not infer which one to persist; ask the user to name one exact provider identifier.",
    };
  }

  const requestedModel = targets.models[0];
  const requestedProvider = targets.providers[0];
  if (requestedModel === undefined && requestedProvider === undefined) return undefined;
  const proposedProvider = typeof config?.provider === "string"
    ? config.provider
    : undefined;
  if (requestedModel !== undefined) {
    const exactTargets = new Set([
      proposedModel,
      ...(proposedProvider === undefined
        ? []
        : [
            `${proposedProvider}/${proposedModel}`,
            `${proposedProvider}:${proposedModel}`,
          ]),
    ]);
    if (!exactTargets.has(requestedModel)) {
      return {
        block: true,
        reason:
          `The user explicitly requested model identifier "${requestedModel}", but this call proposes ` +
          `"${proposedModel}". Never substitute a different model identifier.` +
          exactBindingRetryInstruction(requestedProvider, requestedModel) +
          " Retry with the exact " +
          "identifier; if it is unavailable, report that without changing configuration.",
      };
    }
  }

  if (requestedProvider !== undefined && proposedProvider !== requestedProvider) {
    return {
      block: true,
      reason:
        `The user explicitly requested provider identifier "${requestedProvider}", but this call proposes ` +
        `"${proposedProvider ?? "<omitted>"}". Never omit or substitute an explicit provider identifier.` +
        exactBindingRetryInstruction(requestedProvider, requestedModel) +
        " " +
        "Retry with the exact provider and model binding; if it is unavailable, report that without changing configuration.",
    };
  }
  return undefined;
}

/**
 * Create a beforeToolCall guard that proactively blocks tool execution when
 * safety limits are already reached: step counter exhausted, budget exceeded,
 * or circuit breaker open.
 *
 * Layering: beforeToolCall is PRIMARY (prevents execution).
 * Bridge's reactive checks on tool_execution_end (step counter) and
 * turn_end (budget/circuit breaker) are FALLBACK for limits crossed
 * during execution (e.g., budget consumed by the LLM call that
 * triggered the tool, not the tool itself).
 *
 * Extracted as a named function for independent unit testing.
 */
export function createBeforeToolCallGuard(
  stepCounter: StepCounter,
  // The per-execution budget window (the shared BudgetGuard is also
  // structurally assignable). Only checkBudget(0) is used here.
  budgetGuard: ExecutionBudgetWindow,
  circuitBreaker: CircuitBreaker,
  toolRetryBreaker?: ToolRetryBreaker,
  messageSendLimiter?: MessageSendLimiter,
  turnLoopDetector?: TurnLoopDetector,
  failedToolRedirects?: ReadonlyMap<string, string>,
  explicitMutationSource?: string,
  knownProviderIdentifiers?: ReadonlySet<string>,
  outboundCompletionEvidence?: OutboundCompletionEvidence,
  promptSkillReadPolicy?: PromptSkillReadPolicy,
) {
  return async (context: unknown, _signal?: AbortSignal) => {
    // Proactive step limit check
    if (stepCounter.shouldHalt()) {
      return { block: true, reason: "Step limit reached -- blocking tool execution" };
    }
    // Proactive budget check (cost 0 = just check remaining budget)
    const budgetCheck = budgetGuard.checkBudget(0);
    if (!budgetCheck.ok) {
      return { block: true, reason: "Token budget exhausted" };
    }
    // Proactive circuit breaker check
    if (circuitBreaker.isOpen()) {
      return { block: true, reason: "Provider circuit breaker open" };
    }

    const exactModelVerdict = explicitModelMutationVerdict(
      explicitMutationSource,
      context,
      knownProviderIdentifiers,
    );
    if (exactModelVerdict) return exactModelVerdict;

    const skillReadVerdict = promptSkillReadVerdict(
      {
        sourceText: explicitMutationSource,
        policy: promptSkillReadPolicy,
      },
      context,
    );
    if (skillReadVerdict) return skillReadVerdict;

    const completionEvidenceVerdict = outboundCompletionEvidenceVerdict(
      context,
      outboundCompletionEvidence,
    );
    if (completionEvidenceVerdict) return completionEvidenceVerdict;

    const recipientAuthorityVerdict = outboundRecipientAuthorityVerdict(
      context,
      outboundCompletionEvidence,
    );
    if (recipientAuthorityVerdict) return recipientAuthorityVerdict;

    const citationEvidenceVerdict = outboundCitationEvidenceVerdict(
      context,
      outboundCompletionEvidence,
    );
    if (citationEvidenceVerdict) return citationEvidenceVerdict;

    // Short-circuit a repeat idempotent read (the loop-breaker seam).
    // The SDK's BeforeToolCallResult has only {block, reason} -- no content
    // channel -- so a short-circuit blocks the wasteful re-execution and
    // surfaces the one-line steer as the tool-result reason text the model
    // sees; the cached content is already in the model's context (it ran the
    // read earlier this turn). Placed AFTER the hard safety stops so step /
    // budget / circuit limits still take priority (they are reactive aborts).
    if (turnLoopDetector && context && typeof context === "object") {
      const ctx = context as { toolCall?: { name?: string }; args?: unknown };
      const toolName = ctx.toolCall?.name;
      if (toolName) {
        const verdict = turnLoopDetector.beforeCall(toolName, ctx.args);
        if (verdict.kind === "short_circuit") {
          return { block: true, reason: verdict.steer };
        }
      }
    }

    // A structured terminal failure can redirect the rest of this execution to
    // a capability that was live when the failure occurred. This runs before
    // the threshold-based retry breaker because the source tool has already
    // reported the exact error state declared terminal by its metadata.
    if (failedToolRedirects && context && typeof context === "object") {
      const ctx = context as { toolCall?: { name?: string } };
      const toolName = ctx.toolCall?.name;
      const redirect = toolName
        ? failedToolRedirects.get(toolName)
        : undefined;
      if (redirect) return { block: true, reason: redirect };
    }

    // Tool retry breaker check -- block tools after repeated failures
    if (toolRetryBreaker && context && typeof context === "object") {
      const ctx = context as { toolCall?: { name?: string }; args?: unknown };
      const toolName = ctx.toolCall?.name;
      const args = ctx.args;
      if (toolName && args && typeof args === "object") {
        const verdict = toolRetryBreaker.beforeToolCall(toolName, args as Record<string, unknown>);
        if (verdict.block) {
          return { block: true, reason: verdict.reason ?? "Tool blocked by retry breaker" };
        }
      }
    }

    // Per-execution message send limiter -- prevent spam
    if (messageSendLimiter && context && typeof context === "object") {
      const ctx = context as { toolCall?: { name?: string }; args?: unknown };
      const toolName = ctx.toolCall?.name;
      const args = ctx.args;
      if (toolName && args && typeof args === "object") {
        const verdict = messageSendLimiter.check(toolName, args as Record<string, unknown>);
        if (verdict) return verdict;
      }
    }

    return undefined; // allow execution
  };
}
