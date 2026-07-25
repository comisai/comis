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
import {
  redactOutputText,
  systemDateFrom,
  systemNowMs,
} from "@comis/core";
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

const MESSAGE_FORMATS = new Set(["table", "text", "json", "jsonl"]);
const MAX_MESSAGE_LIMIT = 10_000;
const MESSAGE_REDACTION_POLICY_VERSION = 2;

/** Whether an epoch is both integer-safe and representable by the runtime Date range. */
function isValidEpochMs(value: number): boolean {
  return Number.isSafeInteger(value) && !Number.isNaN(systemDateFrom(value).getTime());
}

/**
 * Parse a `<when>` bound: epoch ms, relative-ago (`Nm|Nh|Nd`), or ISO
 * date/datetime. Returns `undefined` when unparsable — the caller errors and
 * names the accepted forms. A typo must NOT silently widen to "all time":
 * unlike `cost export --since` (content-free counts, widening is benign), a
 * widened messages query dumps every conversation on the operator's terminal.
 */
function parseWhen(value: string, nowMs: number): number | undefined {
  if (/^\d+$/.test(value)) {
    const epochMs = Number(value);
    return isValidEpochMs(epochMs) ? epochMs : undefined;
  }
  const relative = /^(\d+)([mhd])$/.exec(value);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const deltaMs = amount * RELATIVE_UNIT_MS[relative[2]!]!;
    const epochMs = nowMs - deltaMs;
    return Number.isSafeInteger(amount) &&
      Number.isSafeInteger(deltaMs) &&
      isValidEpochMs(epochMs)
      ? epochMs
      : undefined;
  }
  const calendarDate = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(value)?.[1];
  if (calendarDate === undefined || parseUtcDay(calendarDate) === undefined) return undefined;
  const parsed = Date.parse(value);
  return isValidEpochMs(parsed) ? parsed : undefined;
}

/** Parse and strict-round-trip one UTC calendar day. */
function parseUtcDay(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const epochMs = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isSafeInteger(epochMs)) return undefined;
  return systemDateFrom(epochMs).toISOString().slice(0, 10) === value
    ? epochMs
    : undefined;
}

/** Scrub one complete displayed field through the canonical output catalog. */
function scrubDisplayedField(value: string): { value: string; redacted: number } {
  const result = redactOutputText(value);
  return {
    value: result.text,
    redacted: result.redactions,
  };
}

interface ScrubbedSerializedValue<T> {
  readonly value: T;
  readonly redacted: number;
}

/** Scrub every enumerable string value that JSON serialization could expose. */
function scrubSerializedStrings<T>(value: T): ScrubbedSerializedValue<T> {
  if (typeof value === "string") {
    const scrubbed = scrubDisplayedField(value);
    return { value: scrubbed.value as T, redacted: scrubbed.redacted };
  }
  if (Array.isArray(value)) {
    let redacted = 0;
    const scrubbed = value.map((entry) => {
      const result = scrubSerializedStrings(entry);
      redacted += result.redacted;
      return result.value;
    });
    return { value: scrubbed as T, redacted };
  }
  if (value !== null && typeof value === "object") {
    let redacted = 0;
    const entries = Object.entries(value).map(([key, entry]) => {
      const result = scrubSerializedStrings(entry);
      redacted += result.redacted;
      return [key, result.value] as const;
    });
    return { value: Object.fromEntries(entries) as T, redacted };
  }
  return { value, redacted: 0 };
}

/** Scrub every user-controlled displayed field before selecting an output renderer. */
function scrubMessageOutput(result: SessionMessagesResult): SessionMessagesResult {
  let secretRedactions = result.coverage.secretRedactions;
  const messages = result.messages.map((message) => {
    const scrubbed = scrubSerializedStrings(message);
    secretRedactions += scrubbed.redacted;
    return {
      ...scrubbed.value,
      redactions: message.redactions + scrubbed.redacted,
    };
  });
  const unparsedEvidence = result.coverage.unparsedEvidence.map((evidence) => {
    const scrubbed = scrubSerializedStrings(evidence);
    secretRedactions += scrubbed.redacted;
    return {
      ...scrubbed.value,
      redactions: evidence.redactions + scrubbed.redacted,
    };
  });
  return {
    messages,
    coverage: { ...result.coverage, unparsedEvidence, secretRedactions },
    completeness: result.completeness,
  };
}

/** Remove terminal and bidi controls from one human-rendered output fragment. */
function stripTerminalControls(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) continue;
    result += character;
  }
  return result;
}

/** The one-line table preview of a message body (first line, bounded width). */
function previewText(text: string): string {
  const firstLine = stripTerminalControls(text.split("\n", 1)[0] ?? "");
  return firstLine.length > 64 ? `${firstLine.slice(0, 63)}…` : firstLine;
}

/** Render the default table view: one preview row per message + a count summary. */
function renderTable(result: SessionMessagesResult): void {
  const rows = result.messages.map((m) => ({
    time: stripTerminalControls(m.timestamp),
    channel: stripTerminalControls(m.channelType),
    chat: stripTerminalControls(m.chatId),
    sender: stripTerminalControls(m.senderId),
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
    const channelType = stripTerminalControls(m.channelType);
    const senderId = stripTerminalControls(m.senderId);
    const chatId = stripTerminalControls(m.chatId);
    const timestamp = stripTerminalControls(m.timestamp);
    const envelopeTime = stripTerminalControls(m.envelopeTime);
    info(`[${channelType}] ${senderId} · chat ${chatId} · ${timestamp} (${envelopeTime})`);
    for (const line of m.text.split("\n")) info(`  ${stripTerminalControls(line)}`);
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
      `${c.internalExcluded} internal dispatch message(s) (cron/sub-agent/heartbeat/cross-session/background/system/restart-continuation) excluded — --include-internal to show them`,
    );
  }
  if (c.secretRedactions > 0) {
    info(`${c.secretRedactions} secret-bearing output field(s) redacted from message output`);
  }
  if (c.invalidProvenanceRecords > 0) {
    warn(
      `${c.invalidProvenanceRecords} malformed inbound-provenance record(s) fail-closed their synthetic user prompts`,
    );
  }
  if (c.missingSidecars > 0) {
    warn(`${c.missingSidecars} expected inbound provenance sidecar(s) were absent`);
  }
  if (c.provenanceConflicts > 0) {
    warn(`${c.provenanceConflicts} same-source provenance identity conflict(s) were rejected`);
  }
  if (c.duplicateProvenanceMessagesExcluded > 0) {
    info(
      `${c.duplicateProvenanceMessagesExcluded} repeated physical message identity record(s) were deduplicated`,
    );
  }
  if (c.conflictBackfillIncomplete) {
    warn(
      "late provenance conflicts exhausted the bounded backfill runway; fewer than --limit valid messages may be shown",
    );
  } else if (c.conflictCandidateCapReached) {
    info("the bounded conflict-backfill runway was filled; the requested latest window remained complete");
  }
  if (c.compactionSummaryRecordsExcluded > 0) {
    info(
      `${c.compactionSummaryRecordsExcluded} compaction summary record(s) excluded as synthetic session storage`,
    );
  }
  if (c.unparsedUserRecords > 0) {
    info(
      `${c.unparsedUserRecords} user record(s) lacked enough authoritative provenance to attribute safely and were counted, not shown`,
    );
  }
  if (c.ambiguousEnvelopeRecords > 0) {
    warn(
      `${c.ambiguousEnvelopeRecords} unstructured envelope record(s) contained header-shaped body lines; each was preserved as one unsplit message`,
    );
  }
  if (c.filesUnreadable > 0) {
    warn(`${c.filesUnreadable} session file(s) were unreadable and skipped`);
  }
  if (c.sessionDirectoriesUnreadable > 0) {
    warn(`${c.sessionDirectoriesUnreadable} session directory read(s) failed and were skipped`);
  }
  if (c.corruptRecords > 0) {
    warn(`${c.corruptRecords} corrupt session record(s) were skipped`);
  }
  if (c.oversizedRecords > 0) {
    warn(`${c.oversizedRecords} oversized session record(s) exceeded the byte cap and were skipped`);
  }
  if (c.recordCappedFiles > 0) {
    warn(`${c.recordCappedFiles} session file(s) hit the per-file record cap — oldest records in them were not read`);
  }
  if (c.byteCappedFiles > 0) {
    warn(`${c.byteCappedFiles} session file(s) hit the per-file scan-byte cap — older bytes were not read`);
  }
  if (c.totalByteCapReached) {
    warn("the aggregate session scan-byte cap was reached — some session bytes were not inspected");
  }
  if (c.fileCapReached) {
    warn("the session-file walk hit its global cap — some session files were not inspected");
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
    .option(
      "--include-internal",
      "Include cron/sub-agent/heartbeat/cross-session/background/system/restart-continuation dispatch messages",
    )
    .option(
      "--format <format>",
      "Output format: table | text | json | jsonl",
      "table",
    )
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
          const dateStart = parseUtcDay(options.date);
          if (dateStart === undefined) {
            error(`invalid --date '${options.date}' — expected a valid UTC calendar date in YYYY-MM-DD form`);
            process.exit(1);
          }
          sinceMs = dateStart;
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
        const limit = Number(options.limit);
        if (!Number.isSafeInteger(limit) || limit <= 0) {
          error(`invalid --limit '${options.limit}' — expected a positive safe integer`);
          process.exit(1);
        }
        if (limit > MAX_MESSAGE_LIMIT) {
          error(`invalid --limit '${options.limit}' — expected at most ${MAX_MESSAGE_LIMIT}`);
          process.exit(1);
        }
        if (!MESSAGE_FORMATS.has(options.format)) {
          error(
            `invalid --format '${options.format}' — expected table, text, json, or jsonl`,
          );
          process.exit(1);
        }

        const extracted: SessionMessagesResult = await withSpinner(
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
        const result = scrubMessageOutput(extracted);

        if (options.format === "json") {
          json({
            schema: "comis-offline-channel-messages-report",
            schemaVersion: 2,
            messages: result.messages,
            coverage: result.coverage,
            completeness: result.completeness,
            redaction: {
              policyVersion: MESSAGE_REDACTION_POLICY_VERSION,
              redactionsApplied: result.coverage.secretRedactions,
            },
          });
          return;
        }
        if (options.format === "jsonl") {
          for (const m of result.messages) {
            console.log(JSON.stringify(m));
          }
          return;
        }
        if (options.format === "text") renderText(result.messages);
        else renderTable(result);
        renderCoverageNotes(result);
      } catch (e) {
        const failure = redactOutputText(e instanceof Error ? e.message : String(e));
        error(`messages failed: ${failure.text}`);
        process.exit(1);
      }
    });
}
