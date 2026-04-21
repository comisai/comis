// SPDX-License-Identifier: Apache-2.0
// @comis/core/hooks — Plugin registry and lifecycle hook runner

export { createPluginRegistry } from "./plugin-registry.js";
export type { PluginRegistry, PluginRegistryOptions } from "./plugin-registry.js";
export { createHookRunner } from "./hook-runner.js";
export type { HookRunner, HookRunnerOptions } from "./hook-runner.js";
export {
  BeforeAgentStartResultSchema,
  BeforeToolCallResultSchema,
  ToolResultPersistResultSchema,
  BeforeCompactionResultSchema,
  BeforeDeliveryResultSchema,
  mergeBeforeAgentStart,
  mergeBeforeToolCall,
  mergeToolResultPersist,
  mergeBeforeCompaction,
  mergeBeforeDelivery,
} from "./hook-strategies.js";
export { setGlobalHookRunner, getGlobalHookRunner, clearGlobalHookRunner } from "./hook-runner-global.js";
