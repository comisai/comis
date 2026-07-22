// SPDX-License-Identifier: Apache-2.0
import type {
  DeliveredAssistantHistoryPort,
  TaskExtractionPort,
} from "@comis/core";
import { ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createSchedulerCorePortBindings } from "./scheduler-core-port-bindings.js";

const taskTurn = {
  sourceExecutionId: "execution_a",
  origin: {} as never,
  workspacePolicySnapshot: {} as never,
  responseLocalePolicy: {} as never,
  capturedAtMs: 1,
  userText: "user",
  deliveredAssistantText: "assistant",
};

const historyInput = {
  conversation: {} as never,
  deliveredText: "assistant",
  sourceExecutionId: "execution_a",
  attemptId: "attempt_a",
  deliveredAtMs: 1,
};

describe("scheduler core port bindings", () => {
  it("fails both stable proxies closed before their adapters are bound", async () => {
    const bindings = createSchedulerCorePortBindings();

    expect(bindings.taskExtractionPort.enqueue(taskTurn)).toEqual({
      ok: false,
      error: { code: "not_accepting", errorKind: "precondition" },
    });
    await expect(bindings.deliveredAssistantHistoryPort.append(historyInput)).resolves.toEqual({
      ok: false,
      error: { code: "not_accepting", errorKind: "precondition" },
    });
    expect(bindings.status()).toEqual({
      accepting: true,
      taskExtractionBound: false,
      deliveredAssistantHistoryBound: false,
    });
  });

  it("delegates through stable identities after one coherent bind", async () => {
    const enqueue = vi.fn(() => ok("enqueued" as const));
    const append = vi.fn(async () => ok("appended" as const));
    const bindings = createSchedulerCorePortBindings();
    const taskProxy = bindings.taskExtractionPort;
    const historyProxy = bindings.deliveredAssistantHistoryPort;

    expect(bindings.bind({
      taskExtractionPort: { enqueue } satisfies TaskExtractionPort,
      deliveredAssistantHistoryPort: { append } satisfies DeliveredAssistantHistoryPort,
    })).toEqual(ok(undefined));

    expect(bindings.taskExtractionPort).toBe(taskProxy);
    expect(bindings.deliveredAssistantHistoryPort).toBe(historyProxy);
    expect(taskProxy.enqueue(taskTurn)).toEqual(ok("enqueued"));
    await expect(historyProxy.append(historyInput)).resolves.toEqual(ok("appended"));
    expect(enqueue).toHaveBeenCalledWith(taskTurn);
    expect(append).toHaveBeenCalledWith(historyInput);
    expect(bindings.status()).toEqual({
      accepting: true,
      taskExtractionBound: true,
      deliveredAssistantHistoryBound: true,
    });
  });

  it("rejects rebinding and closes admission without discarding bound adapters", async () => {
    const bindings = createSchedulerCorePortBindings();
    const ports = {
      taskExtractionPort: { enqueue: vi.fn(() => ok("enqueued" as const)) },
      deliveredAssistantHistoryPort: { append: vi.fn(async () => ok("appended" as const)) },
    };
    expect(bindings.bind(ports)).toEqual(ok(undefined));
    expect(bindings.bind(ports)).toEqual({
      ok: false,
      error: { code: "already_bound", errorKind: "precondition" },
    });

    bindings.close();

    expect(bindings.taskExtractionPort.enqueue(taskTurn)).toMatchObject({
      ok: false,
      error: { code: "not_accepting" },
    });
    await expect(bindings.deliveredAssistantHistoryPort.append(historyInput)).resolves.toMatchObject({
      ok: false,
      error: { code: "not_accepting" },
    });
    expect(bindings.status()).toEqual({
      accepting: false,
      taskExtractionBound: true,
      deliveredAssistantHistoryBound: true,
    });
  });
});
