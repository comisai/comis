// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { promptSkillReadVerdict } from "./prompt-skill-read-guard.js";

const inactivePath = "/workspace/operator-skills/operator-procedure-fixture/SKILL.md";

describe("prompt skill read guard", () => {
  it("blocks explicit invocation outside the current registry", () => {
    const onBlocked = vi.fn();

    expect(promptSkillReadVerdict(
      "use operator-procedure-fixture again and give me its marker",
      { toolCall: { name: "read" }, args: { path: inactivePath } },
      {
        activeLocations: new Set(["/workspace/skills/active-skill/SKILL.md"]),
        onBlocked,
      },
    )).toEqual({
      block: true,
      reason: expect.stringMatching(
        /operator-procedure-fixture.*not in the current.*available_skills.*unavailable/iu,
      ),
    });
    expect(onBlocked).toHaveBeenCalledWith("operator-procedure-fixture");
  });

  it("allows invocation from the current registry", () => {
    const activePath = "/workspace/skills/active-skill/SKILL.md";

    expect(promptSkillReadVerdict(
      "load active-skill and follow its procedure",
      { toolCall: { name: "read" }, args: { path: activePath } },
      { activeLocations: new Set([activePath]) },
    )).toBeUndefined();
  });

  it("allows ordinary inspection outside the current registry", () => {
    expect(promptSkillReadVerdict(
      "inspect operator-procedure-fixture SKILL.md as a file",
      { toolCall: { name: "read" }, args: { path: inactivePath } },
      { activeLocations: new Set() },
    )).toBeUndefined();
  });
});
