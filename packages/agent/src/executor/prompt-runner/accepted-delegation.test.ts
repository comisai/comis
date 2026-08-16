// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  delegationOwnsPromptSkillWorkflow,
  hasWholeRequestDelegation,
} from "./accepted-delegation.js";

describe("hasWholeRequestDelegation", () => {
  it("requires a successful spawn with explicit whole-request ownership", () => {
    expect(hasWholeRequestDelegation(undefined)).toBe(false);
    expect(hasWholeRequestDelegation([
      { toolName: "sessions_spawn", success: false },
      { toolName: "web_search", success: true },
    ] as never)).toBe(false);
    expect(hasWholeRequestDelegation([
      { toolName: "sessions_spawn", success: true },
      { toolName: "sessions_spawn", success: true, delegationScope: "partial" },
    ] as never)).toBe(false);
    expect(hasWholeRequestDelegation([{
      toolName: "sessions_spawn",
      success: true,
      delegationScope: "whole_request",
    } as never])).toBe(true);
  });
});

describe("delegationOwnsPromptSkillWorkflow", () => {
  it("requires explicit whole-request ownership in addition to delegated tools", () => {
    expect(delegationOwnsPromptSkillWorkflow([{
      toolName: "sessions_spawn",
      success: true,
      delegatedToolNames: ["web_search", "web_fetch"],
      delegationScope: "whole_request",
    } as never], ["web_search", "web_fetch"])).toBe(true);
    expect(delegationOwnsPromptSkillWorkflow([{
      toolName: "sessions_spawn",
      success: true,
      delegatedToolNames: ["web_search", "web_fetch"],
      delegationScope: "partial",
    } as never], ["web_search", "web_fetch"])).toBe(false);
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
