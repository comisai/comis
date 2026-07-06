// SPDX-License-Identifier: Apache-2.0
/**
 * Channel status command.
 *
 * Provides `comis channel status` to display the connection state
 * of each configured channel with color-coded status indicators.
 *
 * @module
 */

import type { Command } from "commander";
import chalk from "chalk";
import { ChannelsHealthContract, ConfigReadContract } from "@comis/core";
import { callTyped, withClient } from "../client/rpc-client.js";
import { error, info, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { renderFindings, type Section } from "../util/render-findings.js";

/**
 * Channel status entry returned from the daemon.
 */
interface ChannelStatus {
  name: string;
  type: string;
  status: string;
  details?: string;
}

/**
 * Color-code a channel status string.
 *
 * The status vocabulary is the health monitor's live state union
 * (healthy/idle/stale/stuck/startup-grace/disconnected/errored/unknown)
 * plus the CLI-derived "disabled" (config) and "not running" (enabled but
 * absent from the monitor).
 */
function colorStatus(status: string): string {
  switch (status) {
    case "healthy":
    case "connected":
      return chalk.green(status);
    case "idle":
    case "startup-grace":
      return chalk.cyan(status);
    case "stale":
    case "stuck":
    case "not running":
    case "disconnected":
      return chalk.yellow(status);
    case "errored":
    case "error":
      return chalk.red(status);
    case "disabled":
      return chalk.gray(status);
    default:
      return chalk.white(status);
  }
}

/**
 * Register the `channel` subcommand group on the program.
 *
 * @param program - The root Commander program
 */
export function registerChannelCommand(program: Command): void {
  const channel = program.command("channel").description("Channel management");

  // channel status
  channel
    .command("status")
    .description("Display channel connection status")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (options: { format: string }) => {
      try {
        // Config tells us what is CONFIGURED (enabled/disabled + identity
        // details); channels.health tells us what is actually RUNNING. A
        // config-only read would default every enabled channel to
        // "disconnected" — a static lie against a healthy live adapter.
        const { config, health } = await withSpinner("Fetching channel status...", () =>
          withClient(async (client) => {
            const config = await callTyped(client, ConfigReadContract, {
              section: "channels",
            }) as Record<string, unknown>;
            const health = await callTyped(client, ChannelsHealthContract, {});
            return { config, health };
          }),
        );

        const channels = extractChannels(config, health.channels);

        if (channels.length === 0) {
          info("No channels configured");
          return;
        }

        if (options.format === "json") {
          json(channels);
          return;
        }

        // Flat-listing case: a single untitled table section (no bold heading).
        const sections: Section[] = [
          {
            kind: "table",
            headers: ["Channel", "Type", "Status", "Details"],
            rows: channels.map((ch) => [
              ch.name,
              ch.type,
              colorStatus(ch.status),
              ch.details ?? "-",
            ]),
            emptyMessage: "No channels configured",
          },
        ];
        renderFindings({ kind: "sections", sections });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to get channel status: ${msg}`);
        process.exit(1);
      }
    });
}

/** Live health entry shape consumed from the channels.health response. */
interface HealthEntry {
  channelType: string;
  state: string;
  connectionMode?: string | null;
}

/**
 * Extract channel status entries by joining the config section (what is
 * configured) with the live health entries (what is actually running).
 *
 * Status per channel: `disabled` when the config disables it; otherwise the
 * health monitor's live state verbatim; `not running` when enabled in
 * config but absent from the monitor (adapter never started).
 */
function extractChannels(
  config: Record<string, unknown>,
  healthEntries: readonly HealthEntry[],
): ChannelStatus[] {
  const channels: ChannelStatus[] = [];

  // Check direct channels section or nested under "channels"
  const channelsObj = (config["channels"] as Record<string, unknown> | undefined) ?? config;

  const healthByType = new Map<string, HealthEntry>();
  for (const entry of healthEntries) {
    healthByType.set(entry.channelType, entry);
  }

  const channelTypes = [
    "telegram", "discord", "slack", "whatsapp", "signal",
    "imessage", "line", "irc", "email", "msteams", "googlechat",
  ] as const;

  for (const type of channelTypes) {
    const chConfig = channelsObj[type] as Record<string, unknown> | undefined;
    if (!chConfig) continue;

    const enabled = chConfig["enabled"] === true;
    const live = healthByType.get(type);
    const status: ChannelStatus["status"] = !enabled
      ? "disabled"
      : live?.state ?? "not running";

    const configDetails = getChannelDetails(type, chConfig);
    const mode = live?.connectionMode;
    const details = [configDetails, mode ? `mode: ${mode}` : undefined]
      .filter((part): part is string => part !== undefined)
      .join(", ");

    channels.push({
      name: type.charAt(0).toUpperCase() + type.slice(1),
      type,
      status,
      ...(details.length > 0 && { details }),
    });
  }

  return channels;
}

/**
 * Get human-readable details for a channel configuration.
 */
function getChannelDetails(type: string, config: Record<string, unknown>): string | undefined {
  switch (type) {
    case "telegram":
      return config["botUsername"] ? `@${config["botUsername"]}` : undefined;
    case "discord":
      return config["applicationId"] ? `App: ${config["applicationId"]}` : undefined;
    case "slack":
      return config["teamId"] ? `Team: ${config["teamId"]}` : undefined;
    case "whatsapp":
      return config["phoneNumber"] ? `Phone: ${config["phoneNumber"]}` : undefined;
    default:
      return undefined;
  }
}
