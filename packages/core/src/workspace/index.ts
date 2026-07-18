// SPDX-License-Identifier: Apache-2.0
/**
 * Workspace helpers.
 *
 * Provides the canonical `ensureWorkspace` + `resolveWorkspaceDir` adapters
 * for CLI + daemon consumers. Internal helpers (WORKSPACE_FILE_NAMES,
 * DEFAULT_TEMPLATES, workspace-state, status/registration helpers) live
 * here alongside because their consumers (daemon api/workspace-handlers,
 * agent bootstrap-loader) need them too.
 *
 * @module
 */

export {
  ensureWorkspace,
  getWorkspaceStatus,
  registerWorkspaceFilesInTracker,
  WORKSPACE_SUBDIRS,
} from "./workspace-manager.js";
export type {
  WorkspaceFiles,
  EnsureWorkspaceOptions,
  WorkspaceStatus,
  WorkspaceSeedTracker,
  RegisterWorkspaceResult,
} from "./workspace-manager.js";

export { resolveWorkspaceDir } from "./workspace-resolver.js";

export {
  WORKSPACE_FILE_NAMES,
  DEFAULT_TEMPLATES,
  OPERATOR_OWNED_FILES,
  AGENT_STATE_FILES,
  TEMPLATE_MARKER,
  isUntouchedWorkspaceTemplate,
} from "./templates.js";
export type { WorkspaceFileName } from "./templates.js";

export {
  readWorkspaceState,
  writeWorkspaceState,
  incrementOnboardingCount,
  isIdentityFilled,
  STATE_FILENAME,
  WorkspaceStateSchema,
} from "./workspace-state.js";
export type { WorkspaceState } from "./workspace-state.js";
