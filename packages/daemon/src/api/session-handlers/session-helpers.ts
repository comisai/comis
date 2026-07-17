// SPDX-License-Identifier: Apache-2.0
/**
 * Shared session-handler helpers.
 *
 * Pure JSONL scanning helpers + dependency-type re-export shared across the
 * session handler bundles. No closures, no factory: every export is a pure
 * function, type alias, or compile-time flag so the dependency graph stays
 * one-directional (list / read / mutate / archive → session-helpers).
 *
 *   - SessionHandlerDeps (re-export of SessionsApiDeps from api/types.ts)
 *   - JsonlSessionInfo (JSONL session shape returned by scanners)
 *   - scanJsonlSessions (per-agent JSONL discovery)
 *   - scanWorkspaceSessions (workspace tenant/channel JSONL discovery)
 *   - loadJsonlSession (load + unwrap pi-agent JSONL message wrappers)
 *   - collectAvailableSessionKeys (error-message hint helper)
 *   - IS_DEV (dev-mode response.parse gate)
 *
 * @module
 */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { safePath, systemGetEnv, systemDateFrom, formatSessionKey } from "@comis/core";
import { INBOUND_MESSAGE_LEDGER_SUFFIX, pathToSessionKey } from "@comis/agent";

// Re-aliased from the cluster slice in api/types.ts.
// Single source of truth: SessionsApiDeps. The session-handlers factory
// consumes SessionHandlerDeps as before; the alias keeps call sites and
// handler bodies unchanged.
import type { SessionsApiDeps as SessionHandlerDeps } from "../types.js";
export type { SessionHandlerDeps };

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse.
 */
export const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

/** Shape of a JSONL session entry merged into session.list results. */
export interface JsonlSessionInfo {
  sessionKey: string;
  userId: string;
  channelId: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/**
 * True for a LIVE session transcript file; false for the co-located
 * non-transcript sidecars: observability trajectories
 * (`<file>.jsonl.trajectory.jsonl`) and inbound provenance ledgers
 * (`<file>~ledger~inbound.jsonl`). Session-key components encode literal `~`
 * characters, so the reserved ledger suffix cannot collide with a transcript.
 * Both scanners must share this predicate so sidecar records are never counted
 * or returned as SDK sessions.
 */
function isLiveTranscriptFile(file: string): boolean {
  return file.endsWith(".jsonl")
    && !file.endsWith(".trajectory.jsonl")
    && !file.endsWith(INBOUND_MESSAGE_LEDGER_SUFFIX);
}

/**
 * Scan JSONL session directories for each configured agent and return
 * session info records for sessions that exist only as JSONL files.
 * Performance-guarded: skips agents with >1000 session files.
 */
export function scanJsonlSessions(
  agentDataDir: string,
  agents: Record<string, unknown>,
): JsonlSessionInfo[] {
  const results: JsonlSessionInfo[] = [];

  for (const agentId of Object.keys(agents)) {
    const sessionsDir = safePath(agentDataDir, agentId, "sessions");
    let files: string[];
    try {
      files = readdirSync(sessionsDir).filter(isLiveTranscriptFile);
    } catch {
      continue; // Directory doesn't exist for this agent
    }

    // Performance guard: skip agents with too many session files
    if (files.length > 1000) {
      continue;
    }

    for (const file of files) {
      const filePath = safePath(sessionsDir, file);
      try {
        const stat = statSync(filePath);
        // Derive session key from filename (remove .jsonl extension)
        const sessionKey = file.slice(0, -6); // remove ".jsonl"

        // Count lines (messages) without parsing full content
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n").filter(l => l.trim().length > 0);
        const messageCount = lines.length;

        // Parse first line to extract metadata if available
        let userId = "unknown";
        const channelId = "unknown";
        if (lines.length > 0) {
          try {
            const firstMsg = JSON.parse(lines[0]) as Record<string, unknown>;
            if (firstMsg.role === "user") {
              userId = (firstMsg.userId as string) ?? "unknown";
            }
          } catch { /* skip parse errors */ }
        }

        results.push({
          sessionKey,
          userId,
          channelId,
          metadata: {},
          createdAt: Math.floor(stat.birthtimeMs),
          updatedAt: Math.floor(stat.mtimeMs),
          messageCount,
        });
      } catch {
        continue; // Skip unreadable files
      }
    }
  }

  return results;
}

/**
 * Scan workspace sessions directory for JSONL session files.
 * Structure: {workspaceDir}/sessions/{tenantId}/{channelDir}/{sessionFile}.jsonl
 * These sessions are created by the pi-agent session manager and may not be
 * indexed in SQLite yet. Returns session info records for merging into session.list.
 */
export function scanWorkspaceSessions(workspaceDir: string): JsonlSessionInfo[] {
  const results: JsonlSessionInfo[] = [];
  const sessionsRoot = safePath(workspaceDir, "sessions");

  let tenantDirs: string[];
  try {
    tenantDirs = readdirSync(sessionsRoot);
  } catch {
    return results;
  }

  for (const tenantId of tenantDirs) {
    const tenantPath = safePath(sessionsRoot, tenantId);
    let channelDirs: string[];
    try {
      const st = statSync(tenantPath);
      if (!st.isDirectory()) continue;
      channelDirs = readdirSync(tenantPath);
    } catch {
      continue;
    }

    // Performance guard
    if (channelDirs.length > 1000) continue;

    for (const channelDir of channelDirs) {
      const channelPath = safePath(tenantPath, channelDir);
      let files: string[];
      try {
        const st = statSync(channelPath);
        if (!st.isDirectory()) continue;
        files = readdirSync(channelPath).filter(isLiveTranscriptFile);
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = safePath(channelPath, file);
        try {
          const st = statSync(filePath);
          // Canonical session key (formatSessionKey: `tenant:user:channel[:peer:peerId]…`)
          // — the SAME form LCD/`reset`/`explain`/`mirror` key on. DERIVE it by parsing
          // the sessions/{tenant}/{channelDir}/{filename}.jsonl path: pathToSessionKey
          // decodes the `~peer~`/`~guild~`/`~thread~` filename tokens into the tagged
          // SessionKey, then formatSessionKey emits the canonical string. The prior
          // `${tenant}:${file}:${channelDir}` spliced the RAW filename whole, so a DM
          // file `111~peer~111.jsonl` produced the hybrid `tenant:111~peer~111:channel`
          // that parseFormattedSessionKey + `explain`/`mirror` reject — "no trajectory
          // found" on a session whose stored key is `tenant:111:channel:peer:111`
          // (an earlier fix added channelDir but missed the peer encoding).
          // Fall back to the legacy splice only when the path is unparseable.
          const parsedKey = pathToSessionKey(filePath, sessionsRoot);
          const sessionKey = parsedKey
            ? formatSessionKey(parsedKey)
            : `${tenantId}:${file.slice(0, -6)}:${channelDir}`;
          const content = readFileSync(filePath, "utf-8");
          const lines = content.split("\n").filter(l => l.trim().length > 0);

          // channelDir is the chat/channel ID (e.g., "678314278")
          results.push({
            sessionKey,
            userId: parsedKey?.userId ?? "unknown",
            channelId: channelDir,
            metadata: { _workspaceJsonlPath: filePath },
            createdAt: Math.floor(st.birthtimeMs),
            updatedAt: Math.floor(st.mtimeMs),
            messageCount: lines.length,
          });
        } catch {
          continue;
        }
      }
    }
  }

  return results;
}

/**
 * Load a JSONL session file and return it as SessionData-compatible shape.
 * Used as fallback when session.history can't find a session in SQLite.
 * pi-agent JSONL uses `{type: "message", message: {role, content}, timestamp}` wrappers.
 * We unwrap to `{role, content, timestamp}` which session.history expects.
 */
export function loadJsonlSession(
  filePath: string,
): { messages: unknown[]; metadata: Record<string, unknown>; createdAt: number; updatedAt: number } | undefined {
  try {
    const st = statSync(filePath);
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(l => l.trim().length > 0);
    const parsed = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    // Unwrap pi-agent message wrappers: {type:"message", message:{role,content}} → {role,content,timestamp}
    const messages: unknown[] = [];
    for (const entry of parsed) {
      const e = entry as Record<string, unknown>;
      if (e.type === "message" && e.message) {
        const msg = e.message as Record<string, unknown>;
        // Attach timestamp from the wrapper if present
        if (e.timestamp && !msg.timestamp) {
          msg.timestamp = typeof e.timestamp === "string" ? systemDateFrom(e.timestamp as string).getTime() : e.timestamp;
        }
        messages.push(msg);
      }
    }

    return {
      messages,
      metadata: {},
      createdAt: Math.floor(st.birthtimeMs),
      updatedAt: Math.floor(st.mtimeMs),
    };
  } catch {
    return undefined;
  }
}

/**
 * Load a session's transcript from EITHER
 * store, keyed by the canonical formatted key. Live channel conversations are
 * persisted ONLY as file JSONL by the pi session manager
 * (`workspace/sessions/<tenant>/<channel>/<userId>~peer~<peerId>.jsonl`), never
 * into the SQLite `sessions` table — so the lifecycle handlers (compact / delete
 * / reset / export / reset_conversation) that read ONLY
 * `sessionStore.loadByFormattedKey` threw "Session not found" for the ACTIVE
 * session even with the correct key (the SQLite table is empty for live chat).
 * This mirrors the proven `session.history` / `search` / `list` fallback: try
 * SQLite first, then the workspace JSONL matched on the canonical formatted key.
 */
export function loadSessionAnyStore(
  deps: SessionHandlerDeps,
  sessionKey: string,
): { messages: unknown[]; metadata: Record<string, unknown>; createdAt: number; updatedAt: number } | undefined {
  const fromStore = deps.sessionStore.loadByFormattedKey(sessionKey);
  if (fromStore) return fromStore;
  if (deps.defaultWorkspaceDir) {
    const match = scanWorkspaceSessions(deps.defaultWorkspaceDir).find((ws) => ws.sessionKey === sessionKey);
    const jsonlPath = match?.metadata._workspaceJsonlPath;
    if (typeof jsonlPath === "string") return loadJsonlSession(jsonlPath);
  }
  return undefined;
}

/**
 * Collect available session keys from all sources (SQLite, JSONL, workspace)
 * for inclusion in "session not found" error messages.
 */
export function collectAvailableSessionKeys(deps: SessionHandlerDeps): string[] {
  const keys: string[] = [];

  for (const s of deps.sessionStore.listDetailed()) {
    keys.push(s.sessionKey);
  }

  if (deps.defaultWorkspaceDir) {
    const existing = new Set(keys);
    for (const ws of scanWorkspaceSessions(deps.defaultWorkspaceDir)) {
      if (!existing.has(ws.sessionKey)) {
        keys.push(ws.sessionKey);
      }
    }
  }

  return keys;
}
