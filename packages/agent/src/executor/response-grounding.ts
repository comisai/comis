// SPDX-License-Identifier: Apache-2.0
/** Deterministic grounding for agent configuration and self-authority replies. */

import { isCompletionClaim } from "./critic-isolation.js";

export { enforceCitationEvidence } from "./citation-evidence.js";
export type { CitationEvidenceGuardResult } from "./citation-evidence.js";

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

export interface RuntimeSelfReportEvidenceGuardResult {
  response: string;
  corrected: boolean;
  reason?:
    | "missing_runtime_self_report_evidence"
    | "unsupported_runtime_self_report_evidence"
    | "unsupported_outage_receipt_evidence";
}

const OUTAGE_RECEIPT_REQUEST_PATTERN =
  /\b(?:did|have) (?:you|u) (?:receive|get|see|process)\b[^?\n]{0,120}\b(?:message|update|request)\b[^?\n]{0,120}\b(?:while|when) (?:you|u|the (?:daemon|service|system)) (?:were|was) (?:down|offline|restarting)\b/iu;

const RUNTIME_SELF_REPORT_REQUEST_PATTERNS = [
  /\bwhat (?:did|have) (?:you|u) (?:even )?(?:do|done)\b/iu,
  /\bwhat (?:have (?:you|u)|did (?:you|u)) (?:actually )?(?:accomplish(?:ed)?|work(?:ed)? on)\b/iu,
  /\bhow much (?:(?:have|did) )?(?:you|u) cost(?: me| us)?\b/iu,
  /\bwhy (?:were|are) (?:you|u) (?:so )?(?:slow|expensive)\b/iu,
  /\bwhy was (?:that|this|it) so slow\b/iu,
  /\bwhy was the slowest\b[^?\n]{0,80}\bslow\b/iu,
  /\b(?:resume|recover|continue)\b[^?\n]{0,120}\b(?:durable|background|pipeline|graph|job|task|work)\b[^?\n]{0,120}\b(?:after|across|through)\b[^?\n]{0,30}\b(?:the )?(?:daemon |service |system )?restart\b/iu,
  /\b(?:give|show|tell)\b[^?\n]{0,100}\b(?:answer|decision|output|result|verdict)\b[^?\n]{0,120}\b(?:after|because|even if|when)\b[^?\n]{0,80}\b(?:(?:graph|pipeline|source) )?node\b[^?\n]{0,50}\b(?:cancelled|completed|failed|stopped)\b/iu,
  OUTAGE_RECEIPT_REQUEST_PATTERN,
  /\bhow many\b[^?\n]{0,80}\b(?:did|have) (?:you|u)\b/iu,
  /\b(?:cost|total)\b[^?\n]{0,100}\bbecause\b[^?\n]{0,80}\b(?:was|were) down\b[^?\n]{0,30}\b(?:right|correct|yeah)\b/iu,
  /\b(?:you|u) only (?:did|used)\b[^?\n]{0,80}\b(?:turns?|calls?|tokens?|sessions?)\b[^?\n]{0,100}\b(?:confirm|right|correct|yeah)\b/iu,
  /\b(?:slowness|latency|delay)\b[^?\n]{0,160}\b(?:cost|total)\b[^?\n]{0,60}\b(?:right|correct|confirm|yeah)\b/iu,
];

/** Whether the user explicitly asks the agent to report its own runtime activity. */
export function isRuntimeSelfReportRequest(request: string): boolean {
  return RUNTIME_SELF_REPORT_REQUEST_PATTERNS.some((pattern) => pattern.test(request));
}

/**
 * Require a successful current-turn observability receipt for runtime work,
 * cause, count, or spend reports. Conversation history records prior prose,
 * not the authoritative diagnostic or billing state.
 */
export function enforceRuntimeSelfReportEvidence(params: {
  request: string;
  response: string;
  toolExecResults?: ReadonlyArray<{
    toolName: string;
    success: boolean;
    observabilityEvidenceLimits?: {
      cost?: "runtime_estimate";
      providerInvoice?: "unverified";
      crossExecutionDurationRanking?: "unavailable";
    };
  }>;
  honestResponse: string;
  unsupportedResponse?: string;
}): RuntimeSelfReportEvidenceGuardResult {
  if (!isRuntimeSelfReportRequest(params.request)) {
    return { response: params.response, corrected: false };
  }
  const evidence = (params.toolExecResults ?? []).findLast(
    (result) => result.toolName === "obs_query" && result.success,
  );
  if (params.response === params.honestResponse) {
    return { response: params.response, corrected: false };
  }
  if (evidence === undefined) {
    return {
      response: params.honestResponse,
      corrected: true,
      reason: "missing_runtime_self_report_evidence",
    };
  }

  const normalizedResponse = normalizedEvidenceText(params.response);
  const admitsOutageReceiptUncertainty =
    /\b(?:cannot|can't|could not|couldn't|did not|didn't|unable|unverified|not verified|does not prove|no (?:current )?(?:evidence|receipt))\b/iu.test(normalizedResponse);
  const claimsOutageReceipt =
    /\b(?:i|we) (?:received|got|saw|processed|accepted)\b|\b(?:message|update|request|it) (?:was )?(?:received|processed|accepted)\b/iu.test(normalizedResponse);
  if (
    OUTAGE_RECEIPT_REQUEST_PATTERN.test(params.request)
    && claimsOutageReceipt
    && !admitsOutageReceiptUncertainty
  ) {
    return {
      response: params.honestResponse,
      corrected: true,
      reason: "unsupported_outage_receipt_evidence",
    };
  }

  const limits = evidence.observabilityEvidenceLimits;
  const asksForSlowest = /\bslowest\b/iu.test(params.request);
  const asksForCost = /\b(?:cost|spend|spent|expensive)\b/iu.test(params.request);
  const qualifiesEstimate = /\b(?:runtime )?estimate(?:d)?\b/iu.test(normalizedResponse);
  const qualifiesProviderInvoice =
    /\b(?:provider|actual) (?:invoice|bill(?:ing)?)\b/iu.test(normalizedResponse)
    && /\b(?:unverified|cannot verify|can't verify|not verified|unavailable)\b/iu.test(normalizedResponse);
  const unsupportedDuration =
    asksForSlowest
    && limits?.crossExecutionDurationRanking === "unavailable";
  // Either qualifier settles the authority question: naming the figure a runtime
  // estimate already withholds the provider-invoice claim. Demanding both
  // phrases discarded correct, qualified answers such as
  // "this turn cost about $0.04 (runtime estimate)".
  const unsupportedCost =
    asksForCost
    && limits?.cost === "runtime_estimate"
    && limits.providerInvoice === "unverified"
    && !qualifiesEstimate
    && !qualifiesProviderInvoice;
  if (unsupportedDuration || unsupportedCost) {
    return {
      response: params.unsupportedResponse ?? params.honestResponse,
      corrected: true,
      reason: "unsupported_runtime_self_report_evidence",
    };
  }
  return { response: params.response, corrected: false };
}

export interface SchedulerStateEvidenceGuardResult {
  response: string;
  corrected: boolean;
  reason?: "missing_scheduler_state_evidence" | "pending_scheduler_confirmation";
}

const SCHEDULER_STATE_SUBJECTS = [
  "reminder",
  "alarm",
  "timer",
  "cron job",
  "scheduled job",
  "scheduled task",
];

const SCHEDULER_STATE_PREDICATES = [
  " is active",
  " is already active",
  " is created",
  " is already created",
  " is scheduled",
  " is already scheduled",
  " is set",
  " is already set",
  " was active",
  " was already active",
  " was created",
  " was already created",
  " was scheduled",
  " was already scheduled",
  " was set",
  " was already set",
  " has been created",
  " has been scheduled",
  " has been set",
  " had been created",
  " had been scheduled",
  " had been set",
];

const SCHEDULER_STATE_TERMINATORS = [" ", ".", ",", "!", "?", ":", ";", "—", "-"];

const SCHEDULER_MUTATION_CONFIRMATION = /\b(?:confirmed|updated|done|scheduled|set)\b/u;
const SCHEDULER_DIRECT_CONFIRMATION = /\b(?:confirmed|updated|scheduled|set)\b/u;
const SCHEDULER_FUTURE_BEHAVIOR =
  /\b(?:will\s+)?(?:not\s+)?(?:run(?:s|ning)?|fir(?:e|es|ing)|send(?:s|ing)?|deliver(?:s|ing)?|skip(?:s|ping)?)\b(?!\s+(?:are|were)\b)/u;
const SCHEDULER_TEMPORAL_CONTEXT =
  /\b(?:hourly|daily|weekly|monthly|weekdays?|weekends?|holidays?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b\d{1,2}:\d{2}\b|\b(?:a\.?m\.?|p\.?m\.?)\b/u;
const SCHEDULER_POLICY_TEMPORAL_CONTEXT = /\b(?:weekdays?|weekends?|holidays?)\b/u;

const SCHEDULER_STATE_EVIDENCE_ACTIONS = new Set([
  "add",
  "update",
  "list",
  "status",
  "runs",
  "run",
]);

type SchedulerPolicyEvidence = "holiday" | "weekday" | "weekend";

function schedulerPolicyClaims(text: string): readonly SchedulerPolicyEvidence[] {
  if (!SCHEDULER_FUTURE_BEHAVIOR.test(text)) return [];
  const claims: SchedulerPolicyEvidence[] = [];
  if (/\bholidays?\b/u.test(text)) claims.push("holiday");
  if (/\bweekdays?\b/u.test(text)) claims.push("weekday");
  if (/\bweekends?\b/u.test(text)) claims.push("weekend");
  return claims;
}

/**
 * Require a current-turn scheduler receipt before preserving affirmative prose
 * about an existing reminder or scheduled job. Conversation history records
 * what was once reported, not whether the mutable scheduler still contains it.
 */
export function enforceSchedulerStateEvidence(params: {
  response: string;
  toolExecResults?: ReadonlyArray<{
    toolName: string;
    action?: string;
    success: boolean;
    requiresConfirmation?: boolean;
    schedulerPolicyEvidence?: readonly SchedulerPolicyEvidence[];
  }>;
  honestResponse: string;
  pendingConfirmationResponse?: string;
}): SchedulerStateEvidenceGuardResult {
  const normalizedResponse = normalizedEvidenceText(params.response);
  const explicitStateClaim = SCHEDULER_STATE_SUBJECTS.some(
    (subject) => SCHEDULER_STATE_PREDICATES.some(
      (predicate) => SCHEDULER_STATE_TERMINATORS.some(
        (terminator) => normalizedResponse.includes(` ${subject}${predicate}${terminator}`),
      ),
    ),
  );
  const futureBehaviorClaim =
    SCHEDULER_MUTATION_CONFIRMATION.test(normalizedResponse)
    && SCHEDULER_FUTURE_BEHAVIOR.test(normalizedResponse)
    && SCHEDULER_TEMPORAL_CONTEXT.test(normalizedResponse);
  const temporalPolicyConfirmation =
    SCHEDULER_DIRECT_CONFIRMATION.test(normalizedResponse)
    && SCHEDULER_POLICY_TEMPORAL_CONTEXT.test(normalizedResponse);
  const policyClaims = schedulerPolicyClaims(normalizedResponse);
  const claimsCurrentSchedulerState =
    explicitStateClaim
    || futureBehaviorClaim
    || temporalPolicyConfirmation
    || policyClaims.length > 0;
  if (!claimsCurrentSchedulerState) {
    return { response: params.response, corrected: false };
  }
  const pendingRemovalConfirmation = (params.toolExecResults ?? []).some(
    (result) =>
      result.toolName === "cron"
      && result.action === "remove"
      && result.success
      && result.requiresConfirmation === true,
  );
  if (pendingRemovalConfirmation) {
    return {
      response: params.pendingConfirmationResponse ?? params.honestResponse,
      corrected: true,
      reason: "pending_scheduler_confirmation",
    };
  }
  const stateReceipts = (params.toolExecResults ?? []).filter(
    (result) =>
      result.toolName === "cron"
      && result.success
      && result.action !== undefined
      && SCHEDULER_STATE_EVIDENCE_ACTIONS.has(result.action),
  );
  const policyReceipt = stateReceipts.findLast(
    (result) => result.action === "add" || result.action === "update" || result.action === "list",
  );
  const hasPolicyEvidence = policyClaims.length === 0
    || policyReceipt?.action === "add"
    || policyReceipt?.action === "update"
    || (
      policyReceipt?.action === "list"
      && policyClaims.every((claim) => policyReceipt.schedulerPolicyEvidence?.includes(claim) === true)
    );
  const hasEvidence = stateReceipts.length > 0 && hasPolicyEvidence;
  return hasEvidence
    ? { response: params.response, corrected: false }
    : {
        response: params.honestResponse,
        corrected: true,
        reason: "missing_scheduler_state_evidence",
      };
}

export interface CompletionEvidenceGuardResult {
  response: string;
  corrected: boolean;
  reason?: "unrecovered_tool_failure_completion_claim";
  correction?: "replaced" | "prefixed_partial";
}

/**
 * Ground affirmative completion prose when the recovery-aware terminal tool
 * inventory still contains a failure. Read-only partial results can remain
 * beneath an explicit runtime warning; all other responses are replaced. A
 * later matching success removes the tool from this input before the guard
 * runs, so recovered attempts remain eligible for ordinary completion replies.
 */
export function enforceCompletionEvidence(params: {
  response: string;
  unrecoveredToolFailures?: readonly string[];
  honestResponse: string;
  preservePartialResponse?: boolean;
}): CompletionEvidenceGuardResult {
  if (
    (params.unrecoveredToolFailures?.length ?? 0) === 0
    || !isCompletionClaim(params.response)
  ) {
    return { response: params.response, corrected: false };
  }
  if (params.preservePartialResponse === true) {
    return {
      response: `${params.honestResponse}\n\n${params.response}`,
      corrected: true,
      reason: "unrecovered_tool_failure_completion_claim",
      correction: "prefixed_partial",
    };
  }
  return {
    response: params.honestResponse,
    corrected: true,
    reason: "unrecovered_tool_failure_completion_claim",
    correction: "replaced",
  };
}

export interface OutboundAudioEvidenceGuardResult {
  response: string;
  corrected: boolean;
  reason?: "missing_outbound_audio_evidence";
}

const OUTBOUND_AUDIO_REQUEST_PATTERNS = [
  /^\s*(?:please\s+)?(?:say|read|speak)\b[\s\S]{0,160}\b(?:out\s+loud|aloud)\b/iu,
  /\b(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?(?:say|read|speak)\b[\s\S]{0,160}\b(?:out\s+loud|aloud)\b/iu,
  /^\s*(?:please\s+)?(?:send|reply|respond)\b[\s\S]{0,100}\b(?:voice|audio)(?:\s+(?:message|note|reply))?\b/iu,
  /\b(?:can|could|would|will)\s+(?:you|u)\b[\s\S]{0,100}\b(?:send|reply|respond)\b[\s\S]{0,100}\b(?:voice|audio)\b/iu,
  /^\s*(?:please\s+)?(?:turn|convert)\b[\s\S]{0,160}\b(?:into|to)\s+(?:an?\s+)?(?:audio|voice|speech)\b/iu,
] as const;

const OUTBOUND_AUDIO_SUCCESS_CLAIM_PATTERNS = [
  /\b(?:i|we)(?:'ve| have)?\s+(?:said|spoke|read|sent|delivered|synthesi[sz]ed|recorded)\b/iu,
  /\b(?:voice|audio)(?:\s+(?:message|note|reply))?\s+(?:(?:was|is|has been)\s+)?(?:sent|delivered|synthesi[sz]ed|recorded|attached|ready)\b/iu,
] as const;

const OUTBOUND_AUDIO_LIMITATION =
  /\b(?:could not|couldn't|cannot|can't|did not|didn't|unable to|failed to)\b[\s\S]{0,100}\b(?:say|speak|read|send|deliver|synthesi[sz]e|record|voice|audio)\b/iu;

/**
 * Require an authoritative delivery receipt before preserving prose that says
 * a current request was spoken or delivered as audio. A background spawn is
 * only a handoff; the trusted completion relay is the receipt for that path.
 */
export function enforceOutboundAudioEvidence(params: {
  request: string;
  response: string;
  toolExecResults?: ReadonlyArray<{
    toolName: string;
    success: boolean;
    backgrounded?: boolean;
  }>;
  currentActionEvidence?: boolean;
  honestResponse: string;
}): OutboundAudioEvidenceGuardResult {
  const requested = OUTBOUND_AUDIO_REQUEST_PATTERNS.some(
    (pattern) => pattern.test(params.request),
  );
  if (!requested) return { response: params.response, corrected: false };

  const successfulSynthesis = (params.toolExecResults ?? []).some(
    (result) =>
      result.toolName === "tts_synthesize"
      && result.success
      && result.backgrounded !== true,
  );
  if (successfulSynthesis || params.currentActionEvidence === true) {
    return { response: params.response, corrected: false };
  }

  // A reply that admits the limitation is already honest about the missing
  // receipt, so it stands even when it also describes the substitute it did
  // deliver ("I couldn't send a voice note, so I've read it out as text
  // below") — that prose matches a claim pattern without claiming audio.
  // Checked BEFORE the claim patterns, as the delivery-status guard does.
  if (OUTBOUND_AUDIO_LIMITATION.test(params.response)) {
    return { response: params.response, corrected: false };
  }
  const completionClaim = isCompletionClaim(params.response);
  const audioSuccessClaim = OUTBOUND_AUDIO_SUCCESS_CLAIM_PATTERNS.some(
    (pattern) => pattern.test(params.response),
  );
  if (!completionClaim && !audioSuccessClaim) {
    return { response: params.response, corrected: false };
  }

  return {
    response: params.honestResponse,
    corrected: true,
    reason: "missing_outbound_audio_evidence",
  };
}

export interface OutboundImageEvidenceGuardResult {
  response: string;
  corrected: boolean;
  reason?: "missing_outbound_image_evidence";
}

const OUTBOUND_IMAGE_REQUEST_PATTERNS = [
  /^\s*(?:please\s+)?(?:make|create|generate|draw|design|render)\b[\s\S]{0,180}\b(?:image|picture|illustration|graphic|photo)\b/iu,
  /\b(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?(?:make|create|generate|draw|design|render)\b[\s\S]{0,180}\b(?:image|picture|illustration|graphic|photo)\b/iu,
  /^\s*(?:please\s+)?(?:turn|convert)\b[\s\S]{0,160}\b(?:into|to)\s+(?:an?\s+)?(?:image|picture|illustration|graphic|photo)\b/iu,
] as const;

const OUTBOUND_IMAGE_SUCCESS_CLAIM_PATTERNS = [
  /\b(?:i|we)(?:'ve| have)?\s+(?:made|created|generated|drew|designed|rendered|sent|delivered)\b/iu,
  /\b(?:image|picture|illustration|graphic|photo)\s+(?:(?:was|is|has been)\s+)?(?:made|created|generated|drawn|designed|rendered|sent|delivered|attached|ready)\b/iu,
] as const;

const OUTBOUND_IMAGE_LIMITATION =
  /\b(?:could not|couldn't|cannot|can't|did not|didn't|unable to|failed to)\b[\s\S]{0,100}\b(?:make|create|generate|draw|design|render|send|deliver|image|picture|illustration|graphic|photo)\b/iu;

/** Require generation or trusted completion proof for current image claims. */
export function enforceOutboundImageEvidence(params: {
  request: string;
  response: string;
  toolExecResults?: ReadonlyArray<{
    toolName: string;
    success: boolean;
    backgrounded?: boolean;
  }>;
  currentActionEvidence?: boolean;
  honestResponse: string;
}): OutboundImageEvidenceGuardResult {
  const requested = OUTBOUND_IMAGE_REQUEST_PATTERNS.some(
    (pattern) => pattern.test(params.request),
  );
  if (!requested) return { response: params.response, corrected: false };

  const successfulGeneration = (params.toolExecResults ?? []).some(
    (result) =>
      result.toolName === "image_generate"
      && result.success
      && result.backgrounded !== true,
  );
  if (successfulGeneration || params.currentActionEvidence === true) {
    return { response: params.response, corrected: false };
  }

  // Same ordering as the audio guard: an admitted limitation stands even when
  // the reply also describes the substitute it delivered instead.
  if (OUTBOUND_IMAGE_LIMITATION.test(params.response)) {
    return { response: params.response, corrected: false };
  }
  const completionClaim = isCompletionClaim(params.response);
  const imageSuccessClaim = OUTBOUND_IMAGE_SUCCESS_CLAIM_PATTERNS.some(
    (pattern) => pattern.test(params.response),
  );
  if (!completionClaim && !imageSuccessClaim) {
    return { response: params.response, corrected: false };
  }

  return {
    response: params.honestResponse,
    corrected: true,
    reason: "missing_outbound_image_evidence",
  };
}

export interface OutboundDeliveryStatusEvidenceGuardResult {
  response: string;
  corrected: boolean;
  reason?: "missing_outbound_delivery_status_evidence";
}

const OUTBOUND_DELIVERY_STATUS_REQUEST_PATTERNS = [
  /^\s*did\s+(?:it|that|this)\s+(?:send|go\s+through)\s*\??\s*$/iu,
  /^\s*(?:was|has)\s+(?:it|that|this)\s+(?:sent|delivered|uploaded|posted)\s*\??\s*$/iu,
] as const;

const OUTBOUND_DELIVERY_STATUS_SUCCESS_PATTERNS = [
  /\b(?:yes|it\s+did)\b[\s\S]{0,180}\b(?:sent|delivered|went\s+through|uploaded|posted)\b/iu,
  /\b(?:was|is|has\s+been)\s+(?:sent|delivered|uploaded|posted)\s+successfully\b/iu,
] as const;

const OUTBOUND_DELIVERY_STATUS_LIMITATION =
  /\b(?:no|not|never|could\s+not|couldn't|did\s+not|didn't|was\s+not|wasn't|failed)\b[\s\S]{0,100}\b(?:send|sent|deliver|delivered|upload|uploaded|post|posted|go\s+through)\b/iu;

const OUTBOUND_DELIVERY_RECEIPT_TOOLS = new Set([
  "obs_query",
  "image_generate",
  "tts_synthesize",
  "video_generate",
]);

/** Require current evidence before preserving an elliptical delivery-status affirmation. */
export function enforceOutboundDeliveryStatusEvidence(params: {
  request: string;
  response: string;
  toolExecResults?: ReadonlyArray<{
    toolName: string;
    success: boolean;
    backgrounded?: boolean;
  }>;
  currentActionEvidence?: boolean;
  honestResponse: string;
}): OutboundDeliveryStatusEvidenceGuardResult {
  const statusRequested = OUTBOUND_DELIVERY_STATUS_REQUEST_PATTERNS.some(
    (pattern) => pattern.test(params.request),
  );
  if (!statusRequested || OUTBOUND_DELIVERY_STATUS_LIMITATION.test(params.response)) {
    return { response: params.response, corrected: false };
  }
  const affirmative = OUTBOUND_DELIVERY_STATUS_SUCCESS_PATTERNS.some(
    (pattern) => pattern.test(params.response),
  );
  if (!affirmative) return { response: params.response, corrected: false };

  const hasCurrentReceipt = (params.toolExecResults ?? []).some(
    (result) =>
      OUTBOUND_DELIVERY_RECEIPT_TOOLS.has(result.toolName)
      && result.success
      && result.backgrounded !== true,
  );
  if (hasCurrentReceipt || params.currentActionEvidence === true) {
    return { response: params.response, corrected: false };
  }
  return {
    response: params.honestResponse,
    corrected: true,
    reason: "missing_outbound_delivery_status_evidence",
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
