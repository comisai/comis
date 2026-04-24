// SPDX-License-Identifier: Apache-2.0
/**
 * Write-config step -- step 10 of the init wizard.
 *
 * Atomically writes config.yaml and .env files from accumulated
 * WizardState. Creates the data directory. Offers secrets store
 * integration when secrets.db exists.
 *
 * @module
 */

import { existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { stringify, parse } from "yaml";
import { safePath, loadEnvFile } from "@comis/core";
import type {
  WizardState,
  WizardStep,
  WizardPrompter,
} from "../index.js";
import {
  updateState,
  heading,
  success as themeSuccess,
  PROVIDER_ENV_KEYS,
  CHANNEL_ENV_KEYS,
  TOOL_PROVIDER_ENV_KEYS,
} from "../index.js";

// ---------- Helpers ----------

/**
 * Get a sensible default model for a provider.
 *
 * Matches the defaults used by the wizard.
 */
function getDefaultModel(provider?: string): string {
  if (!provider) return "default";

  const defaults: Record<string, string> = {
    anthropic: "claude-sonnet-4-5-20250929",
    openai: "gpt-4o",
    google: "gemini-2.0-flash",
    groq: "llama-3.3-70b-versatile",
    ollama: "llama3",
  };
  return defaults[provider] ?? "default";
}

/**
 * Build the config object from WizardState matching AppConfig shape.
 *
 * Uses ${ENV_VAR} substitution for credentials -- actual secrets
 * never appear in config.yaml.
 */
function buildConfigObject(state: WizardState): Record<string, unknown> {
  const config: Record<string, unknown> = {
    logLevel: "info",
    dataDir: state.dataDir ?? safePath(homedir(), ".comis", "data"),
  };

  // Agents section
  const agentConfig: Record<string, unknown> = {
    name: state.agentName ?? "comis-agent",
    provider: state.provider?.id,
    model: state.model ?? getDefaultModel(state.provider?.id),
  };

  // Custom endpoint providers
  if (state.provider?.customEndpoint) {
    agentConfig.customEndpoint = state.provider.customEndpoint;
  }
  if (state.provider?.compatMode) {
    agentConfig.compatMode = state.provider.compatMode;
  }

  // Elevated reply (sender trust map)
  if (state.senderTrustEntries && state.senderTrustEntries.length > 0) {
    const senderTrustMap: Record<string, string> = {};
    for (const entry of state.senderTrustEntries) {
      senderTrustMap[entry.senderId] = entry.level;
    }
    agentConfig.elevatedReply = {
      enabled: true,
      senderTrustMap,
    };
  }

  config.agents = { default: agentConfig };

  // Gateway section
  if (state.gateway) {
    let host: string;
    switch (state.gateway.bindMode) {
      case "loopback":
        host = "127.0.0.1";
        break;
      case "lan":
        host = "0.0.0.0";
        break;
      case "custom":
        host = state.gateway.customIp ?? "127.0.0.1";
        break;
      default:
        host = "127.0.0.1";
    }

    const gatewayConfig: Record<string, unknown> = {
      enabled: true,
      host,
      port: state.gateway.port ?? 4766,
    };

    if (state.gateway.authMethod === "token") {
      gatewayConfig.tokens = [
        { id: "default", secret: "${COMIS_GATEWAY_TOKEN}", scopes: ["*"] },
      ];
    } else if (state.gateway.authMethod === "password") {
      gatewayConfig.password = "${COMIS_GATEWAY_PASSWORD}";
    }

    // Web dashboard -- default true; wizard always sets this explicitly
    gatewayConfig.web = { enabled: state.gateway.webEnabled };

    config.gateway = gatewayConfig;
  }

  // Channels section
  if (state.channels && state.channels.length > 0) {
    const channels: Record<string, unknown> = {};

    for (const ch of state.channels) {
      const entry: Record<string, unknown> = { enabled: true };

      // Use ${ENV_VAR} substitution per channel type
      if (ch.type === "telegram" && ch.botToken) entry.botToken = "${TELEGRAM_BOT_TOKEN}";
      if (ch.type === "discord" && ch.botToken) entry.botToken = "${DISCORD_BOT_TOKEN}";
      if (ch.type === "slack" && ch.botToken) entry.botToken = "${SLACK_BOT_TOKEN}";
      if (ch.type === "slack" && ch.apiKey) entry.signingSecret = "${SLACK_SIGNING_SECRET}";
      if (ch.type === "whatsapp" && ch.botToken) entry.accessToken = "${WHATSAPP_ACCESS_TOKEN}";
      if (ch.type === "line" && ch.botToken) entry.channelAccessToken = "${LINE_CHANNEL_ACCESS_TOKEN}";
      if (ch.type === "line" && ch.channelSecret) entry.channelSecret = "${LINE_CHANNEL_SECRET}";

      // Generic fallback for other channel types
      if (ch.botToken && !entry.botToken && !entry.accessToken && !entry.channelAccessToken) {
        entry.botToken = `\${${ch.type.toUpperCase()}_BOT_TOKEN}`;
      }
      if (ch.apiKey && !entry.signingSecret && !entry.channelSecret) {
        entry.apiKey = `\${${ch.type.toUpperCase()}_API_KEY}`;
      }
      if (ch.appToken) entry.appToken = `\${${ch.type.toUpperCase()}_APP_TOKEN}`;

      // Discord guild IDs
      if (ch.type === "discord" && ch.guildIds && ch.guildIds.length > 0) {
        entry.guildIds = ch.guildIds;
      }

      // Sender allowlist
      if (ch.allowFrom && ch.allowFrom.length > 0) {
        entry.allowFrom = ch.allowFrom;
      }

      channels[ch.type] = entry;
    }

    config.channels = channels;
  }

  return config;
}

/**
 * Build .env file content lines from WizardState.
 *
 * Contains actual credentials -- never appears in config.yaml.
 * Merges with existingEnv to preserve keys the wizard doesn't manage
 * (e.g. tool provider keys survive a quickstart re-run).
 */
function buildEnvLines(
  state: WizardState,
  existingEnv: Record<string, string | undefined> = {},
): string[] {
  // Collect all keys the wizard will explicitly write
  const managed = new Map<string, string>();

  // Provider API key
  if (state.provider?.id && state.provider.apiKey) {
    const envKey = PROVIDER_ENV_KEYS[state.provider.id];
    if (envKey) managed.set(envKey, state.provider.apiKey);
  }

  // Channel credentials
  if (state.channels) {
    for (const ch of state.channels) {
      const envKeys = CHANNEL_ENV_KEYS[ch.type];
      if (ch.botToken && envKeys?.[0]) managed.set(envKeys[0], ch.botToken);
      if (ch.apiKey && envKeys?.[1]) managed.set(envKeys[1], ch.apiKey);
      if (ch.channelSecret && ch.type === "line") {
        const lineEnvKeys = CHANNEL_ENV_KEYS["line"];
        if (lineEnvKeys?.[1]) managed.set(lineEnvKeys[1], ch.channelSecret);
      }
      if (ch.appToken) managed.set(`${ch.type.toUpperCase()}_APP_TOKEN`, ch.appToken);
    }
  }

  // Tool provider credentials
  if (state.toolProviders) {
    for (const tp of state.toolProviders) {
      const envKey = TOOL_PROVIDER_ENV_KEYS[tp.id];
      if (envKey && tp.apiKey) managed.set(envKey, tp.apiKey);
    }
  }

  // Gateway credentials
  if (state.gateway) {
    if (state.gateway.authMethod === "token" && state.gateway.token) {
      managed.set("COMIS_GATEWAY_TOKEN", state.gateway.token);
    } else if (state.gateway.authMethod === "password" && state.gateway.password) {
      managed.set("COMIS_GATEWAY_PASSWORD", state.gateway.password);
    }
  }

  // Merge: start with existing keys, then overlay managed keys
  const merged = new Map<string, string>();
  for (const [key, val] of Object.entries(existingEnv)) {
    if (val !== undefined && val !== "") merged.set(key, val);
  }
  for (const [key, val] of managed) {
    merged.set(key, val);
  }

  const lines: string[] = ["# Comis secrets -- generated by init wizard"];
  for (const [key, val] of merged) {
    lines.push(`${key}=${val}`);
  }

  return lines;
}

// ---------- Step Implementation ----------

export const writeConfigStep: WizardStep = {
  id: "write-config",
  label: "Write Configuration",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    // 1. Show section heading
    prompter.note(heading("Writing Configuration"));

    // 2. Determine paths using safePath (never path.join)
    const configDir = safePath(homedir(), ".comis");
    const configPath = safePath(configDir, "config.yaml");
    const envPath = safePath(configDir, ".env");
    const dataDir = state.dataDir ?? safePath(homedir(), ".comis", "data");

    // 3. Check for secrets store
    let useSecretsStore = false;
    const secretsDbPath = safePath(configDir, "secrets.db");

    if (existsSync(secretsDbPath)) {
      const choice = await prompter.select<string>({
        message: "Your secrets store is active. Store API keys there instead of .env?",
        options: [
          { value: "secrets", label: "Yes -- encrypted at rest (recommended)" },
          { value: "env", label: "No -- keep in .env (plaintext)" },
        ],
      });
      useSecretsStore = choice === "secrets";
    }

    // 4. Build config object
    const configObj = buildConfigObject(state);

    // 5. Serialize to YAML
    const yaml = stringify(configObj, { lineWidth: 0 });

    // 6. Create spinner
    const spinner = prompter.spinner();
    spinner.start("Writing configuration...");

    try {
      // 7. Create config directory
      mkdirSync(configDir, { recursive: true, mode: 0o700 });

      // 8. Atomic config write
      const tempPath = configPath + ".tmp";
      writeFileSync(tempPath, yaml, "utf-8");

      // Validate the temp file is valid YAML
      try {
        const readBack = stringify(parse(yaml));
        if (!readBack) {
          unlinkSync(tempPath);
          throw new Error("YAML validation failed: empty parse result");
        }
      } catch (parseErr) {
        try {
          unlinkSync(tempPath);
        } catch {
          // Best-effort cleanup
        }
        throw new Error(
          `YAML validation failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          { cause: parseErr },
        );
      }

      // Atomic rename (POSIX guarantees atomicity)
      renameSync(tempPath, configPath);
      spinner.update("config.yaml written");

      // 9. Write .env file
      // Load existing .env to preserve keys the wizard doesn't manage
      const existingEnv: Record<string, string | undefined> = {};
      if (existsSync(envPath)) {
        loadEnvFile(envPath, existingEnv);
      }

      if (!useSecretsStore) {
        const envContent = buildEnvLines(state, existingEnv).join("\n") + "\n";
        writeFileSync(envPath, envContent, { mode: 0o600 });
        spinner.update(".env written (0600)");
      } else {
        // 10. Secrets store mode: minimal .env with placeholder
        const secretsEnvLines = [
          "# Comis secrets -- managed by secrets store",
          "# API keys are stored encrypted in secrets.db",
          "# Run: comis secrets set <KEY_NAME> to add keys",
          "",
        ];
        writeFileSync(envPath, secretsEnvLines.join("\n") + "\n", { mode: 0o600 });
        spinner.update(".env written (secrets store mode)");
      }

      // 11. Create data directory
      let dataDirCreated = false;
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        dataDirCreated = true;
      }

      // 12. Stop spinner with success
      spinner.stop("Configuration written successfully");

      // 13. Show summary
      prompter.log.success(themeSuccess("~/.comis/config.yaml"));
      if (!useSecretsStore) {
        prompter.log.success(themeSuccess("~/.comis/.env (0600)"));
      } else {
        prompter.log.success(themeSuccess("~/.comis/.env (secrets store)"));
      }
      if (dataDirCreated) {
        prompter.log.success(themeSuccess(`${dataDir}/ created`));
      }

      // Secrets store guidance
      if (useSecretsStore) {
        prompter.log.info("Run these commands to store your keys:");
        if (state.provider?.id) {
          const envKey = PROVIDER_ENV_KEYS[state.provider.id];
          if (envKey) {
            prompter.log.info(`  comis secrets set ${envKey}`);
          }
        }
        if (state.channels) {
          for (const ch of state.channels) {
            const envKeys = CHANNEL_ENV_KEYS[ch.type];
            if (envKeys) {
              for (const key of envKeys) {
                prompter.log.info(`  comis secrets set ${key}`);
              }
            }
          }
        }
      }
    } catch (writeErr) {
      spinner.stop("Configuration write failed");

      const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);

      if (msg.includes("ENOSPC")) {
        prompter.log.error("Disk full -- free up space and try again.");
      } else if (msg.includes("EACCES") || msg.includes("EPERM")) {
        prompter.log.error(`Permission denied writing to ${configDir}. Check directory permissions.`);
      } else {
        prompter.log.error(`Write failed: ${msg}`);
      }

      throw writeErr;
    }

    // 14. Return updated state
    return updateState(state, {});
  },
};
