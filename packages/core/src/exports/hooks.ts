// SPDX-License-Identifier: Apache-2.0
// @comis/core exports — Hooks (plugin system, lifecycle hooks, approval gate, tool metadata)

export {
  createPluginRegistry,
  createHookRunner,
  BeforeAgentStartResultSchema,
  BeforeCompactionResultSchema,
  BeforeDeliveryResultSchema,
  mergeBeforeAgentStart,
  mergeBeforeCompaction,
  mergeBeforeDelivery,
} from "../hooks/index.js";
export type {
  PluginRegistry,
  PluginRegistryOptions,
  HookRunner,
  HookRunnerOptions,
} from "../hooks/index.js";

// Approval gate (pending request lifecycle with timeout auto-deny)
export { createApprovalGate } from "../approval/index.js";
export type { ApprovalGate, ApprovalGateDeps } from "../approval/index.js";

// Tool metadata registry
export {
  registerToolMetadata,
  getToolMetadata,
  getAllToolMetadata,
  truncateContentBlocks,
} from "../tool-metadata.js";
export type {
  ComisToolMetadata,
  ToolCapabilityMetadata,
  ToolFailureFallback,
  TrackedInvocationSideEffect,
} from "../tool-metadata.js";
