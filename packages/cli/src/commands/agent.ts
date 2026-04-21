// SPDX-License-Identifier: Apache-2.0
/**
 * Agent management commands: list, create, configure, delete, models.
 *
 * Provides `comis agent [list|create|configure|delete|models]` subcommands
 * for managing agent configurations via the daemon RPC interface.
 *
 * @module
 */

import type { AgentConfig } from "@comis/core";
import type { Command } from "commander";
import { ensureWorkspace, resolveWorkspaceDir } from "@comis/agent";
import chalk from "chalk";
import { withClient } from "../client/rpc-client.js";
import { success, error, info, warn, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { renderTable } from "../output/table.js";

/**
 * Agent configuration entry returned from the daemon.
 */
interface AgentEntry {
  name: string;
  provider?: string;
  model?: string;
  bindings?: string[];
}

/**
 * Register the `agent` subcommand group on the program.
 *
 * @param program - The root Commander program
 */
export function registerAgentCommand(program: Command): void {
  const agent = program.command("agent").description("Agent management");

  // agent list
  agent
    .command("list")
    .description("List all configured agents")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (options: { format: string }) => {
      try {
        const result = await withSpinner("Fetching agents...", () =>
          withClient(async (client) => {
            const agentsResult = (await client.call("config.get", { section: "agents" })) as Record<
              string,
              unknown
            >;
            const routingResult = (await client.call("config.get", { section: "routing" })) as Record<
              string,
              unknown
            >;
            return { ...agentsResult, ...routingResult };
          }),
        );

        const agents = extractAgents(result);

        if (agents.length === 0) {
          info("No agents configured");
          return;
        }

        if (options.format === "json") {
          json(agents);
          return;
        }

        renderTable(
          ["Name", "Provider", "Model", "Bindings"],
          agents.map((a) => [
            a.name,
            a.provider ?? "-",
            a.model ?? "-",
            a.bindings?.join(", ") ?? "-",
          ]),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to list agents: ${msg}`);
        process.exit(1);
      }
    });

  // agent create <name>
  agent
    .command("create <name>")
    .description("Create a new agent configuration")
    .option("--provider <provider>", "AI provider (e.g. anthropic, openai)")
    .option("--model <model>", "Model to use (e.g. claude-sonnet-4-5-20250929)")
    .action(async (name: string, options: { provider?: string; model?: string }) => {
      try {
        const agentConfig: Record<string, unknown> = { name };
        if (options.provider) agentConfig["defaultProvider"] = options.provider;
        if (options.model) agentConfig["defaultModel"] = options.model;

        await withSpinner(`Creating agent "${name}"...`, () =>
          withClient(async (client) => {
            return await client.call("config.set", {
              section: "routing",
              key: `agents.${name}`,
              value: agentConfig,
            });
          }),
        );

        // Initialize dedicated workspace for the new agent
        const workspaceDir = resolveWorkspaceDir({ workspacePath: undefined } as AgentConfig, name);
        try {
          await ensureWorkspace({ dir: workspaceDir });
          success(`Agent "${name}" created with workspace at ${workspaceDir}`);
        } catch {
          success(`Agent "${name}" created`);
          warn(`  Workspace initialization failed at ${workspaceDir}`);
        }
        if (options.provider) info(`  Provider: ${options.provider}`);
        if (options.model) info(`  Model: ${options.model}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to create agent: ${msg}`);
        process.exit(1);
      }
    });

  // agent configure <name>
  agent
    .command("configure <name>")
    .description("Update an existing agent's settings")
    .option("--provider <provider>", "AI provider")
    .option("--model <model>", "Model to use")
    .action(async (name: string, options: { provider?: string; model?: string }) => {
      if (!options.provider && !options.model) {
        warn("No settings specified. Use --provider or --model.");
        return;
      }

      try {
        const updates: Record<string, unknown> = {};
        if (options.provider) updates["defaultProvider"] = options.provider;
        if (options.model) updates["defaultModel"] = options.model;

        await withSpinner(`Updating agent "${name}"...`, () =>
          withClient(async (client) => {
            return await client.call("config.set", {
              section: "routing",
              key: `agents.${name}`,
              value: updates,
            });
          }),
        );

        success(`Agent "${name}" updated`);
        if (options.provider) info(`  Provider: ${options.provider}`);
        if (options.model) info(`  Model: ${options.model}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to update agent: ${msg}`);
        process.exit(1);
      }
    });

  // agent delete <name>
  agent
    .command("delete <name>")
    .description("Delete an agent configuration")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (name: string, options: { yes?: boolean }) => {
      // Non-interactive confirmation check
      if (!options.yes && !process.stdin.isTTY) {
        error("Confirmation required. Use --yes flag for non-interactive deletion.");
        process.exit(1);
      }

      if (!options.yes) {
        // Simple confirmation: require --yes in non-TTY, prompt in TTY
        const readline = await import("node:readline");
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const answer = await new Promise<string>((resolve) => {
          rl.question(chalk.yellow(`Delete agent "${name}"? (y/N) `), (ans) => {
            rl.close();
            resolve(ans.trim().toLowerCase());
          });
        });

        if (answer !== "y" && answer !== "yes") {
          info("Cancelled");
          return;
        }
      }

      try {
        await withSpinner(`Deleting agent "${name}"...`, () =>
          withClient(async (client) => {
            return await client.call("config.set", {
              section: "routing",
              key: `agents.${name}`,
              value: null,
            });
          }),
        );

        success(`Agent "${name}" deleted`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to delete agent: ${msg}`);
        process.exit(1);
      }
    });

  // Operation model inspection
  agent
    .command("models <agentId>")
    .description("Show operation model resolutions for an agent")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (agentId: string, options: { format: string }) => {
      try {
        const result = await withSpinner("Fetching operation models...", () =>
          withClient(async (client) => {
            return await client.call("agent.getOperationModels", { agentId });
          }),
        );

        const data = result as {
          agentId: string;
          primaryModel: string;
          providerFamily: string;
          tieringActive: boolean;
          operations: Array<{
            operationType: string;
            model: string;
            provider: string;
            source: string;
            tieringActive: boolean;
            timeoutMs: number;
            crossProvider: boolean;
            apiKeyConfigured: boolean;
          }>;
        };

        if (options.format === "json") {
          json(data);
          return;
        }

        // Header info
        info(`Agent: ${chalk.bold(data.agentId)}`);
        info(`Primary: ${data.primaryModel} (${data.providerFamily})`);
        info(`Tiering: ${data.tieringActive ? chalk.green("active") : chalk.yellow("inactive")}`);
        info("");

        // Operations table
        renderTable(
          ["Operation", "Model", "Source", "Tiered", "Timeout", "Cross-Provider", "API Key"],
          data.operations.map((op) => [
            op.operationType,
            op.model,
            op.source,
            op.tieringActive ? "yes" : "no",
            `${Math.round(op.timeoutMs / 1000)}s`,
            op.crossProvider ? chalk.yellow("yes") : "no",
            op.apiKeyConfigured ? chalk.green("ok") : chalk.red("MISSING"),
          ]),
        );

        // Warnings for missing API keys
        const missingKeys = data.operations.filter((op) => !op.apiKeyConfigured);
        if (missingKeys.length > 0) {
          info("");
          for (const op of missingKeys) {
            warn(`${op.operationType}: ${op.model} requires API key for provider ${op.provider}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to fetch operation models: ${msg}`);
        process.exit(1);
      }
    });
}

/**
 * Extract agent entries from routing config response.
 *
 * Handles various response shapes from the config.get RPC call,
 * normalizing into a flat array of AgentEntry objects.
 */
function extractAgents(config: Record<string, unknown>): AgentEntry[] {
  const agents: AgentEntry[] = [];

  // Try routing.agents or agents directly
  const agentsObj =
    (config["agents"] as Record<string, unknown> | undefined) ??
    ((config["routing"] as Record<string, unknown> | undefined)?.["agents"] as
      | Record<string, unknown>
      | undefined);

  if (agentsObj && typeof agentsObj === "object") {
    for (const [name, value] of Object.entries(agentsObj)) {
      if (value && typeof value === "object") {
        const v = value as Record<string, unknown>;
        agents.push({
          name,
          provider:
            (typeof v["provider"] === "string" ? v["provider"] : undefined) ??
            (typeof v["defaultProvider"] === "string" ? v["defaultProvider"] : undefined),
          model:
            (typeof v["model"] === "string" ? v["model"] : undefined) ??
            (typeof v["defaultModel"] === "string" ? v["defaultModel"] : undefined),
          bindings: Array.isArray(v["bindings"])
            ? (v["bindings"] as string[]).map(String)
            : undefined,
        });
      }
    }
  }

  // Also check top-level or routing-nested bindings for agent references
  const routing = config["routing"] as Record<string, unknown> | undefined;
  const bindings =
    (config["bindings"] as Array<Record<string, unknown>> | undefined) ??
    (routing?.["bindings"] as Array<Record<string, unknown>> | undefined);
  if (Array.isArray(bindings)) {
    for (const binding of bindings) {
      const agentId = typeof binding["agentId"] === "string" ? binding["agentId"] : undefined;
      if (agentId && !agents.some((a) => a.name === agentId)) {
        agents.push({
          name: agentId,
          bindings: [formatBinding(binding)],
        });
      }
    }
  }

  return agents;
}

/**
 * Format a binding object into a human-readable string.
 */
function formatBinding(binding: Record<string, unknown>): string {
  const parts: string[] = [];
  if (binding["channelId"]) parts.push(`channel:${binding["channelId"]}`);
  if (binding["peerId"]) parts.push(`peer:${binding["peerId"]}`);
  if (binding["channelType"]) parts.push(`type:${binding["channelType"]}`);
  return parts.length > 0 ? parts.join(",") : "*";
}
