// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { RunPromptParams } from "./prompt-runner-types.js";
import { hasEnforcedPromptSkillRoute } from "./request-tool-nudge-step.js";

function routeParams(
  names?: readonly string[],
  locations?: readonly string[],
): RunPromptParams {
  return {
    requestRelevantPromptSkillNames: names,
    requestRelevantPromptSkillLocations: locations,
  } as unknown as RunPromptParams;
}

describe("prompt-skill enforcement route", () => {
  it("requires both a selected skill and its trusted location", () => {
    expect(hasEnforcedPromptSkillRoute(routeParams())).toBe(false);
    expect(hasEnforcedPromptSkillRoute(routeParams(["claude-code"]))).toBe(false);
    expect(hasEnforcedPromptSkillRoute(routeParams(
      undefined,
      ["/skills/claude-code/SKILL.md"],
    ))).toBe(false);
    expect(hasEnforcedPromptSkillRoute(routeParams(
      ["claude-code"],
      ["/skills/claude-code/SKILL.md"],
    ))).toBe(true);
  });
});
