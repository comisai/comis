// SPDX-License-Identifier: Apache-2.0
/**
 * The daemon-injected OFFLINE reasoning seam builder.
 *
 * {@link runMemoryReasoning} takes an INJECTED `reason` seam (a single homogeneous
 * evidence cluster's text → typed `{ deductive, inductive }` candidates). This
 * module is the factory the daemon's `__MEMORY_REASONING__` sentinel calls to BUILD
 * that seam from a cheap resolved model — so the daemon stays thin and the two
 * specialist prompts ({@link DEDUCTIVE_PROMPT}/{@link INDUCTIVE_PROMPT}) + their
 * lenient/total parsers stay AGENT-INTERNAL (the prompt strings never cross the
 * package boundary, mirroring how {@link runMemoryConsolidation} keeps
 * `CONSOLIDATION_PROMPT` private).
 *
 * Security posture (the same anti-laundering discipline as the consolidation +
 * triple-extraction seams):
 * - Two SEPARATE cheap-model calls per cluster (one deductive, one inductive) — a
 *   single call NEVER mixes the two specialist contracts.
 * - The lenient `z.object` parsers ({@link parseDeductiveResult}/
 *   {@link parseInductiveResult}) STRIP any smuggled `trustLevel`/`supersededIds`
 *   before the value reaches the job — trust is computed in CODE by the job, NEVER
 *   chosen by the LLM.
 * - NON-FATAL: a thrown/aborted/malformed call yields an EMPTY array for that
 *   branch (the seam never throws out — the job's per-scope `fromPromise` wrap is a
 *   second belt, but the seam already degrades gracefully).
 * - Each call is BOUNDED by `maxReasoningTokens` (the per-call LLM output cap) and a
 *   wall-clock-free abort timer (the injected `clock` supplies timestamps; the
 *   abort uses the sanctioned-root `systemSetTimeout`).
 *
 * @module
 */

import { systemSetTimeout, systemClearTimeout } from "@comis/core";
import type { ClockPort, ComisLogger } from "@comis/core";
import { completeSimple } from "@earendil-works/pi-ai";
import { resolveJudgeModel, temperatureOption, type CustomCompletionsModelSpec } from "./judge-model-resolver.js";
import {
  DEDUCTIVE_PROMPT,
  INDUCTIVE_PROMPT,
  parseDeductiveResult,
  parseInductiveResult,
} from "./memory-reasoning-prompt.js";
import type { ReasoningOutput } from "./memory-reasoning-job.js";

/** Hard abort ceiling per LLM call (mirrors the consolidation-job LLM timeout). */
const LLM_TIMEOUT_MS = 120_000;

/** The cheap-model + key + bound the daemon resolves for one reasoning run. */
export interface ReasoningSeamDeps {
  /** Resolved cheap provider (the "cron" operation model — never the agent's primary). */
  provider: string;
  /** Resolved cheap model id. */
  modelId: string;
  /** The API key VALUE (resolved by NAME at the daemon; never logged here). */
  apiKey: string;
  /** Per-call LLM output bound (the cost axis). */
  maxReasoningTokens: number;
  /** Wall-clock reads — the per-message timestamp. NEVER a wall-clock global. */
  clock: ClockPort;
  /** Counts-only logger (the seam logs failures with a hint + errorKind, never bodies). */
  logger: ComisLogger;
  /** Scope tag for the failure logs. */
  agentId: string;
  /** Custom-provider model spec (resolved `/v1` baseUrl) for a keyless/local YAML provider
   *  the pi-ai catalog can't see — without it the reasoning seam skipped on keyless (the
   *  #223/DIALECTIC-FIX bug class). Optional: built-in providers omit it. */
  customModel?: CustomCompletionsModelSpec;
}

/** Pull the concatenated text parts out of a pi-ai completeSimple response. */
function extractResponseText(response: { content?: unknown[] }): string {
  let text = "";
  if (response.content && Array.isArray(response.content)) {
    for (const part of response.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as Record<string, unknown>).type === "text" &&
        "text" in part
      ) {
        text += (part as Record<string, unknown>).text;
      }
    }
  }
  return text;
}

/**
 * Build the OFFLINE reasoning seam from a cheap resolved model.
 *
 * Returns the `reason(clusterText)` function {@link runMemoryReasoning} injects: it
 * issues ONE deductive + ONE inductive cheap-model call over the cluster text, parses
 * both via the lenient/total parsers, and returns the typed {@link ReasoningOutput}.
 * A model-resolution failure, a thrown/aborted call, or a malformed payload degrades
 * to an EMPTY array for the affected branch — the seam NEVER throws out (non-fatal,
 * the same posture as the consolidation/extraction seams).
 */
export function createReasoningSeam(deps: ReasoningSeamDeps): (clusterText: string) => Promise<ReasoningOutput> {
  const { provider, modelId, apiKey, maxReasoningTokens, clock, logger, agentId, customModel } = deps;

  /** Issue one bounded, non-fatal cheap-model call; return raw text or undefined. */
  async function callModel(systemPrompt: string, clusterText: string): Promise<string | undefined> {
    let model;
    try {
      // Catalog-first, else construct from customModel (keyless/local) — #223/DIALECTIC-FIX.
      model = resolveJudgeModel(provider, modelId, customModel);
    } catch (modelErr) {
      logger.warn(
        {
          agentId,
          err: modelErr,
          errorKind: "dependency" as const,
          step: "reason" as const,
          hint: `could not resolve model ${provider}/${modelId} — skipping this reasoning call`,
        },
        "Reasoning model resolution failed (non-fatal)",
      );
      return undefined;
    }
    if (!model) {
      logger.warn(
        {
          agentId,
          errorKind: "dependency" as const,
          step: "reason" as const,
          hint: `model not found ${provider}/${modelId} — skipping this reasoning call`,
        },
        "Reasoning model not found (non-fatal)",
      );
      return undefined;
    }

    const controller = new AbortController();
    const timer = systemSetTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
      const response = await completeSimple(
        model,
        {
          systemPrompt,
          messages: [{ role: "user" as const, content: clusterText, timestamp: clock.now() }],
        },
        {
          apiKey,
          ...temperatureOption(model, 0.2),
          maxTokens: maxReasoningTokens,
          signal: controller.signal,
        },
      );
      return extractResponseText(response);
    } catch (llmErr) {
      logger.warn(
        {
          agentId,
          err: llmErr,
          errorKind: "dependency" as const,
          step: "reason" as const,
          hint: "reasoning LLM call failed/aborted — no observation from this branch",
        },
        "Reasoning LLM call failed (non-fatal)",
      );
      return undefined;
    } finally {
      systemClearTimeout(timer);
    }
  }

  return async function reason(clusterText: string): Promise<ReasoningOutput> {
    // Two specialist calls — deductive then inductive. Each is independently
    // non-fatal: a failure of one does not abort the other.
    const deductiveText = await callModel(DEDUCTIVE_PROMPT, clusterText);
    const inductiveText = await callModel(INDUCTIVE_PROMPT, clusterText);

    const deductive = deductiveText !== undefined ? parseDeductiveResult(deductiveText) : undefined;
    const inductive = inductiveText !== undefined ? parseInductiveResult(inductiveText) : undefined;

    return {
      deductive: deductive !== undefined ? [deductive] : [],
      inductive: inductive !== undefined ? [inductive] : [],
    };
  };
}
