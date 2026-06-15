// SPDX-License-Identifier: Apache-2.0
// @allow-throw: NONE — this substrate is best-effort THROUGHOUT (unlike
// terminal-wake-persistence.ts's removeWakeStateFile, which re-raises a genuine
// non-ENOENT unlink fault). DUR-02's remove is called off the drive-cleanup path
// where a surfaced fs fault would abort an unrelated teardown; the in-memory
// holder (165-07) is the source of truth, so a removal that cannot complete
// degrades to "the file lingers and is overwritten/recovered next boot", never a
// throw. ENOENT is swallowed (already gone); a genuine fault is logged-by-absence.
/**
 * The DUR-02 DAEMON-side durable journal store — the single genuinely-new
 * capability of Phase 165.
 *
 * The Phase-164 rolling journal (`terminal-drive-journal.ts` in `@comis/skills`:
 * pure, bounded, content-free, total `serialize`/`deserialize`) was built
 * DUR-02-ready. This module adds the durable ATOMIC PERSISTENCE + recover-on-boot
 * + resume read, so a 40h drive that crosses a daemon restart RESUMES from its
 * journal (objective + last classification + answered prompts + steps tried)
 * rather than starting over or re-answering prompts (I10). It WRAPS the shipped
 * pure `serializeJournal`/`deserializeJournal` — NO journal-shape rewrite
 * (CONTEXT §7.1.6 LOCKED).
 *
 * **Daemon-side placement (a deliberate CO-LOCATION CHOICE, NOT a forced
 * constraint).** The store lives in the daemon layer as a sibling of
 * `terminal-wake-persistence.ts` because it is co-located with the `driveJournals`
 * holder (`setup-terminal-wake.ts`, 165-07) + the daemon-side recover-on-boot
 * wiring — exactly where `terminal-wake-persistence.ts` already lives. The
 * `skills → observability` edge it would otherwise traverse is ALLOWED (the
 * architecture graph permits `skills: {shared, core, observability}`, and the MCP
 * OAuth token-store in `@comis/skills` already value-imports
 * `{writeRegularFile, ensureContainedDir}` from `@comis/observability`), so this
 * is a placement decision, not a workaround for a forbidden edge.
 *
 * **The atomic-durable-write substrate (mirrored VERBATIM-in-shape from
 * `terminal-wake-persistence.ts`):** every write goes through the
 * `@comis/observability` fs-safe substrate — `ensureContainedDir` (dir mode
 * `0o700`) + `writeRegularFile` (file mode `0o600`, an unlink-then-`O_CREAT |
 * O_EXCL | O_NOFOLLOW` atomic create with a defensive `fchmod`) — with `dataDir`
 * threaded as the `confinedBaseDir` ancestor-symlink defense. A best-effort
 * `fsync` is layered over the completed write (the `writeDurable` house pattern,
 * `terminal-worker-entry.ts:739-765`), swallowing ONLY the `--permission`
 * disabled-fsync refusal (`isFsyncDisabledByPermissionModel`); the rest of the
 * call is wrapped best-effort so a genuine write/path fault degrades to "this
 * session is missed on recover", never a throw (the wake-persistence semantics —
 * the in-memory holder has already updated).
 *
 * **The confined durable dir (resolved Q2):**
 * `<dataDir>/terminal-drive/<agentId>/journals/<sessionId>.json` — the confined
 * background-task per-agent pattern (runtime state OUT of the agent's
 * user-visible `<agentWs>/terminal/` workspace).
 *
 * **Content-free + secret-redacted (I3).** The journal is content-free BY
 * CONSTRUCTION and the woken-turn driver runs `scrubSecretsFromText` UPSTREAM
 * before any tag/digest lands in it (`terminal-wake-turn.ts`); `clipTag`
 * byte-caps every field. This store does NOT re-redact — it persists the opaque,
 * already-redacted bytes verbatim and never re-structures them into a credential
 * field. The persisted file is mode-`0o600` in a `0o700` confined dir (V8).
 *
 * **I10 preserve-on-failure.** `persistDriveJournal` / `recoverDriveJournals`
 * NEVER delete a journal — a genuinely-gone session keeps its journal for a fresh
 * drive to pick up. {@link removeDriveJournal} is a DISTINCT explicit call.
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
  openSync as nodeOpenSync,
  fsyncSync as nodeFsyncSync,
  closeSync as nodeCloseSync,
} from "node:fs";
import { safePath } from "@comis/core";
import { isFsyncDisabledByPermissionModel } from "@comis/shared";
import {
  ensureContainedDir as obsEnsureContainedDir,
  writeRegularFile as obsWriteRegularFile,
  type EnsureContainedDirOptions,
  type WriteRegularFileOptions,
} from "@comis/observability";
import { serializeJournal, deserializeJournal, type DriveJournal } from "@comis/skills/tools";

/** The top-level confined dir name under the data dir for durable drive state. */
export const DRIVE_DIR_NAME = "terminal-drive";

/** The per-agent subdir holding the durable journal files. */
export const JOURNALS_SUBDIR = "journals";

/**
 * The injectable fs substrate for the durable journal store.
 *
 * `dataDir` is the only required field — the confinement root + the parent of the
 * `terminal-drive/<agentId>/journals/` tree. Every fs op defaults to the real
 * `@comis/observability` fs-safe helper / `node:fs` primitive; a test overrides
 * them to capture the mode args + run the fsync-thrower on macOS with no real
 * disk (the `WorkerFsPort`-shaped seam, `terminal-worker-entry.ts:117`).
 *
 * The store IGNORES the `ensureContainedDir`/`writeRegularFile` `Result` return
 * (best-effort — a failure is swallowed by the outer try), so the seam types them
 * as returning `unknown` and a spy may return `void`.
 */
export interface DriveJournalPersistenceDeps {
  /** The confinement root (the parent of `terminal-drive/`). The only required field. */
  dataDir: string;
  /** Create the confined dir at `0o700` (default: the `@comis/observability` helper). */
  ensureContainedDir?: (options: EnsureContainedDirOptions) => unknown;
  /** Write the file at `0o600`, symlink-safe (default: the `@comis/observability` helper). */
  writeRegularFile?: (options: WriteRegularFileOptions) => unknown;
  readFileSync?: (path: string, encoding: "utf-8") => string;
  readdirSync?: (path: string) => string[];
  statSync?: (path: string) => { isFile(): boolean };
  existsSync?: (path: string) => boolean;
  unlinkSync?: (path: string) => void;
  /** Best-effort fsync trio over the completed write (the `writeDurable` hardening). */
  openSync?: (path: string, flags: string) => number;
  fsyncSync?: (fd: number) => void;
  closeSync?: (fd: number) => void;
  /** Present for the `WorkerFsPort` parity / future atomic-rename use; unused by the direct write. */
  renameSync?: (from: string, to: string) => void;
}

/**
 * The confined per-agent journals dir:
 * `<dataDir>/terminal-drive/<agentId>/journals` (resolved Q2). Path-traversal
 * guarded by `safePath` (a degenerate `dataDir`/`agentId` throws
 * `PathTraversalError`, which the callers swallow best-effort).
 */
export function driveJournalDir(dataDir: string, agentId: string): string {
  return safePath(dataDir, DRIVE_DIR_NAME, agentId, JOURNALS_SUBDIR);
}

/**
 * Best-effort `fsync` over an already-completed write (durability hardening). A
 * genuine I/O error is intentionally NOT re-thrown here — this whole module is
 * best-effort (unlike the worker's `writeDurable`, which re-throws a genuine
 * fault); the only error we even attempt to distinguish is the `--permission`
 * disabled-fsync refusal, which is always benign. The fd is closed in every path.
 */
function bestEffortFsync(deps: DriveJournalPersistenceDeps, filePath: string): void {
  const openSync = deps.openSync ?? nodeOpenSync;
  const fsyncSync = deps.fsyncSync ?? nodeFsyncSync;
  const closeSync = deps.closeSync ?? nodeCloseSync;
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    fsyncSync(fd);
  } catch (err) {
    // Refused under --permission is the expected benign case; any other fault is
    // also swallowed (best-effort substrate — the write+rename already landed the
    // bytes; skipping fsync only widens the power-failure window). We probe the
    // predicate purely to document intent (and to keep the symbol load-bearing).
    if (!isFsyncDisabledByPermissionModel(err)) {
      // Best-effort: a genuine fsync fault degrades durability, never the caller.
    }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Closing a possibly-refused fd is best-effort.
      }
    }
  }
}

/**
 * Persist a single drive's journal to disk synchronously.
 *
 * Writes to `<dataDir>/terminal-drive/<agentId>/journals/<sessionId>.json`
 * through the fs-safe substrate (dir `0o700`, file `0o600`, `confinedBaseDir`
 * symlink defense), then best-effort `fsync`. The serialized bytes are exactly
 * the SHIPPED {@link serializeJournal} output — no shape rewrite.
 *
 * Best-effort: a failure (a `PathTraversalError` from a degenerate
 * `dataDir`/`agentId`, an unwritable target, a write fault) is SWALLOWED — it
 * must not propagate to the holder (165-07), which has already updated the
 * in-memory journal. The recovery scan simply misses this session. NEVER deletes
 * (I10 preserve-on-failure).
 */
export function persistDriveJournal(
  deps: DriveJournalPersistenceDeps,
  agentId: string,
  sessionId: string,
  journal: DriveJournal,
): void {
  const ensure = deps.ensureContainedDir ?? obsEnsureContainedDir;
  const write = deps.writeRegularFile ?? obsWriteRegularFile;
  try {
    const dir = driveJournalDir(deps.dataDir, agentId);
    ensure({ dir, mode: 0o700, confinedBaseDir: deps.dataDir });
    const filePath = safePath(dir, `${sessionId}.json`);
    write({
      path: filePath,
      content: serializeJournal(journal),
      confinedBaseDir: deps.dataDir,
    });
    // Best-effort durability hardening over the completed write+chmod.
    bestEffortFsync(deps, filePath);
  } catch {
    // Best-effort: swallow (mirrors terminal-wake-persistence). A failed persist
    // degrades to "this session is missed on recover", never a throw.
  }
}

/**
 * Recover all of an agent's drive journals from disk on daemon startup.
 *
 * Scans `<dataDir>/terminal-drive/<agentId>/journals/*.json`, mapping each file
 * through the total {@link deserializeJournal} (a corrupt/partial file yields a
 * SAFE default journal, never a throw); a file that fails to even READ is skipped.
 * Returns an empty Map when the dir does not exist or `dataDir`/`agentId` is
 * degenerate (the recover-on-boot path must NEVER crash the daemon constructor).
 *
 * NEVER deletes a journal (I10 preserve-on-failure) — a genuinely-gone session
 * keeps its journal for a fresh drive.
 */
export function recoverDriveJournals(
  deps: DriveJournalPersistenceDeps,
  agentId: string,
): Map<string, DriveJournal> {
  const recovered = new Map<string, DriveJournal>();
  const readFile = deps.readFileSync ?? nodeReadFileSync;
  const readdir = deps.readdirSync ?? nodeReaddirSync;
  const stat = deps.statSync ?? nodeStatSync;
  const exists = deps.existsSync ?? nodeExistsSync;

  // Best-effort: a degenerate dataDir/agentId (e.g. a relative "." from a
  // bootstrap/test config) makes safePath throw PathTraversalError — recovery
  // must NOT crash the daemon boot (165-07 recovers on construction). Swallow +
  // return an empty Map (mirrors persistDriveJournal / recoverWakeStates).
  let dir: string;
  try {
    dir = driveJournalDir(deps.dataDir, agentId);
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
    const sessionId = file.slice(0, -".json".length);
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
    // deserializeJournal is TOTAL — a corrupt/partial payload yields a safe
    // default journal, never a throw (the DUR-02 recovery contract).
    recovered.set(sessionId, deserializeJournal(raw));
  }

  return recovered;
}

/**
 * The resume read (I10): load ONE drive's persisted journal.
 *
 * Returns `undefined` when the file is MISSING (no journal to resume); for a
 * corrupt/partial file returns {@link deserializeJournal}'s SAFE default (the
 * total recovery contract — a corrupt-after-crash file resumes from a safe empty
 * journal rather than crashing). NEVER throws (a degenerate path → `undefined`).
 */
export function loadDriveJournal(
  deps: DriveJournalPersistenceDeps,
  agentId: string,
  sessionId: string,
): DriveJournal | undefined {
  const readFile = deps.readFileSync ?? nodeReadFileSync;
  let filePath: string;
  try {
    filePath = safePath(driveJournalDir(deps.dataDir, agentId), `${sessionId}.json`);
  } catch {
    return undefined;
  }
  let raw: string;
  try {
    raw = readFile(filePath, "utf-8");
  } catch {
    // Missing (ENOENT) or unreadable → no journal to resume.
    return undefined;
  }
  return deserializeJournal(raw);
}

/**
 * Remove a drive's journal file from disk — the DISTINCT explicit call (I10:
 * persist/recover NEVER delete; only this does). Best-effort: ENOENT is swallowed
 * (already gone) and, per the module's all-best-effort contract, a genuine fault
 * is swallowed too (the in-memory holder is the source of truth; a lingering file
 * is overwritten/recovered next boot). NEVER throws — it is called off the
 * drive-cleanup path where a surfaced fault would abort an unrelated teardown.
 */
export function removeDriveJournal(
  deps: DriveJournalPersistenceDeps,
  agentId: string,
  sessionId: string,
): void {
  const unlink = deps.unlinkSync ?? nodeUnlinkSync;
  let filePath: string;
  try {
    filePath = safePath(driveJournalDir(deps.dataDir, agentId), `${sessionId}.json`);
  } catch {
    return;
  }
  try {
    unlink(filePath);
  } catch {
    // Best-effort: ENOENT (already gone) and any other fault are swallowed — the
    // in-memory holder is authoritative; a lingering file is harmless (overwritten
    // / recovered next boot). NEVER throws (called off the cleanup path).
  }
}
