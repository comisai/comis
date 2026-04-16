/**
 * Skill file watcher with setTimeout-based batch debounce.
 *
 * Watches configured discovery directories for SKILL.md file changes
 * and coalesces rapid changes into a single callback invocation.
 * Follows the ConfigWatcherHandle pattern from core/config/watcher.ts.
 *
 * When discovery paths don't exist yet (e.g. workspace/skills not yet
 * created by an agent), watches their parent directories for creation
 * and bootstraps the real watcher + triggers re-discovery once they appear.
 *
 * @module
 */

import { watch, type FSWatcher } from "chokidar";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Minimal pino-compatible logger interface for skills subsystem logging. */
export interface SkillsLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Handle returned from createSkillWatcher for lifecycle management. */
export interface SkillWatcherHandle {
  /** Stop watching and clean up resources. */
  close: () => Promise<void>;
}

/** Options for the skill file watcher. */
export interface SkillWatcherOptions {
  /** Directories to watch for skill file changes. */
  discoveryPaths: string[];
  /** Batch debounce interval in milliseconds. */
  debounceMs: number;
  /** Callback fired after debounce window closes. */
  onReload: () => void;
  /** Optional logger for diagnostic output. */
  logger?: SkillsLogger;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check which discovery paths currently exist on disk. */
function partitionPaths(discoveryPaths: string[]): { existing: string[]; missing: string[] } {
  const existing: string[] = [];
  const missing: string[] = [];
  for (const p of discoveryPaths) {
    try {
      fs.accessSync(p);
      existing.push(p);
    } catch {
      missing.push(p);
    }
  }
  return { existing, missing };
}

/**
 * Start a chokidar watcher on existing discovery paths.
 * Returns the FSWatcher instance. The caller manages the debounce timer.
 */
function startSkillWatcher(
  existingPaths: string[],
  onChange: (filePath: string) => void,
): FSWatcher {
  const watchedRoots = existingPaths.map((p) => fs.realpathSync(p));

  const watcher: FSWatcher = watch(existingPaths, {
    persistent: true,
    ignoreInitial: true,
    depth: undefined,
    ignored: (filePath: string) => {
      const basename = path.basename(filePath);
      if (!basename.startsWith(".")) return false;
      for (const root of watchedRoots) {
        if (filePath === root || root.startsWith(filePath + path.sep)) return false;
      }
      return true;
    },
  });

  watcher.on("add", onChange);
  watcher.on("change", onChange);
  watcher.on("unlink", onChange);

  return watcher;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a skill file watcher with batch debounce.
 *
 * Watches discovery directories for add/change/unlink events and coalesces
 * rapid changes within debounceMs into a single onReload() invocation.
 *
 * When some discovery paths don't exist yet, watches their parent directories
 * for directory creation and bootstraps the real watcher + triggers
 * re-discovery once they appear.
 *
 * @param options - Watcher configuration
 * @returns Handle with close() for lifecycle management
 */
export function createSkillWatcher(options: SkillWatcherOptions): SkillWatcherHandle {
  const { discoveryPaths, debounceMs, onReload, logger } = options;

  const { existing, missing } = partitionPaths(discoveryPaths);

  // Shared debounce timer across skill and parent watchers
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let skillWatcher: FSWatcher | null = null;
  let parentWatcher: FSWatcher | null = null;

  const scheduleReload = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      logger?.info({}, "Skill file change detected, triggering re-discovery");
      onReload();
    }, debounceMs);
  };

  // Start watching existing paths immediately
  if (existing.length > 0) {
    skillWatcher = startSkillWatcher(existing, scheduleReload);
  }

  // For missing paths, watch parent directories for creation
  if (missing.length > 0) {
    const parentDirs = new Set<string>();
    for (const p of missing) {
      let dir = path.dirname(p);
      while (dir !== path.dirname(dir)) {
        try {
          fs.accessSync(dir);
          parentDirs.add(dir);
          break;
        } catch {
          dir = path.dirname(dir);
        }
      }
    }

    if (parentDirs.size > 0) {
      logger?.debug(
        { missingPaths: missing, watchedParents: [...parentDirs] },
        "Watching parent directories for discovery path creation",
      );

      parentWatcher = watch([...parentDirs], {
        persistent: true,
        ignoreInitial: true,
        depth: 3,
        ignorePermissionErrors: true,
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      parentWatcher.on("addDir", (_createdPath: string) => {
        // Check if any missing discovery path now exists
        const nowExists = missing.some((p) => {
          try {
            fs.accessSync(p);
            return true;
          } catch {
            return false;
          }
        });
        if (!nowExists) return;

        logger?.info({}, "Discovery path created, starting skill watcher");

        // Close the parent watcher -- its job is done
        parentWatcher?.close().catch(() => { void 0; /* watcher close is best-effort */ });
        parentWatcher = null;

        // Restart skill watcher with all now-existing paths
        if (skillWatcher) {
          skillWatcher.close().catch(() => { void 0; /* watcher close is best-effort */ });
        }
        const { existing: allExisting } = partitionPaths(discoveryPaths);
        if (allExisting.length > 0) {
          skillWatcher = startSkillWatcher(allExisting, scheduleReload);
        }

        // Trigger re-discovery for newly available paths
        scheduleReload();
      });
    }
  }

  if (existing.length === 0 && parentWatcher === null) {
    logger?.debug({}, "No discovery paths exist, skill watcher not started");
    return { close: async () => {} };
  }

  return {
    close: async () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      await Promise.all([
        skillWatcher?.close(),
        parentWatcher?.close(),
      ]);
    },
  };
}
