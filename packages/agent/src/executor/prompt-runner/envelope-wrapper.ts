// SPDX-License-Identifier: Apache-2.0
/**
 * Envelope wrapping + dynamic preamble + capability-index context +
 * deferred-tools + image passthrough + RAG inline injection + skip-prompt
 * detection + user-budget parsing.
 *
 * Pure function: returns the wrapped envelope state for the downstream
 * stages (budget pre-check, retry loop, output escalation). Mutates only
 * the caller-supplied `budgetWarningRef` callback surface; no shared
 * mutable state escapes this module.
 *
 * Imports types only from `./prompt-runner-types.js` — never from
 * `./prompt-runner.js` (cycle avoidance).
 *
 * @module
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import type { ComisLogger, ErrorKind } from "@comis/core";
import { wrapExternalContent } from "@comis/core";

import { parseUserTokenBudget } from "../../budget/budget-parser.js";
import {
  createTurnBudgetTracker,
  type TurnBudgetTracker,
} from "../../budget/turn-budget-tracker.js";
import { wrapInEnvelope } from "../../envelope/message-envelope.js";
import { CHARS_PER_TOKEN_RATIO } from "../../context-engine/constants.js";
import { buildGoalAnchorBlock } from "./goal-anchor.js";
import { resolveScaffoldDefaults } from "../scaffold-defaults.js";

import type { RunPromptParams } from "./prompt-runner-types.js";

/**
 * State assembled by envelope wrapping; consumed by every downstream phase.
 * Treated as immutable by callers after construction (closure-extraction
 * protocol: helpers read from `state`, never mutate it).
 */
export interface WrappedEnvelope {
  /** Final message text after envelope wrap, preamble, RAG, image hint, budget warning. */
  messageText: string;
  /** Images to send with the prompt (only when the model supports vision). */
  promptImages: ImageContent[] | undefined;
  /** Turn budget tracker for budget-driven continuation; undefined when no user budget. */
  budgetTracker: TurnBudgetTracker | undefined;
  /** Whether the requested user budget was capped by the operator's perExecution limit. */
  budgetCapped: boolean;
  /** Original requested budget (in tokens) — undefined when no user budget. */
  requestedBudget: number | undefined;
  /** True when the message is a standalone /command (no remaining user text → skip LLM call). */
  skipPrompt: boolean;
}

/**
 * Wrap the message in the envelope and assemble all auxiliary context
 * (preamble, capability index, deferred tools, RAG inline memory, vision
 * image passthrough, user-budget parsing). Idempotent given the same params.
 */
export function wrapEnvelope(params: RunPromptParams): WrappedEnvelope {
  const {
    msg,
    deps,
    dynamicPreamble,
    deferredContext,
    capabilityIndexResult,
    inlineMemory,
    cmdResult,
    _directives,
    _prevTimestamp,
    resolvedModel,
    config,
    budgetWarningRef,
    modelProfile,
    executionPlanRef,
  } = params;

  // Wrap message text with envelope
  let messageText = deps.envelopeConfig
    ? wrapInEnvelope(msg, deps.envelopeConfig, _prevTimestamp)
    : msg.text ?? "";

  // Prepend dynamic preamble (date/time, inbound metadata)
  // relocated from system prompt for cache stability.
  // Also includes <deferred-tools> context block when deferred tools exist.
  //
  // Array-concat shape. Each element either contributes a non-empty string
  // or filters out cleanly. The renderer's EMPTY sentinel (gate-disabled OR
  // all-zero counts) yields text === "" which .filter(Boolean) drops
  // automatically.
  const capabilityIndexContext = capabilityIndexResult.text;
  const fullDynamicPreamble = [dynamicPreamble, capabilityIndexContext, deferredContext]
    .filter(Boolean)
    .join("\n\n");

  if (fullDynamicPreamble) {
    messageText = `[System context]\n${fullDynamicPreamble}\n[End system context]\n\n${messageText}`;
  }

  emitPreambleDebug(deps.logger, capabilityIndexResult, fullDynamicPreamble, deferredContext);

  // Inject top-1 RAG memory inline, adjacent to user message
  // for maximum LLM attention. Placed AFTER [End system context] and
  // BEFORE the user's actual question text.
  if (inlineMemory) {
    messageText = `${inlineMemory}\n${messageText}`;
  }

  // R1: GoalAnchor tail injection — APPENDED after user message text.
  // SD1 (Phase 158): GoalAnchor capability-gated default.
  // Effective flag = explicit config ?? capability default (small/nano=true, frontier/mid=false).
  // Precedence: explicit false on small/nano → stays OFF. explicit true on frontier → turns ON.
  // resolveScaffoldDefaults reads config.goalAnchor?.enabled which is `boolean | undefined`
  // from PerAgentConfig (the block is .optional()); do NOT re-parse through GoalAnchorConfigSchema.
  // Fail-closed when modelProfile is absent (no profile → frontier-equivalent → no injection).
  // T-153-02a: injection is bounded by maxChars (500 default); no untrusted data.
  if (
    modelProfile !== undefined &&
    resolveScaffoldDefaults(modelProfile, config).goalAnchorEnabled &&
    executionPlanRef.current?.active
  ) {
    const goalAnchorBlock = buildGoalAnchorBlock(
      executionPlanRef.current,
      (config.goalAnchor as { maxChars?: number } | undefined)?.maxChars,
    );
    if (goalAnchorBlock) {
      messageText = `${messageText}\n\n${goalAnchorBlock}`;
    }
  }

  // Extract vision-direct image content blocks for multimodal prompt
  const imageContents = Array.isArray(msg.metadata?.imageContents)
    ? (msg.metadata.imageContents as ImageContent[])
    : [];
  // L4: read supportsVision from the resolved ModelProfile (not directly from
  // resolvedModel.input). Both are set from the same config field in model-profile.ts,
  // but reading from modelProfile ensures the single-resolve-point invariant and
  // makes the vision gate testable independently of the resolved model entry.
  const modelSupportsVision = modelProfile?.supportsVision ?? false;
  let promptImages: ImageContent[] | undefined;

  if (imageContents.length > 0) {
    const totalBytes = imageContents.reduce(
      (sum, ic) => sum + Math.ceil((ic.data.length * 3) / 4), 0,
    );

    deps.logger.debug(
      { imageCount: imageContents.length, totalBytes, modelSupportsVision },
      "Evaluating image passthrough",
    );

    if (modelSupportsVision) {
      promptImages = imageContents;
      const rawHint = imageContents.length === 1
        ? "[An image is attached to this message and is visible to you. Analyze it directly — do NOT call image_analyze, you can already see it.]"
        : `[${imageContents.length} images are attached to this message and are visible to you. Analyze them directly — do NOT call image_analyze, you can already see them.]`;
      // S7: flag image-derived hint as untrusted (vision input = injection vector).
      // Apply wrapExternalContent ONLY to rawHint (not the full messageText) to
      // avoid double-wrapping already-wrapped content (memory, goal-anchor) in messageText.
      // includeWarning:false avoids visual noise — the real defense is the canary in
      // the system prompt + OutputGuard on the response, both active on all paths.
      const imageHint = wrapExternalContent(rawHint, { source: "vision", includeWarning: false });
      messageText = imageHint + "\n" + messageText;

      deps.logger.info(
        { imageCount: imageContents.length, totalBytes, visionCapable: true },
        "Image passthrough active",
      );
    } else {
      deps.logger.warn(
        {
          imageCount: imageContents.length,
          totalBytes,
          model: resolvedModel?.id,
          provider: resolvedModel?.provider,
          hint: "Images dropped because model does not support vision input; configure a vision-capable model or check agents.[name].model",
          errorKind: "config" as ErrorKind,
        },
        "Images dropped: model lacks vision capability",
      );
    }
  }

  // Skip prompt if this was a standalone /compact command (no remaining user text)
  const skipPrompt = cmdResult.hasCommandDirective && !msg.text.trim();

  // Parse user token budget directive from message text
  let budgetTracker: TurnBudgetTracker | undefined;
  let budgetCapped = false;
  let requestedBudget: number | undefined;

  // Check directives first (/budget Nk), then inline (+Nk)
  const userBudgetFromDirective = _directives?.userTokenBudget;
  const parsedInline = userBudgetFromDirective ? { tokens: undefined, cleanedText: messageText } : parseUserTokenBudget(messageText);
  const userBudgetTokens = userBudgetFromDirective ?? parsedInline.tokens;

  if (!userBudgetFromDirective && parsedInline.tokens !== undefined) {
    // Strip inline budget directive from message text sent to LLM
    messageText = parsedInline.cleanedText;
  }

  if (userBudgetTokens !== undefined) {
    requestedBudget = userBudgetTokens;
    // Effective budget = min(user, operator remaining per-execution)
    const operatorPerExecution = config.budgets?.perExecution ?? Infinity;
    const operatorSnapshot = deps.budgetGuard.getSnapshot();
    const operatorRemaining = operatorPerExecution - operatorSnapshot.perExecution;
    const effectiveBudget = Math.min(userBudgetTokens, Math.max(0, operatorRemaining));

    budgetCapped = effectiveBudget < userBudgetTokens;
    if (budgetCapped) {
      deps.logger.info(
        { requestedBudget: userBudgetTokens, effectiveBudget, operatorPerExecution },
        "User budget capped by operator limit",
      );
    }

    budgetTracker = createTurnBudgetTracker(effectiveBudget);
    deps.logger.info(
      { targetTokens: effectiveBudget, requestedBudget: userBudgetTokens, capped: budgetCapped },
      "User token budget active",
    );
  }

  // Budget trajectory warning: inject system warning when approaching exhaustion
  // (applied AFTER budget parsing so the warning text rides on the cleaned messageText)
  if (budgetWarningRef?.current) {
    messageText = `[System: Token budget is running low (~2 calls remaining). Wrap up now: deliver your answer, summarize progress, note blockers. Do NOT start new multi-step operations.]\n\n${messageText}`;
  }

  return {
    messageText,
    promptImages,
    budgetTracker,
    budgetCapped,
    requestedBudget,
    skipPrompt,
  };
}

/**
 * Pino debug log for the assembled dynamic preamble. `deps.logger.child({
 * submodule })` attaches the submodule label only at this call site, not
 * module-scope. Kept as a private helper so the main
 * `wrapEnvelope` body stays under the 250L mental complexity ceiling.
 */
function emitPreambleDebug(
  logger: ComisLogger,
  capabilityIndexResult: RunPromptParams["capabilityIndexResult"],
  fullDynamicPreamble: string,
  deferredContext: string | undefined,
): void {
  const submoduleLogger = logger.child({ submodule: "executor.capability-index" });
  const fullPreambleTokens = Math.ceil((fullDynamicPreamble ?? "").length / CHARS_PER_TOKEN_RATIO);
  const deferredContextTokens = Math.ceil((deferredContext ?? "").length / CHARS_PER_TOKEN_RATIO);

  submoduleLogger.debug(
    {
      capabilityIndexTokens: capabilityIndexResult.capabilityIndexTokens,
      deferredContextTokens,
      fullPreambleTokens,
      clusterCount: capabilityIndexResult.clusterCount,
      // W6 (obs-llm-troubleshooting): cluster-view counts get their OWN payload
      // names — the bare activeToolCount/deferredToolCount keys collided with the
      // executor-wide counts (agent-execute logs activeToolCount=83 while this
      // cluster view logs 24), making the two lines read as contradictory.
      capabilityIndexActiveTools: capabilityIndexResult.activeToolCount,
      capabilityIndexDeferredTools: capabilityIndexResult.deferredToolCount,
      promptSkillCount: capabilityIndexResult.promptSkillCount,
    },
    "Dynamic preamble assembled",
  );
}
