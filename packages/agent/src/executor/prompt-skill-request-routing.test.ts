import { describe, expect, it } from "vitest";
import { registerToolMetadata, type PromptSkillCapability } from "@comis/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExcludeDeferralResult } from "./tool-deferral.js";
import { applyPromptSkillRequestRouting } from "./prompt-skill-request-routing.js";

function tool(name: string): ToolDefinition {
  return {
    name,
    description: name === "read" ? "Read a workspace file" : "Find workspace files",
    parameters: { type: "object", properties: {} },
  } as unknown as ToolDefinition;
}

function result(): ExcludeDeferralResult {
  return {
    activeTools: [tool("read"), tool("find"), tool("exec")],
    deferredEntries: [],
    discoveredTools: [],
    discoverTool: null,
    deferredCount: 0,
    deferredNames: [],
    requestRelevantToolNames: [],
  };
}

registerToolMetadata("find", { isReadOnly: true });

const skills: PromptSkillCapability[] = [
  {
    name: "find-skills",
    description:
      "For skill discovery, including elliptical follow-ups such as find something that does when the preceding turn names the task.",
    replacesPackages: [],
    requiredBins: ["git"],
  },
  {
    name: "image-generation",
    description: "Generate and edit images from a concrete visual request.",
    replacesPackages: [],
  },
];

describe("prompt skill request routing", () => {
  it("routes an elliptical discovery follow-up through the skill-loading read tool", () => {
    const deferral = result();
    deferral.requestRelevantToolNames.push("find");

    const selected = applyPromptSkillRequestRouting(deferral, {
      capabilityClass: "nano",
      requestRelevanceText: [
        "u dont really know how to make flash cards properly",
        "find something that does",
      ].join("\n"),
      priorUserRequest: "u dont really know how to make flash cards properly",
      skills,
      locations: new Map([
        ["/skills/find-skills/SKILL.md", "find-skills"],
        ["/skills/image-generation/SKILL.md", "image-generation"],
      ]),
    });

    expect(selected).toEqual(["find-skills"]);
    expect(deferral.requestRelevantToolNames).toEqual(["read", "exec"]);
    expect(deferral.requestRelevantPromptSkillWorkflowToolNames).toEqual(["exec"]);
    expect(deferral.requestRelevantPromptSkillWorkflowContext)
      .toBe("u dont really know how to make flash cards properly");
    expect(deferral.requestRelevantPromptSkillLocations).toEqual([
      "/skills/find-skills/SKILL.md",
    ]);
    expect(deferral.activeTools.find((entry) => entry.name === "read")?.description)
      .toContain("/skills/find-skills/SKILL.md");
  });

  it("leaves unrelated requests and non-nano profiles unchanged", () => {
    const unrelated = result();
    const mid = result();

    expect(applyPromptSkillRequestRouting(unrelated, {
      capabilityClass: "nano",
      requestRelevanceText: "what is the weather today",
      skills,
    })).toEqual([]);
    expect(applyPromptSkillRequestRouting(mid, {
      capabilityClass: "mid",
      requestRelevanceText: "find something that does",
      skills,
    })).toEqual([]);
    expect(unrelated.requestRelevantToolNames).toEqual([]);
    expect(mid.requestRelevantToolNames).toEqual([]);
  });
});
