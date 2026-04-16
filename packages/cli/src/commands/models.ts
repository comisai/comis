/**
 * Model management CLI commands: list and set.
 *
 * Provides `comis models list` for browsing available models from the
 * ModelCatalog (with RPC + local fallback), and `comis models set` for
 * updating an agent's model in the YAML config with format preservation.
 *
 * @module
 */

import type { Command } from "commander";
import * as fs from "node:fs";
import chalk from "chalk";
import { Document, parseDocument } from "yaml";
import { createModelCatalog } from "@comis/agent";
import type { CatalogEntry } from "@comis/agent";
import { withClient } from "../client/rpc-client.js";
import { success, error, info, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { renderTable } from "../output/table.js";

/** Default config paths to check (matching daemon defaults). */
const DEFAULT_CONFIG_PATHS = [
  "/etc/comis/config.yaml",
  "/etc/comis/config.local.yaml",
];

/**
 * Format a context window number into a human-readable string.
 *
 * @example formatContextWindow(128000) => "128k"
 * @example formatContextWindow(1000000) => "1000k"
 */
function formatContextWindow(tokens: number): string {
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}k`;
  }
  return String(tokens);
}

/**
 * Format a cost value for display (per million tokens).
 *
 * @example formatCost(3.5) => "$3.50"
 * @example formatCost(0) => "-"
 */
function formatCost(cost: number): string {
  if (cost === 0) return "-";
  return `$${cost.toFixed(2)}`;
}

/**
 * Load models from daemon via RPC, falling back to local catalog on failure.
 *
 * Tries RPC first (daemon may have enriched catalog from live scans).
 * If daemon is not running, loads from pi-ai static registry locally.
 */
async function loadModels(provider?: string): Promise<CatalogEntry[]> {
  // Try RPC first
  try {
    const result = await withClient(async (client) => {
      return (await client.call("models.list", { provider })) as CatalogEntry[];
    });
    if (Array.isArray(result)) {
      return result;
    }
  } catch {
    // Daemon not running or RPC failed -- fall back to local catalog
  }

  // Local fallback via ModelCatalog
  const catalog = createModelCatalog();
  catalog.loadStatic();

  if (provider) {
    return catalog.getByProvider(provider);
  }
  return catalog.getAll();
}

/**
 * Find a model in the catalog by model ID (searching across all providers).
 *
 * Returns the first matching entry, or undefined if not found.
 */
function findModelInCatalog(
  entries: CatalogEntry[],
  modelId: string,
): CatalogEntry | undefined {
  // Try exact match on provider/modelId format
  const slashIdx = modelId.indexOf("/");
  if (slashIdx > 0) {
    const provider = modelId.substring(0, slashIdx);
    const id = modelId.substring(slashIdx + 1);
    return entries.find((e) => e.provider === provider && e.modelId === id);
  }

  // Search by modelId across all providers
  return entries.find((e) => e.modelId === modelId);
}

/**
 * Register the `models` command group on the program.
 *
 * Provides:
 * - `comis models list` -- browse available models
 * - `comis models set <agent> <model>` -- update agent model in config
 *
 * @param program - The root Commander program
 */
export function registerModelsCommand(program: Command): void {
  const models = program.command("models").description("Model management");

  // models list
  models
    .command("list")
    .description("List available models from the catalog")
    .option("--provider <provider>", "Filter by provider name")
    .option("--format <format>", 'Output format: "table" or "json"', "table")
    .action(async (options: { provider?: string; format: string }) => {
      try {
        const entries = await withSpinner("Loading models...", () =>
          loadModels(options.provider),
        );

        if (entries.length === 0) {
          info(
            options.provider
              ? `No models found for provider "${options.provider}"`
              : "No models found in catalog",
          );
          return;
        }

        if (options.format === "json") {
          json(entries);
          return;
        }

        renderTable(
          ["Provider", "Model", "Context Window", "Input Cost", "Output Cost"],
          entries.map((e) => [
            e.provider,
            e.modelId,
            formatContextWindow(e.contextWindow),
            formatCost(e.cost.input),
            formatCost(e.cost.output),
          ]),
        );

        info(`${entries.length} model${entries.length !== 1 ? "s" : ""} listed`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to list models: ${msg}`);
        process.exit(1);
      }
    });

  // models set <agent> <model>
  models
    .command("set <agent> <model>")
    .description("Set the model for an agent")
    .option("-c, --config <path>", "Config file path")
    .action(async (agent: string, model: string, options: { config?: string }) => {
      try {
        // Load catalog to validate model exists
        const catalog = createModelCatalog();
        catalog.loadStatic();
        const allModels = catalog.getAll();
        const entry = findModelInCatalog(allModels, model);

        if (!entry) {
          error(`Model "${model}" not found in catalog`);
          info("Use 'comis models list' to see available models");
          process.exit(1);
        }

        // Resolve config file path
        const configPath =
          options.config ??
          DEFAULT_CONFIG_PATHS.find((p) => {
            try {
              fs.accessSync(p, fs.constants.R_OK);
              return true;
            } catch {
              return false;
            }
          });

        if (!configPath) {
          error("No config file found. Specify one with --config <path>");
          process.exit(1);
        }

        // Load and parse config preserving YAML formatting
        let doc: Document;
        let rawYaml: string;
        try {
          rawYaml = fs.readFileSync(configPath, "utf-8");
          doc = parseDocument(rawYaml);
        } catch {
          error(`Cannot read config file: ${configPath}`);
          process.exit(1);
          return; // Unreachable but satisfies TS control flow
        }

        // Find the agent entry
        const agentsNode = doc.getIn(["agents"]) ?? doc.getIn(["routing", "agents"]);
        const agentsPath = doc.getIn(["agents"]) ? ["agents"] : ["routing", "agents"];

        if (!agentsNode || typeof agentsNode !== "object") {
          error("No agents section found in config");
          info("Configure agents first with 'comis init' or edit config manually");
          process.exit(1);
        }

        // Check if specified agent exists
        const agentNode = doc.getIn([...agentsPath, agent]);
        if (!agentNode || typeof agentNode !== "object") {
          // List available agents for the user -- toJSON converts YAMLMap to plain object
          const agentsPlain = typeof (agentsNode as { toJSON?: () => unknown }).toJSON === "function"
            ? (agentsNode as { toJSON: () => Record<string, unknown> }).toJSON()
            : agentsNode as Record<string, unknown>;
          const availableAgents = typeof agentsPlain === "object" && agentsPlain !== null
            ? Object.keys(agentsPlain)
            : [];

          error(`Agent "${agent}" not found in config`);
          if (availableAgents.length > 0) {
            info(`Available agents: ${availableAgents.join(", ")}`);
          }
          process.exit(1);
        }

        // Get old model value for display
        const oldModel = doc.getIn([...agentsPath, agent, "defaultModel"]);
        const oldModelStr = typeof oldModel === "string" ? oldModel : "(not set)";

        // Update the model field
        const fullModelId = `${entry.provider}/${entry.modelId}`;
        doc.setIn([...agentsPath, agent, "defaultModel"], fullModelId);

        // Write config back preserving format
        const dir = configPath.substring(0, configPath.lastIndexOf("/"));
        if (dir) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(configPath, doc.toString(), { mode: 0o600 });

        success(`Model updated for agent "${agent}"`);
        console.log(`  ${chalk.gray(oldModelStr)} ${chalk.white("->")} ${chalk.cyan(fullModelId)}`);
        info("Daemon will restart to apply the change");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to set model: ${msg}`);
        process.exit(1);
      }
    });
}
