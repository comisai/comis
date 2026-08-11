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
    activeTools: [
      tool("read"),
      tool("find"),
      tool("exec"),
      tool("web_search"),
      tool("web_fetch"),
    ],
    deferredEntries: [],
    discoveredTools: [],
    discoverTool: null,
    deferredCount: 0,
    deferredNames: [],
    requestRelevantToolNames: [],
  };
}

registerToolMetadata("find", { isReadOnly: true });

type TestPromptSkillCapability = PromptSkillCapability & {
  readonly minDistinctWebFetchUrls?: number;
  readonly minDistinctWebSearchQueries?: number;
};

const skills: TestPromptSkillCapability[] = [
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
      "Conduct multi-angle web research before answering requests to understand a topic properly, deeply, or beyond a short paragraph, even when general knowledge could produce an answer. Continue for context-dependent follow-ups requesting source attribution, claim tracing, unavailable-source handling, or compression into essentials.",
    replacesPackages: [],
    minDistinctWebFetchUrls: 3,
    minDistinctWebSearchQueries: 3,
  },
  {
    name: "claude-code",
    description:
      "Drive the Claude Code CLI interactively in a terminal session to build, fix, or extend software — launch it in a named project folder, give it the task, handle its interactive prompts via keystrokes, detect completion, and verify the result. Use whenever the user wants to write, build, debug, refactor, or test code or work on a software project, or asks to use Claude Code — even if they do not name the tool. This is for interactive sessions only; never the headless one-shot mode.",
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
    expect(deferral.requestRelevantToolNames).toEqual([
      "read",
      "web_search",
      "web_fetch",
    ]);
    expect(deferral.requestRelevantPromptSkillWorkflowToolNames).toEqual([
      "web_search",
      "web_fetch",
    ]);
    expect(
      (deferral as ExcludeDeferralResult & {
        requestRelevantPromptSkillMinDistinctWebFetchUrls?: number;
      }).requestRelevantPromptSkillMinDistinctWebFetchUrls,
    ).toBe(3);
    expect(
      (deferral as ExcludeDeferralResult & {
        requestRelevantPromptSkillMinDistinctWebSearchQueries?: number;
      }).requestRelevantPromptSkillMinDistinctWebSearchQueries,
    ).toBe(3);
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

  it("keeps research attribution follow-ups on the relevant prompt skill", () => {
    const deferral = result();
    const currentRequestText =
      "one source is down — where is each claim from, then give me the three essentials";

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText,
      requestRelevanceText: [
        "i need to understand heat pumps properly, not just a paragraph",
        currentRequestText,
      ].join("\n"),
      priorUserRequest:
        "i need to understand heat pumps properly, not just a paragraph",
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

  it("does not route common prose overlap to an unrelated prompt skill", () => {
    const deferral = result();

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText:
        "one source is down — where is each claim from, then give me the three essentials",
      requestRelevanceText:
        "one source is down — where is each claim from, then give me the three essentials",
      skills: skills.filter((skill) => skill.name === "claude-code"),
      locations: new Map([
        ["/skills/claude-code/SKILL.md", "claude-code"],
      ]),
    });

    expect(selected).toEqual([]);
    expect(deferral.requestRelevantPromptSkillNames).toBeUndefined();
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
