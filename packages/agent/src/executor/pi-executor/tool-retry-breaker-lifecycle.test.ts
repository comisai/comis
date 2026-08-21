// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createToolRetryBreakerLifecycle } from "./tool-retry-breaker-lifecycle.js";

const config = {
  enabled: true,
  maxConsecutiveFailures: 3,
  maxToolFailures: 5,
  suggestAlternatives: true,
  maxConsecutiveErrorPatterns: 2,
};

describe("tool retry breaker lifecycle", () => {
  it("keeps foreground failures inside their execution", () => {
    const lifecycle = createToolRetryBreakerLifecycle(config);
    const first = lifecycle.createExecutionBreaker();
    const args = { taskId: "task_a" };

    first?.recordResult("reconcile_task", args, false, "[precondition] denied", {
      transportOk: true,
    });
    first?.recordResult("reconcile_task", args, false, "[precondition] denied", {
      transportOk: true,
    });

    expect(first?.beforeToolCall("reconcile_task", args).block).toBe(true);
    expect(
      lifecycle.createExecutionBreaker()?.beforeToolCall("reconcile_task", args).block,
    ).toBe(false);
  });

  it("carries durable background failures into later executions", () => {
    const lifecycle = createToolRetryBreakerLifecycle(config);
    const args = {};

    lifecycle.backgroundBreaker?.recordResult(
      "long_report",
      args,
      false,
      "[dependency] unavailable",
    );
    lifecycle.backgroundBreaker?.recordResult(
      "long_report",
      args,
      false,
      "[dependency] unavailable",
    );

    expect(
      lifecycle.createExecutionBreaker()?.beforeToolCall("long_report", args).block,
    ).toBe(true);
  });

  it("disables both breaker scopes from one configuration switch", () => {
    const lifecycle = createToolRetryBreakerLifecycle({ ...config, enabled: false });

    expect(lifecycle.backgroundBreaker).toBeUndefined();
    expect(lifecycle.createExecutionBreaker()).toBeUndefined();
  });

  it("clears both scopes through the full reset contract", () => {
    const lifecycle = createToolRetryBreakerLifecycle(config);
    const execution = lifecycle.createExecutionBreaker();

    lifecycle.backgroundBreaker?.recordResult(
      "long_report",
      {},
      false,
      "[dependency] unavailable",
    );
    lifecycle.backgroundBreaker?.recordResult(
      "long_report",
      {},
      false,
      "[dependency] unavailable",
    );
    execution?.reset();

    expect(
      lifecycle.createExecutionBreaker()?.beforeToolCall("long_report", {}).block,
    ).toBe(false);
  });
});
