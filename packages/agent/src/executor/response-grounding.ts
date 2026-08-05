// SPDX-License-Identifier: Apache-2.0
/** Deterministic grounding for agent configuration and self-authority replies. */

import { isCompletionClaim } from "./critic-isolation.js";

function normalizedEvidenceText(value: string): string {
  return ` ${value.toLocaleLowerCase().replaceAll("’", "'").trim()} `;
}

function containsEvidencePhrase(text: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

function containsAnyToken(tokens: ReadonlySet<string>, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => tokens.has(candidate));
}

export interface ProviderModelFailureGroundingGuardResult {
  response: string;
  corrected: boolean;
  reason?: "provider_requires_model";
}

/**
 * Replace model-authored prose after the agent-management boundary reports
 * that a provider name was supplied where an exact model identifier belongs.
 *
 * This terminal code is authoritative runtime state. A model paraphrase can
 * otherwise reverse it by calling the provider a model or suggesting a
 * different, unevidenced provider. A later successful update is current-turn
 * evidence that the rejected request was corrected and suppresses replacement.
 */
export function enforceProviderModelFailureGrounding(params: {
  response: string;
  toolExecResults?: ReadonlyArray<{
    toolName: string;
    action?: string;
    success: boolean;
    failureCode?: string;
  }>;
  honestResponse: string;
}): ProviderModelFailureGroundingGuardResult {
  const results = params.toolExecResults ?? [];
  const failedIndex = results.findIndex(
    (result) =>
      result.toolName === "agents_manage"
      && result.action === "update"
      && !result.success
      && result.failureCode === "provider_requires_model",
  );
  if (failedIndex < 0) {
    return { response: params.response, corrected: false };
  }
  const recovered = results.slice(failedIndex + 1).some(
    (result) =>
      result.toolName === "agents_manage"
      && result.action === "update"
      && result.success,
  );
  if (recovered) {
    return { response: params.response, corrected: false };
  }
  return {
    response: params.honestResponse,
    corrected: true,
    reason: "provider_requires_model",
  };
}

export interface AgentUpdateNoOpGroundingGuardResult {
  response: string;
  corrected: boolean;
  reason?: "agent_update_noop_grounding";
}

/**
 * Ground the final reply in the terminal agent-update receipt.
 *
 * A successful `changed:false` result means the requested binding already
 * matched captured runtime configuration. Only the latest update receipt is
 * authoritative: a subsequent applied update or failure owns the final state
 * and is handled by its matching response path.
 */
export function enforceAgentUpdateNoOpGrounding(params: {
  response: string;
  toolExecResults?: ReadonlyArray<{
    toolName: string;
    action?: string;
    success: boolean;
    changed?: boolean;
  }>;
  honestResponse: string;
}): AgentUpdateNoOpGroundingGuardResult {
  const latestUpdate = (params.toolExecResults ?? [])
    .findLast(
      (result) =>
        result.toolName === "agents_manage"
        && result.action === "update",
    );
  if (
    latestUpdate?.success !== true
    || latestUpdate.changed !== false
    || params.response === params.honestResponse
  ) {
    return { response: params.response, corrected: false };
  }
  return {
    response: params.honestResponse,
    corrected: true,
    reason: "agent_update_noop_grounding",
  };
}

export interface OngoingWorkEvidenceGuardResult {
  response: string;
  corrected: boolean;
  reason?: "missing_ongoing_work_evidence";
}

export interface CompletionEvidenceGuardResult {
  response: string;
  corrected: boolean;
  reason?: "unrecovered_tool_failure_completion_claim";
}

/**
 * Replace affirmative completion prose when the recovery-aware terminal tool
 * inventory still contains a failure. A later matching success removes the
 * tool from this input before the guard runs, so recovered attempts remain
 * eligible for ordinary completion replies.
 */
export function enforceCompletionEvidence(params: {
  response: string;
  unrecoveredToolFailures?: readonly string[];
  honestResponse: string;
}): CompletionEvidenceGuardResult {
  if (
    (params.unrecoveredToolFailures?.length ?? 0) === 0
    || !isCompletionClaim(params.response)
  ) {
    return { response: params.response, corrected: false };
  }
  return {
    response: params.honestResponse,
    corrected: true,
    reason: "unrecovered_tool_failure_completion_claim",
  };
}

const ONGOING_WORK_CLAIM_PATTERNS = [
  /\b(?:i'm|i am|we're|we are) (?:attempting|checking|connecting|continuing|processing|running|working)\b/iu,
  /\b(?:i'm|i am|we're|we are) currently (?:attempting|checking|connecting|continuing|processing|running|working)\b/iu,
  /\bplease\s+(?:hold|wait)\b/iu,
  /\b(?:i(?:'ll| will)|we(?:'ll| will))\s+(?:let you know|update you|send (?:you )?(?:the )?result)\b/iu,
];

/**
 * Replace a terminal reply that promises continued work after a tool failure
 * when the runtime has no background receipt for this execution.
 */
export function enforceOngoingWorkEvidence(params: {
  response: string;
  toolExecResults?: ReadonlyArray<{
    toolName: string;
    success: boolean;
    backgrounded?: boolean;
  }>;
  ongoingWorkEvidence?: boolean;
  honestResponse: string;
}): OngoingWorkEvidenceGuardResult {
  const results = params.toolExecResults ?? [];
  const ongoingReceipt = params.ongoingWorkEvidence === true
    || results.some((result) => result.success && result.backgrounded === true);
  const failedStep = results.some((result) => !result.success);
  const claimsOngoingWork = ONGOING_WORK_CLAIM_PATTERNS.some(
    (pattern) => pattern.test(params.response),
  );
  if (ongoingReceipt || !failedStep || !claimsOngoingWork) {
    return { response: params.response, corrected: false };
  }
  return {
    response: params.honestResponse,
    corrected: true,
    reason: "missing_ongoing_work_evidence",
  };
}

export interface SenderAuthorityGroundingGuardResult {
  response: string;
  corrected: boolean;
  reason?: "sender_authority_overclaim";
}

const SELF_AUTHORITY_REQUEST_TERMS = [
  "access",
  "admin",
  "approval",
  "approvals",
  "authorize",
  "authorization",
  "capabilities",
  "capability",
  "change",
  "configuration",
  "need",
  "permission",
  "permissions",
  "sandbox",
  "settings",
  "skill",
  "skills",
  "tools",
  "trust",
];

const ADMINISTRATIVE_SELF_CHANGE_PHRASES = [
  "agent configuration",
  "connect to external services",
  "connecting external services",
  "connecting to external services",
  "core permissions",
  "current authorized scope",
  "install skills",
  "installed skills",
  "installing skills",
  "my access",
  "my capabilities",
  "my current permissions",
  "my own access",
  "my own permissions",
  "my permissions",
  "system settings",
  "system-level",
  "system level",
  "trust level",
];

const SENDER_AUTHORIZATION_CLAIM_PHRASES = [
  "your approval",
  "your authorization",
  "your direct approval",
  "your direct authorization",
  "your permission",
];

const SENDER_GRANT_VERBS = [
  " approve ",
  " authorize ",
  " give ",
  " grant ",
  " provide ",
];

const AUTHORITY_OBJECT_PHRASES = [
  " access ",
  " approval ",
  " approvals ",
  " authorization ",
  " permission ",
  " permissions ",
];

/**
 * Replace a below-admin self-management answer that tells the current sender
 * they can grant admin-only authority.
 */
export function enforceSenderAuthorityGrounding(params: {
  request: string;
  response: string;
  senderTrust: string;
  honestResponse: string;
}): SenderAuthorityGroundingGuardResult {
  if (params.senderTrust === "admin") {
    return { response: params.response, corrected: false };
  }

  const requestTokens = new Set(
    params.request.toLocaleLowerCase().match(/[a-z0-9]+/gu) ?? [],
  );
  const referencesAgent = containsAnyToken(
    requestTokens,
    ["u", "ur", "you", "your", "yourself"],
  );
  const concernsAuthority = containsAnyToken(
    requestTokens,
    SELF_AUTHORITY_REQUEST_TERMS,
  );
  if (!referencesAgent || !concernsAuthority) {
    return { response: params.response, corrected: false };
  }

  const response = normalizedEvidenceText(params.response);
  const describesAdministrativeSelfChange = ADMINISTRATIVE_SELF_CHANGE_PHRASES.some(
    (phrase) => response.includes(phrase),
  );
  if (!describesAdministrativeSelfChange) {
    return { response: params.response, corrected: false };
  }

  const directlyAttributesAuthorization = SENDER_AUTHORIZATION_CLAIM_PHRASES.some(
    (phrase) => response.includes(phrase),
  );
  const saysSenderCanGrant =
    containsEvidencePhrase(response, [" you ", " you'd ", " you would "])
    && containsEvidencePhrase(response, SENDER_GRANT_VERBS)
    && containsEvidencePhrase(response, AUTHORITY_OBJECT_PHRASES);
  if (!directlyAttributesAuthorization && !saysSenderCanGrant) {
    return { response: params.response, corrected: false };
  }

  return {
    response: params.honestResponse,
    corrected: true,
    reason: "sender_authority_overclaim",
  };
}

export interface ActiveModelSelfStatusGuardResult {
  response: string;
  corrected: boolean;
  reason?: "active_model_status_mismatch";
}

/** Ground an unambiguous current-model query in captured runtime identity. */
export function enforceActiveModelSelfStatus(params: {
  request: string;
  response: string;
  provider: string;
  modelId: string;
}): ActiveModelSelfStatusGuardResult {
  const tokens = new Set(params.request.toLocaleLowerCase().match(/[a-z0-9]+/gu) ?? []);
  const asksModel = tokens.has("model")
    && containsAnyToken(tokens, ["what", "which"]);
  const explicitCurrent = containsAnyToken(tokens, ["active", "current", "currently", "now"]);
  const selfUse = containsAnyToken(tokens, ["u", "ur", "you", "your"])
    && containsAnyToken(tokens, ["running", "use", "using"]);
  const actuallySelfUse = containsAnyToken(tokens, ["actual", "actually"]) && selfUse;
  const requestsChoice = containsAnyToken(tokens, [
    "better", "change", "cheaper", "choose", "pick", "recommend", "recommended", "should", "switch",
  ]);
  if (!asksModel || (!explicitCurrent && !actuallySelfUse) || requestsChoice) {
    return { response: params.response, corrected: false };
  }

  const response = params.response.toLocaleLowerCase();
  if (
    response.includes(params.provider.toLocaleLowerCase())
    && response.includes(params.modelId.toLocaleLowerCase())
  ) {
    return { response: params.response, corrected: false };
  }
  return {
    response: `${params.provider} / ${params.modelId}`,
    corrected: true,
    reason: "active_model_status_mismatch",
  };
}
