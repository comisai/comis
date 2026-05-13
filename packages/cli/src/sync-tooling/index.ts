// SPDX-License-Identifier: Apache-2.0
/**
 * Sync-Tooling — operator UX for materializing/syncing the `tooling:`
 * config block from installed MCPs and skills.
 *
 * Public API consumed by `packages/cli/src/commands/config.ts` (the
 * `comis config sync-tooling` sub-subcommand registered there).
 *
 * @module
 */

export {
  readMcpServers,
  discoverSkills,
  type DiscoveredMcp,
  type DiscoveredSkill,
  type DiscoveredArtifacts,
  type DiscoverError,
} from "./discover.js";

export {
  buildSkeleton,
  computeMutationPlan,
  applyToDocument,
  type MutationPlan,
} from "./generate.js";

export {
  renderInspectHuman,
  renderInspectJson,
  renderUnifiedDiff,
  type InspectPayload,
} from "./diff.js";

export {
  atomicWriteFile,
  type AtomicWriteError,
} from "./atomic-write.js";

export {
  writeBackup,
  buildBackupFilename,
  pruneOldBackups,
  type BackupError,
} from "./backup.js";

export { isDaemonRunning } from "./daemon-guard.js";
