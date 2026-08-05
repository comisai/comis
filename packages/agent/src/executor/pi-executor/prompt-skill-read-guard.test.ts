// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { promptSkillReadVerdict } from "./prompt-skill-read-guard.js";

const inactivePath = "/workspace/operator-skills/operator-procedure-fixture/SKILL.md";

describe("prompt skill read guard", () => {
  it("blocks explicit invocation outside the current registry", () => {
    const onBlocked = vi.fn();

    expect(promptSkillReadVerdict(
      {
        sourceText: "use operator-procedure-fixture again and give me its marker",
        policy: {
          activeLocations: new Set(["/workspace/skills/active-skill/SKILL.md"]),
          onBlocked,
        },
      },
      { toolCall: { name: "read" }, args: { path: inactivePath } },
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
      {
        sourceText: "load active-skill and follow its procedure",
        policy: { activeLocations: new Set([activePath]) },
      },
      { toolCall: { name: "read" }, args: { path: activePath } },
    )).toBeUndefined();
  });

  it("allows ordinary inspection outside the current registry", () => {
    expect(promptSkillReadVerdict(
      {
        sourceText: "inspect operator-procedure-fixture SKILL.md as a file",
        policy: { activeLocations: new Set() },
      },
      { toolCall: { name: "read" }, args: { path: inactivePath } },
    )).toBeUndefined();
  });
});
