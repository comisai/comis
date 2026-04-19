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
} from "./workspace-manager.js";
export { resolveWorkspaceDir } from "./workspace-resolver.js";
export { WORKSPACE_FILE_NAMES, DEFAULT_TEMPLATES } from "./templates.js";
export type { WorkspaceFileName } from "./templates.js";
export { isHeartbeatContentEffectivelyEmpty } from "./heartbeat-file.js";
export { isBootContentEffectivelyEmpty, BOOT_FILE_NAME } from "./boot-file.js";
export { detectOnboardingState } from "./onboarding-detector.js";
export {
  readWorkspaceState,
  writeWorkspaceState,
  isIdentityFilled,
  STATE_FILENAME,
  WorkspaceStateSchema,
} from "./workspace-state.js";
export type { WorkspaceState } from "./workspace-state.js";
