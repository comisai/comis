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
import { withClient } from "../client/rpc-client.js";
import { error, info, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { renderTable } from "../output/table.js";

/**
 * Channel status entry returned from the daemon.
 */
interface ChannelStatus {
  name: string;
  type: string;
  status: "connected" | "disconnected" | "error" | "disabled" | string;
  details?: string;
}

/**
 * Color-code a channel status string.
 */
function colorStatus(status: string): string {
  switch (status) {
    case "connected":
      return chalk.green(status);
    case "disconnected":
      return chalk.yellow(status);
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
        const config = await withSpinner("Fetching channel status...", () =>
          withClient(async (client) => {
            return (await client.call("config.get", { section: "channels" })) as Record<
              string,
              unknown
            >;
          }),
        );

        const channels = extractChannels(config);

        if (channels.length === 0) {
          info("No channels configured");
          return;
        }

        if (options.format === "json") {
          json(channels);
          return;
        }

        renderTable(
          ["Channel", "Type", "Status", "Details"],
          channels.map((ch) => [ch.name, ch.type, colorStatus(ch.status), ch.details ?? "-"]),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to get channel status: ${msg}`);
        process.exit(1);
      }
    });
}

/**
 * Extract channel status entries from the config response.
 *
 * Handles various response shapes, normalizing into ChannelStatus objects.
 * If channel config has enabled=false, status is marked as "disabled".
 */
function extractChannels(config: Record<string, unknown>): ChannelStatus[] {
  const channels: ChannelStatus[] = [];

  // Check direct channels section or nested under "channels"
  const channelsObj = (config["channels"] as Record<string, unknown> | undefined) ?? config;

  const channelTypes = ["telegram", "discord", "slack", "whatsapp"] as const;

  for (const type of channelTypes) {
    const chConfig = channelsObj[type] as Record<string, unknown> | undefined;
    if (!chConfig) continue;

    const enabled = chConfig["enabled"] !== false;
    const status: ChannelStatus["status"] = !enabled
      ? "disabled"
      : typeof chConfig["status"] === "string"
        ? chConfig["status"]
        : "disconnected";

    channels.push({
      name: type.charAt(0).toUpperCase() + type.slice(1),
      type,
      status,
      details: getChannelDetails(type, chConfig),
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
