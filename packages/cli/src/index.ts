// SPDX-License-Identifier: Apache-2.0
// @comis/cli — CLI management tool for Comis daemon

// RPC client
export { createRpcClient, withClient } from "./client/rpc-client.js";
export type { RpcClient } from "./client/rpc-client.js";

// Output utilities
export { success, error, warn, info, json } from "./output/format.js";
export { renderTable, renderKeyValue } from "./output/table.js";
export { withSpinner } from "./output/spinner.js";

// Command registration
export { registerDaemonCommand } from "./commands/daemon.js";
export { registerConfigCommand } from "./commands/config.js";
export { registerAgentCommand } from "./commands/agent.js";
export { registerChannelCommand } from "./commands/channel.js";
export { registerMemoryCommand } from "./commands/memory.js";
export { registerSecurityCommand } from "./commands/security.js";
export { registerDoctorCommand } from "./commands/doctor.js";
export { registerInitCommand } from "./commands/init.js";
export { registerConfigureCommand } from "./commands/configure.js";
export { registerStatusCommand } from "./commands/status.js";
export { registerHealthCommand } from "./commands/health.js";
export { registerModelsCommand } from "./commands/models.js";
export { registerPm2Command } from "./commands/pm2.js";
export { registerSessionsCommand } from "./commands/sessions.js";
export { registerResetCommand } from "./commands/reset.js";
export { registerSignalSetupCommand } from "./commands/signal-setup.js";
export { registerSecretsCommand } from "./commands/secrets.js";
export { registerUninstallCommand } from "./commands/uninstall.js";

// ── Dead Export Audit ─────────────────────────────────────────────────
// Total exports: 29 (28 value, 1 type)
// Exports with external consumers: 1
//   - withClient (test/integration/env-vars-unit.test.ts, test/integration/env-vars-daemon.test.ts)
// Exports with zero external consumers: 28
//   All register* command exports and output utilities are consumed only by the CLI's
//   own main.ts binary (not importable as @comis/cli by other packages).
//   Preserved for public API stability.
//
// Types (1):
//   RpcClient
//
// Values (28):
//   createRpcClient, withClient, success, error, warn, info, json,
//   renderTable, renderKeyValue, withSpinner, registerDaemonCommand,
//   registerConfigCommand, registerAgentCommand, registerChannelCommand,
//   registerMemoryCommand, registerSecurityCommand, registerDoctorCommand,
//   registerInitCommand, registerConfigureCommand, registerStatusCommand,
//   registerHealthCommand, registerModelsCommand, registerPm2Command,
//   registerSessionsCommand, registerResetCommand, registerSignalSetupCommand,
//   registerSecretsCommand
