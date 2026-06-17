// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for buildSkillSynthesisCronDeps — the closed-graph skill-synthesis bundle
 * assembler (SKILL-08/09, Plan 07). The daemon is the SOLE composition root joining
 * @comis/memory (the learned-skill + outcome stores) + @comis/skills (the validation
 * adapter) + @comis/agent (the job); this helper builds the bundle the __SKILL_SYNTHESIS__
 * sentinel injects. createSandboxSkillValidationAdapter is mocked (no real bwrap).
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

const mockCreateSandboxSkillValidationAdapter = vi.hoisted(() => vi.fn(() => ({ validate: vi.fn() })));
vi.mock("@comis/skills", () => ({
  createSandboxSkillValidationAdapter: mockCreateSandboxSkillValidationAdapter,
}));

import { buildSkillSynthesisCronDeps, type SkillSynthesisDepsInput } from "./setup-channels-skill-synthesis-deps.js";

function makeInput(over: Partial<SkillSynthesisDepsInput> = {}): SkillSynthesisDepsInput {
  return {
    container: { config: { tenantId: "t", agents: { "agent-1": { skills: { toolPolicy: { profile: "full", allow: [], deny: [] } } } } } } as any,
    tenantId: "t",
    assembleToolsForAgent: vi.fn(async () => [{ name: "read" }]) as any,
    sessionStore: { listDetailed: vi.fn(() => []), loadByFormattedKey: vi.fn(() => undefined) } as any,
    outcomeStore: { resolve: vi.fn(), observe: vi.fn(), prune: vi.fn() } as any,
    learnedSkillStore: { admit: vi.fn() } as any,
    approvalGate: { requestApproval: vi.fn(async () => ({ approved: false })) } as any,
    ...over,
  };
}

describe("buildSkillSynthesisCronDeps", () => {
  it("returns undefined when the learned-skill store is absent (the sentinel then reports not-wired)", () => {
    expect(buildSkillSynthesisCronDeps(makeInput({ learnedSkillStore: undefined }))).toBeUndefined();
  });

  it("returns undefined when the outcome store is absent", () => {
    expect(buildSkillSynthesisCronDeps(makeInput({ outcomeStore: undefined }))).toBeUndefined();
  });

  it("injects the learned-skill store + the outcome success gate + the approval gate (the closed-graph adapters)", () => {
    const input = makeInput();
    const bundle = buildSkillSynthesisCronDeps(input)!;
    expect(bundle).toBeDefined();
    expect(bundle.learnedSkillStore).toBe(input.learnedSkillStore);
    expect(bundle.outcomeSignal).toBe(input.outcomeStore);
    expect(bundle.approvalGate).toBe(input.approvalGate);
  });

  it("falls back to a deny-all approval gate when none is wired (a mutating candidate is then never admitted)", async () => {
    const bundle = buildSkillSynthesisCronDeps(makeInput({ approvalGate: undefined }))!;
    const r = await bundle.approvalGate.requestApproval({ toolName: "x", action: "y", params: {}, agentId: "a", sessionKey: "s", trustLevel: "learned" });
    expect(r.approved).toBe(false);
  });

  it("constructs the @comis/skills validation adapter with the agent's tool list + policy (buildValidationAdapter)", async () => {
    const input = makeInput();
    const bundle = buildSkillSynthesisCronDeps(input)!;
    await bundle.buildValidationAdapter("agent-1");
    expect(input.assembleToolsForAgent).toHaveBeenCalledWith("agent-1");
    expect(mockCreateSandboxSkillValidationAdapter).toHaveBeenCalledOnce();
    const arg = mockCreateSandboxSkillValidationAdapter.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.allTools).toEqual([{ name: "read" }]);
    expect(arg.policy).toEqual({ profile: "full", allow: [], deny: [] });
  });

  it("flattens the LCD-merged session transcripts into source trajectories (buildSourceTrajectories, NOT raw listDetailed)", async () => {
    const sessionStore = {
      listDetailed: vi.fn(() => [{ sessionKey: "s1", userId: "u1", tenantId: "t", channelId: "c", metadata: null, createdAt: 1, updatedAt: 2, messageCount: 2 }]),
      loadByFormattedKey: vi.fn(() => ({ messages: [{ role: "user", content: "do X" }, { role: "assistant", content: "did X" }], metadata: {}, createdAt: 1, updatedAt: 2 })),
    };
    const bundle = buildSkillSynthesisCronDeps(makeInput({ sessionStore: sessionStore as any }))!;
    const trajectories = await bundle.buildSourceTrajectories("agent-1", "t");
    expect(trajectories).toHaveLength(1);
    expect(trajectories[0].trajectoryId).toBe("s1");
    expect(trajectories[0].sessionId).toBe("s1");
    expect(trajectories[0].sender).toBe("u1");
    expect(trajectories[0].text).toContain("do X");
    expect(trajectories[0].text).toContain("did X");
  });

  it("skips a session that loads no text — no empty trajectory (buildSourceTrajectories)", async () => {
    const sessionStore = {
      listDetailed: vi.fn(() => [{ sessionKey: "s1", userId: "u1", tenantId: "t", channelId: "c", metadata: null, createdAt: 1, updatedAt: 2, messageCount: 0 }]),
      loadByFormattedKey: vi.fn(() => ({ messages: [], metadata: {}, createdAt: 1, updatedAt: 2 })),
    };
    const bundle = buildSkillSynthesisCronDeps(makeInput({ sessionStore: sessionStore as any }))!;
    const trajectories = await bundle.buildSourceTrajectories("agent-1", "t");
    expect(trajectories).toHaveLength(0);
  });
});
