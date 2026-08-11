// SPDX-License-Identifier: Apache-2.0
import {
  getToolMetadata,
  scrubSecretsFromText,
  type PromptSkillCapability,
} from "@comis/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExcludeDeferralResult } from "./tool-deferral.js";

const MAX_MATCHED_SKILLS = 1;
const MIN_SHARED_TERMS = 2;
const MAX_WORKFLOW_CONTEXT_CHARS = 600;
const ROUTING_STOPWORDS: ReadonlySet<string> = new Set([
  "all", "and", "any", "are", "ask", "asks", "each", "for", "from", "give",
  "has", "have", "into", "its", "make", "need", "needs", "not", "one", "only",
  "our", "out", "some", "that", "the", "their", "then", "these", "this", "those",
  "use", "uses", "using", "want", "wants", "was", "were", "when", "where", "which",
  "with", "would", "you", "your",
]);

interface PromptSkillRequestRoutingInput {
  readonly currentRequestText: string;
  readonly requestRelevanceText: string;
  readonly priorUserRequest?: string;
  readonly skills: readonly PromptSkillCapability[];
  readonly locations?: ReadonlyMap<string, string>;
}

function terms(text: string): Set<string> {
  return new Set(
    text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)
      ?.filter((term) => term.length >= 3 && !ROUTING_STOPWORDS.has(term)) ?? [],
  );
}

/** Keep the current request intact while retaining as much preceding context as fits. */
function workflowContext(
  currentRequestText: string,
  priorUserRequest: string | undefined,
): string | undefined {
  const current = scrubSecretsFromText(currentRequestText.trim()).text;
  const prior = scrubSecretsFromText(priorUserRequest?.trim() ?? "").text;
  if (current.length === 0) {
    return prior.length === 0 ? undefined : prior.slice(0, MAX_WORKFLOW_CONTEXT_CHARS);
  }
  if (prior.length === 0 || prior === current) {
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
  const currentText = input.currentRequestText.toLocaleLowerCase();
  const currentTerms = terms(currentText);
  const relevanceText = input.requestRelevanceText.toLocaleLowerCase();
  const relevanceTerms = terms(relevanceText);
  const selectedSkills = input.skills
    .map((skill) => ({
      skill,
      currentScore: scoreSkill(currentTerms, currentText, skill),
      relevanceScore: scoreSkill(relevanceTerms, relevanceText, skill),
    }))
    .filter((entry) => entry.currentScore >= MIN_SHARED_TERMS)
    .sort((left, right) =>
      right.currentScore - left.currentScore
      || right.relevanceScore - left.relevanceScore
      || left.skill.name.localeCompare(right.skill.name)
    )
    .slice(0, MAX_MATCHED_SKILLS)
    .map((entry) => entry.skill);
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

  deferral.requestRelevantPromptSkillNames = selected;
  deferral.requestRelevantPromptSkillLocations = selectedLocations;
  const allTools = [...deferral.activeTools, ...deferral.discoveredTools];
  const availableToolNames = new Set(allTools.map((tool) => tool.name));
  const minDistinctWebFetchUrls = selectedSkills[0]?.minDistinctWebFetchUrls;
  const minDistinctWebSearchQueries = selectedSkills[0]?.minDistinctWebSearchQueries;
  const receiptToolNames = [...new Set([
    ...(minDistinctWebFetchUrls === undefined ? [] : ["web_search", "web_fetch"]),
    ...(minDistinctWebSearchQueries === undefined ? [] : ["web_search"]),
  ])].filter((name) => availableToolNames.has(name));
  const binaryWorkflowToolNames = selectedSkills.some(
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
  const mutationToolNames = workflowToolNames.length > 0
    ? deferral.requestRelevantToolNames.filter(
        (toolName) => getToolMetadata(toolName)?.isReadOnly === false,
      )
    : deferral.requestRelevantToolNames;
  deferral.requestRelevantToolNames = [...new Set([
    ...mutationToolNames,
    "read",
    ...workflowToolNames,
  ])];
  return selected;
}
