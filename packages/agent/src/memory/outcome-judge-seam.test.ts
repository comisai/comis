// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithContext, type WorkspacePolicySnapshot } from "@comis/core";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: vi.fn() }));
vi.mock("./judge-model-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./judge-model-resolver.js")>();
  return { ...actual, resolveJudgeModel: vi.fn(() => ({ provider: "example", id: "judge" })) };
});

import { completeSimple } from "@earendil-works/pi-ai/compat";
import { createOutcomeJudgeSeam, JUDGE_REWARD_CAP } from "./outcome-judge-seam.js";

function snapshot(content = "Follow the configured task boundary."): WorkspacePolicySnapshot {
  return {
    agentId: "agent_a",
    combinedHash: "a".repeat(64),
    sections: [{
      id: "workspace:role",
      sourceKind: "operator",
      trust: "trusted",
      stability: "stable",
      content,
      contentHash: "b".repeat(64),
      maxChars: 20_000,
    }],
  };
}

function makeJudge() {
  return createOutcomeJudgeSeam({
    provider: "example",
    modelId: "judge",
    apiKey: "test-key",
    maxOutputTokens: 128,
    clock: createFakeClock(100),
    logger: createMockLogger(),
    agentId: "agent_a",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createOutcomeJudgeSeam", () => {
  it("uses the exact immutable policy snapshot as generic verdict criteria", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: '{"outcome":"success","confidence":0.6}' }],
    } as never);
    const policySnapshot = snapshot();

    await runWithContext({ contentDelimiter: "judge-delimiter" }, () =>
      makeJudge()({ trajectoryContent: "turn evidence", policySnapshot }));

    const request = vi.mocked(completeSimple).mock.calls[0]?.[1] as {
      systemPrompt: string;
      messages: Array<{ content: string }>;
    };
    expect(request.systemPrompt).toContain("Follow the configured task boundary");
    expect(request.systemPrompt).not.toMatch(/foreign-script|refusal|business alternative/iu);
    expect(request.messages[0]?.content).toContain("<<<UNTRUSTED_judge-delimiter>>>");
  });

  it("returns content-free audit metadata for model policy rubric and evidence", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: '{"outcome":"failure","confidence":1}' }],
    } as never);
    const verdict = await runWithContext({ contentDelimiter: "judge-delimiter" }, () =>
      makeJudge()({ trajectoryContent: "private trajectory text", policySnapshot: snapshot("private policy") }));

    expect(verdict).toEqual(expect.objectContaining({
      outcome: "failure",
      cappedConfidence: JUDGE_REWARD_CAP,
      policyHash: "a".repeat(64),
      judgeModel: "example/judge",
      rubricHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      evidenceRefs: [expect.stringMatching(/^[a-f0-9]{64}$/u)],
    }));
    expect(JSON.stringify(verdict)).not.toContain("private");
  });

  it("keeps agent state out of trusted operator criteria", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: '{"outcome":"unknown","confidence":0}' }],
    } as never);
    const policySnapshot: WorkspacePolicySnapshot = {
      ...snapshot(),
      sections: [...snapshot().sections, {
        id: "workspace:bootstrap",
        sourceKind: "agent_state",
        trust: "untrusted",
        stability: "turn",
        content: "UNTRUSTED_STATE_SENTINEL",
        contentHash: "c".repeat(64),
        maxChars: 20_000,
      }],
    };
    await runWithContext({ contentDelimiter: "judge-delimiter" }, () =>
      makeJudge()({ trajectoryContent: "evidence", policySnapshot }));
    const request = vi.mocked(completeSimple).mock.calls[0]?.[1] as { systemPrompt: string };
    expect(request.systemPrompt).not.toContain("UNTRUSTED_STATE_SENTINEL");
  });

  it("degrades malformed model output to an unknown verdict", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: "not-json" }],
    } as never);
    const verdict = await runWithContext({ contentDelimiter: "judge-delimiter" }, () =>
      makeJudge()({ trajectoryContent: "evidence", policySnapshot: snapshot() }));
    expect(verdict?.outcome).toBe("unknown");
    expect(verdict?.cappedConfidence).toBe(0);
  });
});
