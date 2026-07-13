// SPDX-License-Identifier: Apache-2.0
/**
 * `extractSessionMessages` — the offline inbound-message extraction behind
 * `comis messages`.
 *
 * Reads the RAW session `.jsonl` message logs (NOT the trajectory) from every
 * agent workspace tree under the data dir and returns the inbound channel
 * messages users typed, parsed from the inbound-envelope grammar
 * `[<channelType>] <senderId> (<time>):\n<text>` that `wrapInEnvelope`
 * (@comis/agent `envelope/message-envelope.ts`) writes inside each user-role
 * record, after the `[End system context]` wrapper close
 * (`executor/prompt-runner/envelope-wrapper.ts`).
 *
 * Read posture (the same rules as the `obs.explain` readers):
 *   - OFFLINE + LOCAL-ONLY: the extraction is CONTENT-BEARING by design
 *     (message bodies are the payload), which is exactly why it has NO
 *     RPC/MCP surface — the obs network surfaces stay digest-only/content-free.
 *     The CLI reads files the local operator already owns, so this adds no
 *     privilege. Do not wire it into an RPC without a governance review.
 *   - SOFT-FAIL: an unreadable file/dir or corrupt line is counted in
 *     `coverage` and skipped — never a throw, never a silent drop.
 *   - BOUNDED: file and message caps below; overflow is reported via
 *     `coverage`, never hidden.
 *
 * Parsing limitations (inherent to the envelope grammar, same as the
 * forged-marker defense in @comis/agent `session/forged-context-markers.ts`):
 * the header carries no unforgeable fence, so a user-typed line that matches
 * the exact header grammar at a line start splits as a new message; and a
 * session configured with `envelope.showProvider: false` produces headerless
 * turns, which surface in `coverage.unparsedUserRecords` instead of messages.
 *
 * @module
 */

import * as fs from "node:fs";
import { formatSessionKey, safePath } from "@comis/core";
import { pathToSessionKey } from "@comis/agent";

/** Runaway backstop on the tree walk: at most this many session files are read. */
const MAX_SESSION_FILES = 5_000;

/** Hard ceiling on extracted messages (the `limit` option is clamped to it). */
const MAX_MESSAGES = 10_000;

/** Per-file record cap (mirrors the obs-explain reader's MAX_RECORDS bound). */
const MAX_RECORDS_PER_FILE = 5_000;

/** The `[System context]…` wrapper close the prompt assembler writes before the envelope. */
const SYSTEM_CONTEXT_CLOSE = "[End system context]";

/**
 * The inbound-envelope header `[<channelType>] <senderId> (<time>):` with
 * capture groups. Same grammar as the forge-defense
 * `INBOUND_ENVELOPE_HEADER_RE` (@comis/agent `session/forged-context-markers.ts`):
 * a bracketed channel token with no internal spaces, a sender token, a
 * parenthesized time section (which may carry a ` +Nm` elapsed suffix), and the
 * trailing colon. The producer↔parser sync test drives the real `wrapInEnvelope`.
 */
const ENVELOPE_HEADER_RE = /^[ \t]*\[([\w-]+)\][ \t]+(\S+)[ \t]+\(([^)\n]*)\):[ \t]*$/;

/**
 * Decoded `SessionKey.channelId` prefixes of agent-/scheduler-originated
 * sessions (the writers: `setup-channels-credentials.ts` `cron:<jobId>`,
 * `sub-agent-runner.ts` `sub-agent:<runId>`, `agent-heartbeat-source.ts`
 * `heartbeat-<agentId>`). Their "user" turns are dispatch prompts, not humans.
 */
const INTERNAL_CHANNEL_ID_RE = /^(cron:|sub-agent:|heartbeat-)/;

/** The reserved sender the queue follow-up trigger injects into real peer sessions. */
const INTERNAL_SENDER_ID = "system";

/** Filter options for {@link extractSessionMessages}. All optional — absent means "any". */
export interface SessionMessagesFilter {
  /** Envelope channel type (e.g. `telegram`, `discord`). */
  channel?: string;
  /** Decoded `SessionKey.channelId` — the chat/conversation id. */
  chat?: string;
  /** Envelope sender id. */
  sender?: string;
  /** Agent id — `default` for the `workspace` tree, else the `workspace-<agentId>` suffix. */
  agent?: string;
  /** Lower time bound (inclusive), epoch ms, against the record timestamp. */
  sinceMs?: number;
  /** Upper time bound (exclusive), epoch ms, against the record timestamp. */
  untilMs?: number;
  /** Max messages returned (the LATEST N are kept). Clamped to the hard ceiling. */
  limit?: number;
  /** Include internal-origin (cron/sub-agent/heartbeat/system) dispatch messages. */
  includeInternal?: boolean;
}

/** One extracted inbound message. */
export interface ExtractedChannelMessage {
  /** The session record's ISO timestamp (the arrival instant). */
  timestamp: string;
  /** `timestamp` as epoch ms (the sort/filter key). */
  epochMs: number;
  /** Envelope channel type (`telegram`, `discord`, …). */
  channelType: string;
  /** Envelope sender id. */
  senderId: string;
  /** The envelope's parenthesized time section, verbatim (e.g. `3:45 PM +2m`). */
  envelopeTime: string;
  /** The message body the user typed (multi-line preserved). */
  text: string;
  /** Agent whose workspace tree held the session. */
  agentId: string;
  /** Decoded `SessionKey.channelId` — the chat/conversation id. */
  chatId: string;
  /** The formatted session key (`tenant:user:channel[:peer:…]`). */
  sessionKey: string;
  /** `user` for a human inbound; `internal` for agent-/scheduler-originated dispatch. */
  origin: "user" | "internal";
}

/** Honest-coverage counters for one extraction run. */
export interface SessionMessagesCoverage {
  /** Session files opened (readable or not). */
  filesScanned: number;
  /** Session files that could not be read (counted, then skipped). */
  filesUnreadable: number;
  /** User-role records seen across all files. */
  userRecordsSeen: number;
  /** User-role records with no parsable envelope header (headerless turns, bad timestamps). */
  unparsedUserRecords: number;
  /** Files whose record cap was hit (older records in that file were not read). */
  recordCappedFiles: number;
  /** Internal-origin messages excluded by the default filter (0 when includeInternal). */
  internalExcluded: number;
  /** True when `limit` cut the result (the LATEST N were kept). */
  truncated: boolean;
}

/** The extraction result: chronological messages + honest coverage. */
export interface SessionMessagesResult {
  messages: ExtractedChannelMessage[];
  coverage: SessionMessagesCoverage;
}

/** List subdirectory names, soft-failing to `[]` on an unreadable dir. */
function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** List plain-file names, soft-failing to `[]` on an unreadable dir. */
function listFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * The agent workspace trees under the data dir: `workspace` (the default
 * agent) plus every `workspace-<agentId>` sibling (core `resolveWorkspaceDir`).
 */
function listWorkspaceTrees(dataDir: string): Array<{ agentId: string; dirName: string }> {
  const trees: Array<{ agentId: string; dirName: string }> = [];
  for (const name of listDirs(dataDir)) {
    if (name === "workspace") trees.push({ agentId: "default", dirName: name });
    else if (name.startsWith("workspace-")) {
      trees.push({ agentId: name.slice("workspace-".length), dirName: name });
    }
  }
  return trees;
}

/** A raw session-log user record's envelope text, or undefined for other records. */
function userRecordText(record: Record<string, unknown>): string | undefined {
  if (record["type"] !== "message") return undefined;
  const message = record["message"];
  if (message === null || typeof message !== "object") return undefined;
  const m = message as Record<string, unknown>;
  if (m["role"] !== "user") return undefined;
  const content = m["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        b !== null &&
        typeof b === "object" &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text)
    .join("");
}

/** One parsed envelope: header captures + body. */
interface ParsedEnvelope {
  channelType: string;
  senderId: string;
  envelopeTime: string;
  text: string;
}

/**
 * Parse the inbound envelopes out of one user-role record's text.
 *
 * Only the region AFTER the LAST `[End system context]` is scanned — the
 * system-context preamble may QUOTE header-shaped lines (memory recall echoes
 * past turns), and those are context, not inbound messages. A record with no
 * wrapper is scanned whole. Multiple headers in one record are the queued-batch
 * shape — each starts a new message.
 */
function parseEnvelopes(text: string): ParsedEnvelope[] {
  const closeIdx = text.lastIndexOf(SYSTEM_CONTEXT_CLOSE);
  const scope = closeIdx >= 0 ? text.slice(closeIdx + SYSTEM_CONTEXT_CLOSE.length) : text;

  const envelopes: ParsedEnvelope[] = [];
  let current: (Omit<ParsedEnvelope, "text"> & { bodyLines: string[] }) | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    envelopes.push({
      channelType: current.channelType,
      senderId: current.senderId,
      envelopeTime: current.envelopeTime,
      text: current.bodyLines.join("\n").trim(),
    });
    current = undefined;
  };
  for (const line of scope.split("\n")) {
    const header = ENVELOPE_HEADER_RE.exec(line);
    if (header !== null) {
      flush();
      current = {
        channelType: header[1]!,
        senderId: header[2]!,
        envelopeTime: header[3]!,
        bodyLines: [],
      };
    } else if (current !== undefined) {
      current.bodyLines.push(line);
    }
  }
  flush();
  return envelopes;
}

/**
 * Extract inbound channel messages from every session log under the data dir.
 *
 * Pure offline read — never throws; every degradation is a `coverage` counter.
 * Messages are returned in chronological (ascending) order; when `limit` cuts
 * the result the LATEST N are kept and `coverage.truncated` is set.
 */
export function extractSessionMessages(
  dataDir: string,
  filter: SessionMessagesFilter,
): SessionMessagesResult {
  const coverage: SessionMessagesCoverage = {
    filesScanned: 0,
    filesUnreadable: 0,
    userRecordsSeen: 0,
    unparsedUserRecords: 0,
    recordCappedFiles: 0,
    internalExcluded: 0,
    truncated: false,
  };
  const matches: ExtractedChannelMessage[] = [];

  for (const tree of listWorkspaceTrees(dataDir)) {
    if (filter.agent !== undefined && filter.agent !== tree.agentId) continue;
    const sessionsBase = safePath(safePath(dataDir, tree.dirName), "sessions");
    for (const tenant of listDirs(sessionsBase)) {
      const tenantDir = safePath(sessionsBase, tenant);
      for (const channel of listDirs(tenantDir)) {
        const channelDir = safePath(tenantDir, channel);
        for (const name of listFiles(channelDir)) {
          if (!name.endsWith(".jsonl") || name.endsWith(".trajectory.jsonl")) continue;
          if (coverage.filesScanned >= MAX_SESSION_FILES) return finish(matches, coverage, filter);
          coverage.filesScanned++;
          const filePath = safePath(channelDir, name);
          const key = pathToSessionKey(filePath, sessionsBase);
          if (key === undefined) continue; // Not a session-log filename shape.
          if (filter.chat !== undefined && filter.chat !== key.channelId) continue;

          let raw: string;
          try {
            raw = fs.readFileSync(filePath, "utf-8");
          } catch {
            coverage.filesUnreadable++;
            continue;
          }
          const lines = raw.split("\n");
          if (lines.length > MAX_RECORDS_PER_FILE) {
            // Keep the LATEST records — the bounded read must favor recency.
            lines.splice(0, lines.length - MAX_RECORDS_PER_FILE);
            coverage.recordCappedFiles++;
          }
          for (const line of lines) {
            if (line.trim() === "") continue;
            let record: Record<string, unknown>;
            try {
              record = JSON.parse(line) as Record<string, unknown>;
            } catch {
              continue; // Corrupt line — skip, keep the rest of the file.
            }
            const text = userRecordText(record);
            if (text === undefined) continue;
            coverage.userRecordsSeen++;

            const timestamp = typeof record["timestamp"] === "string" ? record["timestamp"] : "";
            const epochMs = Date.parse(timestamp);
            const envelopes = parseEnvelopes(text);
            if (envelopes.length === 0 || Number.isNaN(epochMs)) {
              coverage.unparsedUserRecords++;
              continue;
            }
            if (filter.sinceMs !== undefined && epochMs < filter.sinceMs) continue;
            if (filter.untilMs !== undefined && epochMs >= filter.untilMs) continue;

            for (const env of envelopes) {
              if (filter.channel !== undefined && filter.channel !== env.channelType) continue;
              if (filter.sender !== undefined && filter.sender !== env.senderId) continue;
              const origin: "user" | "internal" =
                INTERNAL_CHANNEL_ID_RE.test(key.channelId) || env.senderId === INTERNAL_SENDER_ID
                  ? "internal"
                  : "user";
              if (origin === "internal" && filter.includeInternal !== true) {
                coverage.internalExcluded++;
                continue;
              }
              matches.push({
                timestamp,
                epochMs,
                channelType: env.channelType,
                senderId: env.senderId,
                envelopeTime: env.envelopeTime,
                text: env.text,
                agentId: tree.agentId,
                chatId: key.channelId,
                sessionKey: formatSessionKey(key),
                origin,
              });
            }
          }
        }
      }
    }
  }
  return finish(matches, coverage, filter);
}

/** Sort chronologically and apply the limit (keep the LATEST N, flag truncation). */
function finish(
  matches: ExtractedChannelMessage[],
  coverage: SessionMessagesCoverage,
  filter: SessionMessagesFilter,
): SessionMessagesResult {
  matches.sort((a, b) => a.epochMs - b.epochMs);
  const limit = Math.max(1, Math.min(filter.limit ?? MAX_MESSAGES, MAX_MESSAGES));
  if (matches.length > limit) {
    coverage.truncated = true;
    return { messages: matches.slice(matches.length - limit), coverage };
  }
  return { messages: matches, coverage };
}
