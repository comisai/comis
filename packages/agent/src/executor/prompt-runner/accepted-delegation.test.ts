// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  delegationOwnsPromptSkillWorkflow,
  hasAcceptedDelegation,
} from "./accepted-delegation.js";

describe("hasAcceptedDelegation", () => {
  it("recognizes only successful session spawn receipts", () => {
    expect(hasAcceptedDelegation(undefined)).toBe(false);
    expect(hasAcceptedDelegation([
      { toolName: "sessions_spawn", success: false },
      { toolName: "web_search", success: true },
    ])).toBe(false);
    expect(hasAcceptedDelegation([
      { toolName: "sessions_spawn", success: true },
    ])).toBe(true);
  });
});

describe("delegationOwnsPromptSkillWorkflow", () => {
  it("recognizes a successful child that owns every enforced workflow tool", () => {
    expect(delegationOwnsPromptSkillWorkflow([{
      toolName: "sessions_spawn",
      success: true,
      delegatedToolNames: ["web_search", "web_fetch"],
    }], ["web_search", "web_fetch"])).toBe(true);
  });

  it("keeps parent ownership when a child lacks part of the workflow", () => {
    expect(delegationOwnsPromptSkillWorkflow([{
      toolName: "sessions_spawn",
      success: true,
      delegatedToolNames: ["web_search"],
    }], ["web_search", "web_fetch"])).toBe(false);
    expect(delegationOwnsPromptSkillWorkflow([{
      toolName: "sessions_spawn",
      success: false,
      delegatedToolNames: ["web_search", "web_fetch"],
    }], ["web_search", "web_fetch"])).toBe(false);
  });
});
