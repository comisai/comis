// SPDX-License-Identifier: Apache-2.0
import {
  computeWorkspacePolicyCombinedHash,
  createConversationRef,
  hashWorkspacePolicyContent,
} from "@comis/core";
import { err, ok } from "@comis/shared";
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
  it("enforces lifecycle and single-operation admission before model work", async () => {
    let resolveModel: ((value: ReturnType<typeof ok<{ raw: string }>>) => void) | undefined;
    const data = setup();
    data.modelRun.mockImplementationOnce(() => new Promise((resolve) => { resolveModel = resolve; }));

    expect(data.runner.getStatus()).toEqual({ accepting: false, activeCount: 0 });
    expect(data.runner.submit("agent-a", [item()])).toEqual(
      err({ code: "not_accepting", errorKind: "precondition" }),
    );
    data.runner.activate();
    expect(data.runner.submit("agent-a", [item()])).toEqual(ok(undefined));
    expect(data.runner.submit("agent-a", [item()])).toEqual(
      err({ code: "already_running", errorKind: "precondition" }),
    );
    expect(data.runner.getStatus()).toEqual({ accepting: true, activeCount: 1 });
    await vi.waitFor(() => expect(data.withModelSession).toHaveBeenCalledOnce());
    resolveModel?.(ok({ raw: validOutput() }));
    await data.runner.waitForIdle();
    expect(data.runner.close()).toEqual({ activeCount: 0 });
    expect(data.runner.activate()).toEqual(err({ code: "closed", errorKind: "precondition" }));
  });

  it("rejects malformed identifiers batches ownership and timestamps", () => {
    const base = item();
    const wrongAgent = {
      ...base,
      origin: {
        ...base.origin,
        turnScope: {
          ...base.origin.turnScope,
          conversation: { ...base.origin.turnScope.conversation, agentId: "agent-b" },
        },
      },
    };
    const cases = [
      setup({ idFactory: () => { throw new Error("identifier unavailable"); } }),
      setup({ idFactory: () => "wrong-prefix" }),
      setup({ idFactory: () => `root-task-extract-${"x".repeat(300)}` }),
    ];
    for (const data of cases) {
      data.runner.activate();
      expect(data.runner.submit("agent-a", [base])).toMatchObject({
        ok: false,
        error: { code: "invalid_batch", errorKind: "validation" },
      });
    }

    const empty = setup();
    empty.runner.activate();
    expect(empty.runner.submit("", [base])).toMatchObject({ ok: false, error: { code: "invalid_batch" } });
    expect(empty.runner.submit("agent-a", [])).toMatchObject({ ok: false, error: { code: "invalid_batch" } });
    expect(empty.runner.submit("agent-a", Array.from({ length: 65 }, () => base))).toMatchObject({
      ok: false,
      error: { code: "invalid_batch" },
    });
    expect(empty.runner.submit("agent-a", [wrongAgent])).toMatchObject({
      ok: false,
      error: { code: "invalid_batch" },
    });

    const invalidClock = setup();
    invalidClock.setNow(-1);
    invalidClock.runner.activate();
    expect(invalidClock.runner.submit("agent-a", [base])).toMatchObject({
      ok: false,
      error: { code: "invalid_batch" },
    });
  });

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

  it("reports rejected and explicit root registration failures without model access", async () => {
    const rejected = setup({ registerRoot: async () => { throw new Error("registry unavailable"); } });
    rejected.runner.activate();
    rejected.runner.submit("agent-a", [item()]);
    await rejected.runner.waitForIdle();
    expect(rejected.onOutcome).toHaveBeenCalledWith(expect.objectContaining({
      status: "dropped",
      stage: "root_registration",
      errorKind: "internal",
    }));
    expect(rejected.withModelSession).not.toHaveBeenCalled();

    const failed = setup({
      registerRoot: async () => err({ code: "registry_denied", errorKind: "resource" }),
    });
    failed.runner.activate();
    failed.runner.submit("agent-a", [item()]);
    await failed.runner.waitForIdle();
    expect(failed.onOutcome).toHaveBeenCalledWith(expect.objectContaining({
      stage: "root_registration",
      errorKind: "resource",
    }));
  });

  it("attaches rejected and explicit root release failures to the completed outcome", async () => {
    const rejected = setup({ releaseRoot: async () => { throw new Error("release unavailable"); } });
    rejected.runner.activate();
    rejected.runner.submit("agent-a", [item()]);
    await rejected.runner.waitForIdle();
    expect(rejected.onOutcome).toHaveBeenCalledWith(expect.objectContaining({
      status: "persisted",
      releaseErrorKind: "internal",
    }));

    const failed = setup({
      releaseRoot: async () => err({ code: "release_denied", errorKind: "resource" }),
    });
    failed.runner.activate();
    failed.runner.submit("agent-a", [item()]);
    await failed.runner.waitForIdle();
    expect(failed.onOutcome).toHaveBeenCalledWith(expect.objectContaining({
      status: "persisted",
      releaseErrorKind: "resource",
    }));
  });

  it("drops disabled and invalid-time operations before opening a model session", async () => {
    for (const isEnabled of [() => false, () => { throw new Error("gate unavailable"); }]) {
      const data = setup({ isEnabled });
      data.runner.activate();
      data.runner.submit("agent-a", [item()]);
      await data.runner.waitForIdle();
      expect(data.onOutcome).toHaveBeenCalledWith(expect.objectContaining({
        status: "dropped",
        stage: "live_gate",
        errorKind: "precondition",
      }));
      expect(data.withModelSession).not.toHaveBeenCalled();
    }

    let readCount = 0;
    const unsafeClock = setup({
      clock: {
        now: () => (++readCount === 1 ? 2_000 : Number.MAX_SAFE_INTEGER),
        nowDate: () => new Date(0),
      },
    });
    unsafeClock.runner.activate();
    unsafeClock.runner.submit("agent-a", [item()]);
    await unsafeClock.runner.waitForIdle();
    expect(unsafeClock.onOutcome).toHaveBeenCalledWith(expect.objectContaining({
      stage: "internal",
      errorKind: "internal",
    }));
  });

  it("maps model session transport and provider failures to model outcomes", async () => {
    const cases = [
      setup({ withModelSession: async () => { throw new Error("session unavailable"); } }),
      setup({ withModelSession: async () => err({ code: "session_failed", errorKind: "dependency" }) }),
    ];
    for (const data of cases) {
      data.runner.activate();
      data.runner.submit("agent-a", [item()]);
      await data.runner.waitForIdle();
      expect(data.onOutcome).toHaveBeenCalledWith(expect.objectContaining({
        status: "dropped",
        stage: "model",
      }));
    }

    const rejectedRun = setup();
    rejectedRun.modelRun.mockRejectedValueOnce(new Error("provider unavailable"));
    rejectedRun.runner.activate();
    rejectedRun.runner.submit("agent-a", [item()]);
    await rejectedRun.runner.waitForIdle();
    expect(rejectedRun.onOutcome).toHaveBeenCalledWith(expect.objectContaining({
      stage: "model",
      errorKind: "internal",
    }));

    const failedRun = setup();
    failedRun.modelRun.mockResolvedValueOnce(err({ code: "provider_failed", errorKind: "dependency" }));
    failedRun.runner.activate();
    failedRun.runner.submit("agent-a", [item()]);
    await failedRun.runner.waitForIdle();
    expect(failedRun.onOutcome).toHaveBeenCalledWith(expect.objectContaining({
      stage: "model",
      errorKind: "dependency",
    }));
  });

  it("maps invalid configuration and repair failures without persisting candidates", async () => {
    const invalidConfig = setup({ getConfig: () => ({ batchMax: 0, defaultWindowMs: 0 }) });
    invalidConfig.runner.activate();
    invalidConfig.runner.submit("agent-a", [item()]);
    await invalidConfig.runner.waitForIdle();
    expect(invalidConfig.onOutcome).toHaveBeenCalledWith(expect.objectContaining({
      stage: "internal",
      errorKind: "config",
    }));

    const rejectedRepair = setup();
    rejectedRepair.modelRun
      .mockResolvedValueOnce(ok({ raw: "{invalid" }))
      .mockRejectedValueOnce(new Error("repair unavailable"));
    rejectedRepair.runner.activate();
    rejectedRepair.runner.submit("agent-a", [item()]);
    await rejectedRepair.runner.waitForIdle();
    expect(rejectedRepair.onOutcome).toHaveBeenCalledWith(expect.objectContaining({
      stage: "model",
      errorKind: "internal",
    }));

    const failedRepair = setup();
    failedRepair.modelRun
      .mockResolvedValueOnce(ok({ raw: "{invalid" }))
      .mockResolvedValueOnce(err({ code: "repair_failed", errorKind: "dependency" }));
    failedRepair.runner.activate();
    failedRepair.runner.submit("agent-a", [item()]);
    await failedRepair.runner.waitForIdle();
    expect(failedRepair.onOutcome).toHaveBeenCalledWith(expect.objectContaining({
      stage: "model",
      errorKind: "dependency",
    }));
  });

  it("enforces deadline and post-model live gate before durable persistence", async () => {
    let resolveTimed: ((value: ReturnType<typeof ok<{ raw: string }>>) => void) | undefined;
    const timed = setup();
    timed.modelRun.mockImplementationOnce(() => new Promise((resolve) => { resolveTimed = resolve; }));
    timed.runner.activate();
    timed.runner.submit("agent-a", [item()]);
    await vi.waitFor(() => expect(timed.withModelSession).toHaveBeenCalledOnce());
    timed.timers.advance(30_000);
    resolveTimed?.(ok({ raw: validOutput() }));
    await timed.runner.waitForIdle();
    expect(timed.onOutcome).toHaveBeenCalledWith(expect.objectContaining({
      stage: "deadline",
      errorKind: "timeout",
    }));
    expect(timed.persistCandidates).not.toHaveBeenCalled();

    let enabledReads = 0;
    const disabledAfterModel = setup({ isEnabled: () => ++enabledReads === 1 });
    disabledAfterModel.runner.activate();
    disabledAfterModel.runner.submit("agent-a", [item()]);
    await disabledAfterModel.runner.waitForIdle();
    expect(disabledAfterModel.onOutcome).toHaveBeenCalledWith(expect.objectContaining({
      stage: "live_gate",
      errorKind: "precondition",
    }));
  });

  it("maps rejected and explicit persistence failures to store outcomes", async () => {
    const rejected = setup({ persistCandidates: async () => { throw new Error("store unavailable"); } });
    rejected.runner.activate();
    rejected.runner.submit("agent-a", [item()]);
    await rejected.runner.waitForIdle();
    expect(rejected.onOutcome).toHaveBeenCalledWith(expect.objectContaining({
      stage: "store",
      errorKind: "internal",
    }));

    const failed = setup({
      persistCandidates: async () => err({ code: "write_failed", errorKind: "resource" }),
    });
    failed.runner.activate();
    failed.runner.submit("agent-a", [item()]);
    await failed.runner.waitForIdle();
    expect(failed.onOutcome).toHaveBeenCalledWith(expect.objectContaining({
      stage: "store",
      errorKind: "resource",
    }));
  });
});
