import { describe, expect, it } from "vitest";
import { registerToolMetadata, type PromptSkillCapability } from "@comis/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExcludeDeferralResult } from "./tool-deferral.js";
import {
  applyPromptSkillRequestRouting,
  physicalUserRequestText,
  routingIntentText,
} from "./prompt-skill-request-routing.js";

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
registerToolMetadata("browser", { isReadOnly: true });

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
    expect(deferral.requestRelevantToolNames).toEqual(["find", "read", "exec"]);
    expect(deferral.requestRelevantPromptSkillWorkflowToolNames).toEqual(["exec"]);
    expect(deferral.requestRelevantPromptSkillWorkflowContext)
      .toContain("u dont really know how to make flash cards properly");
    expect(deferral.requestRelevantPromptSkillWorkflowContext)
      .toContain("find something that does");
    expect(deferral.requestRelevantPromptSkillLocations).toEqual([
      "/skills/find-skills/SKILL.md",
    ]);
    expect(deferral.activeTools.find((entry) => entry.name === "read")?.description)
      .toContain("/skills/find-skills/SKILL.md");
  });

  it("does not enforce a binary workflow from incidental skill overlap", () => {
    const deferral = result();
    deferral.requestRelevantToolNames.push("browser");
    const browserRequest = [
      "Use the browser tool to open https://example.com, navigate to it, take a snapshot,",
      "and reply with the exact page title plus whether the snapshot succeeded.",
      "Do not use web_fetch for this preflight.",
    ].join(" ");
    const catalogSkill: PromptSkillCapability = {
      name: "find-skills",
      description:
        "MANDATORY: For requests asking whether a skill or specialized capability exists, "
        + "load this skill and run its catalog workflow before answering. This includes "
        + "elliptical follow-ups such as 'find something that does' when the preceding turn "
        + "names the task. Do not answer from general capabilities, search workspace filenames, "
        + "or use generic web search.",
      replacesPackages: [],
      requiredBins: ["git"],
    };

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText: browserRequest,
      requestRelevanceText: browserRequest,
      skills: [catalogSkill],
      locations: new Map([
        ["/skills/find-skills/SKILL.md", "find-skills"],
      ]),
    });

    expect(selected).toEqual(["find-skills"]);
    expect(deferral.requestRelevantPromptSkillNames).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillLocations).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillWorkflowToolNames).toEqual([]);
    expect(deferral.requestRelevantPromptSkillWorkflowContext).toBeUndefined();
    expect(deferral.requestRelevantToolNames).toEqual(["browser"]);
  });

  it("does not enforce a parent skill from a quoted child task", () => {
    const deferral = result();
    deferral.activeTools.push(tool("sessions_spawn"));
    deferral.requestRelevantToolNames.push("sessions_spawn");
    const delegationRequest = [
      "Delegation reachability test. Use sessions_spawn to start a child whose task is:",
      "'Use web_search and web_fetch to retrieve the title of https://example.com and report it.'",
      "On the first spawn deliberately set tool_groups to ['coding'] and required_tools to",
      "['web_search','web_fetch']. Quote the rejection exactly once. Then follow its re-spawn",
      "directive, wait for the child to finish, and report both attempts.",
      "Do not substitute your own research.",
    ].join(" ");

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText: delegationRequest,
      requestRelevanceText: delegationRequest,
      skills: skills.filter((skill) => skill.name === "deep-research"),
      locations: new Map([
        ["/skills/deep-research/SKILL.md", "deep-research"],
      ]),
    });

    expect(selected).toEqual(["deep-research"]);
    expect(deferral.requestRelevantPromptSkillNames).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillWorkflowToolNames).toEqual([]);
    expect(deferral.requestRelevantToolNames).toEqual(["sessions_spawn"]);
  });

  it("does not enforce a parent skill from an unquoted delegated child task", () => {
    const deferral = result();
    deferral.activeTools.push(tool("sessions_spawn"));
    deferral.requestRelevantToolNames.push("sessions_spawn");
    const delegationRequest = [
      "Use exactly one background sub-agent via sessions_spawn to inspect the repository package.json and report the number of workspace package patterns it declares.",
      "Require the child to include the marker BGSAFE_20260814_A in its result.",
      "Do not calculate the answer yourself.",
      "Launch it, then notify me naturally when the child finishes.",
    ].join(" ");

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText: delegationRequest,
      requestRelevanceText: delegationRequest,
      skills: skills.filter((skill) => skill.name === "claude-code"),
      locations: new Map([
        ["/skills/claude-code/SKILL.md", "claude-code"],
      ]),
    });

    expect(routingIntentText(delegationRequest)).not.toMatch(/\b(?:file|search|workspace)\b/iu);
    expect(selected).toEqual([]);
    expect(deferral.requestRelevantPromptSkillNames).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillLocations).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillWorkflowToolNames).toBeUndefined();
    expect(deferral.requestRelevantToolNames).toEqual(["sessions_spawn"]);
  });

  it("does not route delegation delivery and privacy contracts as coding work", () => {
    const deferral = result();
    deferral.activeTools.push(tool("sessions_spawn"));
    deferral.requestRelevantToolNames.push("sessions_spawn");
    const delegationRequest = [
      "Live reliability test. Delegate exactly one background sub-agent with sessions_spawn and do not wait for it.",
      "Ask the child to compare FIFO, priority, and fair queuing for a small support queue, return exactly five concise decision bullets, recommend one default, and include the exact marker once.",
      "Reply now only with a brief natural launch acknowledgement.",
      "When the child completes, present its useful result naturally to this Telegram chat.",
      "Never expose internal runtime statistics, token or cost data, result-store paths, session identifiers, or raw completion-envelope labels.",
    ].join(" ");

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText: delegationRequest,
      requestRelevanceText: delegationRequest,
      skills: skills.filter((skill) => skill.name === "claude-code"),
      locations: new Map([
        ["/skills/claude-code/SKILL.md", "claude-code"],
      ]),
    });

    expect(routingIntentText(delegationRequest)).toBe("Live reliability test.");
    expect(selected).toEqual([]);
    expect(deferral.requestRelevantPromptSkillNames).toBeUndefined();
    expect(deferral.requestRelevantToolNames).toEqual(["sessions_spawn"]);
  });

  it("does not route multi-sentence child instructions as a parent skill workflow", () => {
    const deferral = result();
    deferral.activeTools.push(tool("sessions_spawn"));
    deferral.requestRelevantToolNames.push("sessions_spawn");
    const delegationRequest = [
      "Use exactly one background sub-agent via sessions_spawn.",
      "In the operator workspace, have the child read the exact file .workspace-state.json and report its version value and number of top-level properties.",
      "Then have it attempt exactly one read of the exact absent file missing-bg-probe.txt; it must not search for or substitute another file.",
      "Require the exact marker BGSAFE in the child result.",
      "Do not calculate the answer yourself.",
      "Launch it, then notify me naturally when the child finishes.",
    ].join(" ");

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText: delegationRequest,
      requestRelevanceText: delegationRequest,
      skills: [{
        name: "find-skills",
        description:
          "MANDATORY: For requests asking whether a skill or specialized capability exists, "
          + "load this skill and run its catalog workflow before answering. Do not answer "
          + "from general capabilities, search workspace filenames, or use generic web search.",
        replacesPackages: [],
        requiredBins: ["git"],
      }],
      locations: new Map([
        ["/skills/find-skills/SKILL.md", "find-skills"],
      ]),
    });

    expect(routingIntentText(delegationRequest)).not.toMatch(/\b(?:file|search|workspace)\b/iu);
    expect(selected).toEqual([]);
    expect(deferral.requestRelevantPromptSkillNames).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillWorkflowToolNames).toBeUndefined();
    expect(deferral.requestRelevantToolNames).toEqual(["sessions_spawn"]);
  });

  it("does not route a parent nonexecution constraint as a coding workflow", () => {
    const deferral = result();
    deferral.activeTools.push(tool("sessions_spawn"));
    deferral.requestRelevantToolNames.push("sessions_spawn");
    const delegationRequest = [
      "Use exactly one background sub-agent via sessions_spawn as a coordinator.",
      "Have that coordinator spawn exactly one child of its own via sessions_spawn, with no further nesting.",
      "The leaf child must read the exact operator-workspace file .workspace-state.json and return its version value.",
      "The coordinator must wait for the pushed leaf completion, then return the leaf value and marker.",
      "Do not read or calculate the value yourself.",
      "Launch the coordinator, then notify me naturally when the nested work finishes.",
    ].join(" ");

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText: delegationRequest,
      requestRelevanceText: delegationRequest,
      skills: skills.filter((skill) => skill.name === "claude-code"),
      locations: new Map([
        ["/skills/claude-code/SKILL.md", "claude-code"],
      ]),
    });

    expect(routingIntentText(delegationRequest)).not.toMatch(/\b(?:file|read|workspace)\b/iu);
    expect(selected).toEqual([]);
    expect(deferral.requestRelevantPromptSkillNames).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillLocations).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillWorkflowToolNames).toBeUndefined();
    expect(deferral.requestRelevantToolNames).toEqual(["sessions_spawn"]);
  });

  it("does not route coordinator bookkeeping and negative constraints as coding", () => {
    const deferral = result();
    deferral.activeTools.push(tool("sessions_spawn"));
    deferral.requestRelevantToolNames.push("sessions_spawn");
    const coordinatorRequest = [
      "Act as the sole coordinator for this nested delegation task.",
      "You MUST use sessions_spawn exactly once to spawn exactly one leaf child, and you must not read, inspect, infer, or calculate .workspace-state.json yourself.",
      "Instruct the leaf child to spawn no further sub-agents, make no modifications, read the exact operator-workspace file, and return its version marker.",
      "Then wait for the pushed leaf completion without polling.",
      "After it completes, return the leaf's exact version value and marker.",
      "Do not finish early with only a launch receipt.",
      "Do not modify any files.",
    ].join(" ");

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText: coordinatorRequest,
      requestRelevanceText: coordinatorRequest,
      skills: skills.filter((skill) => skill.name === "claude-code"),
      locations: new Map([
        ["/skills/claude-code/SKILL.md", "claude-code"],
      ]),
    });

    expect(routingIntentText(coordinatorRequest)).toBe("");
    expect(selected).toEqual([]);
    expect(deferral.requestRelevantPromptSkillNames).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillLocations).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillWorkflowToolNames).toBeUndefined();
    expect(deferral.requestRelevantToolNames).toEqual(["sessions_spawn"]);
  });

  it("still enforces a prompt skill for a separate parent-owned task", () => {
    const deferral = result();
    const request = [
      "Spawn a child to inspect package.json.",
      "After it finishes, use Claude Code to refactor and test the parent project.",
    ].join(" ");

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText: request,
      requestRelevanceText: request,
      skills: skills.filter((skill) => skill.name === "claude-code"),
      locations: new Map([
        ["/skills/claude-code/SKILL.md", "claude-code"],
      ]),
    });

    expect(selected).toEqual(["claude-code"]);
    expect(deferral.requestRelevantPromptSkillNames).toEqual(["claude-code"]);
    expect(deferral.requestRelevantPromptSkillLocations).toEqual([
      "/skills/claude-code/SKILL.md",
    ]);
    expect(deferral.requestRelevantToolNames).toContain("read");
  });

  it("preserves a parent skill after returning from delegated work", () => {
    const deferral = result();
    const request = [
      "Spawn a child to inspect package.json.",
      "After it finishes, return to the parent project and use Claude Code to refactor it.",
    ].join(" ");

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText: request,
      requestRelevanceText: request,
      skills: skills.filter((skill) => skill.name === "claude-code"),
      locations: new Map([
        ["/skills/claude-code/SKILL.md", "claude-code"],
      ]),
    });

    expect(routingIntentText(request)).toContain(
      "return to the parent project and use Claude Code to refactor it",
    );
    expect(selected).toEqual(["claude-code"]);
    expect(deferral.requestRelevantPromptSkillNames).toEqual(["claude-code"]);
    expect(deferral.requestRelevantToolNames).toContain("read");
  });

  it("preserves parent work whose final result follows delegated work", () => {
    const deferral = result();
    const request = [
      "Spawn a child to inspect package.json.",
      "After it finishes, return to the parent project and use Claude Code to produce the final result.",
    ].join(" ");

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText: request,
      requestRelevanceText: request,
      skills: skills.filter((skill) => skill.name === "claude-code"),
      locations: new Map([
        ["/skills/claude-code/SKILL.md", "claude-code"],
      ]),
    });

    expect(routingIntentText(request)).toContain(
      "return to the parent project and use Claude Code to produce the final result",
    );
    expect(selected).toEqual(["claude-code"]);
    expect(deferral.requestRelevantPromptSkillNames).toEqual(["claude-code"]);
    expect(deferral.requestRelevantToolNames).toContain("read");
  });

  it("does not route a direct artifact write as a software workflow", () => {
    const deferral = result();
    deferral.activeTools.push(tool("write"));
    deferral.requestRelevantToolNames.push("write");
    const artifactRequest = [
      "Create exactly one CSV file at /workspace/artifacts/report.csv using write.",
      "The file content must contain the requested item counts.",
      "Do not inspect other files and do not retry after a successful write.",
      "Before the final response, verify every listed file exists.",
      "Return marker FILE1 and a short result summary when complete.",
    ].join(" ");

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText: artifactRequest,
      requestRelevanceText: artifactRequest,
      skills: skills.filter((skill) => skill.name === "claude-code"),
      locations: new Map([
        ["/skills/claude-code/SKILL.md", "claude-code"],
      ]),
    });

    expect(selected).toEqual([]);
    expect(deferral.requestRelevantPromptSkillNames).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillLocations).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillWorkflowToolNames).toBeUndefined();
    expect(deferral.requestRelevantToolNames).toEqual(["write"]);
  });

  it("does not route delegated tool bindings and delivery instructions as parent coding intent", () => {
    const deferral = result();
    deferral.activeTools.push(tool("sessions_spawn"));
    deferral.requestRelevantToolNames.push("sessions_spawn");
    const delegationRequest = [
      "Silent attachment check.",
      "Launch exactly one background sub-agent with sessions_spawn.",
      "The child must use write to create exactly /workspace/real-user/artifacts/silent.txt, then return NO_REPLY.",
      "Bind required_tools to write, tool_groups to coding, and declare the path in expected_outputs.",
      "After launch, deliver the verified document with no terminal text notification.",
    ].join(" ");

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText: delegationRequest,
      requestRelevanceText: delegationRequest,
      skills: skills.filter((skill) => skill.name === "claude-code"),
      locations: new Map([
        ["/skills/claude-code/SKILL.md", "claude-code"],
      ]),
    });

    expect(routingIntentText(delegationRequest)).not.toMatch(/\b(?:terminal|write)\b/iu);
    expect(selected).toEqual([]);
    expect(deferral.requestRelevantPromptSkillNames).toBeUndefined();
    expect(deferral.requestRelevantToolNames).toEqual(["sessions_spawn"]);
  });

  it("does not require a parent read for a captionless delegated attachment", () => {
    const deferral = result();
    deferral.activeTools.push(tool("sessions_spawn"));
    deferral.requestRelevantToolNames.push("sessions_spawn");
    const delegationRequest = [
      "Live reliability test. Use sessions_spawn exactly once to launch one background sub-agent and do not wait for it.",
      "Give the child this exact task: in its own workspace, use the write tool to create b2-media-proof.txt containing exactly B2_MEDIA_20260815 followed by one newline; declare b2-media-proof.txt as the only expected output; after the write succeeds return exactly NO_REPLY.",
      "Use required_tools [write] and max_steps 30.",
      "Reply now only with a brief natural launch acknowledgement.",
      "When the child completes, deliver the file to this Telegram chat with no caption and no later terminal text.",
    ].join(" ");

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText: delegationRequest,
      requestRelevanceText: delegationRequest,
      skills: skills.filter((skill) => skill.name === "claude-code"),
      locations: new Map([
        ["/skills/claude-code/SKILL.md", "claude-code"],
      ]),
    });

    expect(routingIntentText(delegationRequest)).toBe("Live reliability test.");
    expect(selected).toEqual([]);
    expect(deferral.requestRelevantPromptSkillNames).toBeUndefined();
    expect(deferral.requestRelevantToolNames).toEqual(["sessions_spawn"]);
  });

  it("does not route an unquoted sessions spawn task argument as parent coding intent", () => {
    const deferral = result();
    deferral.activeTools.push(tool("sessions_spawn"));
    deferral.requestRelevantToolNames.push("sessions_spawn");
    const delegationRequest = [
      "Live captionless attachment check.",
      "First call discover_tools with query sessions_spawn.",
      "Then call sessions_spawn exactly once with task set to: Use write to create b2-media-proof.txt containing exactly B2_MEDIA_20260815 followed by one newline.",
      "After the write succeeds, return exactly NO_REPLY.",
      "Set required_tools to [write], max_steps to 30, and expected_outputs to [b2-media-proof.txt].",
      "Do not wait for the child.",
      "Reply now only with a brief natural launch acknowledgement.",
      "The completed file must be delivered to this Telegram chat with no caption and no later terminal text.",
    ].join(" ");

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText: delegationRequest,
      requestRelevanceText: delegationRequest,
      skills: skills.filter((skill) => skill.name === "claude-code"),
      locations: new Map([
        ["/skills/claude-code/SKILL.md", "claude-code"],
      ]),
    });

    expect(routingIntentText(delegationRequest)).not.toMatch(/\b(?:create|write)\b/iu);
    expect(selected).toEqual(["claude-code"]);
    expect(deferral.requestRelevantPromptSkillNames).toBeUndefined();
    expect(deferral.requestRelevantToolNames).toEqual(["sessions_spawn"]);
  });

  it("does not route a separately declared child task argument as parent coding intent", () => {
    const deferral = result();
    deferral.activeTools.push(tool("sessions_spawn"));
    deferral.requestRelevantToolNames.push("sessions_spawn");
    const delegationRequest = [
      "Live captionless attachment check.",
      "First call discover_tools with query sessions_spawn.",
      "Then call sessions_spawn exactly once and do not wait.",
      "The task argument must be this exact single sentence: Use write to create b2-media-proof.txt containing exactly B2_MEDIA_20260815 followed by one newline, then return exactly NO_REPLY.",
      "Set required_tools to [write], max_steps to 30, and expected_outputs to [b2-media-proof.txt].",
      "Reply now only with a brief natural launch acknowledgement.",
      "The completed file must be delivered to this Telegram chat with no caption and no later terminal text.",
    ].join(" ");

    applyPromptSkillRequestRouting(deferral, {
      currentRequestText: delegationRequest,
      requestRelevanceText: delegationRequest,
      skills: skills.filter((skill) => skill.name === "claude-code"),
      locations: new Map([
        ["/skills/claude-code/SKILL.md", "claude-code"],
      ]),
    });

    expect(routingIntentText(delegationRequest)).not.toMatch(/\b(?:create|write)\b/iu);
    expect(deferral.requestRelevantPromptSkillNames).toBeUndefined();
    expect(deferral.requestRelevantToolNames).toEqual(["sessions_spawn"]);
  });

  it("ignores completion-contract boilerplate when routing a silent artifact write", () => {
    const deferral = result();
    const childRequest = [
      "Use the write tool to create exactly /workspace/artifacts/silent.txt containing exact content.",
      "Then return exactly NO_REPLY with no other text.",
      "Expected output contract: create every file at its exact path.",
      "The completion runner validates these exact paths before the final response.",
    ].join(" ");

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText: childRequest,
      requestRelevanceText: childRequest,
      skills: skills.filter((skill) => skill.name === "claude-code"),
      locations: new Map([
        ["/skills/claude-code/SKILL.md", "claude-code"],
      ]),
    });

    expect(selected).toEqual([]);
    expect(deferral.requestRelevantPromptSkillNames).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillLocations).toBeUndefined();
    expect(deferral.requestRelevantToolNames).toEqual([]);
  });

  it("does not treat absolute path segments as prompt skill intent", () => {
    const deferral = result();
    const artifactRequest =
      "Use write to create exactly /workspace/real-user/artifacts/silent.txt, then return NO_REPLY.";

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText: artifactRequest,
      requestRelevanceText: artifactRequest,
      skills: skills.filter((skill) => skill.name === "claude-code"),
      locations: new Map([
        ["/skills/claude-code/SKILL.md", "claude-code"],
      ]),
    });

    expect(routingIntentText(artifactRequest)).not.toContain("real-user");
    expect(selected).toEqual([]);
    expect(deferral.requestRelevantPromptSkillNames).toBeUndefined();
    expect(deferral.requestRelevantToolNames).toEqual([]);
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
    expect(deferral.requestRelevantPromptSkillNames).toEqual(["deep-research"]);
    expect(deferral.requestRelevantPromptSkillLocations).toEqual([
      "/skills/deep-research/SKILL.md",
    ]);
    expect(deferral.activeTools.find((entry) => entry.name === "read")?.description)
      .toContain("/skills/deep-research/SKILL.md");
  });

  it("preserves a request-relevant specialized read tool beside a prompt-skill workflow", () => {
    const deferral = result();
    deferral.activeTools.push(tool("mcp__records--summary"));
    deferral.requestRelevantToolNames.push("mcp__records--summary");
    const currentRequestText =
      "conduct multi-angle research to understand the connected records properly and deeply";

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText,
      requestRelevanceText: currentRequestText,
      skills: skills.filter((skill) => skill.name === "deep-research"),
      locations: new Map([
        ["/skills/deep-research/SKILL.md", "deep-research"],
      ]),
    });

    expect(selected).toEqual(["deep-research"]);
    expect(deferral.requestRelevantToolNames).toEqual([
      "mcp__records--summary",
      "read",
      "web_search",
      "web_fetch",
    ]);
  });

  it("does not enforce web evidence when the current request excludes web sources", () => {
    const deferral = result();
    const currentRequestText = [
      "Yahoo Finance evidence research for MSFT using the connected yfinance MCP.",
      "Retrieve the current quote, history, key statistics, financials, earnings,",
      "and recommendations. State data timestamps, separate retrieved values from",
      "interpretation, and report unavailable datasets honestly. Do not use web sources.",
    ].join(" ");

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText,
      requestRelevanceText: currentRequestText,
      skills: skills.filter((skill) => skill.name === "deep-research"),
      locations: new Map([
        ["/skills/deep-research/SKILL.md", "deep-research"],
      ]),
    });

    expect(selected).toEqual(["deep-research"]);
    expect(deferral.requestRelevantPromptSkillNames).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillLocations).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillWorkflowToolNames).toEqual([]);
    expect(deferral.requestRelevantPromptSkillMinDistinctWebFetchUrls).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillMinDistinctWebSearchQueries).toBeUndefined();
  });

  it.each([
    "Do not web_search and do not switch URLs.",
    "Use only the connected yfinance MCP—no web sources—for this research.",
    "Do not browse, fetch, or spawn anything else.",
    "Query current Ituran evidence directly; do not use prior results or web browsing.",
    "Query current Ituran evidence directly; do not use prior results, memories, session history, or web browsing.",
  ])("recognizes a direct web evidence exclusion: %s", (constraint) => {
    const deferral = result();
    const currentRequestText = [
      "Conduct deep research to understand this source properly and report its evidence.",
      constraint,
    ].join(" ");

    applyPromptSkillRequestRouting(deferral, {
      currentRequestText,
      requestRelevanceText: currentRequestText,
      skills: skills.filter((skill) => skill.name === "deep-research"),
      locations: new Map([
        ["/skills/deep-research/SKILL.md", "deep-research"],
      ]),
    });

    expect(deferral.requestRelevantPromptSkillNames).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillLocations).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillWorkflowToolNames).toEqual([]);
    expect(deferral.requestRelevantPromptSkillMinDistinctWebFetchUrls).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillMinDistinctWebSearchQueries).toBeUndefined();
  });

  it("keeps coordinated web exclusions from arming research floors", () => {
    const excluded = result();
    const excludedRequest = [
      "Conduct deep research to understand the connected records properly.",
      "Work directly and do not delegate or use web research or prior reports.",
    ].join(" ");

    expect(applyPromptSkillRequestRouting(excluded, {
      currentRequestText: excludedRequest,
      requestRelevanceText: excludedRequest,
      skills: skills.filter((skill) => skill.name === "deep-research"),
      locations: new Map([
        ["/skills/deep-research/SKILL.md", "deep-research"],
      ]),
    })).toEqual(["deep-research"]);
    expect(excluded.requestRelevantPromptSkillNames).toBeUndefined();
    expect(excluded.requestRelevantPromptSkillLocations).toBeUndefined();
    expect(excluded.requestRelevantPromptSkillWorkflowToolNames).toEqual([]);
    expect(excluded.requestRelevantPromptSkillMinDistinctWebFetchUrls).toBeUndefined();
    expect(excluded.requestRelevantPromptSkillMinDistinctWebSearchQueries).toBeUndefined();
    expect(excluded.requestRelevantToolNames).toEqual([]);

    const permitted = result();
    const permittedRequest = [
      "Conduct deep research to understand the connected records properly.",
      "Work directly and use web research instead of prior reports.",
    ].join(" ");

    applyPromptSkillRequestRouting(permitted, {
      currentRequestText: permittedRequest,
      requestRelevanceText: permittedRequest,
      skills: skills.filter((skill) => skill.name === "deep-research"),
      locations: new Map([
        ["/skills/deep-research/SKILL.md", "deep-research"],
      ]),
    });
    expect(permitted.requestRelevantPromptSkillNames).toEqual(["deep-research"]);
    expect(permitted.requestRelevantPromptSkillWorkflowToolNames).toEqual([
      "web_search",
      "web_fetch",
    ]);
  });

  // A floor whose receipt tool is unreachable can never be met, so the
  // completion gate would discard the model's answer on every routed turn.
  it("drops web-evidence floors when the receipt tools are unavailable", () => {
    const deferral = result();
    deferral.activeTools = deferral.activeTools.filter(
      (entry) => entry.name !== "web_search" && entry.name !== "web_fetch",
    );

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
    expect(deferral.requestRelevantPromptSkillWorkflowToolNames).toEqual([]);
    expect(
      (deferral as ExcludeDeferralResult & {
        requestRelevantPromptSkillMinDistinctWebFetchUrls?: number;
      }).requestRelevantPromptSkillMinDistinctWebFetchUrls,
    ).toBeUndefined();
    expect(
      (deferral as ExcludeDeferralResult & {
        requestRelevantPromptSkillMinDistinctWebSearchQueries?: number;
      }).requestRelevantPromptSkillMinDistinctWebSearchQueries,
    ).toBeUndefined();
  });

  // Two shared terms is the weakest match routing admits. Arming a floor there
  // let ordinary local-context prose ("the research topic list we already wrote
  // down") require three fetches and three searches, and the completion gate
  // discarded the model's correct answer when they never arrived.
  it("discloses the skill but drops its floors on a bare-minimum term match", () => {
    const deferral = result();

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText: "summarize the research topic list we already wrote down",
      requestRelevanceText: "summarize the research topic list we already wrote down",
      skills,
      locations: new Map([
        ["/skills/deep-research/SKILL.md", "deep-research"],
      ]),
    });

    expect(selected).toEqual(["deep-research"]);
    expect(deferral.requestRelevantPromptSkillNames).toBeUndefined();
    expect(deferral.requestRelevantPromptSkillLocations).toBeUndefined();
    expect(deferral.activeTools.find((entry) => entry.name === "read")?.description)
      .toContain("/skills/deep-research/SKILL.md");
    expect(deferral.requestRelevantPromptSkillWorkflowToolNames).toEqual([]);
    expect(
      (deferral as ExcludeDeferralResult & {
        requestRelevantPromptSkillMinDistinctWebFetchUrls?: number;
      }).requestRelevantPromptSkillMinDistinctWebFetchUrls,
    ).toBeUndefined();
    expect(
      (deferral as ExcludeDeferralResult & {
        requestRelevantPromptSkillMinDistinctWebSearchQueries?: number;
      }).requestRelevantPromptSkillMinDistinctWebSearchQueries,
    ).toBeUndefined();
  });

  it("keeps the search floor enforceable when only web_fetch is unavailable", () => {
    const deferral = result();
    deferral.activeTools = deferral.activeTools.filter(
      (entry) => entry.name !== "web_fetch",
    );

    applyPromptSkillRequestRouting(deferral, {
      currentRequestText:
        "i need to understand heat pumps properly, not just a paragraph",
      requestRelevanceText:
        "i need to understand heat pumps properly, not just a paragraph",
      skills,
      locations: new Map([
        ["/skills/deep-research/SKILL.md", "deep-research"],
      ]),
    });

    expect(deferral.requestRelevantPromptSkillWorkflowToolNames).toEqual([
      "web_search",
    ]);
    expect(
      (deferral as ExcludeDeferralResult & {
        requestRelevantPromptSkillMinDistinctWebFetchUrls?: number;
      }).requestRelevantPromptSkillMinDistinctWebFetchUrls,
    ).toBeUndefined();
    expect(
      (deferral as ExcludeDeferralResult & {
        requestRelevantPromptSkillMinDistinctWebSearchQueries?: number;
      }).requestRelevantPromptSkillMinDistinctWebSearchQueries,
    ).toBe(3);
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

  it("excludes stale workflow context from a self-contained current request", () => {
    const deferral = result();
    const currentRequestText =
      "i need to understand heat pumps properly, not just a paragraph";
    const priorUserRequest =
      "use exactly four old URLs and report an unavailable fixture source";

    applyPromptSkillRequestRouting(deferral, {
      currentRequestText,
      requestRelevanceText: [priorUserRequest, currentRequestText].join("\n"),
      priorUserRequest,
      skills,
      locations: new Map([
        ["/skills/deep-research/SKILL.md", "deep-research"],
      ]),
    });

    expect(deferral.requestRelevantPromptSkillWorkflowContext).toBe(currentRequestText);
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
    expect(deferral.requestRelevantPromptSkillWorkflowContext).toContain(
      "i need to understand heat pumps properly, not just a paragraph",
    );
    expect(deferral.requestRelevantPromptSkillWorkflowContext).toContain(
      currentRequestText,
    );
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

  it("does not route a conversation-history recall question as a skill workflow", () => {
    const deferral = result();
    const currentRequestText = "what did i say about the project near the start?";

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText,
      requestRelevanceText: currentRequestText,
      skills: [{
        name: "project-start",
        description: "Use a project start workflow to prepare repository tasks.",
        replacesPackages: [],
        requiredBins: ["git"],
      }],
      locations: new Map([
        ["/skills/project-start/SKILL.md", "project-start"],
      ]),
    });

    expect(selected).toEqual([]);
    expect(deferral.requestRelevantToolNames).toEqual([]);
    expect(deferral.requestRelevantPromptSkillNames).toBeUndefined();
  });

  it("does not treat generic background task and tool terms as a coding request", () => {
    const deferral = result();
    const currentRequestText = [
      "[Background Task Failed: mcp fixture-hang--hang forever]",
      "MCP tool error: the hanging fixture tool exceeded the configured call deadline.",
      "Inform the user about this completed background task.",
    ].join("\n");

    const selected = applyPromptSkillRequestRouting(deferral, {
      currentRequestText,
      requestRelevanceText: currentRequestText,
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

describe("physical user request text", () => {
  it("uses the physical typed messages, never the enriched text", () => {
    expect(physicalUserRequestText({
      text: "understand heat pumps properly\n[Extracted page content]: buy now",
      originalMessages: [{ text: "understand heat pumps properly" }],
    })).toBe("understand heat pumps properly");
  });

  it("joins several physical messages of one coalesced turn", () => {
    expect(physicalUserRequestText({
      text: "enriched",
      originalMessages: [{ text: "understand heat pumps" }, { text: "properly please" }],
    })).toBe("understand heat pumps\nproperly please");
  });

  // A voice note normalizes to an EMPTY physical text, so joining the physical
  // messages yields "" — which is not nullish and silenced routing entirely.
  // Speech is first-party user wording: the trusted transcription receipt is
  // the only physical text a spoken turn has.
  it("falls back to the trusted transcription for a voice-only turn", () => {
    expect(physicalUserRequestText({
      text: "[Voice message transcription]: research heat pumps thoroughly",
      originalMessages: [{ text: "" }],
      attachments: [{ transcription: "research heat pumps thoroughly" }],
    })).toBe("research heat pumps thoroughly");
  });

  it("routes a spoken deep-research request exactly like the typed one", () => {
    const spoken = result();
    const locations = new Map([["/skills/deep-research/SKILL.md", "deep-research"]]);
    const currentRequestText = physicalUserRequestText({
      text: "[Voice message transcription]: i need to understand heat pumps properly, not just a paragraph",
      originalMessages: [{ text: "" }],
      attachments: [{
        transcription: "i need to understand heat pumps properly, not just a paragraph",
      }],
    });

    expect(applyPromptSkillRequestRouting(spoken, {
      currentRequestText,
      requestRelevanceText: currentRequestText,
      skills,
      locations,
    })).toEqual(["deep-research"]);
  });

  it("yields no routing text for a media-only turn with no transcription", () => {
    expect(physicalUserRequestText({
      text: "[Image analysis]: a chart of quarterly revenue",
      originalMessages: [{ text: "" }],
      attachments: [{}],
    })).toBe("");
  });
});
