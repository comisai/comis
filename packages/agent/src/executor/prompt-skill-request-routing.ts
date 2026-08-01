// SPDX-License-Identifier: Apache-2.0
import type { PromptSkillCapability } from "@comis/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExcludeDeferralResult } from "./tool-deferral.js";

const MAX_MATCHED_SKILLS = 1;
const MIN_SHARED_TERMS = 2;

interface PromptSkillRequestRoutingInput {
  readonly capabilityClass: string;
  readonly requestRelevanceText: string;
  readonly skills: readonly PromptSkillCapability[];
  readonly locations?: ReadonlyMap<string, string>;
}

function terms(text: string): Set<string> {
  return new Set(
    text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)
      ?.filter((term) => term.length >= 3) ?? [],
  );
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

/** Bridge constrained models from a matching prompt skill to read-based disclosure. */
export function applyPromptSkillRequestRouting(
  deferral: ExcludeDeferralResult,
  input: PromptSkillRequestRoutingInput,
): string[] {
  if (input.capabilityClass !== "nano" || input.skills.length === 0) return [];
  const queryText = input.requestRelevanceText.toLocaleLowerCase();
  const queryTerms = terms(queryText);
  const selectedSkills = input.skills
    .map((skill) => ({ skill, score: scoreSkill(queryTerms, queryText, skill) }))
    .filter((entry) => entry.score >= MIN_SHARED_TERMS)
    .sort((left, right) =>
      right.score - left.score || left.skill.name.localeCompare(right.skill.name)
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
  const workflowToolNames = selectedSkills.some((skill) => (skill.requiredBins?.length ?? 0) > 0)
    && allTools.some((tool) => tool.name === "exec")
    ? ["exec"]
    : [];
  deferral.requestRelevantPromptSkillWorkflowToolNames = workflowToolNames;
  if (!deferral.requestRelevantToolNames.includes("read")) {
    deferral.requestRelevantToolNames.unshift("read");
  }
  for (const toolName of workflowToolNames) {
    if (!deferral.requestRelevantToolNames.includes(toolName)) {
      deferral.requestRelevantToolNames.push(toolName);
    }
  }
  return selected;
}
