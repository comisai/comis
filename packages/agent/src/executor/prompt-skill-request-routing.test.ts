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
  {
    name: "deep-research",
    description:
      "Conduct multi-angle web research before answering requests to understand a topic properly, deeply, or beyond a short paragraph, even when general knowledge could produce an answer.",
    replacesPackages: [],
  },
  {
    name: "claude-code",
    description:
      "Use Claude Code to build, debug, refactor, and test a software project.",
    replacesPackages: [],
  },
];

describe("prompt skill request routing", () => {
  it("routes an elliptical discovery follow-up through the skill-loading read tool", () => {
    const deferral = result();
    deferral.requestRelevantToolNames.push("find");

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText: "find something that does",
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

  it("routes a frontier thorough-understanding request through its matched prompt skill", () => {
    const deferral = result();

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText:
        "i need to understand heat pumps properly, not just a paragraph",
      requestRelevanceText:
        "i need to understand heat pumps properly, not just a paragraph",
      skills,
      locations: new Map([
        ["/skills/deep-research/SKILL.md", "deep-research"],
      ]),
    });

    expect(selected).toEqual(["deep-research"]);
    expect(deferral.requestRelevantToolNames).toEqual(["read"]);
    expect(deferral.requestRelevantPromptSkillLocations).toEqual([
      "/skills/deep-research/SKILL.md",
    ]);
    expect(deferral.activeTools.find((entry) => entry.name === "read")?.description)
      .toContain("/skills/deep-research/SKILL.md");
  });

  it("lets the current request outrank stale prompt-skill history", () => {
    const deferral = result();
    const currentRequestText =
      "i need to understand heat pumps properly, not just a paragraph";

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText,
      requestRelevanceText: [
        "use Claude Code to build debug refactor and test this software project",
        currentRequestText,
      ].join("\n"),
      skills,
      locations: new Map([
        ["/skills/claude-code/SKILL.md", "claude-code"],
        ["/skills/deep-research/SKILL.md", "deep-research"],
      ]),
    });

    expect(selected).toEqual(["deep-research"]);
    expect(deferral.requestRelevantPromptSkillLocations).toEqual([
      "/skills/deep-research/SKILL.md",
    ]);
  });

  it("leaves unrelated requests unchanged", () => {
    const unrelated = result();

    expect(applyPromptSkillRequestRouting(unrelated, {
      currentRequestText: "what is the weather today",
      requestRelevanceText: "what is the weather today",
      skills,
    })).toEqual([]);
    expect(unrelated.requestRelevantToolNames).toEqual([]);
  });
});
