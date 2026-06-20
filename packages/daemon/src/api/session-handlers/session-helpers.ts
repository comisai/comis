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
import { safePath, systemGetEnv, systemDateFrom } from "@comis/core";

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
 * Scan JSONL session directories for each configured agent and return
 * session info records for sessions that exist only as JSONL files.
 * Performance-guarded: skips agents with >1000 session files.
 */
/**
 * True for a LIVE session transcript file; false for the co-located
 * observability artifacts (`<file>.jsonl.trajectory.jsonl`). Both scanners
 * must share this predicate: counting trajectory EVENTS as session messages
 * re-surfaced a deleted session in session.list as
 * `default:<name>.jsonl.trajectory` (live C7 finding, 2026-06-12).
 */
function isLiveTranscriptFile(file: string): boolean {
  return file.endsWith(".jsonl") && !file.endsWith(".trajectory.jsonl");
}

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
          // Canonical session key is `tenant:user:channel` (formatSessionKey) — the
          // SAME form the LCD/`reset`/`explain` paths use. The directory layout is
          // sessions/{tenant}/{channelDir}/{file}, so the file is the user/peer and
          // channelDir is the channel. Dropping channelDir (the old
          // `${tenant}:${file}`) produced a 2-part key that `sessions reset`
          // rejected (0 rows) and that never dedups against the SQLite session_key
          // (UX-1, live 2026-06-20).
          const sessionKey = `${tenantId}:${file.slice(0, -6)}:${channelDir}`;
          const content = readFileSync(filePath, "utf-8");
          const lines = content.split("\n").filter(l => l.trim().length > 0);

          // channelDir is the chat/channel ID (e.g., "678314278")
          results.push({
            sessionKey,
            userId: "unknown",
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
