#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

/**
 * Comis CLI entry point.
 *
 * Commander.js program that registers all CLI subcommands and handles
 * top-level error formatting. All commands are registered via their
 * respective register*Command functions.
 *
 * @module
 */

import { Command } from "commander";
import { readCliVersion } from "./util/cli-version.js";
import { registerAgentCommand } from "./commands/agent.js";
import { registerAuthCommand } from "./commands/auth.js";
import { registerCacheCommand } from "./commands/cache.js";
import { registerChannelCommand } from "./commands/channel.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerDaemonCommand } from "./commands/daemon.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerMemoryCommand } from "./commands/memory.js";
import { registerSecurityCommand } from "./commands/security.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerInitCommand } from "./commands/init.js";
import { registerConfigureCommand } from "./commands/configure.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerHealthCommand } from "./commands/health.js";
import { registerModelsCommand } from "./commands/models.js";
import { registerProvidersCommand } from "./commands/providers.js";
import { registerPm2Command } from "./commands/pm2.js";
import { registerSessionsCommand } from "./commands/sessions.js";
import { registerResetCommand } from "./commands/reset.js";
import { registerSecretsCommand } from "./commands/secrets.js";
import { registerSignalSetupCommand } from "./commands/signal-setup.js";
import { registerTraceCommand } from "./commands/trace.js";
import { registerExplainCommand } from "./commands/explain.js";
import { registerOrchestrateCommand } from "./commands/orchestrate.js";
import { registerWhoamiCommand } from "./commands/whoami.js";
import { registerCostExportCommand } from "./commands/cost-export.js";
import { registerFleetCommand } from "./commands/fleet.js";
import { registerSupportBundleCommand } from "./commands/support-bundle.js";
import { registerUninstallCommand } from "./commands/uninstall.js";

export const program = new Command();

program.name("comis").description("Comis AI agent management CLI").version(readCliVersion() ?? "");

// Register command groups
registerDaemonCommand(program);
registerConfigCommand(program);
registerAgentCommand(program);
registerAuthCommand(program);
registerCacheCommand(program);
registerChannelCommand(program);
registerMemoryCommand(program);
registerSecurityCommand(program);
registerDoctorCommand(program);
registerInitCommand(program);
registerConfigureCommand(program);
registerStatusCommand(program);
registerHealthCommand(program);
registerModelsCommand(program);
registerProvidersCommand(program);
registerMcpCommand(program);
registerPm2Command(program);
registerSessionsCommand(program);
registerResetCommand(program);
registerSecretsCommand(program);
registerSignalSetupCommand(program);
registerTraceCommand(program);
registerExplainCommand(program);
registerOrchestrateCommand(program);
registerWhoamiCommand(program);
registerCostExportCommand(program);
registerFleetCommand(program);
registerSupportBundleCommand(program);
registerUninstallCommand(program);

// Parse and execute
program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exit(1);
});
