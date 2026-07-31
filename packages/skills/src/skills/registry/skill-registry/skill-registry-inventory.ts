// SPDX-License-Identifier: Apache-2.0
/**
 * Management inventory for discovered prompt skills.
 *
 * The model-facing prompt surface includes only eligible skills. Management
 * callers need the broader installed inventory so they can distinguish an
 * absent skill from one blocked by policy or missing runtime prerequisites.
 *
 * @module
 */

import type { SkillsConfig } from "@comis/core";
import type { SkillMetadata } from "../discovery.js";
import { evaluateSkillEligibility, type RuntimeEligibilityContext } from "../eligibility.js";
import type { PromptSkillInventoryEntry, SkillsLogger } from "./skill-registry-types.js";

interface InventoryArgs {
  readonly metadata: Iterable<SkillMetadata>;
  readonly config: SkillsConfig;
  readonly eligibilityContext?: RuntimeEligibilityContext;
  readonly logger?: SkillsLogger;
}

function policyIneligibilityReason(name: string, config: SkillsConfig): string | undefined {
  const allowed = config.promptSkills.allowedSkills ?? [];
  if (allowed.length > 0 && !allowed.includes(name)) {
    return "not included in skills.promptSkills.allowedSkills";
  }
  if ((config.promptSkills.deniedSkills ?? []).includes(name)) {
    return "blocked by skills.promptSkills.deniedSkills";
  }
  return undefined;
}

function runtimeIneligibilityReason(
  metadata: SkillMetadata,
  args: InventoryArgs,
): string | undefined {
  if (!args.eligibilityContext || !(args.config.runtimeEligibility?.enabled ?? true)) {
    return undefined;
  }
  const result = evaluateSkillEligibility(metadata, args.eligibilityContext);
  if (result.eligible) return undefined;
  args.logger?.debug(
    { skillName: metadata.name, reason: result.reason },
    "Skill included in management inventory with unmet runtime requirements",
  );
  return result.reason ?? "runtime requirements are not met";
}

export function buildPromptSkillInventory(args: InventoryArgs): PromptSkillInventoryEntry[] {
  const entries: PromptSkillInventoryEntry[] = [];
  for (const metadata of args.metadata) {
    const reason =
      policyIneligibilityReason(metadata.name, args.config) ??
      runtimeIneligibilityReason(metadata, args);
    const entry = {
      name: metadata.name,
      description: metadata.description,
      location: metadata.filePath,
      disableModelInvocation: metadata.disableModelInvocation || undefined,
      source: metadata.source,
      eligible: reason === undefined,
    };
    entries.push(
      reason === undefined
        ? entry
        : { ...entry, reason },
    );
  }
  return entries;
}
