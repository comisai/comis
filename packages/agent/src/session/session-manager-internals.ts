// SPDX-License-Identifier: Apache-2.0
/**
 * Guarded boundary for the SDK SessionManager's private persisted-entry
 * internals (`fileEntries`, `_rewriteFile`).
 *
 * The session scrubbers (poisoned-thinking-block, redacted-tool-call,
 * forged-context-marker) must repair or neutralize entries in the PERSISTED
 * entry list before the SDK rebuilds LLM replay context. The SDK's public
 * surface (`appendMessage`, `branch`, `buildSessionContext`) is append-only:
 * it cannot express in-place repair of an already-persisted entry, so the
 * scrubbers depend on two private internals.
 *
 * This module is the ONLY place allowed to touch those internals. Every
 * access goes through a runtime shape-guard that degrades to undefined/false
 * on mismatch (preserving the scrubbers' best-effort contract), and the
 * real-SDK canary in session-manager-internals.test.ts pins the internals'
 * existence and end-to-end persistence behavior — an SDK-internal rename
 * fails that test loudly at bump time instead of silently disabling the
 * scrubbers. After a rename, re-point this boundary; do not patch the
 * scrubbers individually.
 *
 * @module
 */

import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { err, ok, tryCatch, type Result } from "@comis/shared";

// ---------------------------------------------------------------------------
// Structural entry views
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of a persisted session entry. Scrubbers narrow on
 * `type === "message"` and then inspect/mutate the `message` payload.
 */
export interface SessionFileEntry {
  type?: string;
  /**
   * Message payload of a `type === "message"` entry. Kept structurally loose
   * (no index signature) so scrubbers can both read persisted JSONL shapes
   * and assign SDK `Message` values back in place.
   */
  message?: {
    role?: string;
    content?: unknown;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Guarded accessors
// ---------------------------------------------------------------------------

/**
 * Return the SessionManager's live persisted-entry list, or undefined when
 * the internal is absent or not an array (best-effort: callers no-op).
 *
 * The returned array is the SDK's OWN list, not a copy — in-place mutations
 * are visible to the SDK's replay (`buildSessionContext`) and rewrite paths,
 * which is exactly what the scrubbers rely on.
 */
export function getSessionFileEntries(
  sessionManager: SessionManager,
): SessionFileEntry[] | undefined {
  const entries = (sessionManager as unknown as { fileEntries?: unknown })?.fileEntries;
  return Array.isArray(entries) ? (entries as SessionFileEntry[]) : undefined;
}

/**
 * Flush the SessionManager's persisted-entry list back to its JSONL file.
 * Returns true when the internal rewrite ran (for a non-persisted/in-memory
 * session the SDK makes it a no-op — still true), false when the internal is
 * absent or not callable (best-effort: callers treat it as "not flushed").
 */
export function rewriteSessionFile(sessionManager: SessionManager): boolean {
  const rewrite = (sessionManager as unknown as { _rewriteFile?: unknown })._rewriteFile;
  if (typeof rewrite !== "function") return false;
  (rewrite as () => void).call(sessionManager);
  return true;
}

/**
 * Replace the complete persisted tree with one already-ordered active branch.
 * This is the guarded private-internals boundary for bounded session retention:
 * it preserves the SDK header, rebuilds the SDK indexes/leaf, and rewrites the
 * file before returning. Callers must already hold the session write lock.
 */
export function replaceSessionActiveBranch(
  sessionManager: SessionManager,
  branch: readonly SessionEntry[],
): Result<void, Error> {
  const internals = sessionManager as unknown as {
    fileEntries?: unknown;
    _buildIndex?: unknown;
    _rewriteFile?: unknown;
  };
  const fileEntries = internals.fileEntries;
  if (
    !Array.isArray(fileEntries)
    || typeof internals._buildIndex !== "function"
    || typeof internals._rewriteFile !== "function"
  ) {
    return err(new Error("SDK session replacement internals are unavailable"));
  }
  const header = fileEntries.find((entry) =>
    entry !== null
    && typeof entry === "object"
    && (entry as { type?: unknown }).type === "session");
  if (header === undefined) return err(new Error("SDK session header is unavailable"));

  const replaced = tryCatch(() => {
    fileEntries.splice(0, fileEntries.length, header, ...branch);
    (internals._buildIndex as () => void).call(sessionManager);
    (internals._rewriteFile as () => void).call(sessionManager);
  });
  return replaced.ok ? ok(undefined) : replaced;
}
