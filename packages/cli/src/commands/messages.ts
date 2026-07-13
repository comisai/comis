// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI command module — Commander.js boundary catches throws and surfaces user-readable messages. The catch block below converts them to error()/process.exit(1) directly.
/**
 * `comis messages` — operator CLI extracting the inbound messages users typed,
 * per channel, from the local session logs.
 *
 * Reads the RAW session `.jsonl` message logs OFFLINE (the operator-owned
 * `~/.comis` tree — the same offline-only posture as `comis cost export`; no
 * daemon RPC exists for this read ON PURPOSE: the output is CONTENT-BEARING,
 * and the obs network surfaces stay digest-only/content-free). Parsing rides
 * the daemon's exported extractor through the single bounded cli→daemon seam.
 *
 * Usage:
 *   comis messages [--channel <type>] [--chat <id>] [--sender <id>] [--agent <id>]
 *     [--since <when>] [--until <when>] [--date <YYYY-MM-DD>] [--limit <n>]
 *     [--include-internal] [--format table|text|json|jsonl]
 *
 * `<when>` accepts epoch ms (`1783900800000`), relative-ago (`30m`, `24h`,
 * `7d`), or an ISO date/datetime (`2026-07-12`, `2026-07-12T10:00:00Z`).
 * `--date` is one-UTC-day sugar for `--since <day 00:00> --until <next 00:00>`.
 *
 * @module
 */

import type { Command } from "commander";
import { systemNowMs } from "@comis/core";
import { error, info, json, warn } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import {
  extractSessionMessagesOffline,
  resolveOfflineDataDir,
  type ExtractedChannelMessage,
  type SessionMessagesResult,
} from "../util/offline-obs.js";

/** CLI options for `comis messages`. */
interface MessagesCliOptions {
  channel?: string;
  chat?: string;
  sender?: string;
  agent?: string;
  since?: string;
  until?: string;
  date?: string;
  limit?: string;
  includeInternal?: boolean;
  format: string;
}

/** Relative-ago suffix multipliers for `<when>` values like `30m` / `24h` / `7d`. */
const RELATIVE_UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a `<when>` bound: epoch ms, relative-ago (`Nm|Nh|Nd`), or ISO
 * date/datetime. Returns `undefined` when unparsable — the caller errors and
 * names the accepted forms. A typo must NOT silently widen to "all time":
 * unlike `cost export --since` (content-free counts, widening is benign), a
 * widened messages query dumps every conversation on the operator's terminal.
 */
function parseWhen(value: string, nowMs: number): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  const relative = /^(\d+)([mhd])$/.exec(value);
  if (relative !== null) return nowMs - Number(relative[1]) * RELATIVE_UNIT_MS[relative[2]!]!;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** The one-line table preview of a message body (first line, bounded width). */
function previewText(text: string): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  return firstLine.length > 64 ? `${firstLine.slice(0, 63)}…` : firstLine;
}

/** Render the default table view: one preview row per message + a count summary. */
function renderTable(result: SessionMessagesResult): void {
  const rows = result.messages.map((m) => ({
    time: m.timestamp,
    channel: m.channelType,
    chat: m.chatId,
    sender: m.senderId,
    preview: previewText(m.text),
  }));
  const width = (col: "time" | "channel" | "chat" | "sender", header: string): number =>
    Math.max(header.length, ...rows.map((r) => r[col].length));
  const timeW = width("time", "TIME");
  const channelW = width("channel", "CHANNEL");
  const chatW = width("chat", "CHAT");
  const senderW = width("sender", "SENDER");
  info(
    `${"TIME".padEnd(timeW)}  ${"CHANNEL".padEnd(channelW)}  ${"CHAT".padEnd(chatW)}  ${"SENDER".padEnd(senderW)}  MESSAGE`,
  );
  for (const r of rows) {
    info(
      `${r.time.padEnd(timeW)}  ${r.channel.padEnd(channelW)}  ${r.chat.padEnd(chatW)}  ${r.sender.padEnd(senderW)}  ${r.preview}`,
    );
  }
  info(`${result.messages.length} message(s)`);
}

/** Render the full-text chat-log view (the human export format). */
function renderText(messages: ExtractedChannelMessage[]): void {
  for (const m of messages) {
    info(`[${m.channelType}] ${m.senderId} · chat ${m.chatId} · ${m.timestamp} (${m.envelopeTime})`);
    for (const line of m.text.split("\n")) info(`  ${line}`);
    info("");
  }
  info(`${messages.length} message(s)`);
}

/** Surface the coverage counters that call for an operator action (table/text only). */
function renderCoverageNotes(result: SessionMessagesResult): void {
  const c = result.coverage;
  if (c.truncated) {
    warn(`output truncated to the latest ${result.messages.length} — raise --limit to see more`);
  }
  if (c.internalExcluded > 0) {
    info(
      `${c.internalExcluded} internal dispatch message(s) (cron/sub-agent/heartbeat/system) excluded — --include-internal to show them`,
    );
  }
  if (c.unparsedUserRecords > 0) {
    info(
      `${c.unparsedUserRecords} user record(s) had no parsable envelope (headerless turns, e.g. envelope.showProvider=false) and were counted, not shown`,
    );
  }
  if (c.filesUnreadable > 0) {
    warn(`${c.filesUnreadable} session file(s) were unreadable and skipped`);
  }
  if (c.recordCappedFiles > 0) {
    warn(`${c.recordCappedFiles} session file(s) hit the per-file record cap — oldest records in them were not read`);
  }
}

/**
 * Register the `messages` command on the program.
 *
 * @param program - The root Commander program
 */
export function registerMessagesCommand(program: Command): void {
  program
    .command("messages")
    .description(
      "Extract the inbound messages users typed, per channel, from the local session logs (offline)",
    )
    .option("--channel <type>", "Filter by channel type (telegram, discord, ...)")
    .option("--chat <id>", "Filter by chat/conversation id")
    .option("--sender <id>", "Filter by sender id")
    .option("--agent <id>", "Filter by agent id (default | the workspace-<agentId> suffix)")
    .option("--since <when>", "Lower bound: epoch ms, relative-ago (30m|24h|7d), or ISO date/datetime")
    .option("--until <when>", "Upper bound (exclusive), same forms as --since")
    .option("--date <YYYY-MM-DD>", "One UTC day (sugar for --since <day> --until <next day>)")
    .option("--limit <n>", "Max messages returned (the latest N are kept)", "500")
    .option("--include-internal", "Include cron/sub-agent/heartbeat/system dispatch messages")
    .option("--format <format>", "Output format: table | text | json | jsonl", "table")
    .action(async (options: MessagesCliOptions) => {
      try {
        const nowMs = systemNowMs();
        let sinceMs: number | undefined;
        let untilMs: number | undefined;
        if (options.date !== undefined) {
          if (options.since !== undefined || options.until !== undefined) {
            error("--date is one-day sugar for --since/--until — pass either --date or the bounds, not both");
            process.exit(1);
          }
          if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
            error(`invalid --date '${options.date}' — expected YYYY-MM-DD`);
            process.exit(1);
          }
          sinceMs = Date.parse(`${options.date}T00:00:00.000Z`);
          untilMs = sinceMs + 86_400_000;
        } else {
          for (const [flag, value, assign] of [
            ["--since", options.since, (v: number): void => void (sinceMs = v)],
            ["--until", options.until, (v: number): void => void (untilMs = v)],
          ] as const) {
            if (value === undefined) continue;
            const parsed = parseWhen(value, nowMs);
            if (parsed === undefined) {
              error(
                `invalid ${flag} '${value}' — expected epoch ms, relative-ago (30m|24h|7d), or an ISO date/datetime`,
              );
              process.exit(1);
            }
            assign(parsed);
          }
        }
        // A non-numeric --limit falls back to the default rather than crashing;
        // the extractor clamps it to its own hard ceiling.
        const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : 500;

        const result: SessionMessagesResult = await withSpinner(
          "Extracting channel messages (offline)...",
          async () =>
            extractSessionMessagesOffline(resolveOfflineDataDir(), {
              channel: options.channel,
              chat: options.chat,
              sender: options.sender,
              agent: options.agent,
              sinceMs,
              untilMs,
              limit,
              includeInternal: options.includeInternal === true,
            }),
        );

        if (options.format === "json") {
          json(result.messages);
          return;
        }
        if (options.format === "jsonl") {
          for (const m of result.messages) {
            // eslint-disable-next-line no-console -- jsonl writes to stdout for redirection (> messages.jsonl)
            console.log(JSON.stringify(m));
          }
          return;
        }
        if (options.format === "text") renderText(result.messages);
        else renderTable(result);
        renderCoverageNotes(result);
      } catch (e) {
        error(`messages failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}
