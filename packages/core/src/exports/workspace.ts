// SPDX-License-Identifier: Apache-2.0
// Workspace helper re-exports for the @comis/core barrel.
export {
  ensureWorkspace,
  getWorkspaceStatus,
  registerWorkspaceFilesInTracker,
  resolveWorkspaceDir,
  WORKSPACE_SUBDIRS,
  WORKSPACE_FILE_NAMES,
  DEFAULT_TEMPLATES,
  TEMPLATE_MARKER,
  readWorkspaceState,
  writeWorkspaceState,
  incrementOnboardingCount,
  isIdentityFilled,
  STATE_FILENAME,
  WorkspaceStateSchema,
} from "../workspace/index.js";
export type {
  WorkspaceFiles,
  EnsureWorkspaceOptions,
  WorkspaceStatus,
  WorkspaceSeedTracker,
  RegisterWorkspaceResult,
  WorkspaceFileName,
  WorkspaceState,
} from "../workspace/index.js";
