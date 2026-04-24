// SPDX-License-Identifier: Apache-2.0
/**
 * Detect existing configuration step -- step 01 of the init wizard.
 *
 * When a user re-runs `comis init`, this step detects any existing
 * configuration file, displays a validity summary, and offers safe
 * options (update / start fresh / cancel) so no data is ever silently
 * destroyed. When no config is found the step passes through silently.
 *
 * @module
 */

import type {
  WizardState,
  WizardStep,
  WizardPrompter,
  ChannelConfig,
} from "../index.js";
import {
  updateState,
  success,
  warning,
  info,
  CancelError,
  CHANNEL_ENV_KEYS,
  PROVIDER_ENV_KEYS,
} from "../index.js";
import {
  loadConfigFile,
  validatePartial,
  safePath,
  loadEnvFile,
} from "@comis/core";
import type { PartialValidationResult } from "@comis/core";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

// ---------- Helpers ----------

/**
 * Default Comis config directory.
 *
 * Uses the user's home directory with the `.comis` subdirectory.
 * May be overridden via state in future phases.
 */
function getConfigDir(): string {
  return homedir() + "/.comis";
}

/**
 * Extract wizard state fields from a raw config object.
 *
 * Maps the on-disk config structure into WizardState fields so that
 * subsequent wizard steps can show current values as defaults when
 * the user chooses "Update existing configuration".
 */
function extractStateFromConfig(
  raw: Record<string, unknown>,
  envRecord: Record<string, string | undefined> = {},
): Partial<WizardState> {
  let agentName: string | undefined;
  let model: string | undefined;
  let provider: WizardState["provider"] | undefined;
  let gateway: WizardState["gateway"] | undefined;
  let channels: ChannelConfig[] | undefined;
  let dataDir: string | undefined;

  // Agent: extract name, model, provider from default agent
  const agentsRaw = raw["agents"] as Record<string, unknown> | undefined;
  if (agentsRaw && typeof agentsRaw === "object") {
    const defaultAgent = (agentsRaw as Record<string, unknown>)["default"] as
      | Record<string, unknown>
      | undefined;
    if (defaultAgent && typeof defaultAgent === "object") {
      if (typeof defaultAgent["name"] === "string") agentName = defaultAgent["name"];
      if (typeof defaultAgent["model"] === "string") model = defaultAgent["model"];
      if (typeof defaultAgent["provider"] === "string") {
        const providerId = defaultAgent["provider"];
        const envKey = PROVIDER_ENV_KEYS[providerId];
        const apiKey = envKey ? envRecord[envKey] : undefined;
        provider = { id: providerId, apiKey, validated: true };
      }
    }
  }

  // Gateway
  const gatewayRaw = raw["gateway"] as Record<string, unknown> | undefined;
  if (gatewayRaw && typeof gatewayRaw === "object") {
    const port = typeof gatewayRaw["port"] === "number" ? gatewayRaw["port"] : undefined;
    const host = typeof gatewayRaw["host"] === "string" ? gatewayRaw["host"] : undefined;

    let bindMode: "loopback" | "lan" | "custom" = "loopback";
    let customIp: string | undefined;
    if (host === "0.0.0.0") {
      bindMode = "lan";
    } else if (host && host !== "127.0.0.1" && host !== "localhost") {
      bindMode = "custom";
      customIp = host;
    }

    if (port !== undefined) {
      const webRaw = gatewayRaw["web"] as Record<string, unknown> | undefined;
      gateway = {
        port,
        bindMode,
        ...(customIp !== undefined && { customIp }),
        authMethod: "token" as const,
        webEnabled: typeof webRaw?.["enabled"] === "boolean" ? webRaw["enabled"] : true,
      };
    }
  }

  // Channels
  const channelsRaw = raw["channels"] as Record<string, unknown> | undefined;
  if (channelsRaw && typeof channelsRaw === "object") {
    const configs: ChannelConfig[] = [];
    for (const [key, val] of Object.entries(channelsRaw)) {
      if (val && typeof val === "object") {
        const entry = val as Record<string, unknown>;
        if (entry["enabled"] !== false) {
          const channelType = key as ChannelConfig["type"];
          const envKeys = CHANNEL_ENV_KEYS[channelType];
          const config: ChannelConfig = { type: channelType, validated: true };

          // Restore credentials from .env
          if (envKeys?.[0]) {
            const token = envRecord[envKeys[0]];
            if (token) config.botToken = token;
          }
          if (envKeys?.[1]) {
            const secret = envRecord[envKeys[1]];
            if (secret) {
              // Second env key maps to apiKey for most channels, channelSecret for LINE
              if (channelType === "line") {
                config.channelSecret = secret;
              } else {
                config.apiKey = secret;
              }
            }
          }
          // Slack app token
          if (channelType === "slack") {
            const appToken = envRecord["SLACK_APP_TOKEN"];
            if (appToken) config.appToken = appToken;
          }

          configs.push(config);
        }
      }
    }
    if (configs.length > 0) channels = configs;
  }

  // Data directory
  const dataDirRaw = raw["dataDir"];
  if (typeof dataDirRaw === "string") dataDir = dataDirRaw;

  return {
    ...(agentName !== undefined && { agentName }),
    ...(model !== undefined && { model }),
    ...(provider !== undefined && { provider }),
    ...(gateway !== undefined && { gateway }),
    ...(channels !== undefined && { channels }),
    ...(dataDir !== undefined && { dataDir }),
  };
}

/**
 * Build a human-readable summary of an existing config's contents.
 *
 * Inspects the raw config object and validation result to produce
 * lines showing agent, gateway, channels, and overall status.
 */
function buildConfigSummary(
  raw: Record<string, unknown>,
  validation: PartialValidationResult,
): string {
  const lines: string[] = [];
  const failedSections = new Set(validation.errors.map((e) => e.section));

  // Agent line
  const agents = raw["agents"] as Record<string, unknown> | undefined;
  if (agents && typeof agents === "object") {
    const defaultAgent = (agents as Record<string, unknown>)["default"] as
      | Record<string, unknown>
      | undefined;
    if (defaultAgent && typeof defaultAgent === "object") {
      const name = (defaultAgent["name"] as string) ?? "default";
      const model = (defaultAgent["model"] as string) ??
        (defaultAgent["provider"] as string) ??
        "unknown";
      lines.push(success(`Agent: ${name} (${model})`));
    } else if (failedSections.has("agents")) {
      lines.push(warning("Agent: configuration has issues"));
    } else {
      lines.push(info("Agent: no default agent configured"));
    }
  } else if (failedSections.has("agents")) {
    lines.push(warning("Agent: configuration has issues"));
  }

  // Gateway line
  const gateway = raw["gateway"] as Record<string, unknown> | undefined;
  if (gateway && typeof gateway === "object") {
    if (failedSections.has("gateway")) {
      lines.push(warning("Gateway: configuration has issues"));
    } else {
      const host = (gateway["host"] as string) ?? "localhost";
      const port = (gateway["port"] as number) ?? 3000;
      lines.push(success(`Gateway: ws://${host}:${port}`));
    }
  }

  // Channels line
  const channels = raw["channels"] as Record<string, unknown> | undefined;
  if (channels && typeof channels === "object") {
    const enabledTypes: string[] = [];
    for (const [key, val] of Object.entries(channels)) {
      // Skip non-adapter entries (e.g. healthCheck config)
      if (key === "healthCheck") continue;
      if (val && typeof val === "object") {
        const entry = val as Record<string, unknown>;
        if (entry["enabled"] !== false) {
          enabledTypes.push(key);
        }
      }
    }
    if (enabledTypes.length > 0) {
      lines.push(success(`Channels: ${enabledTypes.join(", ")}`));
    } else {
      lines.push(info("Channels: none configured"));
    }
  }

  // Status line
  if (validation.errors.length === 0) {
    lines.push(success("Status: Valid"));
  } else {
    const count = validation.errors.length;
    lines.push(
      warning(`Status: ${count} section(s) have issues`),
    );
  }

  return lines.join("\n");
}

// ---------- Step Implementation ----------

export const detectExistingStep: WizardStep = {
  id: "detect-existing",
  label: "Check Existing Config",

  async execute(
    state: WizardState,
    prompter: WizardPrompter,
  ): Promise<WizardState> {
    // 1. Check for existing config
    const configPath = safePath(getConfigDir(), "config.yaml");

    if (!existsSync(configPath)) {
      // No config found -- pass through silently
      return state;
    }

    // 2. Load .env secrets so ${VAR} references resolve before validation
    const envPath = safePath(getConfigDir(), ".env");
    const envRecord: Record<string, string | undefined> = {};
    if (existsSync(envPath)) {
      loadEnvFile(envPath, envRecord);
    }
    const getSecret = (key: string): string | undefined => envRecord[key];

    // 3. Load config file with env substitution
    const loadResult = loadConfigFile(configPath, { getSecret });

    if (!loadResult.ok) {
      // Config file exists but cannot be read/parsed
      prompter.note(
        warning(`Could not read config: ${loadResult.error.message}`),
        "Existing configuration detected",
      );

      const action = await prompter.select<"fresh" | "cancel">({
        message: "What would you like to do?",
        options: [
          {
            value: "fresh" as const,
            label: "Start fresh",
            hint: "Reset and reconfigure everything",
          },
          {
            value: "cancel" as const,
            label: "Cancel",
            hint: "Keep current config unchanged",
          },
        ],
      });

      if (action === "cancel") {
        prompter.outro("Setup cancelled. Existing configuration preserved.");
        throw new CancelError();
      }

      // "fresh" selected on unreadable config -- go to reset scope
      const resetScope = await prompter.select<
        "config" | "config+creds" | "full"
      >({
        message: "Reset scope",
        options: [
          {
            value: "config" as const,
            label: "Config only",
            hint: "Keep credentials and sessions",
          },
          {
            value: "config+creds" as const,
            label: "Config + credentials",
            hint: "Keep sessions",
          },
          {
            value: "full" as const,
            label: "Full reset",
            hint: "Everything -- irreversible",
          },
        ],
      });

      return updateState(state, {
        existingConfigAction: "fresh",
        resetScope,
      });
    }

    const rawConfig = loadResult.value;

    // 4. Partial validation
    const partialResult = validatePartial(rawConfig);

    // 5. Display summary
    const summary = buildConfigSummary(rawConfig, partialResult);
    prompter.note(summary, "Existing configuration detected");

    let action: "update" | "fresh" | "cancel";

    if (partialResult.errors.length === 0) {
      // 6. Valid config -- offer update/fresh/cancel
      action = await prompter.select<"update" | "fresh" | "cancel">({
        message: "What would you like to do?",
        options: [
          {
            value: "update" as const,
            label: "Update existing configuration",
            hint: "Modify specific settings",
          },
          {
            value: "fresh" as const,
            label: "Start fresh",
            hint: "Reset and reconfigure everything",
          },
          {
            value: "cancel" as const,
            label: "Cancel",
            hint: "Keep current config unchanged",
          },
        ],
      });
    } else {
      // 7. Invalid config -- show errors, offer repair/fresh/cancel
      for (const validationError of partialResult.errors) {
        prompter.log.warn(
          `${validationError.section}: ${validationError.error.message}`,
        );
      }

      action = await prompter.select<"update" | "fresh" | "cancel">({
        message: "What would you like to do?",
        options: [
          {
            value: "update" as const,
            label: "Repair configuration",
            hint: "Keep valid values, fix issues",
          },
          {
            value: "fresh" as const,
            label: "Start fresh",
            hint: "Reset and reconfigure everything",
          },
          {
            value: "cancel" as const,
            label: "Cancel",
            hint: "Run 'comis doctor --repair' instead",
          },
        ],
      });
    }

    // 8. Handle cancel
    if (action === "cancel") {
      prompter.outro("Setup cancelled. Existing configuration preserved.");
      throw new CancelError();
    }

    // 9. Handle "fresh" -- reset scope prompt
    if (action === "fresh") {
      const resetScope = await prompter.select<
        "config" | "config+creds" | "full"
      >({
        message: "Reset scope",
        options: [
          {
            value: "config" as const,
            label: "Config only",
            hint: "Keep credentials and sessions",
          },
          {
            value: "config+creds" as const,
            label: "Config + credentials",
            hint: "Keep sessions",
          },
          {
            value: "full" as const,
            label: "Full reset",
            hint: "Everything -- irreversible",
          },
        ],
      });

      return updateState(state, {
        existingConfigAction: "fresh",
        resetScope,
      });
    }

    // 10. Handle "update" -- populate state with existing config values
    const existingState = extractStateFromConfig(rawConfig, envRecord);
    return updateState(state, { ...existingState, existingConfigAction: "update" });
  },
};
