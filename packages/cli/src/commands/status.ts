/**
 * System status overview command.
 *
 * Provides `comis status` that displays a unified view of system health
 * across daemon, gateway, channels, and agents. Connects to the daemon
 * via RPC for live data; handles daemon offline gracefully.
 *
 * @module
 */

import type { Command } from "commander";
import chalk from "chalk";
import { withClient } from "../client/rpc-client.js";
import { json } from "../output/format.js";
import { renderTable, renderKeyValue } from "../output/table.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status for a single section. */
interface SectionStatus {
  label: string;
  status: "online" | "offline" | "degraded" | "disabled" | "unknown";
  details: Record<string, unknown>;
}

/** Full system status result. */
interface SystemStatus {
  daemon: SectionStatus;
  gateway: SectionStatus;
  channels: Array<{
    type: string;
    enabled: boolean;
    status: string;
  }>;
  agents: Array<{
    name: string;
    provider: string;
    model: string;
    bindings: string;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Colorize a status string based on its value.
 */
function colorStatus(status: string): string {
  switch (status.toLowerCase()) {
    case "online":
    case "enabled":
    case "listening":
    case "connected":
      return chalk.green(status);
    case "offline":
    case "error":
    case "disconnected":
      return chalk.red(status);
    case "degraded":
    case "warning":
    case "disabled":
      return chalk.yellow(status);
    default:
      return status;
  }
}

/**
 * Format uptime seconds into a human-readable string.
 */
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

/**
 * Fetch full system status from daemon RPC, with graceful offline handling.
 */
async function fetchSystemStatus(): Promise<SystemStatus> {
  const status: SystemStatus = {
    daemon: {
      label: "Daemon",
      status: "offline",
      details: {},
    },
    gateway: {
      label: "Gateway",
      status: "unknown",
      details: {},
    },
    channels: [],
    agents: [],
  };

  try {
    await withClient(async (client) => {
      // Fetch daemon/process status via gateway.status RPC
      try {
        const gwStatusResult = (await client.call("gateway.status")) as Record<string, unknown> | null;
        if (gwStatusResult) {
          status.daemon.status = "online";
          status.daemon.details = gwStatusResult;
        }
      } catch {
        status.daemon.status = "offline";
      }

      // Fetch gateway config for listening address info
      try {
        const gwConfig = (await client.call("config.get", {
          section: "gateway",
        })) as Record<string, unknown> | null;
        if (gwConfig && typeof gwConfig === "object") {
          const gw = (gwConfig["gateway"] as Record<string, unknown> | undefined) ?? gwConfig;
          const enabled = gw["enabled"] !== false;
          status.gateway.status = enabled ? "online" : "disabled";
          status.gateway.details = {
            host: gw["host"],
            port: gw["port"],
            listening: enabled,
          };
        }
      } catch {
        status.gateway.status = "unknown";
      }

      // Fetch channel config
      try {
        const chResult = (await client.call("config.get", {
          section: "channels",
        })) as Record<string, unknown> | null;
        if (chResult && typeof chResult === "object") {
          // config.get may return { channels: { ... } } or { telegram: {...}, ... }
          const channels = (chResult["channels"] as Record<string, unknown> | undefined) ?? chResult;
          for (const [type, value] of Object.entries(channels)) {
            // Skip non-adapter entries (e.g. healthCheck config)
            if (type === "healthCheck") continue;
            if (value && typeof value === "object") {
              const ch = value as Record<string, unknown>;
              status.channels.push({
                type,
                enabled: ch["enabled"] !== false,
                status: ch["enabled"] !== false ? "enabled" : "disabled",
              });
            }
          }
        }
      } catch {
        // No channel data available
      }

      // Fetch agent config (agents are at top-level "agents" section)
      try {
        const agentResult = (await client.call("config.get", {
          section: "agents",
        })) as Record<string, unknown> | null;
        if (agentResult && typeof agentResult === "object") {
          // config.get may return { agents: { ... } } or { default: {...}, ... }
          const agents = (agentResult["agents"] as Record<string, unknown> | undefined) ?? agentResult;
          for (const [name, value] of Object.entries(agents)) {
            if (value && typeof value === "object") {
              const a = value as Record<string, unknown>;
              status.agents.push({
                name,
                provider: (a["provider"] as string) ?? (a["defaultProvider"] as string) ?? "-",
                model: (a["model"] as string) ?? (a["defaultModel"] as string) ?? "-",
                bindings: Array.isArray(a["bindings"])
                  ? (a["bindings"] as string[]).join(", ")
                  : "-",
              });
            }
          }
        }
      } catch {
        // No agent data available
      }
    });
  } catch {
    // Connection failed -- daemon is offline, all sections remain at defaults
    status.daemon.status = "offline";
    status.gateway.status = "unknown";
  }

  return status;
}

/**
 * Render system status in table format to stdout.
 */
function renderStatusTable(status: SystemStatus): void {
  // Daemon section
  console.log(chalk.bold("\n  Daemon"));
  const daemonPairs: [string, string][] = [
    ["  Status", colorStatus(status.daemon.status)],
  ];
  if (status.daemon.details["uptime"]) {
    daemonPairs.push(["  Uptime", formatUptime(status.daemon.details["uptime"] as number)]);
  }
  if (status.daemon.details["pid"]) {
    daemonPairs.push(["  PID", String(status.daemon.details["pid"])]);
  }
  if (status.daemon.details["version"]) {
    daemonPairs.push(["  Version", String(status.daemon.details["version"])]);
  }
  renderKeyValue(daemonPairs);

  // Gateway section
  console.log(chalk.bold("\n  Gateway"));
  const gwPairs: [string, string][] = [
    ["  Status", colorStatus(status.gateway.status)],
  ];
  if (status.gateway.details["host"]) {
    const host = String(status.gateway.details["host"]);
    const port = String(status.gateway.details["port"] ?? 3000);
    gwPairs.push(["  Address", `${host}:${port}`]);
  }
  if (status.gateway.details["connections"] !== undefined) {
    gwPairs.push(["  Connections", String(status.gateway.details["connections"])]);
  }
  renderKeyValue(gwPairs);

  // Channels section
  console.log(chalk.bold("\n  Channels"));
  if (status.channels.length === 0) {
    console.log(chalk.dim("    No channels configured"));
  } else {
    renderTable(
      ["Type", "Enabled", "Status"],
      status.channels.map((ch) => [
        ch.type,
        ch.enabled ? chalk.green("yes") : chalk.yellow("no"),
        colorStatus(ch.status),
      ]),
    );
  }

  // Agents section
  console.log(chalk.bold("\n  Agents"));
  if (status.agents.length === 0) {
    console.log(chalk.dim("    No agents configured"));
  } else {
    renderTable(
      ["Name", "Provider", "Model", "Bindings"],
      status.agents.map((a) => [a.name, a.provider, a.model, a.bindings]),
    );
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

/**
 * Register the `status` command on the program.
 *
 * Provides:
 * - `comis status` -- display system health overview (table format)
 * - `comis status --format json` -- machine-readable JSON output
 *
 * @param program - The root Commander program
 */
export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Display system status overview")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (options: { format: string }) => {
      const status = await fetchSystemStatus();

      if (options.format === "json") {
        json(status);
        return;
      }

      renderStatusTable(status);
    });
}
