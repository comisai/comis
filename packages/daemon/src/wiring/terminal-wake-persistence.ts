// SPDX-License-Identifier: Apache-2.0
// @allow-throw: removeWakeStateFile (line ~169) re-raises a genuine non-ENOENT fs fault (EPERM/EISDIR) from unlinkSync — silently swallowing a real fs error here would hide a security-relevant fault. Mirrors the grandfathered background-task-persistence.ts removeTaskFile re-raise. ENOENT is swallowed (file already gone); everything else surfaces to the daemon caller.
/**
 * Durable per-session wake-state for the recurring wake-dispatch FSM
 * (terminal-wake-dispatch.ts).
 *
 * This is the "survives daemon restart" substrate: the FSM persists its
 * per-session dispatch state on every transition and re-hydrates it on
 * construction (recover-on-boot), so a session mid-wake before a daemon
 * restart is not spuriously re-woken.
 *
 * Modeled VERBATIM on `packages/agent/src/background/background-task-
 * persistence.ts`: every write goes through the `@comis/observability`
 * fs-safe substrate — `ensureContainedDir` (dir mode `0o700`) +
 * `writeRegularFile` (file mode `0o600`) — with `dataDir` threaded as the
 * `confinedBaseDir` ancestor-symlink defense. State lands under a dedicated
 * `terminal-wake/{sessionId}.json` subdir (the analogue of
 * `background-tasks/{agentId}/{taskId}.json`).
 *
 * **Daemon-side placement (binding constraint):** the persistence imports
 * `@comis/observability`, which `@comis/skills` MUST NOT value-import. The FSM
 * + this substrate therefore live in the daemon layer (the composition root's
 * to use observability), not in the skills worker.
 *
 * **Best-effort contract:** a persist failure is swallowed (it must not
 * propagate to the caller, which has already acted on the in-memory state);
 * the recovery scan simply misses that session — matching the
 * background-task-persistence semantics. Corrupt / shape-invalid files are
 * skipped on recover.
 *
 * No raw timers / clock here — this is pure confined I/O.
 *
 * @module
 */
import { readFileSync, readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { safePath } from "@comis/core";
import { ensureContainedDir, writeRegularFile } from "@comis/observability";

/** Directory name under the data dir for per-session wake-state files. */
export const WAKE_DIR_NAME = "terminal-wake";

/** The owning origin of a terminal session — `(agentId, sessionKey)`. */
export interface PersistedWakeOwner {
  agentId: string;
  sessionKey: string;
}

/**
 * The serializable per-session wake-dispatch state.
 *
 * `dispatchState` is the recurring 3-state machine:
 *   - `idle`    — no pending wake (the steady state between answered frames)
 *   - `pending` — an over-bound wake is parked awaiting a concurrency slot
 *   - `woken`   — a turn is in flight for `pendingFrame`
 *
 * `pendingFrame` is the `requestId` of the unanswered frame the dedupe gate
 * keys on (the `(sessionId, requestId)` correlation); absent when idle.
 */
export interface PersistedWakeState {
  sessionId: string;
  owner: PersistedWakeOwner;
  dispatchState: "idle" | "pending" | "woken";
  hopCount: number;
  pendingFrame?: string;
}

/** The confined `terminal-wake` dir under the data dir. */
function wakeDir(dataDir: string): string {
  return safePath(dataDir, WAKE_DIR_NAME);
}

/**
 * Persist a single session's wake-state to disk synchronously.
 *
 * Writes to `dataDir/terminal-wake/{sessionId}.json` through the fs-safe
 * substrate (dir `0o700`, file `0o600`, `confinedBaseDir` symlink defense).
 *
 * Result errors are intentionally swallowed — best-effort persistence: a
 * failure to persist must not propagate to the FSM (which has already
 * transitioned its in-memory state). The recovery scan will simply miss
 * this session.
 */
export function persistWakeStateSync(dataDir: string, state: PersistedWakeState): void {
  try {
    const dir = wakeDir(dataDir);
    ensureContainedDir({ dir, mode: 0o700, confinedBaseDir: dataDir });
    const filePath = safePath(dir, `${state.sessionId}.json`);
    writeRegularFile({
      path: filePath,
      content: JSON.stringify(state, null, 2),
      confinedBaseDir: dataDir,
    });
  } catch {
    // Best-effort: swallow (mirrors background-task-persistence). A failed
    // persist degrades to "this session is missed on recover", never a throw.
  }
}

/**
 * Shape-guard: a recovered object is a usable wake-state only if it carries
 * the producer-required fields. A file failing this guard is either
 * truncated mid-write or a legacy artifact — skip it.
 */
function isWakeState(parsed: Partial<PersistedWakeState>): parsed is PersistedWakeState {
  return (
    typeof parsed.sessionId === "string" &&
    typeof parsed.owner === "object" &&
    parsed.owner !== null &&
    typeof parsed.owner.agentId === "string" &&
    typeof parsed.owner.sessionKey === "string" &&
    (parsed.dispatchState === "idle" ||
      parsed.dispatchState === "pending" ||
      parsed.dispatchState === "woken") &&
    typeof parsed.hopCount === "number"
  );
}

/**
 * Recover all per-session wake-states from disk on daemon startup.
 *
 * Scans `dataDir/terminal-wake/*.json`, skipping corrupt / unparseable /
 * shape-invalid files. Returns an empty array when the dir does not exist.
 */
export function recoverWakeStates(dataDir: string): PersistedWakeState[] {
  const recovered: PersistedWakeState[] = [];
  // Best-effort: a degenerate dataDir (e.g. a relative "." from a bootstrap/test config)
  // makes safePath throw PathTraversalError — recovery must NOT crash the FSM constructor
  // (the FSM recovers on construction). Swallow + return [] (mirrors persistWakeStateSync).
  let dir: string;
  try {
    dir = wakeDir(dataDir);
  } catch {
    return recovered;
  }
  if (!existsSync(dir)) return recovered;

  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return recovered;
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = safePath(dir, file);
    // Skip non-regular entries (a subdir named *.json would otherwise throw).
    try {
      if (!statSync(filePath).isFile()) continue;
    } catch {
      continue;
    }
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PersistedWakeState>;
      if (!isWakeState(parsed)) continue;
      recovered.push(parsed);
    } catch {
      // Skip unparseable files.
    }
  }

  return recovered;
}

/**
 * Remove a session's wake-state file from disk. Silently ignores ENOENT.
 *
 * Called when a session terminates / is evicted so its durable wake-state
 * does not survive past the session's own lifetime.
 */
export function removeWakeStateFile(dataDir: string, sessionId: string): void {
  // Best-effort path resolution: a degenerate dataDir (relative ".") throws
  // PathTraversalError in safePath — a removal that cannot resolve is a no-op (there is
  // nothing on disk to remove), never a crash. Mirrors recoverWakeStates/persistWakeStateSync.
  let filePath: string;
  try {
    filePath = safePath(wakeDir(dataDir), `${sessionId}.json`);
  } catch {
    return;
  }
  try {
    unlinkSync(filePath);
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code !== "ENOENT") {
      throw e;
    }
  }
}
