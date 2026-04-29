// SPDX-License-Identifier: Apache-2.0
/**
 * JSON output formatter for the init command.
 *
 * Assembles structured JSON from WizardState for the --json flag,
 * enabling CI/CD pipelines to parse init results programmatically.
 * Also provides an error formatter for consistent error output.
 *
 * @module
 */

import { homedir } from "node:os";
import { safePath } from "@comis/core";
import type { WizardState } from "./types.js";

// ---------- Types ----------

/**
 * Structured JSON output for `comis init --json`.
 *
 * On success: status is "success" with config details.
 * On error: status is "error" with error details.
 */
export type InitJsonOutput = {
  status: "success" | "error";
  configPath?: string;
  envPath?: string;
  agent?: { name: string; model: string };
  gateway?: { url: string; token?: string };
  channels?: string[];
  daemon?: { started: boolean; pid?: number };
  health?: { passed: number; failed: number; warnings: number };
  error?: { message: string; field?: string };
};

// ---------- Builders ----------

/**
 * Build structured JSON output from a completed WizardState.
 *
 * Extracts configuration details from the wizard state into a
 * flat JSON structure suitable for machine parsing. The `daemon`
 * and `health` fields are left undefined -- the caller (init.ts)
 * populates these after post-setup steps complete.
 *
 * @param state - The completed wizard state
 * @param opts - Optional overrides (configDir)
 * @returns Structured JSON with status "success"
 */
export function buildJsonOutput(
  state: WizardState,
  opts?: { configDir?: string },
): InitJsonOutput {
  const configDir =
    opts?.configDir ?? safePath(homedir(), ".comis");
  const configPath = safePath(configDir, "config.yaml");
  const envPath = safePath(configDir, ".env");

  // Agent details
  const agentName = state.agentName ?? "comis-agent";
  const model = state.model ?? "default";

  // Gateway URL
  let gatewayUrl: string | undefined;
  let gatewayToken: string | undefined;

  if (state.gateway) {
    // For LAN mode the daemon binds 0.0.0.0, but the printed URL is
    // a *connect* hint — surface 127.0.0.1 (the only address every
    // local caller can reach). External clients use the host's public
    // IP/hostname; surfacing 0.0.0.0 here would just be misleading.
    const connectIp =
      state.gateway.bindMode === "loopback"
        ? "127.0.0.1"
        : state.gateway.bindMode === "lan"
          ? "127.0.0.1"
          : state.gateway.customIp ?? "127.0.0.1";
    const port = state.gateway.port ?? 4766;
    gatewayUrl = `ws://${connectIp}:${port}`;

    // Only include token when auth method is token
    if (state.gateway.authMethod === "token" && state.gateway.token) {
      gatewayToken = state.gateway.token;
    }
  }

  // Channel types
  const channels = state.channels?.map((c) => c.type) ?? [];

  return {
    status: "success",
    configPath,
    envPath,
    agent: { name: agentName, model },
    gateway: gatewayUrl
      ? {
          url: gatewayUrl,
          ...(gatewayToken !== undefined && { token: gatewayToken }),
        }
      : undefined,
    channels,
    // daemon and health are populated by the caller after post-setup
    daemon: undefined,
    health: undefined,
  };
}

/**
 * Build structured JSON error output.
 *
 * @param message - Human-readable error description
 * @param field - Optional flag/field name that caused the error
 * @returns Structured JSON with status "error"
 */
export function buildJsonError(
  message: string,
  field?: string,
): InitJsonOutput {
  return {
    status: "error",
    error: {
      message,
      ...(field !== undefined && { field }),
    },
  };
}
