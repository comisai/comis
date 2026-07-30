// SPDX-License-Identifier: Apache-2.0
/** Current-turn evidence guard for persistent and retry-until requests. */

import type { NormalizedMessage } from "@comis/core";

const PERSISTENT_ACTION_REQUEST_PATTERNS = [
  /\b(?:keep|continue|repeat|retry)\b[\s\S]{0,120}\b(?:until|till)\b/iu,
  /\b(?:do not|don't|dont|never)\s+stop\b/iu,
];

const TERMINAL_SUCCESS_CLAIM_PATTERNS = [
  /\b(?:pass(?:ed|es)?|succeed(?:ed|s)?|successful|verified)\b/giu,
  /\b(?:done|finished|complete[d]?|ready|accomplished)\b/giu,
  /\b(?:implemented|built|created|written)\b/giu,
];

const TERMINAL_SUCCESS_NEGATION_PHRASES = [
  "not",
  "never",
  "without",
  "no",
  "do not",
  "does not",
  "did not",
  "can not",
  "cannot",
  "could not",
  "is not",
  "was not",
  "were not",
  "has not",
  "have not",
  "had not",
  "don't",
  "doesn't",
  "didn't",
  "can't",
  "couldn't",
  "isn't",
  "wasn't",
  "weren't",
  "hasn't",
  "haven't",
  "hadn't",
  "failed to",
  "fails to",
  "failing to",
  "unable to",
  "before",
] as const;

function terminalSuccessClaimIsNegated(clausePrefix: string): boolean {
  const tail = ` ${
    clausePrefix
      .toLocaleLowerCase()
      .replaceAll("’", "'")
      .trim()
      .split(/\s+/u)
      .slice(-5)
      .join(" ")
  } `;
  return TERMINAL_SUCCESS_NEGATION_PHRASES.some(
    (phrase) => tail.includes(` ${phrase} `),
  );
}

function hasUnnegatedTerminalSuccessClaim(response: string): boolean {
  for (const pattern of TERMINAL_SUCCESS_CLAIM_PATTERNS) {
    for (const match of response.matchAll(pattern)) {
      const index = match.index ?? 0;
      const prefix = response.slice(Math.max(0, index - 80), index);
      const clausePrefix = prefix
        .split(/[.!?;:\n]|\b(?:but|then|however)\b/iu)
        .at(-1) ?? prefix;
      if (!terminalSuccessClaimIsNegated(clausePrefix)) return true;
    }
  }
  return false;
}

export interface PersistentActionEvidenceGuardResult {
  response: string;
  corrected: boolean;
  reason?: "missing_current_turn_action_evidence";
}

/**
 * Accept runtime action evidence only from the exact internal completion-relay
 * identity. Ordinary cross-session messages and channel metadata cannot turn
 * prose into a current-action receipt.
 */
export function hasTrustedRuntimeActionEvidence(
  message: Pick<NormalizedMessage, "channelType" | "senderId" | "metadata">,
): boolean {
  return message.channelType === "cross-session"
    && message.senderId === "cross-session-relay"
    && message.metadata.runtimeActionEvidence?.kind
      === "background_completion";
}

/**
 * Prevent a persistent or retry-until-terminal request from being reported as
 * successful without a current tool or runtime-completion receipt.
 */
export function enforcePersistentActionEvidence(params: {
  request: string;
  response: string;
  toolExecResults?: ReadonlyArray<{
    toolName: string;
    success: boolean;
    backgrounded?: boolean;
  }>;
  currentActionEvidence?: boolean;
  honestResponse: string;
}): PersistentActionEvidenceGuardResult {
  const persistentRequest = PERSISTENT_ACTION_REQUEST_PATTERNS.some(
    (pattern) => pattern.test(params.request),
  );
  if (!persistentRequest) {
    return { response: params.response, corrected: false };
  }

  const successfulToolReceipt = (params.toolExecResults ?? []).some(
    (result) => result.success && result.backgrounded !== true,
  );
  if (successfulToolReceipt || params.currentActionEvidence === true) {
    return { response: params.response, corrected: false };
  }

  if (!hasUnnegatedTerminalSuccessClaim(params.response)) {
    return { response: params.response, corrected: false };
  }

  return {
    response: params.honestResponse,
    corrected: true,
    reason: "missing_current_turn_action_evidence",
  };
}
