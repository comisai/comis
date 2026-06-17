// SPDX-License-Identifier: Apache-2.0
/**
 * Memory query commands: search, inspect, stats, clear, export, import.
 *
 * Provides `comis memory [search|inspect|stats|clear|export|import]` subcommands
 * for querying, managing, and porting memory entries via the daemon RPC interface.
 *
 * CLI writes export files directly (not the daemon — daemon runs under
 * node --permission which disables fd-based fs APIs).
 *
 * @module
 */

import * as fs from "node:fs/promises";
import type { Command } from "commander";
import chalk from "chalk";
import {
  MemoryStatsContract,
  MemoryFlushContract,
  MemoryRecallTraceContract,
  MemoryObservationsContract,
  MemoryEntitiesContract,
  MemoryRecallStatsContract,
  MemoryPortabilityExportContract,
  MemoryPortabilityImportContract,
  MemoryPinContract,
  MemoryUnpinContract,
  MemorySearchFilesContract,
  MemoryBrowseContract,
  parseMemoryExportEnvelope,
} from "@comis/core";
import { callTyped, withClient } from "../client/rpc-client.js";
import { success, error, info, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { renderTable, renderKeyValue } from "../output/table.js";
import { confirm } from "../util/confirm.js";
import { resolveOfflineDataDir } from "../util/offline-obs.js";
import { readLearningStatsOffline } from "../util/offline-learning.js";

/**
 * Register the `memory` subcommand group on the program.
 *
 * @param program - The root Commander program
 */
export function registerMemoryCommand(program: Command): void {
  const memory = program.command("memory").description("Memory management");

  // memory search <query> — the hybrid memory-entry search
  // (memory.search_files: memoryApi.search → FTS + vector fusion).
  //
  // Live finding 2026-06-11: this command was a hardcoded exit-1 stub left
  // over from the Phase-126 demolition, blaming "the context engine is
  // 'pipeline'" on a DAG-mode daemon — while the contracted search RPC
  // worked fine. The excuse outlived the era it described.
  memory
    .command("search <query>")
    .description("Search memory entries")
    .option("--limit <n>", "Maximum results to return", "10")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (query: string, options: { limit: string; format: string }) => {
      try {
        const result = await withSpinner("Searching memory...", () =>
          withClient(async (client) =>
            callTyped(client, MemorySearchFilesContract, {
              query,
              limit: Number(options.limit),
            }),
          ),
        );
        const results = result.results ?? [];
        if (results.length === 0) {
          info("No memory entries matched");
          return;
        }
        if (options.format === "json") {
          json(results);
          return;
        }
        renderTable(
          ["#", "Id", "Score", "Content"],
          results.map((r, i) => [
            String(i + 1),
            String(r.id).slice(0, 8),
            (r.score ?? 0).toFixed(3),
            String(r.content).slice(0, 80).replace(/\n/g, " "),
          ]),
        );
      } catch (err) {
        error(`Memory search failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // memory inspect <id> — single-entry detail via memory.browse (no
  // dedicated by-id read RPC exists; the browse page is scanned client-side).
  //
  // Live finding 2026-06-11: like `search`, this was a hardcoded exit-1 stub
  // blaming the demolished pipeline-era context engine.
  memory
    .command("inspect <id>")
    .description("Display full details of a memory entry")
    .option("--format <format>", "Output format (detail|json)", "detail")
    .action(async (id: string, options: { format: string }) => {
      try {
        const result = await withSpinner("Fetching memory entry...", () =>
          withClient(async (client) =>
            callTyped(client, MemoryBrowseContract, { limit: 1000 }),
          ),
        );
        const entries = (result.entries ?? []) as Array<Record<string, unknown>>;
        const entry = entries.find((e) => e.id === id || String(e.id).startsWith(id));
        if (!entry) {
          error(`Memory entry not found in the ${entries.length} most recent entries: ${id} (use 'comis memory export' for a full dump)`);
          process.exit(1);
        }
        if (options.format === "json") {
          json(entry);
          return;
        }
        renderKeyValue(
          Object.entries(entry).map(([k, v]): [string, string] => [
            k,
            typeof v === "string" ? v : JSON.stringify(v),
          ]),
        );
      } catch (err) {
        error(`Memory inspect failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // memory stats — the single operator stats view. Folds in the
  // recall counters (lane usage + rerank-fallback rate + consolidation
  // throughput + recall hit-rate) alongside the base memory.stats, so an
  // operator sees one combined view (cleaner than a separate `recall-stats`
  // subcommand). The recall-counter overlay is BEST-EFFORT: a daemon that has
  // not wired the counters (or rejects the admin call) still renders base stats.
  memory
    .command("stats")
    .description("Display memory statistics")
    .option("--format <format>", "Output format (detail|json)", "detail")
    .action(async (options: { format: string }) => {
      try {
        // Routed via MemoryStatsContract — the daemon's memory-statistics
        // surface. Response is a loose record; the values matter, not the
        // precise shape.
        const result = await withSpinner("Fetching memory stats...", () =>
          withClient(async (client) => {
            return await callTyped(client, MemoryStatsContract, {});
          }),
        );

        const stats = result as Record<string, unknown>;
        if (!stats || Object.keys(stats).length === 0) {
          info("No memory statistics available");
          return;
        }

        // Best-effort recall-counter overlay: a daemon that has not wired the
        // counters (or a non-admin caller) is tolerated — base stats still
        // render. But do NOT swallow the failure silently: leave a non-fatal
        // breadcrumb carrying the cause so an operator debugging "blank recall
        // counters" can tell the call was attempted and why it was skipped
        // (connection reset, auth expiry, serialization bug all look identical
        // otherwise). The overlay stays fail-open — no non-zero exit.
        let recallStats: Record<string, unknown> | undefined;
        try {
          recallStats = (await withClient(async (client) =>
            callTyped(client, MemoryRecallStatsContract, {}),
          )) as unknown as Record<string, unknown>;
        } catch (overlayErr) {
          const overlayMsg =
            overlayErr instanceof Error ? overlayErr.message : String(overlayErr);
          info(`Recall counters unavailable (skipped): ${overlayMsg}`);
          recallStats = undefined;
        }

        if (options.format === "json") {
          json(recallStats ? { ...stats, recallStats } : stats);
          return;
        }

        const pairs: [string, string][] = Object.entries(stats).map(([key, value]) => [
          chalk.bold(formatStatsKey(key)),
          formatStatsValue(value),
        ]);

        // Append the recall counters + derived rates to the same key-value view.
        if (recallStats) {
          for (const [key, value] of Object.entries(recallStats)) {
            pairs.push([chalk.bold(formatStatsKey(key)), formatStatsValue(value)]);
          }
        }

        renderKeyValue(pairs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to fetch memory stats: ${msg}`);
        process.exit(1);
      }
    });

  // memory learning — OBS-02 (Phase 198) outcome-learning telemetry (coverage,
  // volume by source, success/failure ratio per agent). Read OFFLINE from the
  // local outcome_events ledger (~/.comis/memory.db): the CLI cannot import
  // @comis/agent/@comis/skills (closed graph) and the daemon coverage gauge is
  // not yet a queryable RPC, so the offline @comis/memory read is the sanctioned
  // path. Counts/ids/closed-enums only — never a body/confidence/recalled id.
  memory
    .command("learning")
    .description("Outcome-learning telemetry: coverage, volume by source, success/failure ratio")
    .option("--format <format>", "Output format (table|json)", "table")
    .action((options: { format: string }) => {
      const stats = readLearningStatsOffline(resolveOfflineDataDir());
      // Honest empty: learningOutcome is per-agent default-OFF — say WHY it is
      // empty rather than render a misleading zeroed table.
      if (stats === undefined || stats.totalRows === 0) {
        if (options.format === "json") {
          json({ totalRows: 0, totalTrajectories: 0, coverage: 0, perAgent: [] });
          return;
        }
        info(
          "No outcome events recorded yet — learningOutcome is default-off " +
            "(enable agents.<id>.learningOutcome.enabled, gated by memory.costFeatures.enabled, to populate).",
        );
        return;
      }
      if (options.format === "json") {
        json(stats);
        return;
      }
      const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
      info(
        `Coverage: ${pct(stats.coverage)} (${stats.totalResolved}/${stats.totalTrajectories} ` +
          `trajectories resolved · ${stats.totalRows} outcome rows)`,
      );
      renderTable(
        ["Tenant", "Agent", "Trajectories", "Resolved", "Coverage", "Outcomes", "Sources"],
        stats.perAgent.map((a) => [
          a.tenantId,
          a.agentId,
          String(a.trajectories),
          String(a.resolved),
          pct(a.coverage),
          Object.entries(a.outcomes).map(([k, v]) => `${k}:${v}`).join(" "),
          Object.entries(a.sources).map(([k, v]) => `${k}:${v}`).join(" "),
        ]),
      );
    });

  // memory recall-trace <session> — inspect a session's recall trace.
  memory
    .command("recall-trace <session>")
    .description("Inspect a session's hybrid-recall trace (admin)")
    .option("--trace-id <id>", "Filter by trace id instead of / alongside the session")
    .option("--agent <agentId>", "Scope to a specific agent")
    .option("--limit <n>", "Maximum records to return", "200")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(
      async (
        session: string,
        options: { traceId?: string; agent?: string; limit: string; format: string },
      ) => {
        try {
          const result = await withSpinner("Fetching recall trace...", () =>
            withClient(async (client) =>
              callTyped(client, MemoryRecallTraceContract, {
                session_key: session,
                ...(options.traceId !== undefined ? { trace_id: options.traceId } : {}),
                ...(options.agent !== undefined ? { agent_id: options.agent } : {}),
                limit: Number(options.limit),
              }),
            ),
          );

          const records = (result.records ?? []) as Array<Record<string, unknown>>;
          if (records.length === 0) {
            // Honest empty (live finding 2026-06-11): say WHY it is empty —
            // the recorder is opt-in, so a bare "no records" pointed nowhere.
            const traceResult = result as { tracingEnabled?: boolean; hint?: string };
            if (traceResult.hint !== undefined) {
              info(`No recall-trace records found — ${traceResult.hint}`);
            } else {
              info("No recall-trace records found");
            }
            return;
          }

          if (options.format === "json") {
            json(records);
            return;
          }

          // Table view: the correlation keys + the final-count summary. The
          // full per-record ranking detail is available via --format json.
          renderTable(
            ["#", "Trace", "Session", "Final", "When"],
            records.map((r, i) => [
              String(i + 1),
              String(r.traceId ?? "-"),
              String(r.sessionKey ?? "-"),
              String(r.finalCount ?? "-"),
              String(r.ts ?? "-"),
            ]),
          );
          info(`${records.length} record${records.length === 1 ? "" : "s"} found`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          error(`Failed to fetch recall trace: ${msg}`);
          process.exit(1);
        }
      },
    );

  // memory observations — list observation provenance.
  memory
    .command("observations")
    .description("List observation provenance (sources + history) (admin)")
    .option("--agent <agentId>", "Scope to a specific agent")
    .option("--limit <n>", "Maximum observations to return", "50")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (options: { agent?: string; limit: string; format: string }) => {
      try {
        const result = await withSpinner("Fetching observations...", () =>
          withClient(async (client) =>
            callTyped(client, MemoryObservationsContract, {
              ...(options.agent !== undefined ? { agent_id: options.agent } : {}),
              limit: Number(options.limit),
            }),
          ),
        );

        const observations = (result.observations ?? []) as Array<Record<string, unknown>>;
        if (observations.length === 0) {
          info("No observations found");
          return;
        }

        if (options.format === "json") {
          json(observations);
          return;
        }

        renderTable(
          ["ID", "Content", "Proofs", "Sources"],
          observations.map((o) => [
            String(o.id ?? "-"),
            truncate(String(o.content ?? ""), 60),
            String(o.proofCount ?? "-"),
            Array.isArray(o.sourceIds) ? (o.sourceIds as string[]).join(", ") : "-",
          ]),
        );
        info(`${observations.length} observation${observations.length === 1 ? "" : "s"} found`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to fetch observations: ${msg}`);
        process.exit(1);
      }
    });

  // memory entities — list the agent's entity graph.
  memory
    .command("entities")
    .description("List an agent's entity graph, most-mentioned-first (admin)")
    .option("--agent <agentId>", "Scope to a specific agent")
    .option("--limit <n>", "Maximum entities to return", "100")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (options: { agent?: string; limit: string; format: string }) => {
      try {
        const result = await withSpinner("Fetching entity graph...", () =>
          withClient(async (client) =>
            callTyped(client, MemoryEntitiesContract, {
              ...(options.agent !== undefined ? { agent_id: options.agent } : {}),
              limit: Number(options.limit),
            }),
          ),
        );

        const entities = (result.entities ?? []) as Array<Record<string, unknown>>;
        if (entities.length === 0) {
          info("No entities found");
          return;
        }

        if (options.format === "json") {
          json(entities);
          return;
        }

        renderTable(
          ["ID", "Name", "Mentions"],
          entities.map((e) => [
            String(e.id ?? "-"),
            String(e.name ?? "-"),
            String(e.mentionCount ?? "-"),
          ]),
        );
        info(`${entities.length} entit${entities.length === 1 ? "y" : "ies"} found`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to fetch entities: ${msg}`);
        process.exit(1);
      }
    });

  // memory clear
  memory
    .command("clear")
    .description("Clear memory entries matching a filter")
    .option("--filter <filter>", "Filter expression (e.g. memoryType=conversation)")
    .option("--tenant <tenantId>", "Filter by tenant ID")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (options: { filter?: string; tenant?: string; yes?: boolean }) => {
      // Require at least one filter to prevent accidental blanket wipes
      if (!options.filter && !options.tenant) {
        error(
          "At least one filter is required (--filter or --tenant). Safety check prevents blanket clears.",
        );
        process.exit(1);
      }

      // Build filter params
      const params: Record<string, unknown> = {};
      if (options.filter) {
        const [key, ...valueParts] = options.filter.split("=");
        if (!key || valueParts.length === 0) {
          error("Invalid filter format. Use key=value (e.g. memoryType=conversation)");
          process.exit(1);
        }
        params[key] = valueParts.join("=");
      }
      if (options.tenant) {
        params["tenantId"] = options.tenant;
      }

      // Confirmation check
      if (!options.yes && !process.stdin.isTTY) {
        error("Confirmation required. Use --yes flag for non-interactive clearing.");
        process.exit(1);
      }

      if (!options.yes) {
        const filterDesc = Object.entries(params)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");

        if (
          !(await confirm({
            message: `Clear memory entries matching [${filterDesc}]?`,
          }))
        ) {
          info("Cancelled");
          return;
        }
      }

      try {
        // Routed via MemoryFlushContract — the actual flush surface.
        // The tenant filter maps to `tenant_id`; the generic
        // `--filter key=value` flag is a no-op here (there is no
        // `config.set` handler with section=memory).
        await withSpinner("Clearing memory entries...", () =>
          withClient(async (client) => {
            const flushParams: { tenant_id?: string } = {};
            if (typeof params.tenantId === "string") {
              flushParams.tenant_id = params.tenantId;
            }
            return await callTyped(client, MemoryFlushContract, flushParams);
          }),
        );

        success("Memory entries cleared");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to clear memory: ${msg}`);
        process.exit(1);
      }
    });

  // memory export — versioned, secret-scrubbed envelope export.
  // CLI writes the file (daemon runs under node --permission which disables
  // fd-based fs APIs: fsync*, fchmod, fchown). T-02-07: mode 0o600 (owner
  // read/write only).
  memory
    .command("export")
    .description("Export agent memory to a versioned JSON envelope (secrets scrubbed at source)")
    .requiredOption("--agent <agentId>", "Agent whose memory to export")
    .option("--output <path>", "Output file path (default: comis-memory-<agentId>-<timestamp>.json)")
    .option("--limit <n>", "Maximum entries to export (default: 10000)", "10000")
    .action(async (options: { agent: string; output?: string; limit: string }) => {
      // WR-02: guard against non-numeric --limit before the RPC call.
      const exportLimit = parseInt(options.limit, 10);
      if (isNaN(exportLimit) || exportLimit < 1) {
        error("Invalid limit: must be a positive integer");
        process.exit(1);
      }
      try {
        const result = await withSpinner("Exporting memory...", () =>
          withClient(async (client) =>
            callTyped(client, MemoryPortabilityExportContract, {
              agent_id: options.agent,
              limit: exportLimit,
            }),
          ),
        );
        // CLI writes the file — daemon runs node --permission (no fd-based fs APIs).
        // T-02-07: mode 0o600 (owner read/write only — same pattern as openSqliteDatabase).
        const outPath =
          options.output ?? `comis-memory-${options.agent}-${Date.now()}.json`;
        await fs.writeFile(outPath, JSON.stringify(result, null, 2), { mode: 0o600 });
        success(
          `Exported ${result.entryCount} entr${result.entryCount === 1 ? "y" : "ies"} → ${outPath}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to export memory: ${msg}`);
        process.exit(1);
      }
    });

  // memory import — firewalled import from comis-memory-export-v1 envelope.
  // CLI validates envelope client-side (T-02-08 fail-closed layer) before RPC.
  // Daemon runs its own Zod validation + memory-poisoning firewall as second line.
  memory
    .command("import <file>")
    .description("Import memory from a comis-memory-export-v1 JSON envelope")
    .requiredOption("--agent <agentId>", "Target agent to import memory into")
    .option("--dry-run", "Validate and report counts without writing to the store")
    .action(async (file: string, options: { agent: string; dryRun?: boolean }) => {
      try {
        // T-02-08: CLI validates envelope before sending to daemon — fail-closed.
        let raw: unknown;
        try {
          raw = JSON.parse(await fs.readFile(file, "utf-8")) as unknown;
        } catch {
          error(`Cannot read import file: ${file}`);
          process.exit(1);
        }

        const parsed = parseMemoryExportEnvelope(raw);
        if (!parsed.ok) {
          const got =
            (raw as Record<string, unknown> | null)?.["schemaVersion"] ?? "(missing)";
          error(
            `Invalid export envelope — schemaVersion must be "comis-memory-export-v1". ` +
              `Got: ${String(got)}`,
          );
          process.exit(1);
        }

        const result = await withSpinner(
          options.dryRun ? "Validating import (dry-run)..." : "Importing memory...",
          () =>
            withClient(async (client) =>
              callTyped(client, MemoryPortabilityImportContract, {
                entries: parsed.value.entries as Record<string, unknown>[],
                agent_id: options.agent,
                dry_run: options.dryRun,
              }),
            ),
        );

        if (result.dryRun) {
          info(
            `Dry-run: ${result.imported} would import, ${result.blocked} blocked, ` +
              `${result.downgraded} downgraded to external trust (${result.total} total)`,
          );
        } else {
          success(
            `Imported ${result.imported}/${result.total} entr${result.total === 1 ? "y" : "ies"}` +
              (result.blocked > 0
                ? ` — ${result.blocked} blocked (secret/dangerous content)`
                : "") +
              (result.downgraded > 0
                ? `, ${result.downgraded} downgraded to external trust`
                : ""),
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to import memory: ${msg}`);
        process.exit(1);
      }
    });

  // memory pin <id> — mark a memory entry as always-injected in recall. Admin-gated.
  memory
    .command("pin <id>")
    .description("Pin a memory entry (always inject in recall) — admin")
    .option("--agent <agentId>", "Agent scope")
    .option("--tenant <tenantId>", "Tenant scope")
    .action(async (id: string, options: { agent?: string; tenant?: string }) => {
      try {
        const result = await withSpinner("Pinning memory...", () =>
          withClient(async (client) =>
            callTyped(client, MemoryPinContract, {
              id,
              ...(options.agent ? { agent_id: options.agent } : {}),
              ...(options.tenant ? { tenant_id: options.tenant } : {}),
            }),
          ),
        );
        success(`Pinned memory entry: ${result.id}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to pin memory: ${msg}`);
        process.exit(1);
      }
    });

  // memory unpin <id> — remove the always-inject mark from a memory entry. Admin-gated.
  memory
    .command("unpin <id>")
    .description("Unpin a memory entry — admin")
    .option("--agent <agentId>", "Agent scope")
    .option("--tenant <tenantId>", "Tenant scope")
    .action(async (id: string, options: { agent?: string; tenant?: string }) => {
      try {
        const result = await withSpinner("Unpinning memory...", () =>
          withClient(async (client) =>
            callTyped(client, MemoryUnpinContract, {
              id,
              ...(options.agent ? { agent_id: options.agent } : {}),
              ...(options.tenant ? { tenant_id: options.tenant } : {}),
            }),
          ),
        );
        success(`Unpinned memory entry: ${result.id}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to unpin memory: ${msg}`);
        process.exit(1);
      }
    });
}

/**
 * Truncate a string to a maximum length with ellipsis.
 */
function truncate(str: string, maxLength: number): string {
  // Replace newlines with spaces for table display
  const oneLine = str.replace(/\n/g, " ");
  if (oneLine.length <= maxLength) return oneLine;
  return oneLine.slice(0, maxLength - 3) + "...";
}

/**
 * Format a stats value for display, handling nested objects and arrays.
 */
function formatStatsValue(value: unknown): string {
  if (value == null) return "-";
  if (typeof value === "object") {
    if (Array.isArray(value)) return value.join(", ");
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "-";
    return entries.map(([k, v]) => `${k}: ${v}`).join(", ");
  }
  return String(value);
}

/**
 * Format a camelCase stats key into a human-readable label.
 */
function formatStatsKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}
