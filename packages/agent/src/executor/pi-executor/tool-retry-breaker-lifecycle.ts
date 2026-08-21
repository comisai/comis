// SPDX-License-Identifier: Apache-2.0
import type { PerAgentConfig } from "@comis/core";
import {
  createToolRetryBreaker,
  type ToolRetryBreaker,
} from "../../safety/tool-retry-breaker.js";

export interface ToolRetryBreakerLifecycle {
  readonly backgroundBreaker: ToolRetryBreaker | undefined;
  createExecutionBreaker(): ToolRetryBreaker | undefined;
}

function createConfiguredBreaker(
  config: PerAgentConfig["toolRetryBreaker"],
): ToolRetryBreaker {
  return createToolRetryBreaker({
    maxConsecutiveFailures: config?.maxConsecutiveFailures ?? 3,
    maxToolFailures: config?.maxToolFailures ?? 5,
    suggestAlternatives: config?.suggestAlternatives ?? true,
    maxConsecutiveErrorPatterns: config?.maxConsecutiveErrorPatterns ?? 2,
  });
}

function createExecutionView(
  foregroundBreaker: ToolRetryBreaker,
  backgroundBreaker: ToolRetryBreaker,
): ToolRetryBreaker {
  return {
    beforeToolCall(toolName, args) {
      const backgroundVerdict = backgroundBreaker.beforeToolCall(toolName, args);
      return backgroundVerdict.block
        ? backgroundVerdict
        : foregroundBreaker.beforeToolCall(toolName, args);
    },
    recordResult(toolName, args, success, errorText, context) {
      return foregroundBreaker.recordResult(
        toolName,
        args,
        success,
        errorText,
        context,
      );
    },
    getBlockedTools() {
      return [...new Set([
        ...backgroundBreaker.getBlockedTools(),
        ...foregroundBreaker.getBlockedTools(),
      ])];
    },
    reset() {
      foregroundBreaker.reset();
      backgroundBreaker.reset();
    },
  };
}

/**
 * Keep ordinary retry failures inside one execution while retaining durable
 * background-task health across executions. The execution view records only
 * foreground results, but its guard also consults the background breaker.
 */
export function createToolRetryBreakerLifecycle(
  config: PerAgentConfig["toolRetryBreaker"],
): ToolRetryBreakerLifecycle {
  if (config?.enabled === false) {
    return {
      backgroundBreaker: undefined,
      createExecutionBreaker: () => undefined,
    };
  }

  const backgroundBreaker = createConfiguredBreaker(config);
  return {
    backgroundBreaker,
    createExecutionBreaker() {
      return createExecutionView(
        createConfiguredBreaker(config),
        backgroundBreaker,
      );
    },
  };
}
