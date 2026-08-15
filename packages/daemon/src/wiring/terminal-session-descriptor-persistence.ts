// SPDX-License-Identifier: Apache-2.0
/**
 * The DAEMON-side durable SESSION-DESCRIPTOR store — the daemon impl of the
 * {@link SessionDescriptorStorePort} the registry's recover-on-boot consumes, and the
 * SIBLING of the drive-journal store ({@link ./terminal-drive-journal-persistence.js}).
 *
 * WHY THIS EXISTS (the durable-reattach gap, framed in terminal-reattach-match.ts). The
 * tmux re-attach MECHANISM already ships (deterministic `comis-<id>` name + `has-session`-
 * gated create-vs-reattach + a linux survival test). The genuine gap is one layer UP:
 * the registry's `sessionId` is an ephemeral `randomUUID()` it never persists, and there
 * is no recover-on-boot — so on a daemon restart its `sessions` Map starts EMPTY and a
 * healthy multi-day drive whose `comis-<old-id>` is STILL alive under tmux is wrongly
 * flipped `lost`. This store persists the {@link SessionDescriptor} IDENTITY (the
 * allowId/owner/scope/tmuxName) at create-time so the registry's recover-on-boot
 * (`applyRecoveredSessions`) can run each through the pure `reattachDecision` and
 * re-attach the survivors instead of flipping them `lost`.
 *
 * **Daemon-side placement (a deliberate CO-LOCATION CHOICE, NOT a forced constraint).**
 * It lives in the daemon layer as a sibling of `terminal-wake-persistence.ts` +
 * `terminal-drive-journal-persistence.ts` because it is co-located with the daemon-side
 * recover-on-boot wiring (which injects it onto the registry deps). The
 * `skills → observability` edge it would otherwise traverse is ALLOWED (the architecture
 * graph permits `skills: {shared, core, observability}`), so this is a placement
 * decision, not a workaround for a forbidden edge — it mirrors exactly where the journal
 * store lives.
 *
 * **The atomic-durable-write substrate:** every write creates a unique owner-only temporary
 * file through `writeRegularFile`, flushes it, atomically renames it over the descriptor,
 * then flushes the descriptor directory. The prior descriptor therefore remains visible
 * until the replacement commits. `dataDir` is threaded as the `confinedBaseDir`
 * ancestor-symlink defense.
 *
 * **The confined durable dir (the journal store's sibling):**
 * `<dataDir>/terminal-drive/<agentId>/descriptors/<sessionId>.json` — the confined
 * background-task per-agent pattern (runtime state OUT of the agent's user-visible
 * `<agentWs>/terminal/` workspace), the journal store's `journals/` sibling.
 *
 * **Content-free identity.** The descriptor is content-free BY CONSTRUCTION (ids/enums/
 * counts only — `serializeDescriptor`); this store persists those opaque bytes verbatim
 * and never re-structures them into a credential field. The persisted file is mode-`0o600`
 * in a `0o700` confined dir. The recovered descriptor carries the SAME allowId/owner/scope
 * it was persisted with — durability changes WHERE, never WHAT.
 *
 * **The port is INSTANCE-bound to one `(dataDir, agentId)`** because
 * `SessionDescriptorStorePort.persist(descriptor)`/`recover()`/`remove(sessionId)` are
 * the agent-scoped surface the registry deps inject; the daemon constructs one per agent.
 * `persist` reads the agent from the descriptor's `owner.agentId` for an audit cross-check
 * but the store's confinement root is the bound `agentId` (the registry only ever persists
 * its own sessions).
 *
 * **TOTAL recover (the recovery contract).** A corrupt-after-crash descriptor is a
 * corrupt-SKIP via `deserializeDescriptor` (it REJECTS a missing/wrong-typed identity
 * field to `undefined`, never a partially-trusted authorization object — unlike the
 * journal's safe-default); a file that fails to even READ is skipped. `recover` NEVER
 * crashes the daemon constructor (a degenerate `dataDir`/`agentId` → an empty list).
 *
 * **Preserve-on-failure.** `persist`/`recover` never delete a descriptor — {@link
 * SessionDescriptorStorePort.remove} is the distinct explicit call and reports whether
 * deletion plus directory flush committed.
 *
 * No raw timers / clock here — pure confined I/O (the `globals` architecture gate).
 *
 * @module
 */
import { randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  closeSync as nodeCloseSync,
  fsyncSync as nodeFsyncSync,
  openSync as nodeOpenSync,
  readFileSync as nodeReadFileSync,
  readdirSync as nodeReaddirSync,
  renameSync as nodeRenameSync,
  statSync as nodeStatSync,
  existsSync as nodeExistsSync,
  unlinkSync as nodeUnlinkSync,
} from "node:fs";
import { safePath } from "@comis/core";
import {
  ensureContainedDir as obsEnsureContainedDir,
  writeRegularFile as obsWriteRegularFile,
  type EnsureContainedDirOptions,
  type WriteRegularFileOptions,
} from "@comis/observability";
import { err, isFsyncDisabledByPermissionModel, ok, tryCatch, type Result } from "@comis/shared";
import {
  serializeDescriptor,
  deserializeDescriptor,
  type SessionDescriptor,
  type SessionDescriptorStorePort,
} from "@comis/skills/tools";

import { DRIVE_DIR_NAME } from "./terminal-drive-journal-persistence.js";

/** The per-agent subdir holding the durable descriptor files (the `journals/` sibling). */
export const DESCRIPTORS_SUBDIR = "descriptors";

/**
 * The injectable fs substrate + the instance binding for the descriptor store.
 *
 * `dataDir` (the confinement root + the parent of the
 * `terminal-drive/<agentId>/descriptors/` tree) and `agentId` are the two required
 * fields. Every fs op defaults to the real `@comis/observability` fs-safe helper /
 * `node:fs` primitive; a test overrides them to capture the mode args without a real disk
 * (the journal store's `DriveJournalPersistenceDeps`-shaped seam).
 *
 * Persistence reports the confined write result so managed launch can fail closed.
 */
export interface SessionDescriptorPersistenceDeps {
  /** The confinement root (the parent of `terminal-drive/`). Required. */
  dataDir: string;
  /** The agent this store is bound to (its confinement subtree + recover scope). Required. */
  agentId: string;
  /** Create the confined dir at `0o700` (default: the `@comis/observability` helper). */
  ensureContainedDir?: (options: EnsureContainedDirOptions) => ReturnType<typeof obsEnsureContainedDir>;
  /** Write the file at `0o600`, symlink-safe (default: the `@comis/observability` helper). */
  writeRegularFile?: (options: WriteRegularFileOptions) => ReturnType<typeof obsWriteRegularFile>;
  readFileSync?: (path: string, encoding: "utf-8") => string;
  readdirSync?: (path: string) => string[];
  statSync?: (path: string) => { isFile(): boolean };
  existsSync?: (path: string) => boolean;
  unlinkSync?: (path: string) => void;
  renameSync?: (from: string, to: string) => void;
  openSync?: (path: string, flags: number) => number;
  fsyncSync?: (fd: number) => void;
  closeSync?: (fd: number) => void;
}

/**
 * The confined per-agent descriptors dir:
 * `<dataDir>/terminal-drive/<agentId>/descriptors` (the journal store's `journals/`
 * sibling). Path-traversal guarded by `safePath` (a degenerate `dataDir`/`agentId`
 * returns a failed persistence or removal result while recovery remains best-effort).
 */
export function descriptorDir(dataDir: string, agentId: string): string {
  return safePath(dataDir, DRIVE_DIR_NAME, agentId, DESCRIPTORS_SUBDIR);
}

/**
 * Construct the daemon-side durable descriptor store bound to one `(dataDir, agentId)` —
 * the {@link SessionDescriptorStorePort} the registry deps inject. Recovery skips corrupt
 * or unreadable files; removal is ENOENT-tolerant and reports genuine faults.
 */
export function createSessionDescriptorStore(deps: SessionDescriptorPersistenceDeps): SessionDescriptorStorePort {
  const ensure = deps.ensureContainedDir ?? obsEnsureContainedDir;
  const write = deps.writeRegularFile ?? obsWriteRegularFile;
  const readFile = deps.readFileSync ?? nodeReadFileSync;
  const readdir = deps.readdirSync ?? nodeReaddirSync;
  const stat = deps.statSync ?? nodeStatSync;
  const exists = deps.existsSync ?? nodeExistsSync;
  const unlink = deps.unlinkSync ?? nodeUnlinkSync;
  const rename = deps.renameSync ?? nodeRenameSync;
  const open = deps.openSync ?? nodeOpenSync;
  const fsync = deps.fsyncSync ?? nodeFsyncSync;
  const close = deps.closeSync ?? nodeCloseSync;

  function removePath(path: string): Result<void, Error> {
    const removed = tryCatch(() => unlink(path));
    if (removed.ok) return ok(undefined);
    return (removed.error as NodeJS.ErrnoException).code === "ENOENT"
      ? ok(undefined)
      : err(removed.error);
  }

  function syncDirectory(dir: string): Result<void, Error> {
    const noFollow = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
    const directory = (fsConstants as Record<string, number | undefined>).O_DIRECTORY ?? 0;
    const opened = tryCatch(() => open(dir, fsConstants.O_RDONLY | noFollow | directory));
    if (!opened.ok) return err(opened.error);
    const synced = tryCatch(() => fsync(opened.value));
    const closed = tryCatch(() => close(opened.value));
    if (!synced.ok && !isFsyncDisabledByPermissionModel(synced.error)) return err(synced.error);
    return closed.ok ? ok(undefined) : err(closed.error);
  }

  return {
    persist(descriptor: SessionDescriptor): Result<void, Error> {
      if (descriptor.owner.agentId !== deps.agentId) {
        return err(new Error("terminal descriptor owner does not match its durable store"));
      }
      const paths = tryCatch(() => {
        const dir = descriptorDir(deps.dataDir, deps.agentId);
        return {
          dir,
          filePath: safePath(dir, `${descriptor.sessionId}.json`),
          temporaryPath: safePath(dir, `.${descriptor.sessionId}.${randomUUID()}.tmp`),
        };
      });
      if (!paths.ok) return err(paths.error);
      const ensured = tryCatch(() => ensure({
        dir: paths.value.dir,
        mode: 0o700,
        confinedBaseDir: deps.dataDir,
      }));
      if (!ensured.ok) return err(ensured.error);
      if (!ensured.value.ok) return err(ensured.value.error);
      const written = tryCatch(() => write({
        path: paths.value.temporaryPath,
        content: serializeDescriptor(descriptor),
        confinedBaseDir: deps.dataDir,
        fsyncBeforeSuccess: true,
      }));
      if (!written.ok) {
        removePath(paths.value.temporaryPath);
        return err(written.error);
      }
      if (!written.value.ok) {
        removePath(paths.value.temporaryPath);
        return err(written.value.error);
      }
      const renamed = tryCatch(() => rename(paths.value.temporaryPath, paths.value.filePath));
      if (!renamed.ok) {
        removePath(paths.value.temporaryPath);
        return err(renamed.error);
      }
      return syncDirectory(paths.value.dir);
    },

    recover(): SessionDescriptor[] {
      const recovered: SessionDescriptor[] = [];
      // Best-effort: a degenerate dataDir/agentId (e.g. a relative "." from a bootstrap/
      // test config) makes safePath throw — recovery must NOT crash the daemon boot.
      let dir: string;
      try {
        dir = descriptorDir(deps.dataDir, deps.agentId);
      } catch {
        return recovered;
      }
      if (!exists(dir)) return recovered;

      let files: string[];
      try {
        files = readdir(dir);
      } catch {
        return recovered;
      }

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        let filePath: string;
        try {
          filePath = safePath(dir, file);
        } catch {
          continue;
        }
        // Skip non-regular entries (a subdir named *.json would otherwise throw).
        try {
          if (!stat(filePath).isFile()) continue;
        } catch {
          continue;
        }
        let raw: string;
        try {
          raw = readFile(filePath, "utf-8");
        } catch {
          // Skip a file we cannot even read.
          continue;
        }
        // deserializeDescriptor REJECTS a malformed/partial identity to undefined (a
        // corrupt-after-crash file is a corrupt-SKIP, never a partial-trust authorization).
        const descriptor = deserializeDescriptor(raw);
        if (descriptor !== undefined) recovered.push(descriptor);
      }

      return recovered;
    },

    remove(sessionId: string): Result<void, Error> {
      const path = tryCatch(() => safePath(
        descriptorDir(deps.dataDir, deps.agentId),
        `${sessionId}.json`,
      ));
      if (!path.ok) return err(path.error);
      const removed = tryCatch(() => unlink(path.value));
      if (!removed.ok) {
        return (removed.error as NodeJS.ErrnoException).code === "ENOENT"
          ? ok(undefined)
          : err(removed.error);
      }
      return syncDirectory(descriptorDir(deps.dataDir, deps.agentId));
    },
  };
}
