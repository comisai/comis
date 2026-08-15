// SPDX-License-Identifier: Apache-2.0
import {
  scrubSecretsFromText,
  type PromptSkillCapability,
} from "@comis/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExcludeDeferralResult } from "./tool-deferral.js";

const MAX_MATCHED_SKILLS = 1;
const MIN_SHARED_TERMS = 2;
/**
 * Disclosure and ENFORCEMENT are separate decisions. Routing at
 * `MIN_SHARED_TERMS` only decorates the read tool with a skill location, which
 * costs nothing when the guess is wrong. A skill's required binary workflow or
 * web-evidence floor is a completion REQUIREMENT: unmet receipts end the turn as
 * a tool-invocation stall and the model's answer is discarded. A broad
 * description ("understand", "explain", "reports", "documentation", …) shares
 * the bare two-term minimum with ordinary local-context prose, so that weakest
 * admissible signal must not arm a destructive workflow — above it, the request
 * is speaking the skill's own vocabulary, and naming the skill outright always
 * clears it.
 */
const MIN_WORKFLOW_ENFORCEMENT_SHARED_TERMS = MIN_SHARED_TERMS + 1;
const MAX_WORKFLOW_CONTEXT_CHARS = 600;
const PRIOR_REQUEST_REFERENCE_PATTERN =
  /\b(?:again|continue|earlier|former|it|its|latter|one|ones|previous|same|something|that|them|these|this|those)\b/iu;
const CONVERSATION_HISTORY_RECALL_PATTERN =
  /\bwhat\s+(?:did|have)\s+i\s+(?:say|tell|mention|ask)\b/iu;
const WEB_EVIDENCE_EXCLUSION_PATTERN =
  /\b(?:(?:do\s+not|don't|never)\s+(?:(?:(?:use|call|invoke|rely\s+on)\s+(?!only\b)(?:the\s+)?(?:web(?:\s+(?:search|fetch|sources?|tools?))?|web_search|web_fetch)|(?:browse|web\s+(?:search|fetch)|web_search|web_fetch))|(?:[\p{L}\p{N}_'-]+\s+){1,8}(?:or|nor)\s+(?:(?:use|call|invoke|rely\s+on)\s+(?!only\b)(?:the\s+)?(?:web(?:\s+(?:search|fetch|sources?|tools?))?|web_search|web_fetch)|(?:browse|web\s+(?:search|fetch)|web_search|web_fetch)))|without\s+(?:using\s+)?(?:the\s+)?(?:web(?:\s+(?:search|fetch|sources?|tools?))?|web_search|web_fetch)|no\s+(?:web(?:\s+(?:search|fetch|sources?|tools?))?|web_search|web_fetch))\b/iu;
const DELEGATED_CHILD_ASSIGNMENT_PATTERN =
  /(?<!-)\b(?:(?:delegate|use|start|spawn|launch)\b(?=[^\n]{0,240}\b(?:sub-?agents?|child|children|coordinator|leaf)\b)|(?:ask|tell|instruct|require)\s+(?:the\s+)?(?:sub-?agents?|child|children|coordinator|leaf)\b|give\s+(?:the\s+)?(?:sub-?agents?|child|children|coordinator|leaf)\b[^.!?\n]{0,80}\btask\b|(?:call|invoke|use)\s+sessions_spawn\b[^.!?\n]{0,160}\btask\b)/iu;
const EXPLICIT_DELEGATION_PATTERN =
  /\b(?:sessions_spawn|sub-?agents?|child|children|coordinator|leaf)\b/iu;
const DELEGATED_CHILD_CONTINUATION_PATTERN =
  /\b(?:have\s+(?:the\s+)?(?:sub-?agents?|child|children|coordinator|leaf|it|them)\b|(?:sub-?agents?|child|children|coordinator|leaf|it|they)\s+(?:must|should)\b|require\b[^.!?\n]{0,160}\b(?:sub-?agents?|child|children|coordinator|leaf)\b|after\b[^.!?\n]{0,160}\b(?:succeeds?|completes?|finishes?)\b[^.!?\n]{0,160}\b(?:return|reply|respond)\b(?!\s+to\b)(?=[^.!?\n]{0,80}\b(?:child|exactly|file|leaf|marker|no_reply|output|result|value)\b))/iu;
const DELEGATED_TOOL_BINDING_PATTERN =
  /\b(?:expected_outputs|max_steps|required_tools|token_budget|tool_groups|worktree|task\s+(?:argument|body|parameter))\b/iu;
const DELEGATED_DELIVERY_COORDINATION_PATTERN =
  /\bafter\s+(?:the\s+)?(?:completion|launch|run)\b[^.!?\n]{0,200}\b(?:deliver|notify|report)\b/iu;
const ROUTING_STOPWORDS: ReadonlySet<string> = new Set([
  "all", "and", "any", "are", "ask", "asks", "each", "for", "from", "give",
  "has", "have", "into", "its", "make", "need", "needs", "not", "one", "only",
  "our", "out", "some", "that", "the", "their", "then", "these", "this", "those",
  "task", "tasks", "tool", "tools", "use", "uses", "using", "want", "wants", "was",
  "were", "when", "where", "which", "with", "would", "you", "your",
  // Outcome boilerplate appears in artifact contracts across unrelated domains.
  // It cannot distinguish a software procedure from an ordinary tool request.
  "completion", "result", "results", "verified", "verify",
]);

interface PromptSkillRequestRoutingInput {
  readonly currentRequestText: string;
  readonly requestRelevanceText: string;
  readonly priorUserRequest?: string;
  readonly skills: readonly PromptSkillCapability[];
  readonly locations?: ReadonlyMap<string, string>;
}

/**
 * The text the user physically supplied this turn, for intent routing only.
 *
 * Media preprocessing enriches `text` with extracted external content and
 * runtime coverage instructions, which must not decide skill selection. The
 * structured physical messages are the primary source — but a voice or media
 * turn carries an EMPTY physical text, so the trusted transcription receipt is
 * the only first-party wording a spoken request has. Without it, "research X
 * thoroughly" routed a skill when typed and routed nothing when spoken.
 */
export function physicalUserRequestText(message: {
  readonly text?: string;
  readonly originalMessages?: readonly { readonly text: string }[];
  readonly attachments?: readonly { readonly transcription?: string }[];
}): string {
  const physical = message.originalMessages?.map((original) => original.text)
    ?? [message.text ?? ""];
  const typed = physical.filter((text) => text.trim().length > 0);
  if (typed.length > 0) return typed.join("\n");
  const spoken = (message.attachments ?? [])
    .map((attachment) => attachment.transcription ?? "")
    .filter((text) => text.trim().length > 0);
  return spoken.length > 0 ? spoken.join("\n") : "";
}

function terms(text: string): Set<string> {
  return new Set(
    text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)
      ?.filter((term) => term.length >= 3 && !ROUTING_STOPWORDS.has(term)) ?? [],
  );
}

function isDelegatedNegativeConstraint(sentence: string): boolean {
  const normalized = ` ${sentence.toLocaleLowerCase().replaceAll("’", "'")} `;
  const forbidsAction = [" do not ", " don't ", " must not ", " never "].some(
    (phrase) => normalized.includes(phrase),
  );
  const introducesAlternative = [" but ", " instead ", " then use "].some(
    (phrase) => normalized.includes(phrase),
  );
  const constrainsCoordinatorExecution = [
    " directly", " finish early", " modify ", " on your own", " yourself",
  ].some((phrase) => normalized.includes(phrase));
  return forbidsAction && constrainsCoordinatorExecution && !introducesAlternative;
}

function isDelegatedCoordination(sentence: string): boolean {
  const normalized = ` ${sentence.toLocaleLowerCase().replaceAll("’", "'")} `;
  const namesDelegatedRole = [
    " sub-agent", " subagent", " child", " coordinator", " leaf", " it ", " they ",
  ].some((phrase) => normalized.includes(phrase));
  const assignsCoordinatorRole =
    normalized.includes(" act as ") && normalized.includes(" coordinator");
  const waitsForChild =
    normalized.includes(" wait for ")
    && normalized.includes(" completion")
    && namesDelegatedRole;
  const returnsCompletedChildResult =
    normalized.includes(" after ")
    && normalized.includes(" complete")
    && normalized.includes(" return ")
    && namesDelegatedRole;
  const presentsCompletedChildResult =
    (normalized.includes(" after ") || normalized.includes(" when "))
    && normalized.includes(" complete")
    && [" deliver ", " notify ", " present ", " report ", " share "].some(
      (phrase) => normalized.includes(phrase),
    )
    && namesDelegatedRole;
  const requestsLaunchAcknowledgement =
    normalized.includes(" launch ")
    && normalized.includes(" acknowledgement")
    && [" reply ", " respond "].some((phrase) => normalized.includes(phrase));
  return assignsCoordinatorRole
    || waitsForChild
    || returnsCompletedChildResult
    || presentsCompletedChildResult
    || requestsLaunchAcknowledgement;
}

function isDelegatedOutputContract(sentence: string): boolean {
  const normalized = ` ${sentence.toLocaleLowerCase().replaceAll("’", "'")} `;
  const forbidsExposure = [" do not ", " don't ", " never "].some(
    (phrase) => normalized.includes(phrase),
  ) && [" expose ", " include ", " reveal ", " show "].some(
    (phrase) => normalized.includes(phrase),
  );
  const namesRuntimeMetadata = [
    " completion-envelope", " cost ", " result-store", " runtime ", " session identifier",
    " token ", " tokens ",
  ].some((phrase) => normalized.includes(phrase));
  return forbidsExposure && namesRuntimeMetadata;
}

function stripDelegatedChildTask(text: string): string {
  const hasExplicitDelegation = EXPLICIT_DELEGATION_PATTERN.test(text);
  if (!hasExplicitDelegation) return text;

  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .filter((sentence) => (
      !DELEGATED_CHILD_ASSIGNMENT_PATTERN.test(sentence)
      && !DELEGATED_CHILD_CONTINUATION_PATTERN.test(sentence)
      && !DELEGATED_TOOL_BINDING_PATTERN.test(sentence)
      && !DELEGATED_DELIVERY_COORDINATION_PATTERN.test(sentence)
      && !isDelegatedNegativeConstraint(sentence)
      && !isDelegatedCoordination(sentence)
      && !isDelegatedOutputContract(sentence)
    ))
    .join(" ");
}

/** Exclude quoted payloads and code literals from the caller's own skill intent. */
export function routingIntentText(text: string): string {
  const unquoted = text
    .replace(/`[^`\n]+`/gu, " ")
    .replace(
      /(^|[\s,:=([])(["'])(?:(?!\2)[^\n]){2,}?\2(?=$|[\s,.;)\]])/gu,
      "$1",
    );
  // A filesystem path is a tool argument, not intent vocabulary. Letting its
  // directory names participate made `/.../real-user/...` contribute `user`
  // to a software-workflow match and armed an unrelated binary procedure.
  // Require start/whitespace/open-paren before the slash so `https://...`
  // remains ordinary request text rather than being mistaken for a path.
  const withoutAbsolutePaths = unquoted.replace(
    /(^|[\s(])(?:~\/|\/)[^\s,;)\]}]+/gu,
    "$1",
  );
  return stripDelegatedChildTask(withoutAbsolutePaths);
}

/** Retain preceding context only when the current wording refers back to it. */
function workflowContext(
  currentRequestText: string,
  priorUserRequest: string | undefined,
): string | undefined {
  const current = scrubSecretsFromText(currentRequestText.trim()).text;
  const prior = scrubSecretsFromText(priorUserRequest?.trim() ?? "").text;
  if (current.length === 0) {
    return prior.length === 0 ? undefined : prior.slice(0, MAX_WORKFLOW_CONTEXT_CHARS);
  }
  if (
    prior.length === 0
    || prior === current
    || !PRIOR_REQUEST_REFERENCE_PATTERN.test(current)
  ) {
    return current.slice(0, MAX_WORKFLOW_CONTEXT_CHARS);
  }
  const currentLabel = "Current request:\n";
  const priorLabel = "Earlier request:\n";
  const currentSection = currentLabel
    + current.slice(0, MAX_WORKFLOW_CONTEXT_CHARS - currentLabel.length);
  const priorBudget = MAX_WORKFLOW_CONTEXT_CHARS
    - currentSection.length
    - priorLabel.length
    - 1;
  return priorBudget <= 0
    ? currentSection
    : `${priorLabel}${prior.slice(0, priorBudget)}\n${currentSection}`;
}

function scoreSkill(
  queryTerms: ReadonlySet<string>,
  queryText: string,
  skill: PromptSkillCapability,
): number {
  const skillTerms = terms(`${skill.name} ${skill.summary ?? ""} ${skill.description}`);
  let score = 0;
  for (const term of skillTerms) {
    if (queryTerms.has(term)) score++;
  }
  if (queryText.includes(skill.name.toLocaleLowerCase())) score += 10;
  return score;
}

function attachSkillRoute(
  tool: ToolDefinition,
  skillNames: readonly string[],
  locations: readonly string[],
): ToolDefinition {
  return {
    ...tool,
    description:
      `${tool.description ?? "Read a workspace file."} `
      + `Request-relevant prompt skill${skillNames.length === 1 ? "" : "s"}: ${skillNames.join(", ")}. `
      + `Load the trusted registry location with this read tool before answering: ${locations.join(", ")}.`,
  };
}

/** Bridge a request-matched prompt skill to read-based progressive disclosure. */
export function applyPromptSkillRequestRouting(
  deferral: ExcludeDeferralResult,
  input: PromptSkillRequestRoutingInput,
): string[] {
  if (input.skills.length === 0) return [];
  // Conversation-history lookup is owned by context assembly and scoped
  // memory recall. Lexical overlap must not turn it into a task procedure.
  if (CONVERSATION_HISTORY_RECALL_PATTERN.test(input.currentRequestText)) return [];
  const currentText = input.currentRequestText.toLocaleLowerCase();
  const currentIntentText = routingIntentText(currentText);
  const currentTerms = terms(currentIntentText);
  const relevanceText = input.requestRelevanceText.toLocaleLowerCase();
  const relevanceIntentText = routingIntentText(relevanceText);
  const relevanceTerms = terms(relevanceIntentText);
  const selectedEntries = input.skills
    .map((skill) => ({
      skill,
      currentScore: scoreSkill(currentTerms, currentIntentText, skill),
      relevanceScore: scoreSkill(relevanceTerms, relevanceIntentText, skill),
    }))
    .filter((entry) => entry.currentScore >= MIN_SHARED_TERMS)
    .sort((left, right) =>
      right.currentScore - left.currentScore
      || right.relevanceScore - left.relevanceScore
      || left.skill.name.localeCompare(right.skill.name)
    )
    .slice(0, MAX_MATCHED_SKILLS);
  const selectedSkills = selectedEntries.map((entry) => entry.skill);
  const selected = selectedSkills.map((skill) => skill.name);
  if (selected.length === 0) return [];
  const selectedSet = new Set(selected);
  const selectedLocations = [...(input.locations ?? [])]
    .filter(([, name]) => selectedSet.has(name))
    .map(([location]) => location);
  if (selectedLocations.length === 0) return [];

  const activeIndex = deferral.activeTools.findIndex((tool) => tool.name === "read");
  const discoveredIndex = deferral.discoveredTools.findIndex((tool) => tool.name === "read");
  if (activeIndex >= 0) {
    deferral.activeTools[activeIndex] = attachSkillRoute(
      deferral.activeTools[activeIndex]!,
      selected,
      selectedLocations,
    );
  } else if (discoveredIndex >= 0) {
    deferral.discoveredTools[discoveredIndex] = attachSkillRoute(
      deferral.discoveredTools[discoveredIndex]!,
      selected,
      selectedLocations,
    );
  } else {
    return [];
  }

  const allTools = [...deferral.activeTools, ...deferral.discoveredTools];
  const availableToolNames = new Set(allTools.map((tool) => tool.name));
  // Required workflows are only enforceable when the current request matched the
  // skill above the bare disclosure minimum. Evidence floors additionally need
  // the tool that mints their receipts to be reachable. Declaring an unreachable
  // floor leaves the completion gate permanently unsatisfiable, and arming any
  // workflow on incidental description overlap discards a correct answer; both
  // end the turn with the model's reply thrown away.
  const selectedRequiresWebEvidence = selectedSkills.some(
    (skill) => skill.minDistinctWebFetchUrls !== undefined
      || skill.minDistinctWebSearchQueries !== undefined,
  );
  // Prompt skills are advisory procedures, so their evidence floors cannot
  // override an explicit current-turn constraint against that evidence source.
  // Keep the route visible on `read`, but do not make it a completion gate.
  const workflowEnforceable =
    (selectedEntries[0]?.currentScore ?? 0) >= MIN_WORKFLOW_ENFORCEMENT_SHARED_TERMS
    && !(selectedRequiresWebEvidence
      && WEB_EVIDENCE_EXCLUSION_PATTERN.test(input.currentRequestText));
  if (workflowEnforceable) {
    deferral.requestRelevantPromptSkillNames = selected;
    deferral.requestRelevantPromptSkillLocations = selectedLocations;
  }
  const minDistinctWebFetchUrls =
    workflowEnforceable && availableToolNames.has("web_fetch")
      ? selectedSkills[0]?.minDistinctWebFetchUrls
      : undefined;
  const minDistinctWebSearchQueries =
    workflowEnforceable && availableToolNames.has("web_search")
      ? selectedSkills[0]?.minDistinctWebSearchQueries
      : undefined;
  const receiptToolNames = [...new Set([
    ...(minDistinctWebFetchUrls === undefined ? [] : ["web_search", "web_fetch"]),
    ...(minDistinctWebSearchQueries === undefined ? [] : ["web_search"]),
  ])].filter((name) => availableToolNames.has(name));
  const binaryWorkflowToolNames = workflowEnforceable && selectedSkills.some(
    (skill) => (skill.requiredBins?.length ?? 0) > 0,
  )
    && allTools.some((tool) => tool.name === "exec")
    ? ["exec"]
    : [];
  const workflowToolNames = [...new Set([
    ...binaryWorkflowToolNames,
    ...receiptToolNames,
  ])];
  deferral.requestRelevantPromptSkillWorkflowToolNames = workflowToolNames;
  deferral.requestRelevantPromptSkillMinDistinctWebFetchUrls = minDistinctWebFetchUrls;
  deferral.requestRelevantPromptSkillMinDistinctWebSearchQueries =
    minDistinctWebSearchQueries;
  const context = workflowContext(input.currentRequestText, input.priorUserRequest);
  if (workflowToolNames.length > 0 && context !== undefined) {
    deferral.requestRelevantPromptSkillWorkflowContext = context;
  }
  deferral.requestRelevantToolNames = [...new Set([
    ...deferral.requestRelevantToolNames,
    ...(workflowEnforceable ? ["read", ...workflowToolNames] : []),
  ])];
  return selected;
}
