// SPDX-License-Identifier: Apache-2.0
/**
 * Output-budget repair — restore an output allowance the provider SDK clamped
 * away, and make the clamp visible when it cannot be restored.
 *
 * The SDK applies its own context clamp to every request AFTER the executor has
 * resolved an output cap:
 *
 *     available = contextWindow − estimateContextTokens(context) − safety
 *     max_tokens = min(requested, max(1, available))
 *
 * The floor is ONE token. So when the SDK's estimate says the window is full,
 * a request that asked for 32768 output tokens goes onto the wire asking for 1.
 * The model then emits a single token and returns `stop_reason: max_tokens`,
 * which arrives back as a truncated turn.
 *
 * That failure is doubly misleading. The executor logs the cap it INTENDED
 * (`dynamicMax`), so the operator-visible number is never the wire number; and
 * the resulting `output_starved` reply advises raising the agent's `maxTokens`,
 * which cannot lift a clamped cap — the clamp takes the MINIMUM of the two.
 * Because the SDK's estimate counts the system prompt and every tool schema
 * while the executor's budget does not, the two layers disagree about how full
 * the window is, and only the SDK's opinion reaches the provider.
 *
 * This module runs inside the request-body `onPayload` hook, the one place that
 * sees the FINAL wire value and can still change it. It re-derives the headroom
 * from the payload actually being sent and restores a viable cap when the room
 * exists. When the room genuinely does not exist, it repairs nothing — raising
 * the cap there would trade a one-token reply for a provider rejection — and
 * warns against the context knobs instead.
 *
 * @module
 */

import type { ComisLogger } from "@comis/core";
import { estimateBlockTokens } from "./token-estimation.js";

/**
 * Smallest wire cap that can still carry a usable reply. Below this a turn is
 * starved: it can only emit a token or two before the provider stops it.
 */
export const MIN_VIABLE_WIRE_OUTPUT_TOKENS = 512;

/**
 * Room left unclaimed when re-deriving a cap, mirroring the SDK's own reserve so
 * a repaired request cannot land just over the window.
 */
const WIRE_CONTEXT_SAFETY_TOKENS = 4096;

/** Outcome of inspecting (and possibly repairing) one request's output cap. */
export interface OutputBudgetVerdict {
  /** The cap found on the payload, i.e. what the provider would have received. */
  readonly wireMaxTokens: number;
  /** True when the wire cap was too small to carry a reply. */
  readonly starved: boolean;
  /** The cap written back onto the payload, when a repair was possible. */
  readonly repairedTo?: number;
  /** Estimated input tokens for the payload as sent. */
  readonly inputEstimate: number;
}

/**
 * Repair a request body's output cap in place and return it.
 *
 * Call-site facade over {@link repairStarvedOutputBudget}: reads the executor's
 * resolved cap off the stream options and the window off the model, so the
 * payload pipeline can finish with a single expression.
 *
 * @param payload - The provider request body, mutated in place on repair
 * @param options - Stream options carrying the executor's resolved `maxTokens`
 * @param model - The resolved model, carrying `contextWindow`
 * @param logger - Logger for the starvation warning
 * @returns The same payload reference
 */
export function repairPayloadOutputBudget(
  payload: Record<string, unknown>,
  options: unknown,
  model: unknown,
  logger: ComisLogger,
): Record<string, unknown> {
  repairStarvedOutputBudget({
    payload,
    intendedMaxTokens: (options as { maxTokens?: number } | undefined)?.maxTokens,
    contextWindow: (model as { contextWindow?: number } | undefined)?.contextWindow,
    logger,
  });
  return payload;
}

/** Sum estimated tokens across one payload field's blocks. */
function estimateField(value: unknown): number {
  if (typeof value === "string") return estimateBlockTokens({ text: value });
  if (!Array.isArray(value)) {
    return value === undefined || value === null
      ? 0
      : estimateBlockTokens(value as Record<string, unknown>);
  }
  let total = 0;
  for (const entry of value) {
    if (typeof entry === "string") {
      total += estimateBlockTokens({ text: entry });
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    // Messages nest their blocks under `content`; everything else (system
    // blocks, tool schemas) is estimated whole.
    total += "content" in record
      ? estimateField(record.content)
      : estimateBlockTokens(record);
  }
  return total;
}

/**
 * Estimate the input tokens of an API payload as it will go onto the wire.
 *
 * Counts the system prompt, every message block AND every tool schema — the
 * tool schemas are the term the executor's own budget omits, and on an agent
 * carrying a large tool surface they are what pushes the SDK's estimate past
 * the window.
 *
 * @param payload - The provider request body
 * @returns Estimated input tokens
 */
export function estimatePayloadInputTokens(payload: Record<string, unknown>): number {
  return (
    estimateField(payload.system)
    + estimateField(payload.messages)
    + estimateField(payload.tools)
  );
}

/**
 * Inspect a request's output cap and restore it when the SDK clamped it away.
 *
 * Mutates `payload.max_tokens` in place when a viable cap can be re-derived.
 *
 * @param args.payload - The provider request body, mutated in place on repair
 * @param args.intendedMaxTokens - The cap the executor resolved for this call
 * @param args.contextWindow - The model's context window, when known
 * @param args.logger - Logger for the starvation warning
 * @returns The verdict, or undefined when the payload carries no numeric cap
 */
export function repairStarvedOutputBudget(args: {
  payload: Record<string, unknown>;
  intendedMaxTokens?: number | undefined;
  contextWindow?: number | undefined;
  logger: ComisLogger;
}): OutputBudgetVerdict | undefined {
  const { payload, intendedMaxTokens, contextWindow, logger } = args;
  const wireMaxTokens = payload.max_tokens;
  if (typeof wireMaxTokens !== "number" || !Number.isFinite(wireMaxTokens)) return undefined;

  if (wireMaxTokens >= MIN_VIABLE_WIRE_OUTPUT_TOKENS) {
    return { wireMaxTokens, starved: false, inputEstimate: 0 };
  }

  const inputEstimate = estimatePayloadInputTokens(payload);
  const headroom = contextWindow !== undefined && Number.isFinite(contextWindow)
    ? contextWindow - inputEstimate - WIRE_CONTEXT_SAFETY_TOKENS
    : 0;
  const target = intendedMaxTokens !== undefined
    ? Math.min(intendedMaxTokens, headroom)
    : headroom;
  const repairable = target >= MIN_VIABLE_WIRE_OUTPUT_TOKENS;

  if (repairable) payload.max_tokens = target;

  logger.warn(
    {
      wireMaxTokens,
      ...(intendedMaxTokens !== undefined && { intendedMaxTokens }),
      ...(contextWindow !== undefined && { contextWindow }),
      inputEstimate,
      headroom,
      ...(repairable && { repairedTo: target }),
      errorKind: "resource" as const,
      hint: repairable
        ? "The provider SDK clamped this call's output cap to "
          + `${wireMaxTokens} because its own context estimate (system prompt + all tool schemas + messages) `
          + "reported the window full, which would have truncated the reply after a token or two. "
          + `Restored to ${target} from the payload's real headroom. Raising the agent's maxTokens would NOT `
          + "have helped: the clamp takes the minimum of the two."
        : "The provider SDK clamped this call's output cap to "
          + `${wireMaxTokens} and the payload's own input (~${inputEstimate} tokens against a `
          + `${contextWindow ?? "unknown"}-token window) leaves no room to restore it, so the cap was left as sent. `
          + "This is a context-budget problem, not an output-cap one: reduce the assembled input "
          + "(compaction, history horizon) or the agent's tool surface. Raising maxTokens cannot help.",
    },
    repairable ? "Restored a clamped output budget" : "Output budget clamped with no room to restore",
  );

  return {
    wireMaxTokens,
    starved: true,
    ...(repairable && { repairedTo: target }),
    inputEstimate,
  };
}
