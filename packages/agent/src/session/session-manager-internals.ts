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

import type { SessionManager } from "@earendil-works/pi-coding-agent";

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
