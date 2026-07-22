// SPDX-License-Identifier: Apache-2.0
/**
 * Restart continuation: capture active sessions on shutdown, replay on startup.
 * When the daemon shuts down via SIGUSR2 (config-change restart), recently-active
 * sessions are written to a JSON file. On startup, synthetic inbound messages are
 * injected for each record so the LLM auto-resumes in-progress conversations.
 * @module
 */

import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { systemNowMs, tryGetContext, type NormalizedMessage } from "@comis/core";
import { resolveResponseLocalePolicy } from "@comis/agent";
import { writeRegularFile } from "@comis/observability";
import type { ComisLogger } from "@comis/infra";
import type { McpConnection } from "@comis/skills";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single session to resume after daemon restart. */
export interface ContinuationRecord {
  agentId: string;
  channelType: string;
  channelId: string;
  userId: string;
  peerId?: string;
  guildId?: string;
  threadId?: string;
  /**
   * Channel-native chat type tag captured at track-time so the synthetic
   * restart message can frame the resumed conversation correctly.
   *
   * For Telegram: `"private"`, `"group"`, `"supergroup"`, or `"channel"`
   * (sourced from `metadata.telegramChatType`). Without this, group sessions
   * are mis-framed as DMs on first turn after restart because the synthetic
   * inbound carries no chat-type metadata.
   */
  chatType?: string;
  /** Resolved response locale carried into the synthetic replay context. */
  resolvedLanguage?: string;
  tenantId: string;
  timestamp: number;
}

/** In-memory tracker for sessions with channel turns still in flight. */
export interface RestartContinuationTracker {
  /** Mark a channel turn active before inbound processing starts. */
  track(record: ContinuationRecord): void;
  /** Mark one active turn complete after inbound processing settles successfully. */
  complete(record: Pick<ContinuationRecord, "channelType" | "channelId" | "userId" | "peerId">): void;
  /** Check if a session still has at least one channel turn in flight. */
  isTracked(record: Pick<ContinuationRecord, "channelType" | "channelId" | "userId" | "peerId">): boolean;
  /**
   * Write recent records to disk. Returns the count written.
   *
   * @param filePath - Target file (typically `safePath(dataDir, "restart-continuations.json")`).
   * @param recentWindowMs - Sessions older than this are skipped.
   * @param confinedBaseDir - Confinement base for the fs-safe substrate.
   *   Required: the resolved real path of
   *   `filePath` must stay inside the operator's data root so writes
   *   cannot escape `~/.comis/` via an ancestor-symlink swap. Pass
   *   `dataDir` from the caller's closure.
   * @param logger - Optional logger for WARN on substrate Result.err
   *   (parent-symlink rejected, confinement-escape, etc.). Preserves
   *   the existing best-effort write contract — a failure does not
   *   block daemon shutdown.
   */
  capture(
    filePath: string,
    recentWindowMs: number,
    confinedBaseDir: string,
    logger?: ComisLogger,
  ): number;
}

/** Resolve the language that a future synthetic restart turn must retain. */
export function resolveContinuationLanguage(
  message: Pick<NormalizedMessage, "metadata" | "originalMessages" | "text">,
  explicitLocale?: string,
): string | undefined {
  if (message.metadata.isRestartContinuation === true) {
    return tryGetContext()?.resolvedLanguage;
  }
  return resolveResponseLocalePolicy({
    explicitLocale,
    requestLocale: typeof message.metadata.locale === "string"
      ? message.metadata.locale
      : undefined,
    requestText: message.originalMessages?.map((original) => original.text).join("\n")
      ?? message.text,
  }).locale;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an in-memory tracker that stores the newest in-flight turn per session.
 * On shutdown, `capture()` writes active records within the recent window to a JSON file.
 */
export function createRestartContinuationTracker(): RestartContinuationTracker {
  const records = new Map<string, { record: ContinuationRecord; activeCount: number }>();

  function makeKey(r: Pick<ContinuationRecord, "channelType" | "channelId" | "userId" | "peerId">): string {
    return `${r.channelType}:${r.channelId}:${r.userId}:${r.peerId ?? ""}`;
  }

  return {
    track(record) {
      const key = makeKey(record);
      const activeCount = (records.get(key)?.activeCount ?? 0) + 1;
      records.set(key, {
        record: { ...record, timestamp: systemNowMs() },
        activeCount,
      });
    },

    complete(record) {
      const key = makeKey(record);
      const active = records.get(key);
      if (!active) return;
      if (active.activeCount > 1) {
        records.set(key, { ...active, activeCount: active.activeCount - 1 });
        return;
      }
      records.delete(key);
    },

    isTracked(record) {
      return records.has(makeKey(record));
    },

    capture(filePath, recentWindowMs, confinedBaseDir, logger) {
      const now = systemNowMs();
      const recent = Array.from(records.values(), ({ record }) => record).filter(
        (r) => now - r.timestamp < recentWindowMs,
      );
      if (recent.length === 0) return 0;
      // Route through the fs-safe substrate so the
      // restart-continuation hand-off file lands at mode `0o600` per
      // §1.4. Failure is non-fatal: log + return 0 so daemon shutdown
      // continues (best-effort write contract preserved).
      const result = writeRegularFile({
        path: filePath,
        content: JSON.stringify(recent, null, 2),
        confinedBaseDir,
      });
      if (!result.ok) {
        logger?.warn(
          {
            err: result.error,
            filePath,
            hint: "Restart-continuation hand-off write failed; daemon restart will lose this session window",
            errorKind: "resource" as const,
          },
          "Restart continuation write rejected by fs-safe substrate",
        );
        return 0;
      }
      return recent.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Load + consume
// ---------------------------------------------------------------------------

/**
 * Load continuation records from disk, filter stale entries, delete the file.
 * @param filePath - Path to the continuation JSON file.
 * @param staleTtlMs - Maximum age in ms before a record is considered stale (default 5 min).
 * @param logger - Logger for warnings on parse errors.
 * @returns Non-stale continuation records (empty array if file missing or corrupt).
 */
export function loadContinuations(
  filePath: string,
  staleTtlMs: number,
  logger: ComisLogger,
): ContinuationRecord[] {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed: ContinuationRecord[] = JSON.parse(raw);
    unlinkSync(filePath);
    const now = systemNowMs();
    const valid = parsed.filter((r) => now - r.timestamp < staleTtlMs);
    const discarded = parsed.length - valid.length;
    if (discarded > 0) {
      logger.debug(
        { discarded, total: parsed.length },
        "Discarded stale continuation records",
      );
    }
    return valid;
  } catch (err) {
    logger.warn(
      {
        err,
        filePath,
        hint: "Continuation file may be corrupted; skipping replay",
        errorKind: "internal" as const,
      },
      "Failed to load continuation records",
    );
    try {
      unlinkSync(filePath);
    } catch {
      /* ignore cleanup failure */
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// MCP status line
// ---------------------------------------------------------------------------

const MCP_ERROR_TRUNCATE = 120;
const MCP_MAX_NAMES = 5;

/**
 * Build a one-line `[MCP Status]` summary for the synthetic restart message.
 *
 * Returns `undefined` when every connection is healthy so the happy path stays
 * quiet. The agent LLM reads this line and self-corrects instead of claiming
 * success for servers that never completed handshake after a config-change
 * restart.
 *
 * Only `status === "error"` connections are reported. Transient states
 * (`reconnecting`, `disconnected`) are already handled by the manager's
 * reconnect loop and would spam the agent on normal network hiccups.
 *
 * @param connections - All known MCP connections (typically from `McpClientManager.getAllConnections()`).
 * @returns A formatted status line, or `undefined` when no connections are errored.
 */
export function buildMcpStatusLine(connections: readonly McpConnection[]): string | undefined {
  const failed = connections.filter((c) => c.status === "error");
  if (failed.length === 0) return undefined;

  const shown = failed.slice(0, MCP_MAX_NAMES).map((c) => {
    const raw = (c.error ?? "").trim();
    const msg = raw.length === 0 ? "unknown error" : raw;
    const truncated = msg.length > MCP_ERROR_TRUNCATE ? `${msg.slice(0, MCP_ERROR_TRUNCATE)}…` : msg;
    return `${c.name} (${truncated})`;
  });
  const overflow = failed.length - shown.length;
  const suffix = overflow > 0 ? `, +${overflow} more` : "";
  return `[MCP Status] ${failed.length} server(s) failed to connect: ${shown.join(", ")}${suffix}`;
}
