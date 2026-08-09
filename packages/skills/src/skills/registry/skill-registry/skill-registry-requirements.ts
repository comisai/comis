// SPDX-License-Identifier: Apache-2.0
/** Aggregated warning for eligible prompt skills without runtime declarations. */

import type { SkillsConfig } from "@comis/core";
import { evaluateSkillEligibility, type RuntimeEligibilityContext } from "../eligibility.js";
import type { SkillMetadata } from "../discovery.js";
import { isSkillEligible } from "./skill-registry-discovery.js";
import type { SkillsLogger } from "./skill-registry-types.js";

export function logUndeclaredRequirements(
  skills: Iterable<SkillMetadata>,
  config: SkillsConfig,
  eligibilityContext?: RuntimeEligibilityContext,
  logger?: SkillsLogger,
): void {
  if (!eligibilityContext || !(config.runtimeEligibility?.enabled ?? true)) return;
  const skillNames = [...skills]
    .filter((metadata) => isSkillEligible(metadata.name, config.promptSkills))
    .filter((metadata) => {
      const result = evaluateSkillEligibility(metadata, eligibilityContext);
      return result.eligible && !result.requirementsDeclared;
    })
    .map((metadata) => metadata.name)
    .sort();
  if (skillNames.length === 0) return;
  const displayedNames = skillNames.slice(0, 20);
  logger?.warn(
    {
      skillCount: skillNames.length,
      skillNames: displayedNames,
      truncatedSkillCount: skillNames.length - displayedNames.length,
      errorKind: "precondition" as const,
      hint: "Add an explicit `comis.requires` block to each listed SKILL.md; use empty bins and env arrays for dependency-free skills",
    },
    "Eligible skills have undeclared runtime requirements",
  );
}
