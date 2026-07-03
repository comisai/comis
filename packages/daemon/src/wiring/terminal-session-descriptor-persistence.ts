// SPDX-License-Identifier: Apache-2.0
// @allow-throw: NONE — this substrate is best-effort THROUGHOUT (like its sibling
// terminal-drive-journal-persistence.ts, and unlike terminal-wake-persistence.ts's
// removeWakeStateFile which re-raises a genuine non-ENOENT unlink fault). The
// descriptor store's persist runs at create-time off the registry's hot path and its
// remove off the drive-cleanup path, where a surfaced fs fault would abort an unrelated
// teardown; the registry's in-memory `sessions` handle is the source of truth at
// runtime, so a write that cannot complete degrades to "this session is missed on the
// next recover" (it is flipped `lost` on boot, never re-attached), never a throw.
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
 * **The atomic-durable-write substrate (mirrored VERBATIM-in-shape from the journal
 * store):** every write goes through the `@comis/observability` fs-safe substrate —
 * `ensureContainedDir` (dir mode `0o700`) + `writeRegularFile` (file mode `0o600`, an
 * unlink-then-`O_CREAT | O_EXCL | O_NOFOLLOW` atomic create with a defensive `fchmod`) —
 * with `dataDir` threaded as the `confinedBaseDir` ancestor-symlink defense.
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
 * **Preserve-on-failure.** `persist`/`recover` NEVER delete a descriptor — {@link
 * SessionDescriptorStorePort.remove} is the DISTINCT explicit call (the registry calls it
 * on a genuinely-gone / cleanly-evicted session).
 *
 * No raw timers / clock here — pure confined I/O (the `globals` architecture gate).
 *
 * @module
 */
import {
  readFileSync as nodeReadFileSync,
  readdirSync as nodeReaddirSync,
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
 * The store IGNORES the `ensureContainedDir`/`writeRegularFile` `Result` return
 * (best-effort — a failure is swallowed by the outer try), so the seam types them as
 * returning `unknown` and a spy may return `void`.
 */
export interface SessionDescriptorPersistenceDeps {
  /** The confinement root (the parent of `terminal-drive/`). Required. */
  dataDir: string;
  /** The agent this store is bound to (its confinement subtree + recover scope). Required. */
  agentId: string;
  /** Create the confined dir at `0o700` (default: the `@comis/observability` helper). */
  ensureContainedDir?: (options: EnsureContainedDirOptions) => unknown;
  /** Write the file at `0o600`, symlink-safe (default: the `@comis/observability` helper). */
  writeRegularFile?: (options: WriteRegularFileOptions) => unknown;
  readFileSync?: (path: string, encoding: "utf-8") => string;
  readdirSync?: (path: string) => string[];
  statSync?: (path: string) => { isFile(): boolean };
  existsSync?: (path: string) => boolean;
  unlinkSync?: (path: string) => void;
}

/**
 * The confined per-agent descriptors dir:
 * `<dataDir>/terminal-drive/<agentId>/descriptors` (the journal store's `journals/`
 * sibling). Path-traversal guarded by `safePath` (a degenerate `dataDir`/`agentId`
 * throws `PathTraversalError`, which the callers swallow best-effort).
 */
export function descriptorDir(dataDir: string, agentId: string): string {
  return safePath(dataDir, DRIVE_DIR_NAME, agentId, DESCRIPTORS_SUBDIR);
}

/**
 * Construct the daemon-side durable descriptor store bound to one `(dataDir, agentId)` —
 * the {@link SessionDescriptorStorePort} the registry deps inject. All
 * three methods are best-effort + total (never throw): `persist` swallows a write fault
 * (the registry handle is the runtime source of truth), `recover` skips a corrupt /
 * unreadable file (never crashes boot), `remove` is ENOENT-tolerant.
 */
export function createSessionDescriptorStore(deps: SessionDescriptorPersistenceDeps): SessionDescriptorStorePort {
  const ensure = deps.ensureContainedDir ?? obsEnsureContainedDir;
  const write = deps.writeRegularFile ?? obsWriteRegularFile;
  const readFile = deps.readFileSync ?? nodeReadFileSync;
  const readdir = deps.readdirSync ?? nodeReaddirSync;
  const stat = deps.statSync ?? nodeStatSync;
  const exists = deps.existsSync ?? nodeExistsSync;
  const unlink = deps.unlinkSync ?? nodeUnlinkSync;

  return {
    persist(descriptor: SessionDescriptor): void {
      // Best-effort: a failure (a PathTraversalError from a degenerate dataDir/agentId,
      // an unwritable target, a write fault) is SWALLOWED — it must not propagate off the
      // registry's create path (the in-memory handle already exists). NEVER deletes.
      try {
        const dir = descriptorDir(deps.dataDir, deps.agentId);
        ensure({ dir, mode: 0o700, confinedBaseDir: deps.dataDir });
        const filePath = safePath(dir, `${descriptor.sessionId}.json`);
        write({
          path: filePath,
          content: serializeDescriptor(descriptor),
          confinedBaseDir: deps.dataDir,
        });
      } catch {
        // Best-effort: a failed persist degrades to "this session is missed on the next
        // recover" (flipped lost on boot), never a throw (mirrors the journal store).
      }
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

    remove(sessionId: string): void {
      // The DISTINCT explicit delete (persist/recover NEVER delete; only this does).
      // ENOENT-tolerant; per the module's all-best-effort contract a genuine fault is
      // swallowed too (the lingering file is overwritten/skipped on the next boot).
      let filePath: string;
      try {
        filePath = safePath(descriptorDir(deps.dataDir, deps.agentId), `${sessionId}.json`);
      } catch {
        return;
      }
      try {
        unlink(filePath);
      } catch {
        // Best-effort: ENOENT (already gone) and any other fault are swallowed — NEVER
        // throws (called off the cleanup path where a surfaced fault aborts teardown).
      }
    },
  };
}
