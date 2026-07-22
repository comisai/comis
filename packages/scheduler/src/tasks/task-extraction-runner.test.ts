// SPDX-License-Identifier: Apache-2.0
import {
  computeWorkspacePolicyCombinedHash,
  createConversationRef,
  hashWorkspacePolicyContent,
} from "@comis/core";
import { ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import type { TaskExtractionItem } from "./task-extraction-queue.js";
import { createTaskExtractionRunner } from "./task-extraction-runner.js";

function item(): TaskExtractionItem {
  const conversation = {
    tenantId: "tenant-a",
    agentId: "agent-a",
    partition: { kind: "agent" as const },
  };
  const conversationRef = createConversationRef(conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  const content = "# Scope\n\nUse the configured scope.";
  const section = {
    id: "workspace:scope",
    sourceKind: "operator" as const,
    trust: "trusted" as const,
    stability: "stable" as const,
    content,
    contentHash: hashWorkspacePolicyContent(content),
    maxChars: 20_000,
  };
  return {
    itemId: "item-a",
    sourceExecutionId: "execution-a",
    origin: {
      turnScope: {
        conversation,
        principal: { principalId: "user-a" },
        endpoint: {
          channelType: "echo",
          channelInstanceId: "echo-main",
          conversationId: "conversation-a",
          conversationKind: "direct",
        },
      },
      conversationRef: conversationRef.value,
      deliveryOrigin: {
        tenantId: "tenant-a",
        channelType: "echo",
        channelId: "conversation-a",
        userId: "user-a",
      },
      traceId: "trace-a",
      backgroundHopCount: 0,
    },
    workspacePolicySnapshot: {
      agentId: "agent-a",
      sections: [section],
      combinedHash: computeWorkspacePolicyCombinedHash([section]),
    },
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    capturedAtMs: 1_000,
    minimumDueAtMs: 61_000,
    userText: "Please check this later.",
    deliveredAssistantText: "I will follow up.",
  };
}

function validOutput() {
  return JSON.stringify({
    candidates: [{
      itemId: "item-a",
      text: "Check the outcome",
      dueInSecondsEarliest: 60,
      dueInSecondsLatest: 120,
      confidence: 0.9,
    }],
  });
}

function setup(overrides: Record<string, unknown> = {}) {
  const timers = createFakeTimers();
  let nowMs = 2_000;
  const modelRun = vi.fn(async () => ok({ raw: validOutput() }));
  const withModelSession = vi.fn(async (_input, use) => ok(await use({ run: modelRun })));
  const persistCandidates = vi.fn(async () => ok({ createdCount: 1, mergedCount: 0 }));
  const releaseRoot = vi.fn(async () => ok(undefined));
  const onOutcome = vi.fn();
  const runner = createTaskExtractionRunner({
    clock: { now: () => nowMs, nowDate: () => new Date(nowMs) },
    timers,
    idFactory: () => "root-task-extract-a",
    getConfig: () => ({ batchMax: 8, defaultWindowMs: 3_600_000 }),
    isEnabled: () => true,
    registerRoot: async () => ok(undefined),
    releaseRoot,
    withModelSession,
    persistCandidates,
    onOutcome,
    ...overrides,
  } as never);
  return {
    runner,
    timers,
    modelRun,
    withModelSession,
    persistCandidates,
    releaseRoot,
    onOutcome,
    setNow(value: number) { nowMs = value; },
  };
}

describe("governed task extraction runner", () => {
  it("runs one rooted model session and persists strictly bound candidates", async () => {
    const data = setup();
    expect(data.runner.activate()).toEqual(ok(undefined));
    expect(data.runner.submit("agent-a", [item()])).toEqual(ok(undefined));
    await data.runner.waitForIdle();

    expect(data.withModelSession).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-a",
      rootRunId: "root-task-extract-a",
      items: [expect.objectContaining({ itemId: "item-a" })],
      deadlineAtMs: 32_000,
      signal: expect.any(AbortSignal),
    }), expect.any(Function));
    expect(data.modelRun).toHaveBeenCalledWith({ mode: "initial" });
    expect(data.persistCandidates).toHaveBeenCalledWith("agent-a", [expect.objectContaining({
      text: "Check the outcome",
      item: expect.objectContaining({ itemId: "item-a" }),
    })]);
    expect(data.releaseRoot).toHaveBeenCalledWith("root-task-extract-a");
    expect(data.onOutcome).toHaveBeenCalledWith(expect.objectContaining({
      status: "persisted",
      itemCount: 1,
      candidateCount: 1,
    }));
  });

  it("rejects a model batch containing more than one immutable workspace policy", async () => {
    const data = setup();
    const first = item();
    const alternateContent = "# Scope\n\nUse the updated configured scope.";
    const alternateSection = {
      ...first.workspacePolicySnapshot.sections[0]!,
      content: alternateContent,
      contentHash: hashWorkspacePolicyContent(alternateContent),
    };
    const second: TaskExtractionItem = {
      ...first,
      itemId: "item-b",
      sourceExecutionId: "execution-b",
      workspacePolicySnapshot: {
        agentId: "agent-a",
        sections: [alternateSection],
        combinedHash: computeWorkspacePolicyCombinedHash([alternateSection]),
      },
    };
    data.runner.activate();

    const submitted = data.runner.submit("agent-a", [first, second]);
    await data.runner.waitForIdle();

    expect(submitted).toMatchObject({ ok: false, error: { code: "invalid_batch" } });
    expect(data.withModelSession).not.toHaveBeenCalled();
  });

  it("uses one schema repair inside the same model session", async () => {
    const data = setup();
    data.modelRun
      .mockResolvedValueOnce(ok({ raw: "{invalid" }))
      .mockResolvedValueOnce(ok({ raw: validOutput() }));
    data.runner.activate();
    expect(data.runner.submit("agent-a", [item()])).toEqual(ok(undefined));
    await data.runner.waitForIdle();

    expect(data.modelRun).toHaveBeenNthCalledWith(1, { mode: "initial" });
    expect(data.modelRun).toHaveBeenNthCalledWith(2, { mode: "repair", invalidOutput: "{invalid" });
    expect(data.withModelSession).toHaveBeenCalledOnce();
    expect(data.persistCandidates).toHaveBeenCalledOnce();
  });

  it("does not repair or persist an oversized model response", async () => {
    const data = setup();
    data.modelRun.mockResolvedValueOnce(ok({ raw: "x".repeat(64 * 1_024 + 1) }));
    data.runner.activate();
    expect(data.runner.submit("agent-a", [item()])).toEqual(ok(undefined));
    await data.runner.waitForIdle();

    expect(data.modelRun).toHaveBeenCalledOnce();
    expect(data.persistCandidates).not.toHaveBeenCalled();
    expect(data.onOutcome).toHaveBeenCalledWith(expect.objectContaining({
      status: "dropped",
      stage: "model_output",
      errorKind: "validation",
    }));
  });

  it("closes the persistence fence before aborting a late model result", async () => {
    let resolveModel: ((value: ReturnType<typeof ok<{ raw: string }>>) => void) | undefined;
    const data = setup();
    data.modelRun.mockImplementationOnce(() => new Promise((resolve) => { resolveModel = resolve; }));
    data.runner.activate();
    expect(data.runner.submit("agent-a", [item()])).toEqual(ok(undefined));
    await vi.waitFor(() => expect(data.withModelSession).toHaveBeenCalledOnce());

    expect(data.runner.close()).toEqual({ activeCount: 1 });
    expect(data.withModelSession.mock.calls[0]![0].signal.aborted).toBe(true);
    resolveModel?.(ok({ raw: validOutput() }));
    await data.runner.waitForIdle();

    expect(data.persistCandidates).not.toHaveBeenCalled();
    expect(data.releaseRoot).toHaveBeenCalledWith("root-task-extract-a");
    expect(data.onOutcome).toHaveBeenCalledWith(expect.objectContaining({
      status: "dropped",
      stage: "persistence_fence",
      errorKind: "precondition",
    }));
  });
});
