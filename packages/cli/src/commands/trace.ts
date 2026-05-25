// SPDX-License-Identifier: Apache-2.0
/**
 * `comis trace` — operator CLI for trace correlation.
 *
 * Subcommands:
 *   --message-id <uuid>       Search trace rows by inbound messageId
 *   --trace-id <uuid>         Search trace rows by traceId
 *   --chat <chatId> --tail    Live polling stream of trace events for a chat
 *   --since <dur> --where <f> Session-index scan for failures in last N min
 *   export <sessionId>        Invoke bundle pipeline; print path
 *
 * Every subcommand supports --json (boolean) for machine consumption.
 * Per cli-uses-typed-rpc.test.ts arch invariant: ONLY callTyped is used; never client.call.
 *
 * @module
 */

import type { Command } from "commander";
import {
  ObsTraceExportContract,
  ObsTraceSearchContract,
  ObsTraceTailContract,
} from "@comis/core";
import { callTyped, withClient } from "../client/rpc-client.js";
import { info, error, json } from "../output/format.js";
import { renderTable } from "../output/table.js";
import { withSpinner } from "../output/spinner.js";

type SearchOptions = {
  messageId?: string;
  traceId?: string;
  since?: string;
  where?: string;
  chat?: string;
  tail?: boolean;
  json?: boolean;
};

/**
 * Register the `trace` subcommand group on the program.
 *
 * Provides 5 trace-correlation subcommands backed by three daemon RPC
 * contracts: ObsTraceSearchContract, ObsTraceTailContract, ObsTraceExportContract.
 *
 * @param program - The root Commander program
 */
export function registerTraceCommand(program: Command): void {
  const trace = program
    .command("trace")
    .description("Trace correlation and export (operator CLI)");

  // ------------------------------------------------------------------
  // Search modes: --message-id, --trace-id, --since/--where
  // ------------------------------------------------------------------
  trace
    .option("--message-id <uuid>", "Trace by inbound messageId")
    .option("--trace-id <uuid>", "Trace by traceId")
    .option("--chat <chatId>", "Filter / tail by chat ID")
    .option("--tail", "Stream events live (requires --chat; polling every ~1s)")
    .option("--since <duration>", "Time window e.g. 10m, 1h")
    .option("--where <filter>", "Filter e.g. 'error'")
    .option("--json", "Machine-readable JSON output")
    .action(async (options: SearchOptions) => {
      // --tail loops; the other modes are single-call search operations
      if (options.tail) {
        if (!options.chat) {
          error("--tail requires --chat <chatId>");
          process.exit(1);
        }
        await runTailLoop(options.chat, Boolean(options.json));
        return;
      }

      try {
        const params = {
          messageId: options.messageId,
          traceId: options.traceId,
          chatId: options.chat,
          since: options.since,
          where: options.where,
        };
        const result = await withSpinner("Searching trace...", () =>
          withClient(async (client) => callTyped(client, ObsTraceSearchContract, params)),
        );
        if (options.json) {
          json(result);
        } else {
          const headers = ["ts", "event", "sessionId", "traceId"];
          const rows = result.rows.map((r) => [
            String(r.ts ?? ""),
            String(r.event ?? ""),
            String(r.sessionId ?? ""),
            String(r.traceId ?? ""),
          ]);
          renderTable(headers, rows);
        }
      } catch (e) {
        error(`Trace search failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  // ------------------------------------------------------------------
  // export subcommand
  // ------------------------------------------------------------------
  trace
    .command("export <sessionId>")
    .description("Export session bundle and print path")
    .option("--json", "Machine-readable JSON output")
    .action(async (sessionId: string, options: { json?: boolean }) => {
      try {
        const result = await withSpinner("Exporting bundle...", () =>
          withClient(async (client) =>
            callTyped(client, ObsTraceExportContract, { sessionId }),
          ),
        );
        if (options.json) {
          json(result);
        } else {
          info(`Bundle written to: ${result.bundlePath}`);
        }
      } catch (e) {
        error(`Bundle export failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}

/**
 * `--tail` polling loop.
 *
 * Calls ObsTraceTailContract every ~1 s, threading `nextSinceMs` as the
 * cursor between polls. Exits cleanly on SIGINT via AbortController.
 *
 * @param chatId - Chat to tail events for
 * @param asJson - When true, emit one JSON object per line; otherwise human-readable columns
 */
async function runTailLoop(chatId: string, asJson: boolean): Promise<void> {
  const abort = new AbortController();
  process.once("SIGINT", () => {
    abort.abort();
  });

  let sinceMs = Date.now() - 60_000;

  while (!abort.signal.aborted) {
    const result = await withClient(async (client) =>
      callTyped(client, ObsTraceTailContract, { chatId, sinceMs, limit: 100 }),
    );

    for (const ev of result.events) {
      if (asJson) {
        // One JSON object per line for machine consumption
        process.stdout.write(JSON.stringify(ev) + "\n");
      } else {
        process.stdout.write(
          `${String(ev.ts ?? "")}  ${String(ev.event ?? "")}  ${String(ev.sessionId ?? "")}\n`,
        );
      }
    }

    sinceMs = result.nextSinceMs;

    // Poll interval ~1 s. Skip the sleep if already aborted to exit promptly.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1000);
      abort.signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  }
}
