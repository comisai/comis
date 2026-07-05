// SPDX-License-Identifier: Apache-2.0
/**
 * Boot-time skill-import crash reconciliation.
 *
 * A hard crash between the staged→live move and the staging cleanup leaves a
 * `<dataDir>/tmp/skill-import-<id>/` dir behind. `sweepOrphanedImports` runs once
 * at boot (alongside the bundled-skill seed, before agents come up) and
 * reconciles every such dir via its `commit.json` intent marker:
 *
 *   - NO marker            ⇒ pre-commit debris (the crash was before the move);
 *                            discard the staging dir, touch nothing live.
 *   - fresh, pin ABSENT    ⇒ the move happened but the provenance write did not;
 *                            remove the moved-in live dir (roll back), then discard.
 *   - fresh, pin PRESENT   ⇒ the commit completed; leave the live dir intact, discard.
 *   - update, re-pin NOT done (the on-disk pin's contentHash != the marker's)
 *                          ⇒ the swap did not finish; restore the parked previous
 *                            install over the live dir, then discard.
 *   - update, re-pin DONE  ⇒ the swap completed (a logically-committed update);
 *                            leave the live dir intact + discard — NEVER restore
 *                            parked (that would revert a committed update and
 *                            manufacture a false divergence on the next re-import).
 *
 * Invariants preserved: no installed-but-unprovenanced skill survives; the
 * previous install is never lost; a committed update is never reverted. The sweep
 * is idempotent — running it twice is a no-op after the first pass removes every
 * staging dir. PURE over injected fs seams so the state machine is unit-provable
 * without a real daemon; {@link defaultSweepDeps} wires the production `node:fs`.
 *
 * @module
 */

import {
  existsSync as nodeExistsSync,
  readdirSync as nodeReaddirSync,
  readFileSync as nodeReadFileSync,
  renameSync as nodeRenameSync,
  rmSync as nodeRmSync,
} from "node:fs";
import { safePath } from "@comis/core";
import { provenanceKey, readProvenanceStore as skillsReadProvenanceStore, type ProvenanceStore } from "@comis/skills";
import { parseCommitIntent, COMMIT_MARKER_FILENAME, type CommitIntent } from "./import-commit.js";

/** The staging-root name prefix owned by the import pipeline. */
const STAGING_PREFIX = "skill-import-";

/** Injected seams for {@link sweepOrphanedImports} (defaulted by {@link defaultSweepDeps}). */
export interface SweepDeps {
  /** Comis data dir. */
  readonly dataDir: string;
  /** Absolute paths of the `<dataDir>/tmp/skill-import-*` staging roots. */
  listImportRoots: () => string[];
  /** Read + parse the `commit.json` marker in a staging root, or undefined. */
  readCommitIntent: (importRoot: string) => CommitIntent | undefined;
  /** Existence check for a path. */
  pathExists: (p: string) => boolean;
  /** Remove a directory tree (recursive, best-effort). */
  removeDir: (p: string) => void;
  /** Move `src` → `dest`. */
  moveDir: (src: string, dest: string) => void;
  /** Read the provenance store (the record-presence + re-pin guard). */
  readProvenanceStore: (dataDir: string) => ProvenanceStore;
  /** Optional boot logger (counts only — content-free). */
  readonly logger?: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn?: (obj: Record<string, unknown>, msg: string) => void;
  };
}

/** The reconciliation outcome (for logging / tests). */
export interface SweepResult {
  /** Roots where a live-side rollback / restore action was taken. */
  readonly reconciled: string[];
  /** Roots removed with NO live-side action (debris or a completed commit). */
  readonly discarded: string[];
}

/**
 * Reconcile every orphaned staging dir. See the module doc for the branch table.
 * Never throws — a single malformed root is skipped so it can never block boot.
 */
export function sweepOrphanedImports(deps: SweepDeps): SweepResult {
  const reconciled: string[] = [];
  const discarded: string[] = [];

  for (const importRoot of deps.listImportRoots()) {
    const intent = deps.readCommitIntent(importRoot);

    // No (or corrupt) marker ⇒ the crash was before the move; pure debris.
    if (intent === undefined) {
      deps.removeDir(importRoot);
      discarded.push(importRoot);
      continue;
    }

    const store = deps.readProvenanceStore(deps.dataDir);
    const key = provenanceKey(intent.record.scope, intent.record.agentId, intent.record.name);
    const onDisk = store[key];
    let parkedDir: string | undefined;
    try {
      parkedDir = safePath(importRoot, "parked");
    } catch {
      parkedDir = undefined;
    }

    let action = false;
    if (intent.mode === "fresh") {
      // Roll back ONLY if the provenance write did not complete. A present record
      // means the commit finished — leave the live dir intact.
      if (onDisk === undefined) {
        deps.removeDir(intent.targetPath);
        action = true;
      }
    } else {
      // update: the re-pin completed iff the on-disk pin matches the marker's
      // intended contentHash. If so, the update is committed — leave it. Otherwise
      // restore the parked previous install (or, if none was parked because the
      // live dir was already gone at commit time, remove the moved-in dir).
      const rePinned = onDisk !== undefined && onDisk.contentHash === intent.contentHash;
      if (!rePinned) {
        deps.removeDir(intent.targetPath);
        if (parkedDir !== undefined && deps.pathExists(parkedDir)) {
          deps.moveDir(parkedDir, intent.targetPath);
        }
        action = true;
      }
    }

    deps.removeDir(importRoot);
    (action ? reconciled : discarded).push(importRoot);
  }

  if (reconciled.length > 0 || discarded.length > 0) {
    deps.logger?.info(
      { reconciledCount: reconciled.length, discardedCount: discarded.length },
      "Skill-import boot sweep reconciled orphaned staging directories",
    );
  }
  return { reconciled, discarded };
}

/** Wire the production deps: real `node:fs`, `safePath`-confined, fail-safe reads. */
export function defaultSweepDeps(
  dataDir: string,
  logger?: SweepDeps["logger"],
): SweepDeps {
  return {
    dataDir,
    ...(logger !== undefined && { logger }),
    listImportRoots: () => {
      let tmpRoot: string;
      try {
        tmpRoot = safePath(dataDir, "tmp");
      } catch {
        return [];
      }
      try {
        return nodeReaddirSync(tmpRoot, { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name.startsWith(STAGING_PREFIX))
          .map((e) => {
            try {
              return safePath(tmpRoot, e.name);
            } catch {
              return undefined;
            }
          })
          .filter((p): p is string => p !== undefined);
      } catch {
        return []; // no tmp dir on this install ⇒ nothing to reconcile
      }
    },
    readCommitIntent: (importRoot) => {
      let markerPath: string;
      try {
        markerPath = safePath(importRoot, COMMIT_MARKER_FILENAME);
      } catch {
        return undefined;
      }
      if (!nodeExistsSync(markerPath)) return undefined;
      try {
        return parseCommitIntent(nodeReadFileSync(markerPath, "utf-8"));
      } catch {
        return undefined;
      }
    },
    pathExists: (p) => nodeExistsSync(p),
    removeDir: (p) => {
      try {
        nodeRmSync(p, { recursive: true, force: true });
      } catch {
        /* best effort — a leftover dir is reclaimed on the next boot sweep */
      }
    },
    moveDir: (src, dest) => {
      nodeRenameSync(src, dest);
    },
    readProvenanceStore: (dir) => skillsReadProvenanceStore(dir),
  };
}
