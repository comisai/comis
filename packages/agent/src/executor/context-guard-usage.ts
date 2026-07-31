// SPDX-License-Identifier: Apache-2.0
/**
 * Resolves the context measurement used by the post-turn safety guard.
 *
 * The SDK session retains the lossless live transcript while the LCD context
 * engine ships a bounded assembled request. Once assembly has run, guarding the
 * unassembled transcript can abort a request that already fits the model window.
 */
import type { ContextUsageData } from "../safety/context-window-guard.js";

export interface ContextGuardUsageInput {
  assembledInputTokens: number;
  effectiveWindow: number;
  getSdkUsage: () => ContextUsageData | undefined;
}

export function resolveContextGuardUsage(
  input: ContextGuardUsageInput,
): ContextUsageData | undefined {
  if (
    Number.isFinite(input.assembledInputTokens) &&
    input.assembledInputTokens > 0 &&
    Number.isFinite(input.effectiveWindow) &&
    input.effectiveWindow > 0
  ) {
    return {
      tokens: input.assembledInputTokens,
      contextWindow: input.effectiveWindow,
      percent: (input.assembledInputTokens / input.effectiveWindow) * 100,
      source: "assembled",
    };
  }

  const sdkUsage = input.getSdkUsage();
  return sdkUsage === undefined ? undefined : { ...sdkUsage, source: "sdk" };
}
