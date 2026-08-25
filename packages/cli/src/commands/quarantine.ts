// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI command module — Commander.js boundary catches throws and surfaces user-readable messages. The catch blocks below convert them to error()/process.exit(1) directly.
/**
 * `comis quarantine` — the operator lever over quarantined background-task
 * announcements.
 *
 * A quarantined announcement is a completed task's outcome that the runtime
 * could not prove was delivered. Nothing drains it automatically, because
 * re-sending risks telling a user the same thing twice — so it waits for a
 * human. Invalid storage rows wait because they cannot be safely replayed.
 *
 * DAEMON-ONLY on purpose. There is deliberately no `--offline` mode: while the
 * daemon is up it is the only authority, and an offline write would be
 * overwritten without warning — the exact trap this command exists to remove.
 *
 * Content-free: the listing shows ids, route, timing, the failure reason and
 * the announcement's LENGTH — never its text. The announcement is quarantined
 * precisely because it was not delivered to its intended reader; an operator
 * deciding its fate needs the route and the reason, not the message.
 *
 * Usage:
 *   comis quarantine list [--format table|json]
 *   comis quarantine release <id> --outcome delivered|discarded
 *
 * @module
 */

import type { Command } from "commander";
import {
  ObsQuarantineListContract,
  ObsQuarantineReleaseContract,
  type QuarantinedAnnouncementWire,
} from "@comis/core";
import { callTyped, withClient } from "../client/rpc-client.js";
import { error, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";

/** Render one parked announcement as an operator-readable block. */
function renderRow(row: QuarantinedAnnouncementWire, nowMs: number): string {
  if (row.kind === "invalid_record") {
    const ageMin = Math.max(0, Math.round((nowMs - row.detectedAt) / 60_000));
    return [
      `  ${row.id}`,
      "    kind        : invalid_record",
      `    detected    : ${ageMin} min ago (source line: ${row.sourceLine})`,
      `    reason      : ${row.reason}`,
      `    raw evidence: ${row.rawBytes} bytes (withheld, sha256: ${row.rawDigest})`,
    ].join("\n");
  }
  const ageMin = Math.max(0, Math.round((nowMs - row.failedAt) / 60_000));
  const lines = [
    `  ${row.id}`,
    `    kind        : ${row.kind}`,
    `    run         : ${row.runId}`,
    `    route       : ${row.channelType}/${row.channelId}${row.threadId ? `/${row.threadId}` : ""}`,
    `    parked      : ${ageMin} min ago (attempts: ${row.attemptCount})`,
    `    announcement: ${row.announcementChars} chars (withheld)`,
  ];
  if (row.lastError !== undefined) lines.push(`    reason      : ${row.lastError}`);
  if (row.agentId !== undefined) lines.push(`    agent       : ${row.agentId}`);
  return lines.join("\n");
}

/** Register the `quarantine` command group. */
export function registerQuarantineCommand(program: Command): void {
  const group = program
    .command("quarantine")
    .description("Inspect and release quarantined background-task announcements");

  group
    .command("list")
    .description("List announcements awaiting an operator decision")
    .option("--format <format>", "Output format: table or json", "table")
    .action(async (options: { format?: string }) => {
      try {
        const result = await withSpinner(
          "Reading quarantined announcements...",
          () => withClient((client) => callTyped(client, ObsQuarantineListContract, {})),
        );
        const rows = result.rows as unknown as QuarantinedAnnouncementWire[];
        if (options.format === "json") {
          json(result);
          return;
        }
        if (rows.length === 0) {
          process.stdout.write("No quarantined announcements.\n");
          return;
        }
        const nowMs = Date.now();
        process.stdout.write(
          `${result.total} quarantined announcement(s) awaiting a decision:\n\n`
          + rows.map((row) => renderRow(row, nowMs)).join("\n\n")
          + "\n\nRelease one with:\n"
          + "  comis quarantine release <id> --outcome delivered|discarded\n"
          + "Use 'delivered' when you have confirmed the reader already has it, "
          + "'discarded' when it is not worth sending.\n",
        );
      } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        process.exit(1);
      }
    });

  group
    .command("release <id>")
    .description("Record a decision about one quarantined announcement and drop it")
    .requiredOption(
      "--outcome <outcome>",
      "delivered (the reader already has it) or discarded (not worth sending)",
    )
    .action(async (id: string, options: { outcome: string }) => {
      try {
        if (options.outcome !== "delivered" && options.outcome !== "discarded") {
          error("--outcome must be 'delivered' or 'discarded'");
          process.exit(1);
          return;
        }
        const result = await withSpinner(
          "Releasing quarantined announcement...",
          () => withClient((client) => callTyped(client, ObsQuarantineReleaseContract, {
            id,
            outcome: options.outcome as "delivered" | "discarded",
          })),
        );
        // A false `released` is not an error: the id is already gone, which is
        // the state the operator wanted. Say so rather than implying a failure.
        process.stdout.write(
          result.released
            ? `Released ${id} as ${options.outcome}. ${result.remaining} announcement(s) still quarantined.\n`
            : `No quarantined announcement carries id ${id} — it is already gone. `
              + `${result.remaining} still quarantined.\n`,
        );
      } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        process.exit(1);
      }
    });
}
